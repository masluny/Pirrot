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
function inputBox(width: number): string {
	const top = "╭" + "─".repeat(width - 2) + "╮";
	const bot = "╰" + "─".repeat(width - 2) + "╯";
	const mid = "│ › ask pi…" + " ".repeat(Math.max(0, width - 11)) + "│";
	return [top, mid, bot].map((l) => `<div class="ln box">${l}</div>`).join("");
}
const t = THEMES[0]!;
const src = idleFrames()[0]!;
const cards = [1.4, 1.6, 1.8].map((z) => {
	const cells = frameToCells(downscale(src, z), t.palette);
	return `<div class="card"><div class="cap">zoom ${z}× · ${cells.length} lines</div><div class="term">${cellsToHtml(cells)}${inputBox(Math.max(...cells.map((r) => r.length)) + 2)}</div></div>`;
}).join("");
const html = `<!doctype html><meta charset=utf-8><style>
 body{margin:0;background:#12141a;padding:20px;font-family:sans-serif}
 h1{color:#8ab;font-size:14px}
 .row{display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap}
 .card{background:#0d0f14;padding:18px;border-radius:10px}
 .cap{font-size:11px;color:#7a8699;margin-bottom:10px}
 .term{font-family:Menlo,monospace;font-size:19px;line-height:19px;white-space:pre}
 .ln{height:1em} .ln.box{color:#59637a}
</style>
<h1>zoomed-out pet above the input box — natural branch</h1>
<div class="row">${cards}</div>`;
writeFileSync(new URL("../preview/final.html", import.meta.url), html);
console.log("wrote final.html");
