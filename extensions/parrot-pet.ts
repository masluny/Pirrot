/**
 * parrot-pet.ts — a pixel scarlet-macaw pet that lives in the bottom-RIGHT corner.
 *
 * It replaces pi's editor with a CustomEditor: the real input box is narrowed to
 * the left, and the macaw (mirror-flipped so its branch grows out of the very
 * corner) is painted into the bottom-right on the same rows, with the token/
 * context stats (↑in ↓out ctx%) sitting just to the left of the branch. The
 * model name + thinking level move to the bottom-left via footer.ts.
 *
 * The bird walks left/right along its branch while the model is working (the
 * only time the editor re-renders for animation — you're not typing then); it
 * stays still while idle. Any render failure falls back to the normal editor, so
 * typing can never break. `/pet off` restores the default editor entirely.
 *
 * Rendering: square-pixel art, two stacked source rows per terminal cell via a
 * vertical half-block ("▀"). `/pet zoom <1–3>` downscales it (1 = full detail).
 *
 * Commands: /pet [on|off] · /pet zoom <n> · /pet theme <name|next> (or /pet <name>).
 * Morphs: scarlet (default), hyacinth, galah, synthwave.
 * Auto-discovered from ~/.pi/agent/extensions/. Hot-reload with /reload.
 * Source + preview harness live in ~/.pi/parrot-pet/.
 */

import type {
	ExtensionAPI,
	ExtensionUIContext,
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";

//..........................................................................//
// palette + sprite                                                          //
//..........................................................................//
type RGB = readonly [number, number, number];
type Palette = Record<string, RGB>;
type Theme = { name: string; blurb: string; palette: Palette };

const BARK = { N: [158, 114, 70], m: [124, 86, 52], n: [80, 54, 32] } as const;
const LEAF = { G: [96, 168, 78], g: [52, 112, 54], L: [150, 205, 110] } as const;
// macaw beak: bone-white upper mandible, near-black lower — same for every morph.
const BEAK = { O: [234, 226, 202], o: [52, 48, 52] } as const;

function makeTheme(name: string, blurb: string, bird: Palette): Theme {
	return { name, blurb, palette: { ...bird, ...BARK, ...LEAF, ...BEAK } as Palette };
}

// bird keys: R body  r shade  W cheek/eye-ring  w lid  K pupil
//            y wing-patch  B blue feathers  b blue shade  f feet
const THEMES: Theme[] = [
	makeTheme("scarlet", "scarlet macaw — yellow-and-blue wing", {
		R: [220, 54, 60], r: [156, 30, 42], W: [248, 246, 240], w: [206, 198, 188],
		K: [24, 20, 28], y: [246, 202, 54], B: [64, 120, 214], b: [40, 82, 158],
		f: [235, 180, 58],
	}),
	makeTheme("hyacinth", "hyacinth macaw — cobalt + gold", {
		R: [54, 92, 220], r: [32, 54, 148], W: [246, 206, 92], w: [200, 166, 74],
		K: [18, 16, 28], y: [244, 206, 88], B: [120, 176, 250], b: [70, 118, 210],
		f: [235, 180, 58],
	}),
	makeTheme("galah", "galah — rose-pink + grey", {
		R: [238, 112, 148], r: [176, 62, 98], W: [250, 232, 236], w: [214, 188, 196],
		K: [28, 22, 32], y: [236, 226, 198], B: [150, 156, 168], b: [110, 118, 132],
		f: [235, 190, 90],
	}),
	makeTheme("synthwave", "synthwave — magenta + cyan", {
		R: [236, 66, 162], r: [160, 32, 120], W: [242, 232, 252], w: [200, 186, 228],
		K: [18, 10, 32], y: [240, 210, 120], B: [120, 120, 250], b: [96, 56, 198],
		f: [240, 210, 90],
	}),
];

// The detailed macaw: rounded crown, eye in pair (2,3), big pale hooked beak,
// arched back, folded wing (yellow coverts -> pointed blue tip), + small yellow
// legs (row 11). Facing right; one char = one square pixel.
const BIRD: string[] = [
	"....RR......", //  0 crest (rounded)
	"..RRRR......", //  1 head top
	".RRWWROOO...", //  2 eye white + pale upper mandible (pairs with row 3)
	".RRWKROOOO..", //  3 eye pupil + upper mandible
	".RRRRoOOO...", //  4 dark mouth corner + mandible (pairs with row 5)
	".RRRRooO....", //  5 lower mandible + hooked tip
	"..RyyRR.....", //  6 neck + wing shoulder
	".RyyyRR.....", //  7 arched back · wing yellow coverts
	".RBBRR......", //  8 wing blue primaries
	".RBRR.......", //  9 wing tip (point) · belly
	"..RRR.......", // 10 belly
	"..f.f.......", // 11 small yellow legs
];

// A separate red tail hanging behind the branch (only shows when there is room
// below the limb; at the current compact height it is tucked behind the bird).
const TAIL: string[] = ["RRr", "Rrr", "rrr", "rr.", "r.."];

function setAt(row: string, i: number, s: string): string {
	return row.slice(0, i) + s + row.slice(i + s.length);
}
// The only motion: the eye closes to a dark lid line.
function blink(g: string[]): string[] {
	const o = g.slice();
	o[2] = setAt(o[2], 3, "RR");
	o[3] = setAt(o[3], 3, "KK");
	return o;
}

//..........................................................................//
// scene: stamp bird → tail → branch                                         //
//..........................................................................//
const CANVAS_W = 27;
const CANVAS_H = 16; // 8 terminal lines (crisp detailed bird — no downscale by default)
const LIMB_ROW = 12; // horizontal limb top (kept LEVEL to the right)
const BIRD_X = 8;
const BASE_X = 1; // where the diagonal meets the input box (bottom-left)
const ELBOW_X = 5; // where the diagonal joins the horizontal limb (steeper rise)
const LIMB_X1 = CANVAS_W - 2;

function blank(): string[][] {
	return Array.from({ length: CANVAS_H }, () => Array<string>(CANVAS_W).fill("."));
}
function put(c: string[][], x: number, y: number, ch: string): void {
	if (y >= 0 && y < CANVAS_H && x >= 0 && x < CANVAS_W) c[y]![x] = ch;
}
function stamp(c: string[][], grid: string[], x0: number, y0: number): void {
	for (let y = 0; y < grid.length; y++)
		for (let x = 0; x < grid[y]!.length; x++)
			if (grid[y]![x] !== ".") put(c, x0 + x, y0 + y, grid[y]![x]!);
}
// The horizontal limb stays LEVEL (no right-side droop). Only the left end dips,
// via the diagonal that reaches down to the input box.
function limbTop(_x: number): number {
	return LIMB_ROW;
}
function leafCluster(c: string[][], x: number, y: number): void {
	stamp(c, [".L", "Gg"], x, y);
}
function drawBranch(c: string[][]): void {
	// diagonal base on the LEFT: the limb dips down to the input box, then levels.
	const baseY = CANVAS_H - 1;
	const steps = ELBOW_X - BASE_X;
	for (let i = 0; i <= steps; i++) {
		const x = BASE_X + i;
		const y = Math.round(baseY - ((baseY - LIMB_ROW) * i) / steps);
		put(c, x, y, "N");
		put(c, x, y + 1, "n");
		if (i < steps) {
			put(c, x + 1, y, "N");
			put(c, x + 1, y + 1, "n");
		}
	}
	// horizontal limb — level, but a natural bough: sturdy near the base, tapering
	// thinner toward the tip, with a knot and bark grain.
	for (let x = ELBOW_X; x <= LIMB_X1; x++) {
		put(c, x, LIMB_ROW, "N");
		put(c, x, LIMB_ROW + 1, "n");
		if (x <= ELBOW_X + 3) put(c, x, LIMB_ROW - 1, "m"); // sturdier at the base
	}
	// a knot on the bough
	put(c, 16, LIMB_ROW, "m");
	put(c, 16, LIMB_ROW - 1, "N");
	put(c, 17, LIMB_ROW, "n");
	// bark grain
	for (const x of [10, 13, 20]) put(c, x, LIMB_ROW, "m");
	// taper the last stretch to a thin tip
	put(c, LIMB_X1, LIMB_ROW + 1, ".");
	put(c, LIMB_X1 - 1, LIMB_ROW + 1, ".");
	put(c, LIMB_X1, LIMB_ROW, "m");
	// leaf sprigs (kept clear of the bird box)
	leafCluster(c, 3, LIMB_ROW - 2);
	stamp(c, ["gG", "GG", ".g"], 21, LIMB_ROW - 3); // a leafy twig sprouting up
	stamp(c, ["Gg"], 24, LIMB_ROW - 1);
}
const BIRD_W = 12; // bird grid width (to mirror the tail to the far side)
const TAIL_W = 3;
const TAIL_DX = 2; // right-facing tail offset from the bird's left edge

// Facing left = the whole bird mirrored (beak + gaze point left; wing and tail
// swap to the correct anatomical side). Used by the walking animation.
function mirror(grid: string[]): string[] {
	return grid.map((row) => row.split("").reverse().join(""));
}

// dx shifts the bird along the branch; face flips it to look the way it walks.
function buildScene(bird: string[], dx = 0, face: "R" | "L" = "R"): string[] {
	const c = blank();
	const bx = BIRD_X + dx;
	// tail first (behind the bird so the legs stay visible), then bird, then branch
	if (face === "L") {
		stamp(c, mirror(TAIL), bx + (BIRD_W - TAIL_DX - TAIL_W), LIMB_ROW - 1); // tail on the right
		stamp(c, mirror(bird), bx, LIMB_ROW - 1 - (bird.length - 1)); // bird faces left
	} else {
		stamp(c, TAIL, bx + TAIL_DX, LIMB_ROW - 1);
		stamp(c, bird, bx, LIMB_ROW - 1 - (bird.length - 1));
	}
	drawBranch(c); // branch last, so the limb occludes the tail's middle
	return c.map((row) => row.join(""));
}

// Walking patrol (while the model works): steps right facing right, turns at the
// end, steps left facing left, turns, repeat.
const WALK: Array<{ dx: number; face: "R" | "L" }> = [
	{ dx: 0, face: "R" }, { dx: 1, face: "R" }, { dx: 2, face: "R" }, { dx: 3, face: "R" },
	{ dx: 3, face: "L" }, { dx: 2, face: "L" }, { dx: 1, face: "L" }, { dx: 0, face: "L" }, { dx: -1, face: "L" }, { dx: -2, face: "L" },
	{ dx: -2, face: "R" }, { dx: -1, face: "R" },
];

//..........................................................................//
// vertical half-block renderer (2 source rows -> 1 cell)                    //
//..........................................................................//
function eq(a: RGB, b: RGB): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
function fg(c: RGB): string {
	return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}
function bg(c: RGB): string {
	return `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`;
}
// One cell = two stacked square pixels: top -> fg, bottom -> bg. Only "▀ ▄ █"
// and space are ever used, so a cell is always a clean split of two solid
// colors — never a diagonal approximation. That keeps the pixels crisp.
function renderScene(scene: string[], palette: Palette): string[] {
	const w = Math.max(0, ...scene.map((r) => r.length));
	const px = (x: number, y: number): RGB | null => palette[scene[y]?.[x] ?? "."] ?? null;
	const lines: string[] = [];
	for (let y = 0; y < scene.length; y += 2) {
		const cells: string[] = [];
		let last = -1;
		for (let x = 0; x < w; x++) {
			const top = px(x, y);
			const bot = px(x, y + 1);
			if (!top && !bot) { cells.push(" "); continue; }
			last = x;
			if (top && bot) {
				cells.push(eq(top, bot) ? `${fg(top)}█\x1b[0m` : `${fg(top)}${bg(bot)}▀\x1b[0m`);
			} else if (top) {
				cells.push(`${fg(top)}▀\x1b[0m`);
			} else {
				cells.push(`${fg(bot!)}▄\x1b[0m`);
			}
		}
		lines.push(cells.slice(0, last + 1).join(""));
	}
	return lines;
}

// Zoom out: downscale a palette grid by `factor` (a real zoom, same art at a
// smaller pixel resolution). Each output pixel is the dominant color of its
// source box; boxes that are mostly transparent stay transparent.
function downscale(grid: string[], factor: number): string[] {
	if (factor <= 1) return grid;
	const srcH = grid.length;
	const srcW = Math.max(0, ...grid.map((r) => r.length));
	const outH = Math.max(1, Math.round(srcH / factor));
	const outW = Math.max(1, Math.round(srcW / factor));
	const at = (x: number, y: number): string => grid[y]?.[x] ?? ".";
	const out: string[] = [];
	for (let oy = 0; oy < outH; oy++) {
		const y0 = Math.floor((oy * srcH) / outH);
		const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * srcH) / outH));
		let row = "";
		for (let ox = 0; ox < outW; ox++) {
			const x0 = Math.floor((ox * srcW) / outW);
			const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * srcW) / outW));
			const counts = new Map<string, number>();
			let total = 0;
			for (let y = y0; y < y1; y++)
				for (let x = x0; x < x1; x++) {
					const ch = at(x, y);
					counts.set(ch, (counts.get(ch) ?? 0) + 1);
					total++;
				}
			const dot = counts.get(".") ?? 0;
			let best = ".";
			let bestN = 0;
			for (const [ch, n] of counts) if (ch !== "." && n > bestN) { best = ch; bestN = n; }
			row += bestN * 5 >= (total - dot) * 2 && total - dot > 0 && dot * 5 < total * 3 ? best : ".";
		}
		out.push(row);
	}
	return out;
}

// mirror a palette grid left-right — for the corner, the branch comes from the RIGHT.
function mirrorGrid(grid: string[]): string[] {
	const w = Math.max(0, ...grid.map((r) => r.length));
	return grid.map((r) => r.padEnd(w, ".").split("").reverse().join(""));
}
function padRightVis(s: string, w: number): string {
	return s + " ".repeat(Math.max(0, w - visibleWidth(s.split(CURSOR_MARKER).join(""))));
}
function padLeftVis(s: string, w: number): string {
	return " ".repeat(Math.max(0, w - visibleWidth(s))) + s;
}

type RightContent = { bird: string[]; birdW: number };

// Custom editor: narrows the real input to the left and paints the mirrored macaw
// (plus token stats just to its left) into the bottom-right corner, same rows.
// Any failure falls back to the normal editor so typing can never break.
class CornerEditor extends CustomEditor {
	private readonly getRight: () => RightContent;
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getRight: () => RightContent,
	) {
		super(tui, theme, keybindings);
		this.getRight = getRight;
	}
	render(width: number): string[] {
		try {
			const { bird, birdW } = this.getRight();
			const gap = 2;
			if (!bird.length || width < birdW + gap + 28) return super.render(width);
			const inW = Math.max(24, width - birdW - gap);
			const input = super.render(inW); // input box at reduced width (carries CURSOR_MARKER)
			const birdH = bird.length;
			// Keep the whole editor/footer/pet cluster visually docked to the bottom.
			// Without a fixed editor block, transient UI states can change the editor
			// height and make the entire bottom stack jump upward.
			const H = birdH;
			const visibleInput = input.slice(-H);
			const inputH = visibleInput.length;
			const out: string[] = [];
			for (let i = 0; i < H; i++) {
				const inIdx = i - (H - inputH);
				const left = inIdx >= 0 ? padRightVis(visibleInput[inIdx]!, inW) : " ".repeat(inW);
				const bIdx = i - (H - birdH);
				out.push(left + " ".repeat(gap) + (bIdx >= 0 ? bird[bIdx]! : ""));
			}
			return out;
		} catch {
			return super.render(width);
		}
	}
}

//..........................................................................//
// extension                                                                 //
//..........................................................................//
export default function (pi: ExtensionAPI): void {
	let ctx: ExtensionContext | null = null;
	let tui: TUI | null = null;
	let enabled = true;
	let streaming = false;
	let theme = THEMES[0]!;
	let zoom = 1;

	let idleFrame: string[] = [];
	let walkFrames: string[][] = [];
	let birdW = 0;
	let walkIdx = 0;
	let walkTimer: ReturnType<typeof setInterval> | null = null;

	const cornerLines = (grid: string[]): string[] =>
		renderScene(mirrorGrid(downscale(grid, zoom)), theme.palette);

	const rebuild = (): void => {
		idleFrame = cornerLines(buildScene(BIRD));
		walkFrames = WALK.map((w) => cornerLines(buildScene(BIRD, w.dx, w.face)));
		birdW = Math.max(0, ...idleFrame.map((l) => visibleWidth(l)));
	};

	const getRight = (): RightContent => {
		if (!enabled) return { bird: [], birdW: 0 };
		const bird = streaming && walkFrames.length ? walkFrames[walkIdx % walkFrames.length]! : idleFrame;
		return { bird, birdW };
	};

	const refresh = (): void => tui?.requestRender();

	const startWalk = (): void => {
		if (walkTimer) clearInterval(walkTimer);
		walkIdx = 0;
		walkTimer = setInterval(() => {
			if (!enabled || !streaming) return;
			walkIdx++;
			refresh();
		}, 320);
	};
	const stopWalk = (): void => {
		if (walkTimer) clearInterval(walkTimer);
		walkTimer = null;
		refresh();
	};

	const installEditor = (): void => {
		ctx?.ui.setEditorComponent((t, th, kb) => {
			tui = t;
			return new CornerEditor(t, th, kb, getRight);
		});
	};

	pi.on("session_start", async (_e, c) => {
		if (c.mode !== "tui") return;
		ctx = c;
		rebuild();
		if (enabled) installEditor();
	});
	pi.on("agent_start", async (_e, c) => {
		if (c.mode !== "tui") return;
		streaming = true;
		if (enabled) startWalk();
	});
	pi.on("agent_end", async (_e, c) => {
		streaming = false;
		if (c.mode === "tui") stopWalk();
	});
	pi.on("session_shutdown", async () => {
		if (walkTimer) clearInterval(walkTimer);
		ctx?.ui.setEditorComponent(undefined);
	});

	const findTheme = (name: string): Theme | undefined =>
		THEMES.find((t) => t.name === name) ?? THEMES.find((t) => t.name.startsWith(name));

	pi.registerCommand("pet", {
		description: "The corner macaw. /pet on|off | zoom <n> | theme <name|next>.",
		handler: async (args, c) => {
			if (c.mode !== "tui") {
				c.ui.notify("The pet only perches in interactive mode 🦜", "info");
				return;
			}
			ctx = c;
			const arg = (args ?? "").trim().toLowerCase();
			const notify = (m: string) => c.ui.notify(m, "info");

			if (arg === "" || arg === "on" || arg === "off" || arg === "toggle") {
				enabled = arg === "on" ? true : arg === "off" ? false : !enabled;
				if (enabled) {
					installEditor();
					notify("The macaw is perched 🦜");
				} else {
					stopWalk();
					c.ui.setEditorComponent(undefined);
					notify("The macaw flew off 🦜");
				}
				refresh();
				return;
			}
			if (arg === "zoom" || arg.startsWith("zoom ")) {
				const v = parseFloat(arg.split(/\s+/)[1] ?? "");
				if (!Number.isFinite(v)) {
					notify(`Zoom is ${zoom}× — /pet zoom <1–3> (higher = smaller)`);
					return;
				}
				zoom = Math.min(3, Math.max(1, v));
				rebuild();
				refresh();
				notify(`Pet zoom: ${zoom}×`);
				return;
			}
			if (arg === "theme" || arg === "themes") {
				notify(`Morphs: ${THEMES.map((t) => (t === theme ? `[${t.name}]` : t.name)).join(" ")}`);
				return;
			}
			const want = arg.startsWith("theme ") ? arg.slice(6).trim() : arg;
			if (want === "next") {
				theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
				rebuild();
				refresh();
				notify(`Pet morph: ${theme.name}`);
				return;
			}
			const found = findTheme(want);
			if (found) {
				theme = found;
				rebuild();
				refresh();
				notify(`Pet morph: ${theme.name} — ${theme.blurb}`);
				return;
			}
			c.ui.notify("Usage: /pet [on|off|zoom <n>|theme <name|next>]", "warning");
		},
	});
}
