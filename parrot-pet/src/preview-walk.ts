import { writeFileSync } from "node:fs";
import { frameToCells, type Cell, type RGB } from "./pet-core.ts";
import { walkFrames, THEMES } from "./pet-sprite.ts";

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
const strip = walkFrames()
	.map((f, i) => `<div class="frame"><div class="cap">walk ${i}</div><div class="term">${cellsToHtml(frameToCells(f, t.palette))}</div></div>`)
	.join("");

const html = `<!doctype html><meta charset=utf-8><style>
 body{margin:0;background:#12141a;padding:20px;font-family:sans-serif}
 h1{color:#8ab;font-size:14px}
 .term{font-family:Menlo,monospace;font-size:15px;line-height:15px;white-space:pre}
 .ln{height:1em}
 .film{display:flex;flex-wrap:wrap;gap:10px}
 .frame{background:#0d0f14;padding:8px;border-radius:6px}
 .cap{font-size:9px;color:#667;margin-bottom:4px}
</style>
<h1>walking patrol — scarlet (R = facing right, L = facing left)</h1>
<div class="film">${strip}</div>`;
writeFileSync(new URL("../preview/walk.html", import.meta.url), html);
console.log("wrote walk.html");
