// Render the architecture boards to PNG.
//
//   node docs/architecture/render.mjs            # all six
//   node docs/architecture/render.mjs Main       # one, by file stem
//
// The sources under canvas/ are the exact files published to the Claude
// Design canvas (see docs/ARCHITECTURE.md, "Presentation copies"). Each is a
// Design Component page: an <x-dc> wrapper with a <helmet> for page styles,
// and a support.js the canvas supplies. This script unwraps that -- helmet
// contents into <head>, the wrapper and the component script dropped -- and
// screenshots the board's fixed-size root with the Chromium that Playwright
// already installs for the acceptance suite. Nothing else is needed, and
// the boards are never edited here: change the source, re-run this.
//
// Fonts come from Google Fonts at render time, so an offline render falls
// back to system faces and looks slightly different. The PNGs are written
// at 2x for crisp text; the width and height baked into each board's root
// div are the truth for its size.
import { chromium } from "@playwright/test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const canvasDir = join(here, "canvas");
const outDir = join(here, "boards");
const only = process.argv[2];

const index = JSON.parse(readFileSync(join(canvasDir, "canvas.json"), "utf8"));
const files = index.order.filter((f) => !only || f.startsWith(only));

function standalone(source) {
  const helmet = /<helmet>([\s\S]*?)<\/helmet>/.exec(source)?.[1] ?? "";
  const body = /<x-dc>[\s\S]*?<\/helmet>([\s\S]*?)<\/x-dc>/.exec(source)?.[1] ?? "";
  const title = /<title>([\s\S]*?)<\/title>/.exec(source)?.[1] ?? "board";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${helmet}</head><body>${body}</body></html>`;
}

const browser = await chromium.launch();
try {
  for (const file of files) {
    const board = index.boards[file];
    const page = await browser.newPage({ viewport: { width: board.w, height: board.h }, deviceScaleFactor: 2 });
    await page.setContent(standalone(readFileSync(join(canvasDir, file), "utf8")), { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const out = join(outDir, basename(file, ".dc.html") + ".png");
    await page.screenshot({ path: out, clip: { x: 0, y: 0, width: board.w, height: board.h } });
    console.log(`${file} -> ${out} (${board.w}x${board.h} @2x)`);
    await page.close();
  }
} finally {
  await browser.close();
}
