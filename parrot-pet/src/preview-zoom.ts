import { writeFileSync } from "node:fs";
import { frameToCells, downscale, type Cell, type RGB } from "./pet-core.ts";
import { idleFrames, THEMES } from "./pet-sprite.ts";

const rgb = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
function cellsToHtml(rows: Cell[][]): string {
	return rows.map((row) => {
		let last = row.length - 1;
		while (last >= 0 && row[last].glyph === " " && !row[last].bg) last--;
		let line = "";
		for (let i = 0; i <= last; i++) {
			const c = row[i];
			if (!c.fg && !c.bg) { line += "&nbsp;"; continue; }
			line += `<span style="color:${c.fg ? rgb(c.fg) : "transparent"};${c.bg ? `background:${rgb(c.bg)};` : ""}">${c.glyph}</span>`;
		}
		return `<div class="ln">${line || "&nbsp;"}</div>`;
	}).join("");
}
const t = THEMES[0]!;
const src = idleFrames()[0]!;
const zooms = [1, 1.3, 1.5, 1.8, 2.2];
const cards = zooms.map((z) => {
	const g = downscale(src, z);
	const cells = frameToCells(g, t.palette);
	return `<div class="card"><div class="cap">zoom ${z}× — ${cells.length} lines</div><div class="term">${cellsToHtml(cells)}</div></div>`;
}).join("");

const html = `<!doctype html><meta charset=utf-8><style>
 body{margin:0;background:#12141a;padding:20px;font-family:sans-serif}
 h1{color:#8ab;font-size:14px}
 .row{display:flex;gap:20px;align-items:flex-end;flex-wrap:wrap}
 .card{background:#0d0f14;padding:14px;border-radius:8px}
 .cap{font-size:11px;color:#7a8699;margin-bottom:8px}
 .term{font-family:Menlo,monospace;font-size:16px;line-height:16px;white-space:pre}
 .ln{height:1em}
</style>
<h1>zoom-out comparison — same detailed macaw, downscaled</h1>
<div class="row">${cards}</div>`;
writeFileSync(new URL("../preview/zoom.html", import.meta.url), html);
console.log("wrote zoom.html");
