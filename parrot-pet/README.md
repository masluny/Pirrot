# parrot-pet workshop

Design sources for the macaw. The shipped extension is `../extensions/parrot-pet.ts`, which is self-contained (it inlines its own sprite + renderer), so nothing here is needed at runtime.

- `src/pet-core.ts` renders a palette grid to terminal cells; `src/pet-sprite.ts` holds the sprite, morphs and scene.
- `src/pet-sprite.v*.ts` are earlier iterations of the bird, kept for reference; `preview/*.png` are screenshots of each.
- `footer.ts.corner-layout` is an older footer variant from before the stats moved under the input box.

Preview loop (Node 22+, runs the `.ts` files directly):

```bash
npm run preview          # all frames x all morphs -> preview/preview.html
npm run preview:final    # -> preview/final.html
npm run preview:walk     # walk cycle -> preview/walk.html
npm run preview:zoom     # zoom levels -> preview/zoom.html
```

Screenshot it headless:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --screenshot=out.png --window-size=680,520 "file://$PWD/preview/preview.html"
```
