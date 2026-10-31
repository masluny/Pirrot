/**
 * multikey.ts — quality-of-life glue for the NVIDIA multikey rotator setup.
 *
 * 1. Auto-continue on output-token truncation.
 *    When a response stops with stopReason === "length" (the request's
 *    max_tokens was reached), pi normally halts with:
 *      "Error: Model stopped because it reached the maximum output token limit."
 *    Rotating API keys can't fix that — it's a per-request cap, not a key
 *    quota — so instead we automatically ask the model to continue where it
 *    was cut off (max 5 times in a row, to avoid infinite loops).
 *
 * 2. /multikey — show rotator key status (reads ~/.pi/nvidia_keys_state.json).
 *
 * Auto-discovered from ~/.pi/agent/extensions/. Hot-reload with /reload.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEYS_FILE = join(homedir(), ".pi", "nvidia_keys.txt");
const STATE_FILE = join(homedir(), ".pi", "nvidia_keys_state.json");
const PROVIDER = "nvidia-multikey";
const MAX_AUTO_CONTINUES = 5;
const DEFAULT_BUDGET = 1000;

/**
 * Shared parse rule with the rotator: the first whitespace token is the key,
 * an optional `budget=N` token overrides DEFAULT_BUDGET. State is keyed by the
 * bare key string, so this must return the same key the proxy stores.
 */
function parseKeyLines(text: string): { key: string; budget: number }[] {
	const out: { key: string; budget: number }[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const parts = line.split(/\s+/);
		let budget = DEFAULT_BUDGET;
		for (const tok of parts.slice(1)) {
			if (tok.startsWith("budget=")) {
				const n = Number.parseInt(tok.slice("budget=".length), 10);
				if (!Number.isNaN(n)) budget = n;
			}
		}
		out.push({ key: parts[0], budget });
	}
	return out;
}

const CONTINUE_PROMPT =
	"[auto-continue] Your previous response was cut off by the output token limit. " +
	"Continue exactly where you left off. Do not repeat content you already produced. " +
	"If you were in the middle of a tool call, redo that tool call completely.";

function mask(key: string): string {
	return key.length > 10 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "***";
}

function fmtRemaining(until: number, now: number): string {
	const secs = Math.max(0, Math.floor(until - now));
	const h = Math.floor(secs / 3600);
	const m = Math.floor((secs % 3600) / 60);
	const s = secs % 60;
	if (h) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

export default function (pi: ExtensionAPI): void {
	let autoContinues = 0;

	// Reset the loop guard whenever input comes from somewhere other than this
	// extension. event.source is "interactive" | "rpc" | "extension"; matching
	// on it is robust to the prompt text changing (the "[auto-continue]" prefix
	// is kept in the prompt purely for the model's benefit).
	pi.on("input", async (event) => {
		if ((event as { source?: string }).source !== "extension") {
			autoContinues = 0;
		}
		return { action: "continue" };
	});

	pi.on("agent_end", async (event, ctx) => {
		const lastAssistant = [...event.messages]
			.reverse()
			.find((m) => m.role === "assistant") as { stopReason?: string } | undefined;
		if (!lastAssistant || lastAssistant.stopReason !== "length") {
			autoContinues = 0;
			return;
		}
		if (autoContinues >= MAX_AUTO_CONTINUES) {
			if (ctx.mode === "tui") {
				ctx.ui.notify(
					`Output limit hit ${MAX_AUTO_CONTINUES}x in a row — stopping auto-continue. ` +
						"Consider raising maxTokens in ~/.pi/agent/models.json.",
					"warning",
				);
			}
			return;
		}
		autoContinues++;
		if (ctx.mode === "tui") {
			ctx.ui.notify(
				`Output token limit hit — auto-continuing (${autoContinues}/${MAX_AUTO_CONTINUES})`,
				"info",
			);
		}
		pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
	});

	pi.registerCommand("multikey", {
		description: "Show NVIDIA multikey rotator status (keys, usage, limits)",
		handler: async (_args, ctx) => {
			const emit = (text: string, level: "info" | "warning" | "error") => {
				// Align with the agent_end handler: only notify in TUI mode; fall
				// back to console elsewhere so the command never throws headless.
				if (ctx.mode === "tui") ctx.ui.notify(text, level);
				else console.log(text);
			};
			if (!existsSync(KEYS_FILE)) {
				emit(`No keys file at ${KEYS_FILE}`, "error");
				return;
			}
			const entries = parseKeyLines(readFileSync(KEYS_FILE, "utf-8"));
			let state: { keys?: Record<string, any> } = {};
			try {
				state = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
			} catch {
				// no state yet — proxy hasn't served a request
			}
			const now = Date.now() / 1000;
			let available = 0;
			const lines = entries.map(({ key: k, budget }, i) => {
				const ks = state.keys?.[k] ?? {};
				const until = ks.rate_limited_until ?? 0;
				const active = !until || until <= now;
				if (active) available++;
				const status = active ? "ACTIVE " : `LIMITED ${fmtRemaining(until, now)}`;
				const reqs = ks.requests ?? 0;
				const inTok = ks.input_tokens ?? 0;
				const outTok = ks.output_tokens ?? 0;
				const credits = budget
					? `  ${reqs}/${budget} (${Math.round((100 * reqs) / budget)}%)`
					: "";
				return `${i}: ${mask(k)}  ${status}  reqs ${reqs}  ↑${inTok} ↓${outTok}${credits}`;
			});
			emit(
				`multikey: ${available}/${entries.length} keys available\n${lines.join("\n")}`,
				available > 0 ? "info" : "warning",
			);
		},
	});

	// ---- /multikey-model — switch the NVIDIA model used by the rotator ----

	/** Curated catalog of NVIDIA-hosted chat/reasoning models worth using. */
	interface ModelSpec {
		id: string;
		label: string;
		reasoning: boolean;
		contextWindow: number;
		maxTokens: number;
		compat: {
			thinkingFormat?: string;
			supportsReasoningEffort?: boolean;
			maxTokensField?: string;
		};
		thinkingLevelMap?: Record<string, string | null>;
	}

	const NVIDIA_MODELS: ModelSpec[] = [
		// ── Reasoning models ────────────────────────────────────────────
		{
			id: "moonshotai/kimi-k3",
			label: "Kimi K3 (Moonshot)",
			reasoning: true,
			contextWindow: 1048576,
			maxTokens: 131072,
			compat: { maxTokensField: "max_tokens" },
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
		},
		{
			id: "moonshotai/kimi-k2.6",
			label: "Kimi K2.6 (Moonshot)",
			reasoning: true,
			contextWindow: 262144,
			maxTokens: 262144,
			compat: { maxTokensField: "max_tokens" },
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
		},
		{
			id: "deepseek-ai/deepseek-v4-pro-0813",
			label: "DeepSeek V4 Pro",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false, maxTokensField: "max_tokens" },
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
		},
		{
			id: "deepseek-ai/deepseek-v4-flash-0731",
			label: "DeepSeek V4 Flash",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false, maxTokensField: "max_tokens" },
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
		},
		{
			id: "nvidia/nemotron-3-ultra-550b-a55b",
			label: "Nemotron 3 Ultra 550B",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 65536,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "nvidia/nemotron-3-super-120b-a12b",
			label: "Nemotron 3 Super 120B",
			reasoning: true,
			contextWindow: 262144,
			maxTokens: 262144,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "nvidia/nemotron-3.5-lightning-30b-a3b",
			label: "Nemotron 3.5 Lightning 30B",
			reasoning: true,
			contextWindow: 262144,
			maxTokens: 262144,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
			label: "Nemotron 3 Nano Omni 30B",
			reasoning: true,
			contextWindow: 256000,
			maxTokens: 65536,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
			label: "Llama 3.1 Nemotron Ultra 253B",
			reasoning: true,
			contextWindow: 128000,
			maxTokens: 16384,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "meta/muse-glimmer-30b",
			label: "Muse Glimmer 30B (Meta)",
			reasoning: true,
			contextWindow: 131072,
			maxTokens: 131072,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "nvidia/cosmos-reason2-8b",
			label: "Cosmos Reason2 8B",
			reasoning: true,
			contextWindow: 131072,
			maxTokens: 16384,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "minimaxai/minimax-m3",
			label: "MiniMax M3",
			reasoning: true,
			contextWindow: 1000000,
			maxTokens: 16384,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "openai/gpt-oss-120b",
			label: "GPT-OSS 120B (OpenAI)",
			reasoning: true,
			contextWindow: 128000,
			maxTokens: 8192,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "openai/gpt-oss-20b",
			label: "GPT-OSS 20B (OpenAI)",
			reasoning: true,
			contextWindow: 131072,
			maxTokens: 32768,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "poolside/laguna-xs-2.1",
			label: "Laguna XS 2.1 (Poolside)",
			reasoning: true,
			contextWindow: 262144,
			maxTokens: 16384,
			compat: { maxTokensField: "max_tokens" },
		},
		// ── Non-reasoning models ────────────────────────────────────────
		{
			id: "nvidia/llama-3.1-nemotron-70b-instruct",
			label: "Llama 3.1 Nemotron 70B",
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 8192,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "mistralai/mistral-nemotron",
			label: "Mistral Nemotron",
			reasoning: false,
			contextWindow: 131072,
			maxTokens: 32768,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "mistralai/mistral-large-2-instruct",
			label: "Mistral Large 2",
			reasoning: false,
			contextWindow: 131072,
			maxTokens: 16384,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "google/gemma-4-31b-it",
			label: "Gemma 4 31B",
			reasoning: false,
			contextWindow: 131072,
			maxTokens: 16384,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "meta/llama-3.2-90b-vision-instruct",
			label: "Llama 3.2 90B Vision",
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 8192,
			compat: { maxTokensField: "max_tokens" },
		},
		{
			id: "writer/palmyra-creative-122b",
			label: "Palmyra Creative 122B (Writer)",
			reasoning: false,
			contextWindow: 131072,
			maxTokens: 16384,
			compat: { maxTokensField: "max_tokens" },
		},
	];

	const SETTINGS_FILE = join(homedir(), ".pi", "agent", "settings.json");
	const MODELS_FILE = join(homedir(), ".pi", "agent", "models.json");

	pi.registerCommand("multikey-model", {
		description: "Switch the NVIDIA model used by the multikey rotator: /multikey-model [name]",
		handler: async (args, ctx) => {
			const emit = (text: string, level: "info" | "warning" | "error") => {
				if (ctx.mode === "tui") ctx.ui.notify(text, level);
				else console.log(text);
			};

			// Current model from settings
			let currentId = "";
			try {
				const settings = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
				currentId = settings.defaultModel ?? "";
			} catch { /* empty */ }

			let spec: ModelSpec | undefined;
			const arg = (args ?? "").trim().toLowerCase();

			if (!arg) {
				// Interactive selector
				const options = NVIDIA_MODELS.map((m) => {
					const tag = m.reasoning ? " ⚡" : "";
					const cur = m.id === currentId ? " ●" : "";
					return `${m.label}${tag}${cur}`;
				});
				const choice = await ctx.ui.select("Multikey model  (⚡ = reasoning)", options);
				if (!choice) return; // cancelled
				const idx = options.indexOf(choice);
				spec = NVIDIA_MODELS[idx];
			} else {
				// Fuzzy match by label or id
				spec = NVIDIA_MODELS.find(
					(m) =>
						m.id.toLowerCase() === arg ||
						m.label.toLowerCase() === arg ||
						m.id.toLowerCase().includes(arg) ||
						m.label.toLowerCase().includes(arg),
				);
			}

			if (!spec) {
				emit(`Unknown model "${arg}". Use /multikey-model to see the list.`, "error");
				return;
			}

			if (spec.id === currentId) {
				emit(`Already using ${spec.label} (${spec.id})`, "info");
				return;
			}

			// 1) Persist to models.json
			try {
				const modelsJson = existsSync(MODELS_FILE)
					? JSON.parse(readFileSync(MODELS_FILE, "utf-8"))
					: { providers: {} };
				const providerCfg = modelsJson.providers[PROVIDER] ?? {};
				providerCfg.baseUrl = "http://127.0.0.1:8765/v1";
				providerCfg.apiKey = "rotator";
				providerCfg.api = "openai-completions";
				providerCfg.models = [{
					id: spec.id,
					name: "multikey",
					reasoning: spec.reasoning,
					contextWindow: spec.contextWindow,
					maxTokens: spec.maxTokens,
					compat: spec.compat,
					...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
				}];
				modelsJson.providers[PROVIDER] = providerCfg;
				delete modelsJson.providers.nvidia;
				writeFileSync(MODELS_FILE, JSON.stringify(modelsJson, null, 2) + "\n");
			} catch (e) {
				emit(`Failed to write models.json: ${e}`, "error");
				return;
			}

			// 2) Persist to settings.json
			try {
				const settings = existsSync(SETTINGS_FILE)
					? JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"))
					: {};
				settings.defaultProvider = PROVIDER;
				settings.defaultModel = spec.id;
				writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
			} catch (e) {
				emit(`models.json updated but failed to persist settings: ${e}`, "warning");
			}

			// 3) Refresh the model registry from the updated models.json
			ctx.modelRegistry.refresh();

			// 4) Switch the active model live
			const model = ctx.modelRegistry.find(PROVIDER, spec.id);
			if (model) {
				await pi.setModel(model);
			}

			const tag = spec.reasoning ? " (reasoning)" : "";
			emit(`multikey model → ${spec.label}${tag}\n${spec.id}`, "info");
		},
	});
}
