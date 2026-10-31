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
		f: [150, 150, 156],
	}),
	theme("hyacinth", "hyacinth macaw — cobalt + gold", {
		R: [54, 92, 220], r: [32, 54, 148], W: [246, 206, 92], w: [200, 166, 74],
		K: [18, 16, 28], y: [244, 206, 88], B: [120, 176, 250], b: [70, 118, 210],
		f: [150, 150, 156],
	}),
	theme("galah", "galah — rose-pink + grey", {
		R: [238, 112, 148], r: [176, 62, 98], W: [250, 232, 236], w: [214, 188, 196],
		K: [28, 22, 32], y: [236, 226, 198], B: [150, 156, 168], b: [110, 118, 132],
		f: [176, 150, 150],
	}),
	theme("synthwave", "synthwave — magenta + cyan", {
		R: [236, 66, 162], r: [160, 32, 120], W: [242, 232, 252], w: [200, 186, 228],
		K: [18, 10, 32], y: [240, 210, 120], B: [120, 120, 250], b: [96, 56, 198],
		f: [150, 150, 170],
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
// Scaled down ~20%. Same curvy macaw: rounded crown, S-neck, arched back, folded
// wing (yellow coverts → pointed blue tip), hooked beak. Eye in pair (2,3).
const BIRD: string[] = [
	"....RR......", //  0 crest (rounded)
	"..RRRR......", //  1 head top
	".RRWWROOO...", //  2 eye white + pale upper mandible (pairs with row 3)
	".RRWKROOOO..", //  3 eye pupil + upper mandible
	".RRRRoOOO...", //  4 dark mouth corner + mandible (pairs with row 5)
	".RRRRooO....", //  5 lower mandible + hooked tip
	"..RyyRR.....", //  6 neck + wing shoulder (pairs with row 7)
	".RyyyRR.....", //  7 arched back · wing yellow coverts
	".RBBRR......", //  8 wing blue primaries (pairs with row 9)
	".RBRR.......", //  9 wing tip (point) · belly
	"..RRR.......", // 10 rump (pairs with row 11)
	".f.f........", // 11 feet
];

// tail — a separate RED element hanging behind the branch (static, doesn't move)
const TAIL: string[] = [
	"RRr",
	"Rrr",
	"rrr",
	"rr.",
	"r..",
];

// ---- animation variants (small local edits) --------------------------------//
function setAt(row: string, i: number, s: string): string {
	return row.slice(0, i) + s + row.slice(i + s.length);
}
function blink(g: string[]): string[] {
	const o = g.slice();
	o[2] = setAt(o[2], 4, "RR"); // eye closes...
	o[3] = setAt(o[3], 4, "KK"); // ...to a dark lid line
	return o;
}

// ---- scene: stamp bird → tail → branch -------------------------------------//
const CANVAS_W = 38;
const CANVAS_H = 16; // 8 terminal lines
const LIMB_ROW = 12; // horizontal limb top
const BIRD_X = 13;
const BASE_X = 2; // where the diagonal meets the input box (bottom-left)
const ELBOW_X = 10; // where the diagonal joins the horizontal limb
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
function limbTop(x: number): number {
	if (x <= BIRD_X + 10) return LIMB_ROW;
	if (x <= BIRD_X + 15) return LIMB_ROW + 1;
	return LIMB_ROW + 2;
}

function leafCluster(c: string[][], x: number, y: number, big: boolean): void {
	if (big) stamp(c, ["LG.", "GGg", ".gg"], x, y);
	else stamp(c, [".L", "Gg"], x, y);
}

function drawBranch(c: string[][]): void {
	// diagonal base: a natural angled limb rising out of the input box to the perch
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
		if (i >= steps - 3) put(c, x, y + 2, "n"); // thicker toward the base
	}
	// horizontal limb from the elbow rightward (with the droop)
	for (let x = ELBOW_X; x <= LIMB_X1; x++) {
		const t = limbTop(x);
		put(c, x, t, "N");
		put(c, x, t + 1, "n");
	}
	// bark grain + a knot
	for (const x of [13, 18, 24, 30]) put(c, x, limbTop(x), "m");
	put(c, 26, limbTop(26), "m"); put(c, 27, limbTop(27), "n"); put(c, 26, limbTop(26) + 1, "N");
	// taper the far tip
	put(c, LIMB_X1, limbTop(LIMB_X1) + 1, ".");
	put(c, LIMB_X1, limbTop(LIMB_X1), "m");

	// leaf clusters (kept clear of the bird box, cols ~13-23)
	leafCluster(c, 5, LIMB_ROW - 3, true);
	leafCluster(c, 25, limbTop(25) - 3, true);
	leafCluster(c, 30, limbTop(30) - 2, false);
	leafCluster(c, 34, limbTop(34) - 3, true);
	stamp(c, ["g", "G"], 28, limbTop(28) + 2); // a small hanging sprig
}

export function buildFrame(bird: string[], tail: string[]): string[] {
	const c = blank();
	// bird first...
	stamp(c, bird, BIRD_X, LIMB_ROW - 1 - (bird.length - 1));
	// ...tail next: a separate slim element hanging from the rump...
	stamp(c, tail, BIRD_X + 2, LIMB_ROW - 2);
	// ...branch last, so the limb occludes the tail's middle -> it hangs behind.
	drawBranch(c);
	return c.map((row) => row.join(""));
}

export function idleFrames(): string[][] {
	// only the eye blinks; the tail (and everything else) stays put
	return [
		buildFrame(BIRD, TAIL), // 0 idle
		buildFrame(BIRD, TAIL), // 1 idle
		buildFrame(blink(BIRD), TAIL), // 2 blink
		buildFrame(BIRD, TAIL), // 3 idle
	];
}
