/**
 * preview.ts — render the pet frames to an HTML terminal-grid so a headless
 * Chrome screenshot shows exactly the glyphs/colors pi will draw.
 * Renders every animation frame for every theme + composites over the input box.
 */
import { writeFileSync } from "node:fs";
import { frameToCells, type Cell, type RGB } from "./pet-core.ts";
import { idleFrames, THEMES } from "./pet-sprite.ts";

const rgb = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

function cellsToHtml(rows: Cell[][]): string {
	return rows
		.map((row) => {
			let last = row.length - 1;
			while (last >= 0 && row[last].glyph === " " && !row[last].bg) last--;
			let line = "";
			for (let i = 0; i <= last; i++) {
				const c = row[i];
				const g = c.glyph === " " ? "&nbsp;" : c.glyph;
				const st = `color:${c.fg ? rgb(c.fg) : "transparent"};${c.bg ? `background:${rgb(c.bg)};` : ""}`;
				line += `<span style="${st}">${g}</span>`;
			}
			return `<div class="ln">${line || "&nbsp;"}</div>`;
		})
		.join("");
}

function inputBox(width: number): string {
	const top = "╭" + "─".repeat(width - 2) + "╮";
	const bot = "╰" + "─".repeat(width - 2) + "╯";
	const mid = "│ › type a message…" + " ".repeat(Math.max(0, width - 20)) + "│";
	return [top, mid, bot].map((l) => `<div class="ln box">${l}</div>`).join("");
}

const FRAME_LABELS = ["idle", "idle", "blink", "idle", "tail", "peck", "idle", "flap"];

let sections = "";
for (const theme of THEMES) {
	const frames = idleFrames();
	const strip = frames
		.map((f, i) => `<div class="frame"><div class="cap">${i} ${FRAME_LABELS[i]}</div><div class="term">${cellsToHtml(frameToCells(f, theme.palette))}</div></div>`)
		.join("");
	const composite = `<div class="term big">${cellsToHtml(frameToCells(frames[0], theme.palette))}${inputBox(56)}</div>`;
	sections += `
	  <h2>${theme.name} — ${theme.blurb}</h2>
	  <div class="row">
	    <div class="composite">${composite}</div>
	    <div class="filmstrip">${strip}</div>
	  </div>`;
}

const html = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#12141a;color:#ddd;font-family:-apple-system,sans-serif;padding:24px;}
  h1{font-size:15px;color:#8ab;margin:0 0 10px;}
  h2{font-size:12px;color:#9ab;margin:26px 0 8px;font-weight:700;text-transform:capitalize;}
  .term{font-family:"Menlo","DejaVu Sans Mono",monospace;font-size:15px;line-height:15px;white-space:pre;}
  .term.big{font-size:22px;line-height:22px;}
  .ln{height:1em;} .ln.box{color:#5b6472;}
  .row{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;}
  .composite{background:#0d0f14;padding:16px;border-radius:8px;}
  .filmstrip{display:flex;flex-wrap:wrap;gap:10px;background:#171a21;padding:12px;border-radius:8px;}
  .frame{background:#0d0f14;padding:8px;border-radius:6px;}
  .cap{font-family:sans-serif;font-size:9px;color:#667;margin-bottom:5px;}
</style>
<h1>parrot pet — all frames, all themes (exact terminal glyphs)</h1>
${sections}
`;

const out = new URL("../preview/preview.html", import.meta.url);
writeFileSync(out, html);
console.log("wrote", out.pathname);
