/**
 * emit-widget2.ts — compact inline preview: ship raw palette-key grids + a
 * per-theme color map, and do the vertical-half-block rendering in the browser.
 */
import { writeFileSync } from "node:fs";
import { THEMES } from "./pet-sprite.ts";
import * as S from "./pet-sprite.ts";

// idleFrames order: [idle, idle, blink, idle]
const PICK = { idle: 0, blink: 2 } as const;

const themes = THEMES.map((t) => {
	const seq = S.idleFrames();
	const pal: Record<string, string> = {};
	for (const [k, v] of Object.entries(t.palette)) pal[k] = `rgb(${(v as number[]).join(",")})`;
	const frames: Record<string, string[]> = {};
	for (const [name, idx] of Object.entries(PICK)) frames[name] = seq[idx];
	return { name: t.name, blurb: t.blurb, pal, frames };
});

const frag = `<style>
  .pw{font-family:-apple-system,system-ui,sans-serif;color:#cbd5e1}
  .pw .bar{display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap}
  .pw .bar button{font:500 13px system-ui;color:#cbd5e1;background:#1b1f2a;border:1px solid #313a4d;border-radius:999px;padding:6px 14px;cursor:pointer}
  .pw .bar button.on{background:#2b3550;border-color:#6b8ccc;color:#fff}
  .pw .screen{background:#0d0f14;border:1px solid #232a38;border-radius:12px;padding:20px}
  .pw canvas{display:block;image-rendering:pixelable;image-rendering:pixelated}
  .pw .cap{font-size:12px;color:#64748b;margin-top:10px}
</style>
<div class="pw">
  <h2 class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden">Animated pixel-art parrot pet perched on a branch above the pi input box.</h2>
  <div class="bar" id="bar"></div>
  <div class="screen"><canvas id="cv" width="640" height="360"></canvas></div>
  <div class="cap" id="cap"></div>
</div>
<script>
(function(){
  var THEMES=${JSON.stringify(themes)};
  var PX=8;               // device px per source pixel (square)
  var GAP_ROWS=2;         // gap between branch and the mock input box
  var cv=document.getElementById('cv'), ctx=cv.getContext('2d');
  var bar=document.getElementById('bar'), cap=document.getElementById('cap');
  var cur=0, queue=[];

  function grid(f){return f.map(function(r){return r.split('');});}
  function drawFrame(theme, name){
    var t=THEMES[theme], f=t.frames[name]||t.frames.idle, g=grid(f);
    var W=0; g.forEach(function(r){if(r.length>W)W=r.length;});
    var H=g.length;
    var boxRows=3, boxTop=H+GAP_ROWS;
    var totalRows=(H+GAP_ROWS+boxRows);
    cv.width=W*PX; cv.height=totalRows*PX;
    ctx.clearRect(0,0,cv.width,cv.height);
    // pixels
    for(var y=0;y<H;y++){var row=g[y];for(var x=0;x<row.length;x++){var ch=row[x];var col=t.pal[ch];if(!col)continue;ctx.fillStyle=col;ctx.fillRect(x*PX,y*PX,PX,PX);}}
    // mock input box (rounded), drawn with strokes to look like pi
    var bx=0.5*PX, by=boxTop*PX, bw=(W-1)*PX, bh=boxRows*PX;
    ctx.strokeStyle='#4a5568'; ctx.lineWidth=Math.max(1,PX*0.18);
    roundRect(bx,by,bw,bh,PX*0.8); ctx.stroke();
    ctx.fillStyle='#5b6472'; ctx.font=(PX*1.7)+'px Menlo, monospace';
    ctx.textBaseline='middle'; ctx.fillText('› ask pi…', bx+PX*1.2, by+bh/2);
  }
  function roundRect(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}

  function tick(){var name=Math.random()<0.10?'blink':'idle';drawFrame(cur,name);}

  THEMES.forEach(function(t,i){var b=document.createElement('button');b.textContent=t.name;if(i===0)b.className='on';b.onclick=function(){cur=i;queue=[];[].forEach.call(bar.children,function(x,j){x.className=j===i?'on':'';});cap.textContent=t.blurb;};bar.appendChild(b);});
  cap.textContent=THEMES[0].blurb;
  tick(); setInterval(tick,260);
})();
</script>`;

writeFileSync(new URL("../preview/widget2.html", import.meta.url), frag);
console.log("bytes", frag.length);
