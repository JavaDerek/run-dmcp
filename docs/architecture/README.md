# Architecture boards

Presentation copies of the six C4 diagrams in [../ARCHITECTURE.md](../ARCHITECTURE.md), one board
per diagram. **That file is the source of truth**; these are pictures of it, and they rot at the
rates its "Presentation copies" section states: component boards first, the container board
next, the context board last. When a board and the Markdown disagree, the Markdown wins.

```
architecture/
├── canvas/      the board sources, exactly as published to the Claude Design canvas
│   ├── canvas.json            the canvas index: board frames, notes, order
│   └── *.dc.html              one Design Component page per board
├── boards/      rendered PNGs at 2x, one per board
└── render.mjs   renders boards/ from canvas/ with Playwright's Chromium
```

| Board | Source | Rendered |
|---|---|---|
| Level 1 · System context | `canvas/Main.dc.html` | `boards/Main.png` |
| Level 2 · Containers | `canvas/L2-Containers.dc.html` | `boards/L2-Containers.png` |
| Level 3.1 · Timeline and persistence core | `canvas/L3-1-Timeline-Core.dc.html` | `boards/L3-1-Timeline-Core.png` |
| Level 3.2 · Core MCP surface | `canvas/L3-2-MCP-Surface.dc.html` | `boards/L3-2-MCP-Surface.png` |
| Level 3.3 · Tabletop layer | `canvas/L3-3-Tabletop.dc.html` | `boards/L3-3-Tabletop.png` |
| Level 3.4 · HTTP server and web viewer | `canvas/L3-4-HTTP-Viewer.dc.html` | `boards/L3-4-HTTP-Viewer.png` |

## Regenerating

```bash
node docs/architecture/render.mjs          # all six
node docs/architecture/render.mjs L3-1     # one, by file stem
```

Uses the Chromium that `npx playwright install chromium` puts in place for the acceptance suite.
Fonts are fetched from Google Fonts at render time; offline, system faces stand in.

## Editing

Edit a source under `canvas/`, re-render, and commit both. The same files are what the live canvas
at <https://claude.ai/artifact/Qu38NzWrAXNvb29i6h83Na> holds, so a change here should be published
there too, or the two copies diverge. Each source is a self-contained page: the `<helmet>` holds
page styles, the fixed-size root `div` is the board, and the diagram is inline SVG with hand-laid
coordinates. `render.mjs` strips the canvas wrapper before screenshotting; nothing else is needed.

Consumers stay anonymous here, as everywhere in this repository outside `DESIGN.md`:
`src/__tests__/engineVocabulary.test.ts` scans these files too.
