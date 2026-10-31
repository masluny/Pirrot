#!/usr/bin/env python3
"""
NVIDIA API key rotator + usage counter for the `pi` coding agent.

pi is pointed at this local proxy (via ~/.pi/agent/models.json). The proxy:
  - loads NVIDIA API keys from ~/.pi/nvidia_keys.txt (one per line)
  - forwards requests to https://integrate.api.nvidia.com/v1
  - streams responses through to the client as they arrive (SSE-safe)
  - on rate-limit (429 / 402) marks the key, retries the request on the next key
  - on auth failure (401 / 403) benches the key for an hour
  - counts requests + tokens per key (cumulative) and records reset times
  - persists state to ~/.pi/nvidia_keys_state.json

Notes on semantics:
  - finish_reason == "length" means the *request's* max_tokens was hit. That is
    a client-side setting (models.json maxTokens), NOT key exhaustion, so it
    must never bench a key. The multikey.ts pi extension handles resuming.
  - usage objects are OpenAI-format: prompt_tokens / completion_tokens.
  - NVIDIA free credits are a ONE-TIME allocation, not a daily quota. A
    credit-exhausted key (402, or 429 whose body says "credit"/"quota") is
    benched LONG and only comes back via `pi-nvidia reset`. Nothing resets at
    midnight — there is no daily reset on the free tier.

Concurrency:
  - State mutations take BOTH an in-process threading lock (_state_lock) and an
    OS-level file lock (fcntl.flock on nvidia_keys_state.lock) so a separate
    `pi-nvidia reset`/`test` process can't clobber the running proxy's counters.
  - Keys accept an optional inline budget annotation, e.g.
        nvapi-xxxx budget=1000
    parsed as: first whitespace token is the key, `budget=N` optional. State is
    always keyed by the bare key string so all readers stay consistent.

CLI:
  pi-nvidia serve            run the local proxy (default if no subcommand)
  pi-nvidia status           show per-key usage + reset time table
  pi-nvidia keys             list loaded keys (masked)
  pi-nvidia reset [index]    clear rate-limit + counters for a key (or all)
  pi-nvidia test             send a tiny request to every key and report
"""

from __future__ import annotations

import contextlib
import errno
import fcntl
import json
import os
import re
import sys
import time
import threading
import http.client
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone

PI_DIR = os.path.expanduser("~/.pi")
KEYS_FILE = os.path.join(PI_DIR, "nvidia_keys.txt")
STATE_FILE = os.path.join(PI_DIR, "nvidia_keys_state.json")
LOCK_FILE = os.path.join(PI_DIR, "nvidia_keys_state.lock")
UPSTREAM_HOST = "integrate.api.nvidia.com"
UPSTREAM_BASE = "/v1"
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8765
TEST_MODEL = "moonshotai/kimi-k3"

# NVIDIA chat/completions can occasionally accept the TCP/TLS request and then
# never send response headers. If we wait for Python's old 300s socket timeout,
# pi times out first and the user only sees "working" forever. Keep this short
# enough to rotate, but long enough for a healthy model to produce first bytes.
UPSTREAM_TIMEOUT = float(os.environ.get("PI_NVIDIA_UPSTREAM_TIMEOUT", "20"))
UPSTREAM_TIMEOUT_COOLDOWN = float(os.environ.get("PI_NVIDIA_TIMEOUT_COOLDOWN", "90"))
UPSTREAM_TOTAL_DEADLINE = float(os.environ.get("PI_NVIDIA_TOTAL_DEADLINE", "45"))
UPSTREAM_MAX_TIMEOUT_ATTEMPTS = int(os.environ.get("PI_NVIDIA_MAX_TIMEOUT_ATTEMPTS", "2"))
TEST_TIMEOUT = float(os.environ.get("PI_NVIDIA_TEST_TIMEOUT", "12"))

# Body substrings that indicate credit/quota exhaustion (NOT a per-minute rate
# limit). NVIDIA free credits are a one-time allocation, so a match means the
# key is dead until credits are refilled — bench it LONG, not for 60s.
# Deliberately narrow: generic phrases like "rate limit exceeded" are ordinary
# per-minute limits and must fall through to the short escalating cooldown, not
# a 7-day bench. The escalation path still catches credit-dead keys that only
# return bare 429s.
CREDIT_HINTS = ("credit", "quota", "insufficient", "billing", "payment")

# Known NVIDIA free-tier per-minute cap (40 RPM baseline; upgradable to 200).
# We proactively skip a key that is near the cap so we don't burn a round-trip
# on a guaranteed 429. Kept a small margin below the real limit.
RPM_LIMIT = 40
RPM_MARGIN = 2

# Long bench durations (seconds).
CREDITS_BENCH = 7 * 86400        # 402 / credit exhaustion
AUTH_DEAD_BENCH = 30 * 86400     # repeated 401/403 -> probably invalid key
AUTH_BENCH = 3600                # single 401/403

# Default per-key credit budget for the status views (1 credit == 1 request).
# 0 = untracked. Overridable per key with `budget=N` in nvidia_keys.txt.
DEFAULT_BUDGET = 1000

# A numeric reset value larger than this is not a plausible relative duration;
# it is probably an absolute epoch timestamp (seconds or ms). Guards against
# benching a key until ~2082 when a provider sends epoch seconds in Retry-After.
MAX_PLAUSIBLE_DURATION = 2 * 86400  # 2 days

# Least-recently-used key selection spreads per-minute limits across keys.
# Flip to False for the old pick-first-available behaviour (keeps tail keys as
# an untouched reserve). LRU + RPM throttling is the recommended default.
USE_LRU = True

_state_lock = threading.Lock()

# In-memory sliding window of request timestamps per key, for RPM throttling.
# Not persisted (a per-minute window is meaningless across restarts).
_rpm_lock = threading.Lock()
_rpm_window: dict[str, list[float]] = {}


# --------------------------------------------------------------------------- #
# Keys + state
# --------------------------------------------------------------------------- #
def _parse_key_line(line: str) -> tuple[str, int] | None:
    """Parse one keys-file line into (key, budget), or None for blank/comment.

    Shared parse rule for every reader: the first whitespace token is the key,
    an optional `budget=N` token overrides DEFAULT_BUDGET. State is always keyed
    by the bare key string returned here.
    """
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    parts = line.split()
    key = parts[0]
    budget = DEFAULT_BUDGET
    for tok in parts[1:]:
        if tok.startswith("budget="):
            try:
                budget = int(tok.split("=", 1)[1])
            except ValueError:
                pass
    return key, budget


def load_keys() -> list[str]:
    if not os.path.exists(KEYS_FILE):
        return []
    keys: list[str] = []
    with open(KEYS_FILE, "r", encoding="utf-8") as fh:
        for line in fh:
            parsed = _parse_key_line(line)
            if parsed:
                keys.append(parsed[0])
    return keys


def load_key_budgets() -> dict[str, int]:
    """Return {key: budget} for the status views. Missing file -> {}."""
    budgets: dict[str, int] = {}
    if not os.path.exists(KEYS_FILE):
        return budgets
    with open(KEYS_FILE, "r", encoding="utf-8") as fh:
        for line in fh:
            parsed = _parse_key_line(line)
            if parsed:
                budgets[parsed[0]] = parsed[1]
    return budgets


def _now() -> float:
    return time.time()


def _default_key_state() -> dict:
    return {
        "requests": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "rate_limited_until": 0.0,   # epoch seconds; 0 = available
        "reset_reason": "",
        "last_used": 0.0,
        "last_status": "",
        "errors": 0,
        "consecutive_limits": 0,          # 429s in a row; reset on any 200
        "consecutive_auth_failures": 0,   # 401/403 in a row; reset on any 200
    }


def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            pass
    return {"keys": {}}


def save_state(state: dict) -> None:
    tmp = STATE_FILE + ".tmp"
    # 0600 on the tmp file so perms never regress on rewrite — the state file
    # contains every key unmasked as JSON object keys.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, STATE_FILE)


@contextlib.contextmanager
def state_transaction():
    """Load->modify->save the state file under BOTH the in-process lock and an
    OS-level file lock, so `reset`/`test` from another process cannot race the
    serving proxy. Yields the loaded state; saves on clean exit.
    """
    with _state_lock:
        lock_fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            state = load_state()
            yield state
            save_state(state)
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)


def prune_state(state: dict, keys: list[str]) -> None:
    """Drop state entries for keys no longer in the keys file."""
    known = set(keys)
    for k in list(state.get("keys", {})):
        if k not in known:
            del state["keys"][k]


def _key_state(state: dict, key: str) -> dict:
    ks = state["keys"].get(key)
    if ks is None:
        ks = _default_key_state()
        state["keys"][key] = ks
    return ks


def mask(key: str) -> str:
    if len(key) <= 10:
        return "***"
    return key[:4] + "..." + key[-4:]


# --------------------------------------------------------------------------- #
# RPM throttling (proactive, in-memory)
# --------------------------------------------------------------------------- #
def _rpm_count(key: str, now: float) -> int:
    with _rpm_lock:
        ts = [t for t in _rpm_window.get(key, ()) if t > now - 60]
        _rpm_window[key] = ts
        return len(ts)


def _rpm_record(key: str, now: float) -> None:
    with _rpm_lock:
        _rpm_window.setdefault(key, []).append(now)


def pick_key_for_request(state: dict, keys: list[str], exclude: set[str]) -> str | None:
    """Pick an available key not in `exclude`.

    Availability = not benched by rate-limit/auth. Among available keys we
    prefer ones under the per-minute RPM cap; ties broken least-recently-used
    (or first-available when USE_LRU is False). Expired benches are cleared.
    """
    now = _now()
    candidates: list[tuple[str, dict]] = []
    for k in keys:
        if k in exclude:
            continue
        ks = _key_state(state, k)
        until = ks.get("rate_limited_until", 0.0)
        if until and until > now:
            continue
        candidates.append((k, ks))
    if not candidates:
        return None
    if USE_LRU:
        candidates.sort(key=lambda kv: kv[1].get("last_used", 0.0))
    # Proactively avoid keys at/over the RPM cap; fall back to all available if
    # every candidate is throttled (better to try than to fail the request).
    under = [(k, ks) for (k, ks) in candidates
             if _rpm_count(k, now) < RPM_LIMIT - RPM_MARGIN]
    k, ks = (under or candidates)[0]
    if ks.get("rate_limited_until"):
        _clear_limit(ks)
    return k


def _clear_limit(ks: dict) -> None:
    """Clear an expired rate-limit flag. Usage counters stay cumulative."""
    ks["rate_limited_until"] = 0.0
    ks["reset_reason"] = ""


# --------------------------------------------------------------------------- #
# Reset-time parsing
# --------------------------------------------------------------------------- #
_DURATION_RE = re.compile(r"(\d+(?:\.\d+)?)([smhd])")


def parse_duration(s: str) -> float | None:
    """Parse a duration string into seconds.

    Handles single-unit ('60s', '5m', '2h', '1d'), compound OpenAI-style
    ('6m0s', '1m30s', '1h2m3s'), and bare numbers ('60', '90.5' -> seconds).
    Returns None if it doesn't look like a duration at all.
    """
    if not s:
        return None
    s = s.strip().lower()
    if not s:
        return None
    matches = _DURATION_RE.findall(s)
    if matches and "".join(f"{n}{u}" for n, u in matches) == s:
        mult = {"s": 1, "m": 60, "h": 3600, "d": 86400}
        return sum(float(n) * mult[u] for n, u in matches)
    try:
        return float(s)
    except ValueError:
        return None


def _parse_http_date(s: str) -> float | None:
    """Parse an RFC HTTP-date (Retry-After form) into an epoch, or None."""
    try:
        dt = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _interpret_reset_value(secs: float) -> float:
    """Turn a numeric reset value (nominally 'seconds from now') into an epoch
    'until', defending against absolute epoch timestamps sent in a
    duration-shaped header.

    - Plausible relative duration (<= 2 days): now + secs.
    - Looks like absolute epoch seconds (now < v < now+1yr): use directly.
    - Looks like absolute epoch milliseconds: divide by 1000.
    - Otherwise implausible: clamp the cooldown to 24h.
    """
    now = _now()
    if secs <= MAX_PLAUSIBLE_DURATION:
        return now + max(0.0, secs)
    year = 366 * 86400
    if now < secs < now + year:
        return secs                      # epoch seconds
    ms = secs / 1000.0
    if now < ms < now + year:
        return ms                        # epoch milliseconds
    return now + 86400                    # implausible -> clamp to 24h


def _clamp_until(until: float) -> float:
    """A header-derived rate-limit reset should never bench a key beyond 24h
    (credit exhaustion is a separate, explicit long-bench path). Floor at now."""
    now = _now()
    return min(max(until, now), now + 86400)


def compute_reset(headers: dict) -> tuple[float, str] | None:
    """Return (epoch_until, reason) from rate-limit headers, or None if the
    response carried no usable reset header (caller decides the fallback).
    The returned `until` is always clamped to at most 24h from now."""
    retry_after = headers.get("retry-after")
    if retry_after:
        secs = parse_duration(retry_after)
        if secs is not None:
            return _clamp_until(_interpret_reset_value(secs)), f"Retry-After {retry_after}"
        epoch = _parse_http_date(retry_after)
        if epoch is not None:
            return _clamp_until(epoch), f"Retry-After {retry_after}"

    for hdr in ("x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"):
        val = headers.get(hdr)
        if not val:
            continue
        secs = parse_duration(val)
        if secs is not None:
            return _clamp_until(_interpret_reset_value(secs)), f"{hdr} {val}"

    return None


# --------------------------------------------------------------------------- #
# Upstream forwarding
# --------------------------------------------------------------------------- #
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host",
}
# Response headers we replace or that would clash with our own framing.
SKIP_RESPONSE = HOP_BY_HOP | {"content-length", "date", "server"}


def extract_usage(raw: bytes, headers: dict) -> dict | None:
    """Pull the OpenAI-format usage object out of an SSE stream or JSON body."""
    ctype = headers.get("content-type", "")
    try:
        text = raw.decode("utf-8", "replace")
    except Exception:
        return None
    if "text/event-stream" in ctype:
        usage = None
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                continue
            try:
                obj = json.loads(payload)
            except Exception:
                continue
            u = obj.get("usage")
            if u:
                usage = u
        return usage
    try:
        obj = json.loads(text)
    except Exception:
        return None
    return obj.get("usage")


def usage_tokens(usage: dict | None) -> tuple[int, int]:
    """Return (input, output) tokens from an OpenAI or generic usage object."""
    if not usage:
        return 0, 0
    def _i(v) -> int:
        try:
            return int(v or 0)
        except (TypeError, ValueError):
            return 0
    in_tok = _i(usage.get("prompt_tokens", usage.get("input_tokens")))
    out_tok = _i(usage.get("completion_tokens", usage.get("output_tokens")))
    return in_tok, out_tok


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Quieter logging; suppress the default stderr tracebacks for client
    # disconnects (BrokenPipe) that used to spam rotator.log.
    def log_message(self, fmt, *args):
        pass

    # ---- helpers ----
    def _send_json(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _clean_headers(self) -> list[tuple[str, str]]:
        out = []
        for k, v in self.headers.items():
            kl = k.lower()
            if kl in HOP_BY_HOP or kl == "content-length":
                continue
            if kl == "authorization":
                continue  # we set our own
            if kl == "accept-encoding":
                # Force identity so we can parse usage and relay verbatim.
                continue
            out.append((k, v))
        return out

    # ---- main forward ----
    def _forward(self, method: str):
        keys = load_keys()
        if not keys:
            self._send_json(503, {"error": "no NVIDIA keys configured in ~/.pi/nvidia_keys.txt"})
            return

        body = self._read_body() if method in ("POST", "PUT", "PATCH") else None
        path = self.path
        # strip our own /v1 prefix -> upstream expects /v1/...
        if not path.startswith("/v1"):
            path = "/v1" + path
        req_headers = self._clean_headers()

        tried: set[str] = set()
        last_error: tuple[int, str] = (502, "")
        deadline = _now() + UPSTREAM_TOTAL_DEADLINE
        timeout_attempts = 0

        for _attempt in range(len(keys)):
            if _now() >= deadline:
                last_error = (504, "upstream timeout deadline reached")
                break
            with state_transaction() as state:
                key = pick_key_for_request(state, keys, tried)
                if key is None:
                    break
                tried.add(key)
                ks = _key_state(state, key)
                ks["last_used"] = _now()
            _rpm_record(key, _now())

            conn = http.client.HTTPSConnection(UPSTREAM_HOST, timeout=UPSTREAM_TIMEOUT)
            headers = dict(req_headers)
            headers["Authorization"] = f"Bearer {key}"
            headers["Host"] = UPSTREAM_HOST
            try:
                conn.request(method, path, body=body, headers=headers)
                resp = conn.getresponse()
            except TimeoutError as exc:
                timeout_attempts += 1
                try:
                    conn.close()
                except Exception:
                    pass
                with state_transaction() as state:
                    ks = _key_state(state, key)
                    ks["last_status"] = "timeout"
                    ks["errors"] += 1
                    ks["rate_limited_until"] = _now() + UPSTREAM_TIMEOUT_COOLDOWN
                    ks["reset_reason"] = (
                        f"upstream timeout -> cooldown {int(UPSTREAM_TIMEOUT_COOLDOWN)}s"
                    )
                last_error = (
                    504,
                    f"upstream timeout before response headers after {UPSTREAM_TIMEOUT:g}s",
                )
                if timeout_attempts >= UPSTREAM_MAX_TIMEOUT_ATTEMPTS:
                    break
                continue
            except Exception as exc:
                try:
                    conn.close()
                except Exception:
                    pass
                with state_transaction() as state:
                    ks = _key_state(state, key)
                    ks["last_status"] = "conn-error"
                    ks["errors"] += 1
                last_error = (502, f"upstream connection error: {exc}")
                continue  # network hiccup: try the next key rather than dying

            status = resp.status
            resp_headers = {k.lower(): v for k, v in resp.getheaders()}

            if status in (429, 402, 401, 403):
                # Rotate: mark this key and retry the same request on another.
                try:
                    err_body = resp.read().decode("utf-8", "replace")
                except Exception:
                    err_body = ""
                finally:
                    conn.close()
                with state_transaction() as state:
                    ks = _key_state(state, key)
                    ks["last_status"] = str(status)
                    ks["errors"] += 1
                    if status in (429, 402):
                        until, reason = self._bench_rate_limited(ks, status, resp_headers, err_body)
                    else:
                        until, reason = self._bench_auth(ks, status)
                    ks["rate_limited_until"] = until
                    ks["reset_reason"] = reason
                last_error = (status, err_body or "rate limited / auth error")
                continue

            if status >= 400:
                # Other client/server errors are the caller's problem; relay as-is.
                try:
                    err_body = resp.read()
                except Exception:
                    err_body = b""
                finally:
                    conn.close()
                with state_transaction() as state:
                    ks = _key_state(state, key)
                    ks["last_status"] = str(status)
                    ks["errors"] += 1
                self._relay_buffered(status, resp_headers, err_body)
                return

            # Success: stream the response through while collecting a copy for
            # usage accounting. finish_reason=length is deliberately NOT treated
            # as key exhaustion (it's the request's max_tokens, not a quota).
            raw, client_gone = self._relay_stream(status, resp_headers, resp)
            conn.close()

            usage = extract_usage(raw, resp_headers)
            in_tok, out_tok = usage_tokens(usage)
            with state_transaction() as state:
                ks = _key_state(state, key)
                ks["last_status"] = str(status)
                ks["requests"] += 1
                ks["input_tokens"] += in_tok
                ks["output_tokens"] += out_tok
                ks["consecutive_limits"] = 0
                ks["consecutive_auth_failures"] = 0
            if client_gone:
                self.close_connection = True
            return

        # all keys exhausted / errored
        code, msg = last_error
        self._send_json(code if code else 503, {
            "error": {
                "message": f"pi-nvidia rotator: all NVIDIA keys are rate-limited or invalid. {msg}",
                "type": "rotator_all_keys_exhausted",
            }
        })

    @staticmethod
    def _bench_rate_limited(ks: dict, status: int, resp_headers: dict,
                            err_body: str) -> tuple[float, str]:
        """Decide the bench duration for a 429/402. Mutates counters on ks."""
        body_is_credit = any(h in err_body.lower() for h in CREDIT_HINTS)
        if status == 402 or body_is_credit:
            # Credit exhaustion — a one-time allocation, not a daily quota.
            # Do NOT rejoin the pool every 60s; long-bench until manual reset.
            ks["consecutive_limits"] = ks.get("consecutive_limits", 0) + 1
            return (_now() + CREDITS_BENCH,
                    "credits exhausted — reset manually if refilled")

        header_reset = compute_reset(resp_headers)
        if header_reset is not None:
            ks["consecutive_limits"] = ks.get("consecutive_limits", 0) + 1
            return header_reset

        # Headerless 429: per-minute rate limit (refills in <=60s). Short
        # cooldown, but escalate to catch keys that are actually credit-dead
        # yet return bare 429s.
        n = ks.get("consecutive_limits", 0) + 1
        ks["consecutive_limits"] = n
        cooldown = min(30 * (2 ** n), 1800)
        return _now() + cooldown, f"rate limit — cooldown {cooldown}s (x{n})"

    @staticmethod
    def _bench_auth(ks: dict, status: int) -> tuple[float, str]:
        """Decide the bench duration for a 401/403. Mutates counters on ks."""
        n = ks.get("consecutive_auth_failures", 0) + 1
        ks["consecutive_auth_failures"] = n
        if n >= 3:
            return (_now() + AUTH_DEAD_BENCH,
                    f"auth {status} x{n} — invalid? reset manually")
        return _now() + AUTH_BENCH, f"auth {status} -> 1h"

    def _relay_stream(self, status: int, headers: dict, resp) -> tuple[bytes, bool]:
        """Stream the upstream response to the client with chunked framing.

        Returns (collected_body, client_gone). Data is forwarded the moment it
        arrives (read1), so SSE tokens reach pi in real time instead of after
        the whole response is buffered.

        On client disconnect we stop pulling tokens from upstream. On an
        upstream read error mid-stream we surface an error rather than sending a
        clean-looking (but silently truncated) terminator.
        """
        collected: list[bytes] = []
        client_gone = False
        upstream_error = False
        is_sse = "text/event-stream" in headers.get("content-type", "")
        try:
            self.send_response(status)
            for k, v in headers.items():
                if k in SKIP_RESPONSE:
                    continue
                self.send_header(k, v)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            client_gone = True

        while True:
            if client_gone:
                break  # client hung up: stop pulling tokens from upstream
            try:
                chunk = resp.read1(65536)
            except Exception:
                upstream_error = True  # upstream died mid-stream
                break
            if not chunk:
                break
            collected.append(chunk)
            try:
                self.wfile.write(b"%x\r\n" % len(chunk))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                client_gone = True
                break

        if not client_gone:
            try:
                if upstream_error and is_sse:
                    # Surface the failure as an SSE error event so pi shows an
                    # error instead of rendering a silently truncated response.
                    err = (b'data: {"error": {"message": "rotator: upstream '
                           b'connection lost mid-stream"}}\n\n')
                    self.wfile.write(b"%x\r\n" % len(err))
                    self.wfile.write(err)
                    self.wfile.write(b"\r\n")
                if upstream_error and not is_sse:
                    # No clean SSE channel to signal the error — abort the
                    # transfer WITHOUT the terminating chunk so the client sees
                    # a broken stream, not a valid-but-truncated one.
                    self.close_connection = True
                else:
                    self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                client_gone = True
        return b"".join(collected), client_gone

    def _relay_buffered(self, status: int, headers: dict, body: bytes):
        try:
            self.send_response(status)
            for k, v in headers.items():
                if k in SKIP_RESPONSE:
                    continue
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    # ---- routing ----
    def do_GET(self): self._forward("GET")
    def do_POST(self): self._forward("POST")
    def do_PUT(self): self._forward("PUT")
    def do_PATCH(self): self._forward("PATCH")
    def do_DELETE(self): self._forward("DELETE")


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Client disconnects are routine (pi aborts, timeouts) — don't dump
        # tracebacks into the log for them.
        import traceback
        exc = sys.exception()
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        print(f"--- error handling request from {client_address} ---", file=sys.stderr)
        traceback.print_exc()


# --------------------------------------------------------------------------- #
# CLI subcommands
# --------------------------------------------------------------------------- #
def cmd_serve():
    # Wait for keys rather than exiting: under launchd KeepAlive=true a
    # sys.exit(1) here would become a crash-respawn loop.
    keys = load_keys()
    if not keys:
        print(f"!! No keys found in {KEYS_FILE}", file=sys.stderr)
        print("   Waiting for keys (add one NVIDIA key per line)...", file=sys.stderr)
        while not keys:
            time.sleep(30)
            keys = load_keys()

    with state_transaction() as state:
        prune_state(state, keys)

    try:
        server = QuietServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            # Another rotator already owns the port. Exit 0 so bootstrapping
            # launchd next to a manual instance doesn't crash-respawn forever.
            print(f"rotator already listening on {LISTEN_PORT} — nothing to do")
            sys.exit(0)
        raise

    print(f"nvidia-rotator proxy on http://{LISTEN_HOST}:{LISTEN_PORT} "
          f"-> https://{UPSTREAM_HOST}{UPSTREAM_BASE}", flush=True)
    print(f"loaded {len(keys)} key(s) from {KEYS_FILE}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


def _fmt_remaining(until: float) -> str:
    if not until:
        return "available"
    now = _now()
    if until <= now:
        return "available"
    secs = int(until - now)
    h, rem = divmod(secs, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"resets in {h}h{m:02d}m"
    if m:
        return f"resets in {m}m{s:02d}s"
    return f"resets in {s}s"


def _fmt_time(until: float) -> str:
    if not until:
        return "-"
    return datetime.fromtimestamp(until, tz=timezone.utc).strftime("%H:%M:%SZ")


def _fmt_credits(used: int, budget: int) -> str:
    if not budget:
        return "-"
    pct = int(round(100 * used / budget)) if budget else 0
    return f"{used}/{budget} ({pct}%)"


def cmd_status():
    keys = load_keys()
    if not keys:
        print(f"No keys in {KEYS_FILE}")
        return
    budgets = load_key_budgets()
    now = _now()
    state = load_state()  # read-only: the proxy owns state mutation
    print(f"nvidia-rotator status  ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')})")
    print("-" * 108)
    hdr = (f"{'#':>2}  {'key':<16} {'status':<10} {'reqs':>7} {'in_tok':>9} "
           f"{'out_tok':>9} {'credits':>16} {'reset_at':>10}  {'remaining':<16} reason")
    print(hdr)
    print("-" * 108)
    total_req = total_in = total_out = total_err = 0
    avail = 0
    for i, k in enumerate(keys):
        ks = state.get("keys", {}).get(k, _default_key_state())
        until = ks.get("rate_limited_until", 0.0)
        active = not until or until <= now
        if active:
            avail += 1
        status_txt = "ACTIVE" if active else "LIMITED"
        reqs = ks.get("requests", 0)
        intok = ks.get("input_tokens", 0)
        outtok = ks.get("output_tokens", 0)
        total_req += reqs
        total_in += intok
        total_out += outtok
        total_err += ks.get("errors", 0)
        reset_at = _fmt_time(until) if (until and not active) else "-"
        remaining = _fmt_remaining(until if not active else 0.0)
        reason = ks.get("reset_reason", "") if not active else ""
        credits = _fmt_credits(reqs, budgets.get(k, DEFAULT_BUDGET))
        print(f"{i:>2}  {mask(k):<16} {status_txt:<10} {reqs:>7} {intok:>9} {outtok:>9} "
              f"{credits:>16} {reset_at:>10}  {remaining:<16} {reason}")
    print("-" * 108)
    print(f"{'':>2}  {'TOTAL':<16} {'':<10} {total_req:>7} {total_in:>9} {total_out:>9} "
          f"{'':>16} {'errors':>10}  {total_err}")
    print(f"\nproxy: http://{LISTEN_HOST}:{LISTEN_PORT}  state: {STATE_FILE}")
    print(f"available keys: {avail}/{len(keys)}")


def cmd_keys():
    keys = load_keys()
    if not keys:
        print(f"No keys in {KEYS_FILE}")
        return
    for i, k in enumerate(keys):
        print(f"{i}: {mask(k)}")


def cmd_reset(arg):
    keys = load_keys()
    with state_transaction() as state:
        if arg in (None, "all", "*"):
            for k in keys:
                state["keys"][k] = _default_key_state()
            print("reset all keys (limits + counters)")
            return
        try:
            idx = int(arg)
        except ValueError:
            print(f"bad index: {arg}")
            return
        if idx < 0 or idx >= len(keys):
            print(f"index out of range (0..{len(keys)-1})")
            return
        state["keys"][keys[idx]] = _default_key_state()
        print(f"reset key {idx} ({mask(keys[idx])})")


def cmd_test():
    keys = load_keys()
    if not keys:
        print("no keys")
        return
    body = json.dumps({
        "model": TEST_MODEL,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "stream": False,
        "thinking": {"type": "disabled"},
    }).encode()
    for i, k in enumerate(keys):
        conn = http.client.HTTPSConnection(UPSTREAM_HOST, timeout=30)
        try:
            conn.request("POST", "/v1/chat/completions", body=body,
                         headers={"Authorization": f"Bearer {k}",
                                  "Content-Type": "application/json"})
            r = conn.getresponse()
            text = r.read(2000).decode("utf-8", "replace")
            with state_transaction() as state:
                ks = _key_state(state, k)
                ks["last_status"] = str(r.status)
                ks["last_used"] = _now()
            ok = "OK" if r.status == 200 else f"FAIL {r.status}"
            print(f"{i}: {mask(k):<16} {ok}  {text[:120]}", flush=True)
        except Exception as exc:
            print(f"{i}: {mask(k):<16} ERROR {exc}", flush=True)
        finally:
            conn.close()


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "serve"
    if cmd in ("-h", "--help", "help"):
        print(__doc__)
        return
    if cmd == "serve":
        cmd_serve()
    elif cmd == "status":
        cmd_status()
    elif cmd == "keys":
        cmd_keys()
    elif cmd == "reset":
        cmd_reset(args[1] if len(args) > 1 else None)
    elif cmd == "test":
        cmd_test()
    else:
        print(f"unknown command: {cmd}\n")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
