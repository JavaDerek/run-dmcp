# The acceptance suite

Unit tests here prove that a function behaves. This suite proves that the **shipped artifact**
behaves — the built server in `dist/`, the built admin client in `client/dist/`, over real HTTP,
a real browser, and a real MCP stdio connection, in real child processes.

It is deliberately a different question from `npm run test:run`, and it is deliberately kept out of
that runner's way.

## Running it

```bash
npm run test:acceptance        # builds, then runs everything
npm run test:acceptance:only   # runs against whatever is already built (fast iteration)
npm run typecheck:e2e          # type-checks the suite itself
```

First time on a machine, or after a Playwright upgrade:

```bash
npx playwright install chromium
```

Chromium is the only browser this suite needs — one project uses a page, the rest never open one.

Narrower runs:

```bash
npx playwright test --project=api        # the read-only JSON API and its SSE stream
npx playwright test --project=ui         # the built Vue admin client, in a browser
npx playwright test --project=harness    # MCP over stdio: invariants, lifecycle, resolve, render
npx playwright test e2e/specs/mcp-invariants.spec.ts
```

**The build is a prerequisite, not a convenience.** Every helper imports from `../../dist/`, never
`../../src/`, because the point is to accept the artifact a consumer installs. `npm run test:acceptance`
builds for you; `globalSetup` fails fast with an actionable message if `dist/` or `client/dist/` is
missing.

## Hermeticity — what this suite guarantees about your machine

`src/test-setup.ts` gives the unit suite its guarantee by pinning `DMCP_DB_PATH` to `":memory:"`
process-wide. **This suite cannot borrow that**, because half of what it proves is that state
*survives* a process: an HTTP server the specs talk to from outside, a stdio server killed and
started again on the same file. An in-memory database dies with its process by definition.

So the same guarantee is made a second way, in `support/tempDb.ts`:

- **Every database is a fresh `mkdtemp` directory.** `makeTempDb()` is the only way to get one, and
  it hands back an environment with `DMCP_DB_PATH` already set. There is no parameter for "which
  database" and no default that falls through to `data/games.db`.
- **`assertHermetic()` re-checks on the way out**, and the server child re-checks again on the way
  in. A path outside the system temp directory is refused, loudly, rather than opened.
- **The directory matters as much as the file.** `src/db/connection.ts` derives `dataDir` from
  `dirname(dbPath)`, so generated media lands in the temp directory too — not in your repository.
- **Vendor credentials are stripped from every child.** `FORBIDDEN_CHILD_ENV` covers the Anthropic
  and OpenAI key and base-URL variables. Nothing in this suite calls a model, so there is no
  legitimate reason for one to reach a child, and "none of them, ever" is a rule with no exceptions
  to argue about. This is not theoretical: it fired during development against a real key in the
  ambient environment.
- **Ports are always ephemeral.** Servers bind port 0 and report back what they were given.
- **Runs are isolated from each other.** Each run gets `e2e/.tmp/run-<pid>-<random>/`, published to
  workers via `E2E_RUN_DIR`. Two concurrent runs — two developers, two CI jobs, an agent iterating
  while another does — cannot delete each other's handshake or kill each other's server.

Everything the suite writes lives under `e2e/.tmp/`, which is gitignored and safe to delete.

## How a spec finds the server

`globalSetup` spawns `support/serverProcess.ts`, which seeds a database, starts the application's
own HTTP server on port 0, and then publishes a **handshake file** — the bound URL plus every
seeded id — which specs read through `readHandshake()`.

A file, rather than a shared variable, because `globalSetup` and the workers are different
processes; inheriting `process.env` is a rule about process ancestry that would quietly stop being
true the day something is spawned differently. The file is written to a temp name and renamed into
place, so a reader can never observe a half-written one.

Specs assert against **specific seeded ids** from that handshake, never `[0]` of a list and never a
guessed name.

### The control server

`serverProcess.ts` also starts a second, tiny server: `POST /control/log-event` and
`POST /control/create-character`.

**It is not part of the product.** The application's HTTP surface is read-only by design and must
stay that way — `api-readonly.spec.ts` exists to keep it that way. But proving the SSE stream
carries real events needs something to *cause* one, and the emitter is a module-scope singleton, so
the cause has to happen inside the same process. The control server is that side door, living in
`e2e/`, borrowing the product's own writer functions.

## The fixture world

One seeded game, `The Millhouse Ledger`: two connected locations (the mill, the granary), a player
character and one other, a faction, quest, item, note, timer, secret, ability, a logged narrative
event, and the resources that make the invariants testable — a plain `grain`, a bounded
`population`, two conserved treasuries, and a scheduled event carrying an on-expiry consequence.

Vocabulary is **grain, treasury, population** and nothing else. `src/__tests__/engineVocabulary.test.ts`
scans untracked-but-not-ignored files as well as tracked ones, so every file in this directory is in
scope for it — including one you have not committed yet.

## What each spec file proves

### `harness` project — MCP over stdio, no browser

| File | What it proves |
| --- | --- |
| `mcp-invariants.spec.ts` | The three server-enforced invariants, end to end through real `tools/call` against `dist/bin/run-dmcp.js`. A **conserved** set's total holds across several transfers including a zero-amount one; a direct write to a member is refused and the value does not move; a transfer to a non-member is refused. A **bounded** value rejects rather than clamps — and the stored value is read back to prove it did not silently land at the clamp — while the exact boundaries are legal. A **scheduled event's consequence** lands by itself when time crosses its trigger, verified by reading the resource back, not by trusting the response. Also pins that the shipped surface carries no `resolve` or `render_state_at`, by construction. |
| `mcp-lifecycle.spec.ts` | The shipped executable's process lifecycle: state written before a shutdown is still there after a second process opens the same file (quit and resume), `DMCP_NO_HTTP=1` binds no port, and `SIGTERM` exits 0 without leaving the database unreadable. |
| `consumer-resolve.spec.ts` | The resolve protocol, against a server assembled the way a **consumer** assembles one — mechanics injected at construction. `list_mechanics` returns exactly what was injected; an outcome is authoritative against state read back independently; an unknown mechanic and a contradicted expectation are both refused with nothing written; a mechanic that throws mid-adjudication rolls back every change and records no event; and a `resolve_only` value refuses a direct write while moving through `resolve`. |
| `consumer-render.spec.ts` | "Say what is, never what is absent," from outside the engine. Rendered state uses only nouns and adjectives from the vocabulary the harness itself injected; a fact with no vocabulary entry becomes a row in `unnamed` rather than invented text; a fact that does not hold at `t` produces **nothing at all** — checked after first confirming it *did* hold, so the absence means something; earlier and later `t` render their own states; and a vocabulary entry carrying an extra field is refused **at server construction**, before a transport is ever connected. |

### `api` project — the read-only JSON API

| File | What it proves |
| --- | --- |
| `api-handshake.spec.ts` | The infrastructure itself: the handshake exists, its database is inside the temp directory and is not `data/games.db`, the server serves, and the control server answers. |
| `api-routes.spec.ts` | Every GET route in `src/http/server.ts` returns coherent JSON for the seeded game, asserted against specific seeded ids — plus every reachable explicit 404 branch, so a 404 can never pass as "coherent". |
| `api-readonly.spec.ts` | The surface is read-only, in both halves: POST/PUT/PATCH/DELETE against representative routes do not mutate — proven by reading the resource back, because a status code alone proves nothing — and, structurally, `src/http/server.ts` registers no mutating verb at all. The structural half has an anti-vacuity guard, so it cannot pass by matching nothing. |
| `api-sse.spec.ts` | The SSE stream is live: the `connected` frame arrives, a mutation driven through the control server arrives as a frame on an already-open stream, and an unknown game id 404s without opening one. Event-driven throughout — the stream must be open *before* the mutation, because the emitter drops events for a game with no subscribers. |

### `ui` project — the built admin client, in chromium

| File | What it proves |
| --- | --- |
| `client-smoke.spec.ts` | Each core screen renders seeded data, not merely HTTP 200 — home, game, characters, locations, resources, history, and a character's own page — while collecting uncaught page errors and failed requests and asserting there were none. |
| `client-navigation.spec.ts` | Routing as served in production: a **deep link** loads directly (the assertion that proves the server's SPA fallback is wired, and the one a dev-server-only test would miss entirely), in-app navigation moves URL and content together, an unknown client path still returns the shell, and `/api/` is not swallowed by the fallback. |

## A bug this suite found

The deep-link spec failed on a checkout living under `.claude/worktrees/`, with **HTTP 500** on every
client-side route while `/` worked fine.

`res.sendFile(absolutePath)` with no `root` option hands the whole absolute path to `send`, whose
`dotfiles` option defaults to `"ignore"` — so any path segment beginning with a dot makes it refuse
the file, and the error handler turns that into a 500. `/` kept working because `express.static`
dotfile-checks only the request path, not its own root.

Installing under a dot directory is ordinary: a worktree, a deploy under `~/.local/share`, a CI
checkout in a dotted cache path. The fix is an explicit `dotfiles` option on that one call, pinned by
`src/http/__tests__/spaFallback.test.ts` — which was checked by reverting the fix and watching it go
red, the way `CLAUDE.md` asks.

## Conventions

- **No retries, ever.** `retries: 0` in `playwright.config.ts`. A retry lets a genuinely flaky spec
  report green, which is the one outcome this suite exists to prevent.
- **No arbitrary sleeps.** Readiness is a polled real condition with a deadline, or an awaited event.
  Browser specs use Playwright auto-waiting only.
- **Serial, one worker.** These specs spawn real processes against real SQLite files; the suite is
  small enough that determinism is worth more than the clock.
- **Assert on our own tokens, never on English.** Where a spec checks generated output, it compares
  against a vocabulary object the harness itself defined, or a substring the server itself produced.
  `CLAUDE.md` hard rule 4 applies to tests as much as to the engine.

## Deliberately not covered

- **Image and audio routes** are exercised only for their empty and 404 shapes. The seed creates no
  media, so `sharp`-backed resizing is untested here.
- **The admin client is smoke coverage**, by intent — core screens render seeded data. Per-component
  behaviour belongs in `client/`'s own vitest suite.
- **No mutating MCP tool is swept exhaustively.** The `harness` specs go deep on the invariants and
  the protocols; the breadth of the 218-tool surface is the unit suite's job.
