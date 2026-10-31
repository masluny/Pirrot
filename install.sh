#!/usr/bin/env bash
# Pirrot installer — parrot pet + NVIDIA multikey rotator for the pi coding agent.
#
#   ./install.sh                 install everything
#   ./install.sh --no-service    skip the macOS launchd service for the rotator
#   ./install.sh --pet-only      only the parrot pet + footer extensions
#   BIN_DIR=~/bin ./install.sh   where to put the pi-nvidia / multikey-status commands
#
# Existing files that would be overwritten are backed up as <file>.bak.<timestamp>.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
PI="$HOME/.pi"
EXT="$PI/agent/extensions"
STAMP="$(date +%Y%m%d-%H%M%S)"
SERVICE=1
MULTIKEY=1

for arg in "$@"; do
	case "$arg" in
		--no-service) SERVICE=0 ;;
		--pet-only) MULTIKEY=0; SERVICE=0 ;;
		-h|--help) sed -n '2,9p' "$0"; exit 0 ;;
		*) echo "unknown option: $arg" >&2; exit 1 ;;
	esac
done

say() { printf '\033[1;31m🦜\033[0m %s\n' "$*"; }

install_file() { # src dest [mode]
	local src="$1" dest="$2" mode="${3:-644}"
	if [[ -e "$dest" ]] && ! cmp -s "$src" "$dest"; then
		cp "$dest" "$dest.bak.$STAMP"
		say "backed up $dest -> $dest.bak.$STAMP"
	fi
	install -m "$mode" "$src" "$dest"
}

mkdir -p "$EXT"

say "installing extensions into $EXT"
install_file "$REPO/extensions/parrot-pet.ts" "$EXT/parrot-pet.ts"
install_file "$REPO/extensions/footer.ts" "$EXT/footer.ts"

if [[ $MULTIKEY == 1 ]]; then
	command -v python3 >/dev/null || { echo "python3 (3.11+) is required for the rotator" >&2; exit 1; }
	PYTHON="$(command -v python3)"

	install_file "$REPO/extensions/multikey.ts" "$EXT/multikey.ts"

	say "installing the rotator into $PI"
	install_file "$REPO/multikey/nvidia-rotator.py" "$PI/nvidia-rotator.py" 755
	install_file "$REPO/multikey/multikey-status" "$PI/multikey-status" 755

	if [[ ! -e "$PI/nvidia_keys.txt" ]]; then
		install -m 600 "$REPO/multikey/nvidia_keys.example.txt" "$PI/nvidia_keys.txt"
		say "created $PI/nvidia_keys.txt — add your NVIDIA keys there"
	fi

	if [[ -n "${BIN_DIR:-}" ]]; then
		BIN="$BIN_DIR"
	elif [[ -w /opt/homebrew/bin ]]; then
		BIN=/opt/homebrew/bin
	else
		BIN="$HOME/.local/bin"
	fi
	mkdir -p "$BIN"
	install_file "$REPO/multikey/pi-nvidia" "$BIN/pi-nvidia" 755
	ln -sf "$PI/multikey-status" "$BIN/multikey-status"
	say "CLI: $BIN/pi-nvidia, $BIN/multikey-status"
	[[ ":$PATH:" == *":$BIN:"* ]] || say "note: $BIN is not on your PATH"

	say "registering the nvidia-multikey provider in $PI/agent/models.json"
	"$PYTHON" - "$PI/agent/models.json" "$REPO/multikey/models.example.json" <<'PY'
import json, os, sys
dest, example = sys.argv[1], sys.argv[2]
cfg = {"providers": {}}
if os.path.exists(dest):
    with open(dest) as fh:
        cfg = json.load(fh)
cfg.setdefault("providers", {})
if "nvidia-multikey" not in cfg["providers"]:
    with open(example) as fh:
        cfg["providers"]["nvidia-multikey"] = json.load(fh)["providers"]["nvidia-multikey"]
    with open(dest, "w") as fh:
        json.dump(cfg, fh, indent=2)
        fh.write("\n")
    print("   added nvidia-multikey provider")
else:
    print("   nvidia-multikey provider already present, left as-is")
PY

	if [[ $SERVICE == 1 && "$(uname)" == "Darwin" ]]; then
		PLIST="$HOME/Library/LaunchAgents/com.pi.nvidia-rotator.plist"
		mkdir -p "$(dirname "$PLIST")"
		TMP="$(mktemp)"
		sed -e "s#__PYTHON__#$PYTHON#g" -e "s#__HOME__#$HOME#g" \
			"$REPO/multikey/com.pi.nvidia-rotator.plist.template" > "$TMP"
		install_file "$TMP" "$PLIST"
		rm -f "$TMP"
		launchctl bootout "gui/$(id -u)/com.pi.nvidia-rotator" 2>/dev/null || true
		launchctl bootstrap "gui/$(id -u)" "$PLIST"
		say "rotator running as launchd service com.pi.nvidia-rotator (log: $PI/rotator.log)"
	elif [[ $MULTIKEY == 1 ]]; then
		say "start the rotator yourself with: pi-nvidia serve"
	fi
fi

say "done. Start pi (or /reload). Try /pet, /multikey, /multikey-model 🏴‍☠️"
