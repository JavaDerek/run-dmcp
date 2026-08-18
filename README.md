# run-dmcp

**An MCP server for LLM-run interactive fiction where the server owns what is true — including when
it was true.**

> The model classifies and narrates. The server resolves, remembers, and can say what the world
> looked like at any point in its history. The narrator may be as florid as it likes about *the how*;
> it can never lie about *the what*, or about *the when*.

Both halves of that are deliberate reversals of the design this project continues, in which the model
holds full adjudication discretion over a world that only ever stores *now*.

## Status

**0.1.0 — the foundation, not the thesis.** What ships today is the predecessor's engine plus four
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

The timeline that gives this project its reason to exist — interval-versioned facts, `replay(t)`,
irreversibility, `changes_within` — is designed and accepted but **not yet built**. See
[docs/DESIGN.md](docs/DESIGN.md), which is the authority, and §11 for the order things land in.

## Provenance

This continues [DMCP](https://github.com/shawnrushefsky/dmcp) by Shawn Rushefsky (MIT), whose last
commit was 2026-01-06. This repository carries its full history rather than a squashed root: the
first commit here is his, from 2025-12-30.

It is **not** a GitHub fork, deliberately — a repository inside another's fork network is discoverable
only as "a fork of" and cannot own its issue tracker. The four offers listed above stand as open pull
requests against the original and remain valid there; they are merged here because this project
cannot wait on a repository that has not moved in seven months.

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

npm run dev           # tsx src/index.ts
```

CI runs lint, typecheck, tests and build on every push, for both the server and the client.

Local MCP inspection: `npx @modelcontextprotocol/inspector node dist/index.js`

## License

MIT — see [LICENSE](LICENSE).
