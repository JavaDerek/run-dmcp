# run-dmcp

**An MCP server for LLM-run interactive fiction where the server owns what is true — including when
it was true.**

> The model classifies and narrates. The server resolves, remembers, and can say what the world
> looked like at any point in its history. The narrator may be as florid as it likes about *the how*;
> it can never lie about *the what*, or about *the when*.

Both halves of that are deliberate reversals of the design this project continues, in which the model
holds full adjudication discretion over a world that only ever stores *now*.

## Status

**0.1.1 — the foundation, not the thesis.** What ships today is the predecessor's engine plus four
pieces of generic mechanism that were built for it and offered back to it:

- **Atomicity** — `withTransaction()` wired into the multi-write operations that were running
  non-atomically.
- **Declarative constraints** — resources can be declared `bounded` or `monotonic`, and the store
  enforces it rather than trusting every caller. (`resolve_only` — every direct write rejected, so a
  value can move only through an adjudicating call — exists in a downstream consumer and has not been
  extracted here yet. It arrives with the resolve protocol; see [docs/DESIGN.md](docs/DESIGN.md) §5.2a.)
- **Conserved resource sets** — a set of resources can be declared conserved, with an atomic transfer
  that never silently clamps.
- **On-expiry consequences** — scheduled events and timers can carry a consequence that actually
  lands when they expire, rather than expiring into nothing.

0.1.1 adds the packaging half of that: importing the library starts nothing, the database resolves to
the consuming application rather than into `node_modules`, and a consumer can bring up its own tables
through the migration hook below.

The timeline that gives this project its reason to exist — interval-versioned facts, `replay(t)`,
irreversibility, timeline export, `changes_within` — is built, and every write of world state appends
to it in the same transaction, through generated triggers rather than edited write sites.

**There is one versioning substrate, and it is the timeline.** A resource's value is a constrained
numeric fact: declared constraints (`bounded`, `monotonic`, conserved sets, `irreversible`) are
checked at a single choke point, and "what did this value used to be" is answered by the fact
intervals rather than by a history table beside them. The former `resource_history` and
`relationship_history` tables no longer accept writes. See [docs/DESIGN.md](docs/DESIGN.md), which is
the authority, §5.4 for that decision and §11 for the order the rest lands in.

## Running it, and depending on it

These are two different things, and the package keeps them apart.

**As an application** — `run-dmcp` (or `node dist/bin/run-dmcp.js`) serves MCP over stdio and the web
UI alongside it. `DMCP_HTTP_PORT` moves the web UI; `DMCP_NO_HTTP=1` turns it off entirely, which is
what a host that spawns this as a subprocess wants: a referee has no use for an admin page, and a
server it cannot close squats a port.

**As a dependency** — importing the package starts nothing. No listener, no database file, no work at
all: the entry point is exports, and the application lives behind `bin`. A consumer decides when the
schema comes up, where the database lives, and whether anything listens.

**The package root is the core, and the tabletop surface is a layer above it.** Dice, combat,
abilities, status effects, random tables and quests are genuinely game-shaped — an optional
dependency, not part of the engine (see [docs/DESIGN.md](docs/DESIGN.md) §8). A consumer that only
needs entities, facts, events and the timeline imports `run-dmcp` and calls `createCoreMcpServer`. A
consumer that wants the full tabletop surface imports `run-dmcp/rpg` and calls `createMcpServer` —
same name, same options, the whole assembly this package has always served:

```ts
import { initializeSchema, type SchemaMigration } from "run-dmcp";
import { createMcpServer } from "run-dmcp/rpg";

const migrations: SchemaMigration[] = [
  {
    name: "my-tables",
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS my_table (id TEXT PRIMARY KEY)`);
      try {
        db.exec(`ALTER TABLE my_table ADD COLUMN added_later TEXT`);
      } catch {
        // Already added -- migrations run on every startup, so they must be idempotent.
      }
    },
  },
];

initializeSchema({ migrations });   // engine tables first, then yours, one pass, one database
const server = createMcpServer();   // built, not started -- connect it to a transport yourself
```

The hook is a parameter rather than a global `register()` because a parameter cannot be registered
too late to run. There is no framework behind it: no version table, no record of what already ran, no
down-migrations. Every migration runs on every startup, exactly like the engine's own DDL — which is
what forces them to be idempotent, and it is tested against an existing database, not just a fresh
one.

The database lands in the consuming application: `DMCP_DB_PATH` if set, else an existing
`~/.local/share/dmcp`, else `./data/games.db` relative to the working directory. Never inside the
installed package.

## Provenance

This continues [DMCP](https://github.com/shawnrushefsky/dmcp) by Shawn Rushefsky (MIT), whose last
commit was 2026-01-06. This repository carries its full history rather than a squashed root: the
first commit here is his, from 2025-12-30.

It is **not** a GitHub fork, deliberately — a repository inside another's fork network is discoverable
only as "a fork of" and cannot own its issue tracker. The four offers listed above were opened as pull
requests against the original ([#6](https://github.com/shawnrushefsky/dmcp/pull/6)–[#9](https://github.com/shawnrushefsky/dmcp/pull/9))
and withdrawn on 2026-08-18 after seven months without a maintainer response; they are merged here
instead. Their diffs remain readable upstream at `refs/pull/6..9/head`.

MIT, and his copyright notice travels with the code. See [LICENSE](LICENSE).

## The one rule that shapes everything else

This engine serves more than one piece of interactive fiction. Two consumers were in the room when it
was designed, chosen to be unlike each other: one whose world advances a turn at a time and has a
player making uncertain decisions, and one with no player at all, whose units have *duration* and are
entirely known in advance.

Neither may become the reason the engine exists. That intention does not survive as a rule people
remember, so it is a test: `src/__tests__/engineVocabulary.test.ts` fails CI when a specific
consumer's language appears anywhere in the engine. Fixtures use grain, treasury and population — a
throwaway vocabulary for exercising mechanism, never a starter set.

**Core membership is "generic, with at least one real caller"** — not "needed by every consumer", and
not "sounds general". Nothing enters the core against an imagined client.

## Development

```bash
npm ci
cd client && npm ci && cd ..

npm run lint          # eslint
npm run typecheck     # tsc --noEmit
npm run test:run      # vitest, one shot
npm run build         # tsc + client build

npm run dev           # tsx src/bin/run-dmcp.ts
```

CI runs lint, typecheck, tests and build on every push, for both the server and the client.

Local MCP inspection: `npx @modelcontextprotocol/inspector node dist/bin/run-dmcp.js`

## License

MIT — see [LICENSE](LICENSE).
