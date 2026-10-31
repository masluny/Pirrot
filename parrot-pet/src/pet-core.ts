/**
 * pet-core.ts — shared rendering core for the parrot pet.
 *
 * Source pixels are grouped 2x2 into one terminal cell rendered as a Unicode
 * quadrant block. This is the SAME technique parrot.ts uses, so what the
 * preview harness draws is byte-identical to what pi will draw.
 *
 * A terminal cell is ~2x taller than wide; each quadrant sub-pixel is thus
 * ~1 (wide) x 2 (tall). To keep the art visually square, the sprite is drawn
 * "2 sub-px wide per visual unit".
 */

export type RGB = readonly [number, number, number];
export type Palette = Record<string, RGB>;

// ---- quadrant glyphs: bit layout TL=1 TR=2 BL=4 BR=8 ----------------------//
export const GLYPH_2X2: Record<number, string> = {
	0b0000: " ", 0b0001: "▘", 0b0010: "▝", 0b0011: "▀",
	0b0100: "▖", 0b0101: "▌", 0b0110: "▞", 0b0111: "▙",
	0b1000: "▗", 0b1001: "▚", 0b1010: "▐", 0b1011: "▛",
	0b1100: "▄", 0b1101: "▟", 0b1110: "▜", 0b1111: "█",
};

export type Cell = { glyph: string; fg: RGB | null; bg: RGB | null };

function distSq(a: RGB, b: RGB): number {
	const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
	return dr * dr + dg * dg + db * db;
}

// One 2x2 sub-pixel block -> a single cell {glyph, fg, bg}.
export function cellFor(tl: RGB | null, tr: RGB | null, bl: RGB | null, br: RGB | null): Cell {
	const positions: Array<[RGB | null, number]> = [[tl, 1], [tr, 2], [bl, 4], [br, 8]];
	const filled = positions.filter(([c]) => c !== null) as Array<[RGB, number]>;
	if (filled.length === 0) return { glyph: " ", fg: null, bg: null };

	// Fully opaque: pick the best 2-color split so a cell can show two colors.
	if (filled.length === 4) {
		const uniq: RGB[] = [];
		for (const [c] of filled) if (!uniq.some((u) => u[0] === c[0] && u[1] === c[1] && u[2] === c[2])) uniq.push(c);
		let bestErr = Infinity, bestFg = filled[0][0], bestBg = filled[0][0], bestMask = 0;
		for (const a of uniq) for (const b of uniq) {
			let err = 0, mask = 0;
			for (const [col, bit] of positions) {
				const da = distSq(col!, a), db = distSq(col!, b);
				err += Math.min(da, db);
				if (da <= db) mask |= bit;
			}
			if (err < bestErr) { bestErr = err; bestFg = a; bestBg = b; bestMask = mask; }
		}
		if (bestMask === 0) return { glyph: GLYPH_2X2[0b1111], fg: bestBg, bg: bestFg };
		return { glyph: GLYPH_2X2[bestMask], fg: bestFg, bg: bestBg };
	}

	// Partially transparent: single dominant fg, no bg (keeps transparency).
	const counts = new Map<string, { color: RGB; n: number }>();
	for (const [c] of filled) {
		const k = `${c[0]},${c[1]},${c[2]}`;
		const p = counts.get(k);
		if (p) p.n++; else counts.set(k, { color: c, n: 1 });
	}
	let dom = filled[0][0], domN = -1;
	for (const v of counts.values()) if (v.n > domN) { dom = v.color; domN = v.n; }
	let mask = 0;
	for (const [col, bit] of positions) if (col) mask |= bit;
	return { glyph: GLYPH_2X2[mask], fg: dom, bg: null };
}

// ---- vertical half-block cell: 1 source col wide, 2 source rows tall --------//
// Each cell = two stacked SQUARE pixels: top -> fg, bottom -> bg. Only "▀ ▄ █"
// and space are ever used, so a cell is always a clean horizontal split of two
// solid colors — never a diagonal approximation. That is what keeps the pixels
// crisp instead of "glitchy".
export function cellVHB(top: RGB | null, bottom: RGB | null): Cell {
	if (!top && !bottom) return { glyph: " ", fg: null, bg: null };
	if (top && !bottom) return { glyph: "▀", fg: top, bg: null };
	if (!top && bottom) return { glyph: "▄", fg: bottom, bg: null };
	// both set
	if (top![0] === bottom![0] && top![1] === bottom![1] && top![2] === bottom![2]) {
		return { glyph: "█", fg: top, bg: null };
	}
	return { glyph: "▀", fg: top, bg: bottom };
}

// A frame is an array of equal-length strings of palette keys ('.' = clear).
// Source pixels are square; two rows collapse into one terminal cell.
export function frameToCells(frame: string[], palette: Palette): Cell[][] {
	const h = frame.length;
	const w = Math.max(0, ...frame.map((r) => r.length));
	const px = (x: number, y: number): RGB | null => {
		const ch = frame[y]?.[x] ?? ".";
		return palette[ch] ?? null;
	};
	const rows: Cell[][] = [];
	for (let y = 0; y < h; y += 2) {
		const row: Cell[] = [];
		for (let x = 0; x < w; x++) row.push(cellVHB(px(x, y), px(x, y + 1)));
		rows.push(row);
	}
	return rows;
}

// ---- ANSI output (what the extension emits into the widget) ----------------//
export function cellsToAnsi(rows: Cell[][], opts?: { trimRight?: boolean }): string[] {
	const trim = opts?.trimRight ?? true;
	return rows.map((row) => {
		let last = row.length - 1;
		if (trim) { while (last >= 0 && row[last].glyph === " " && !row[last].bg) last--; }
		let out = "";
		for (let i = 0; i <= last; i++) {
			const c = row[i];
			if (!c.fg && !c.bg) { out += " "; continue; }
			let s = "";
			if (c.fg) s += `\x1b[38;2;${c.fg[0]};${c.fg[1]};${c.fg[2]}m`;
			if (c.bg) s += `\x1b[48;2;${c.bg[0]};${c.bg[1]};${c.bg[2]}m`;
			out += s + c.glyph + "\x1b[0m";
		}
		return out;
	});
}

export function frameToAnsi(frame: string[], palette: Palette): string[] {
	return cellsToAnsi(frameToCells(frame, palette));
}

// ---- zoom-out: downscale a palette grid by `factor` -----------------------//
// Keeps the SAME art but at a smaller pixel resolution (a real "zoom out"). Each
// output pixel is the dominant color of the source box it covers; a box that is
// mostly transparent stays transparent, so the silhouette shrinks cleanly.
export function downscale(grid: string[], factor: number): string[] {
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
			// keep the pixel if the box is at least ~40% covered, else transparent
			row += bestN * 5 >= (total - dot) * 2 && total - dot > 0 && dot * 5 < total * 3 ? best : ".";
		}
		out.push(row);
	}
	return out;
}
