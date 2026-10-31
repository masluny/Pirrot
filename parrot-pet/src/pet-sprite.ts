/**
 * pet-sprite.ts — the parrot pet + the branch it perches on.
 *
 * Modeled on a scarlet-macaw reference: big pale hooked beak (bone upper / dark
 * lower), a bold yellow wing patch over blue flight feathers, red body, and a
 * long red tail with a blue tip. Square-pixel art; two source rows collapse into
 * one terminal cell via a clean "▀" split (pet-core) so pixels stay crisp.
 * The branch leaves the input box on a natural diagonal (no 90° elbow).
 */

import type { Palette } from "./pet-core.ts";

export type Theme = { name: string; blurb: string; palette: Palette };

const BARK = { N: [158, 114, 70], m: [124, 86, 52], n: [80, 54, 32] } as const;
const LEAF = { G: [96, 168, 78], g: [52, 112, 54], L: [150, 205, 110] } as const;
// macaw beak: bone-white upper mandible, near-black lower — same for every theme
const BEAK = { O: [234, 226, 202], o: [52, 48, 52] } as const;

function theme(name: string, blurb: string, bird: Palette): Theme {
	return { name, blurb, palette: { ...bird, ...BARK, ...LEAF, ...BEAK } as Palette };
}

// bird keys: R body  r shade  W cheek/eye-ring  w lid  K pupil
//            y wing-patch  B blue feathers  b blue shade  f feet
export const THEMES: Theme[] = [
	theme("scarlet", "scarlet macaw — yellow-and-blue wing", {
		R: [220, 54, 60], r: [156, 30, 42], W: [248, 246, 240], w: [206, 198, 188],
		K: [24, 20, 28], y: [246, 202, 54], B: [64, 120, 214], b: [40, 82, 158],
		f: [235, 180, 58],
	}),
	theme("hyacinth", "hyacinth macaw — cobalt + gold", {
		R: [54, 92, 220], r: [32, 54, 148], W: [246, 206, 92], w: [200, 166, 74],
		K: [18, 16, 28], y: [244, 206, 88], B: [120, 176, 250], b: [70, 118, 210],
		f: [235, 180, 58],
	}),
	theme("galah", "galah — rose-pink + grey", {
		R: [238, 112, 148], r: [176, 62, 98], W: [250, 232, 236], w: [214, 188, 196],
		K: [28, 22, 32], y: [236, 226, 198], B: [150, 156, 168], b: [110, 118, 132],
		f: [235, 190, 90],
	}),
	theme("synthwave", "synthwave — magenta + cyan", {
		R: [236, 66, 162], r: [160, 32, 120], W: [242, 232, 252], w: [200, 186, 228],
		K: [18, 10, 32], y: [240, 210, 120], B: [120, 120, 250], b: [96, 56, 198],
		f: [240, 210, 90],
	}),
];

// ---- the bird, facing right (one char = one square pixel), 15 rows tall -----//
// Curvy silhouette (not a rectangle): rounded crown, a neck tuck, a chest/belly
// that bulges forward, then tapers into the rump. Eye lives in cell-pair (2,3)
// and the wing bands in pairs (8,9)/(10,11) so both render solid, not as slivers.
// Curvy macaw posture: an S-neck, an arched (convex) back, a breast that curves
// down without jutting forward, and a folded WING shaped like a wing — a rounded
// shoulder tapering to a pointed tip (yellow coverts over blue primaries).
// Eye in cell-pair (2,3); wing bands stay mostly within pairs, and the tapered
// edges deliberately fall on half-cells so they read as diagonals, not steps.
// The detailed macaw: rounded crown, eye in pair (2,3), big pale hooked beak,
// arched back, folded wing (yellow coverts -> pointed blue tip), + small yellow
// legs (row 11). Same bird as before; the whole scene is just narrower now.
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

// tail — a separate RED element hanging behind the branch (static, doesn't move)
const TAIL: string[] = ["RRr", "Rrr", "rrr", "rr.", "r.."];

// ---- animation variants (small local edits) --------------------------------//
function setAt(row: string, i: number, s: string): string {
	return row.slice(0, i) + s + row.slice(i + s.length);
}
function blink(g: string[]): string[] {
	const o = g.slice();
	o[2] = setAt(o[2], 3, "RR"); // eye closes...
	o[3] = setAt(o[3], 3, "KK"); // ...to a dark lid line
	return o;
}

// ---- scene: stamp bird → tail → branch -------------------------------------//
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
	if (y >= 0 && y < CANVAS_H && x >= 0 && x < CANVAS_W) c[y][x] = ch;
}
function stamp(c: string[][], grid: string[], x0: number, y0: number): void {
	for (let y = 0; y < grid.length; y++)
		for (let x = 0; x < grid[y].length; x++)
			if (grid[y][x] !== ".") put(c, x0 + x, y0 + y, grid[y][x]);
}

// horizontal limb droops gently to the right; level under the bird.
// The horizontal limb stays LEVEL (no right-side droop). Only the left end
// dips, via the diagonal that reaches down to the input box.
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
			// bridge the stair-step so the diagonal reads as a solid limb
			put(c, x + 1, y, "N");
			put(c, x + 1, y + 1, "n");
		}
	}
	// horizontal limb — level, but a natural bough: thick and sturdy near the base,
	// tapering thinner toward the tip, with a knot and bark grain.
	for (let x = ELBOW_X; x <= LIMB_X1; x++) {
		put(c, x, LIMB_ROW, "N");
		put(c, x, LIMB_ROW + 1, "n");
		if (x <= ELBOW_X + 3) put(c, x, LIMB_ROW - 1, "m"); // sturdier at the base
	}
	// a knot on the bough
	put(c, 16, LIMB_ROW, "m"); put(c, 16, LIMB_ROW - 1, "N"); put(c, 17, LIMB_ROW, "n");
	// bark grain
	for (const x of [10, 13, 20]) put(c, x, LIMB_ROW, "m");
	// taper the last stretch to a thin tip
	put(c, LIMB_X1, LIMB_ROW + 1, ".");
	put(c, LIMB_X1 - 1, LIMB_ROW + 1, ".");
	put(c, LIMB_X1, LIMB_ROW, "m");

	// leaf sprigs (kept clear of the bird box, cols ~8-19)
	leafCluster(c, 3, LIMB_ROW - 2);
	stamp(c, ["gG", "GG", ".g"], 21, LIMB_ROW - 3); // a leafy twig sprouting up
	stamp(c, ["Gg"], 24, LIMB_ROW - 1);
}

const BIRD_W = 12; // bird grid width (used to mirror the tail to the far side)
const TAIL_W = 3;
const TAIL_DX = 2; // right-facing tail offset from the bird's left edge

// Facing left = the whole bird mirrored (beak + gaze point left, wing/tail swap
// to the correct anatomical side). Used by the "walking" animation.
function mirror(grid: string[]): string[] {
	return grid.map((row) => row.split("").reverse().join(""));
}

// dx shifts the bird along the branch; face flips it to look the way it walks.
export function buildScene(bird: string[], tail: string[], dx = 0, face: "R" | "L" = "R"): string[] {
	const c = blank();
	const bx = BIRD_X + dx;
	// tail first (behind the bird so the legs stay visible), then bird, then branch
	if (face === "L") {
		stamp(c, mirror(tail), bx + (BIRD_W - TAIL_DX - TAIL_W), LIMB_ROW - 1); // tail on the right
		stamp(c, mirror(bird), bx, LIMB_ROW - 1 - (bird.length - 1)); // bird faces left
	} else {
		stamp(c, tail, bx + TAIL_DX, LIMB_ROW - 1);
		stamp(c, bird, bx, LIMB_ROW - 1 - (bird.length - 1));
	}
	drawBranch(c); // branch last, so the limb occludes the tail's middle
	return c.map((row) => row.join(""));
}

export function idleFrames(): string[][] {
	// only the eye blinks; everything else stays put
	return [
		buildScene(BIRD, TAIL), // 0 idle
		buildScene(BIRD, TAIL), // 1 idle
		buildScene(blink(BIRD), TAIL), // 2 blink
		buildScene(BIRD, TAIL), // 3 idle
	];
}

// Walking patrol (shown while the model is working): steps right facing right,
// turns at the end, steps left facing left, turns, repeat.
const WALK: Array<{ dx: number; face: "R" | "L" }> = [
	{ dx: 0, face: "R" }, { dx: 1, face: "R" }, { dx: 2, face: "R" }, { dx: 3, face: "R" },
	{ dx: 3, face: "L" }, { dx: 2, face: "L" }, { dx: 1, face: "L" }, { dx: 0, face: "L" }, { dx: -1, face: "L" }, { dx: -2, face: "L" },
	{ dx: -2, face: "R" }, { dx: -1, face: "R" },
];
export function walkFrames(): string[][] {
	return WALK.map((w) => buildScene(BIRD, TAIL, w.dx, w.face));
}
