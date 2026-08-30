# run-dmcp — Claude Context

## What this is

**An MCP server for LLM-run interactive fiction where the server owns what is true — including when
it was true.**

> The model classifies and narrates. The server resolves, remembers, and can say what the world
> looked like at any point in its history. The narrator may be as florid as it likes about *the how*;
> it can never lie about *the what*, or about *the when*.

Both halves reverse the premise of [DMCP](https://github.com/shawnrushefsky/dmcp), which this project
continues: there, the model holds full adjudication discretion over a world that only stores *now*.

**[docs/DESIGN.md](docs/DESIGN.md) is the authority.** It was negotiated across three rounds between
two consumers and is signed by both. Read it before making design decisions; section numbers below
refer to it. Open work is in GitHub issues, grouped by the phases in §11.

## This engine has two consumers and belongs to neither

One consumer's world advances a turn at a time and has a player making uncertain decisions. The
other has no player at all: its units have **duration** and everything is known in advance. They were
chosen to be unlike each other, and **neither may become the reason the engine exists.**

That is not a sentiment. It is `src/__tests__/engineVocabulary.test.ts`, which fails CI when a
specific consumer's language appears anywhere in the tracked tree. One file is excluded —
`docs/DESIGN.md`, whose job is to explain where the boundary falls and which cannot do that without
naming what is on either side of it. A test asserts that the exclusion list has exactly one entry, so
routing around the rule means editing the assertion that says you may not.

Fixtures use **grain, treasury, population** — a throwaway vocabulary for exercising mechanism, never
a starter set.

## Hard rules — violations are bugs, not style opinions

1. **Core membership is "generic, with at least one real caller."** Not "needed by both consumers" —
   the resolve protocol has one caller and belongs here. Not "sounds general" either: nothing enters
   the core against an imagined client. Fog of war is deferred for exactly this reason (§8).
2. **The engine records decisions; it does not make them.** `changes_within(t0, t1)` returns
   transitions, never a verdict — no `is_clean`, no severity. One consumer reads those rows to *fail*
   a unit, another reads them to *build* a summary. The moment a query returns a judgement it has
   baked the first caller's policy into the engine (§5.5).
3. **Say what is, never what is absent.** Rendered state is positive concrete nouns, enforced **at
   construction** — the renderer emits from a caller-injected vocabulary and has no way to express
   absence. Downstream models render the nouns they are given and cannot subtract: a clause reading
   `avoid = [..., "harnesses or safety gear"]` put a harness and carabiners onto a character in a
   single-variable A/B at identical seed (§7).
4. **Never pattern-match meaning.** No state is ever derived by matching words, phrases or regexes
   against natural language — not a player's input, not a model's output, not prose this codebase
   produced itself. In particular **never scan generated text for negation** to enforce rule 3; make
   negation unconstructable instead. This failure has four recorded instances across two codebases,
   and one of them arrived *while its author was writing the argument against it*. A literal check
   for a token **we** defined in output **we** generated is fine; understanding English is not.
5. **Prohibitions are derived and structural, never authored and lexical.** If fact F holds at `t`,
   any assertion contradicting F is prohibited; if F is `irreversible`, prohibited thereafter. Never
   add a list of forbidden phrases — that is rule 4 wearing a costume (§5.2b).
6. **`t` is the axis that stays invariant when a caller re-segments its own units.** A timestamp or a
   turn counter qualifies; an index into re-cuttable units does not. Choosing wrong raises no error —
   it silently attaches one unit's content to another's (§5.1, §14).

## Testing

DMCP arrived with **3 test files for 66 source files**. There is no upstream safety net; we are it.

- **TDD is mandatory.** Write the failing test first, verify it fails for the right reason, then
  implement.
- Cover the happy path, every rejection path, boundaries, re-entrancy, and partial-failure/rollback.
- A test that cannot fail is worse than no test. When adding a guard, **plant a violation and watch
  it go red** before trusting it — that is how the vocabulary test was validated.
- Use the existing in-memory database fixture; do not build a second one.

## Inherited gotchas — learned downstream, do not rediscover them

- **`withTransaction()` was dead code** until it was wired. Anything touching several tables must be
  atomic or it can half-land.
- **Expiry is passive.** `scheduled_events`, `timers` and `status_effects.duration` are three
  uncoordinated systems that never call each other, and `status_effects.expires_at` is written but
  never read. On-expiry consequences are net-new (and now present).
- **Per-entity visibility is not enforced.** `get_secret`'s own description reads *"DM view - shows
  all info"*. Fog of war is net-new, not inherited.
- **`resources.owner_type` allows only `game|character`.** Other owners need a migration.
- **Migrations: no framework.** `initializeSchema()` runs at every startup; changes to existing
  tables are idempotent `try { db.exec("ALTER TABLE ...") } catch {}` blocks near the relevant
  `CREATE TABLE`. No down-migrations. **Test against an existing database, not just a fresh one.**
- **Style:** the source uses double quotes despite the formatter config, and CI does not run the
  formatter. Match the surrounding code.

## Development

```bash
npm ci && (cd client && npm ci)

npm run lint          # eslint      (CI runs this)
npm run typecheck     # tsc --noEmit (CI runs this)
npm run test:run      # vitest, one shot (CI runs this)
npm run build         # tsc + client build (CI runs this)
npm run dev           # tsx src/bin/run-dmcp.ts
```

Local MCP inspection: `npx @modelcontextprotocol/inspector node dist/bin/run-dmcp.js`

**Two entry points, and the difference is load-bearing.** `src/index.ts` is the library: exports and
nothing else, and importing it must never start, open or create anything. `src/bin/run-dmcp.ts` is
the application, and is the only place that brings up the schema, binds a port or connects a
transport. `src/__tests__/entrypoints.test.ts` enforces both halves by running them in child
processes — the library one must be able to *exit*, so no enumeration of forbidden side effects has
to be kept up to date.

## Provenance

Continues DMCP by Shawn Rushefsky, MIT. This repository carries its **full history** — the first
commit is his, from 2025-12-30 — and is deliberately **not** a GitHub fork, so it owns its own issue
tracker. His copyright notice travels with the code and is in `LICENSE` above ours; that is MIT's one
real obligation and it is also just correct.

Four pieces of generic mechanism here were offered back upstream and remain open pull requests
against `shawnrushefsky/dmcp` (#6 atomicity, #7 constraints, #8 conserved sets, #9 expiry
consequences). They are merged here because that repository has not moved since 2026-01-06.
