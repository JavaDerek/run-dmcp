import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection.js";

/**
 * The adjudication window (design §5.2a, §5.3; issue #13): an ephemeral
 * marker that an adjudicating call -- issue #10's resolver, not built here
 * -- is currently in progress. `resolve_only` (the fourth member of the
 * constraint family, `src/types/index.ts`) means "every direct write to
 * this fact key is refused"; this module is what "direct" is measured
 * against. A write made while this window is open is the one write that is
 * NOT direct -- it arrived through the adjudicating call that opened it.
 *
 * ONE SOURCE OF TRUTH, READ IN TWO PLACES. `adjudicationOpen()` below is
 * called from the JS choke point (`assertConstraintsAllow`,
 * src/timeline/constrained.ts) and the exact same table is read by
 * `timeline_facts_resolve_only` (the `BEFORE INSERT ON facts` trigger,
 * src/db/schema.ts) via `NOT EXISTS (SELECT 1 FROM
 * timeline_adjudications_open)`. Two independent checks that happened to
 * agree today would be two representations of one fact waiting to drift --
 * exactly the "two write paths for one idea" shape root CLAUDE.md warns
 * about and hard rule 7 exists to prevent for constrained writes generally.
 * There is exactly one row of truth: this table. Neither reader owns a
 * second copy of "is a window open" to keep in sync with the other.
 *
 * EMPTY AT REST. A database with no adjudicating call ever in flight has
 * zero rows here, forever -- this is not a log and not a history; nothing
 * here is meant to be read back after the window that wrote it closes. It
 * is deliberately NOT a `PROJECTED_TABLES` entry (no entity/fact is ever
 * derived from it -- an adjudication window is not part of the game's
 * timeline, it is a fact about how a write reached the timeline), NOT
 * frozen the way `resource_history`/`relationship_history` are (those hold
 * rows nothing should ever add to again; this table's whole job is to gain
 * and lose rows constantly), and NEVER exported as a query -- there is no
 * `listOpenAdjudications()` beside `adjudicationOpen()` below, because
 * nothing outside this module and its trigger counterpart has legitimate
 * business asking anything about it other than the one boolean.
 *
 * SINGLE CONNECTION, NO RACE. better-sqlite3 is synchronous and this
 * project holds exactly one connection per process (`getDatabase()`,
 * src/db/connection.ts) -- there is no `await` between the INSERT that
 * opens a window and the DELETE that closes it for two different callers'
 * windows to interleave across, and no second connection that could read a
 * half-open state. A future multi-process deployment would need to revisit
 * this; nothing here assumes it.
 *
 * `withAdjudicationOpen` IS INTENDED TO BE CALLED FROM INSIDE
 * `withTransaction()` (src/db/connection.ts) -- the resolver (issue #10,
 * built separately) is expected to nest it as
 * `withTransaction(() => withAdjudicationOpen(gameId, () => { ...writes...;
 * ...event insert... }))`, so the marker row this module inserts commits or
 * rolls back atomically WITH the writes it authorizes, exactly like every
 * other constrained write's fact/event pair (see `applyLiveWrite`,
 * constrained.ts). Getting that order backwards -- opening the window
 * outside any transaction -- is exactly the crash scenario
 * `initializeAdjudicationSchema`'s startup cleanup below exists to recover
 * from; this module cannot enforce the nesting order on a caller, so it
 * says so here instead.
 *
 * IMPORT DIRECTION IS LOAD-BEARING, same rule as constrained.ts's own doc
 * comment states for itself: this file imports nothing from `src/tools/`.
 * It stays a `src/timeline/` leaf -- the only thing it reaches for outside
 * this directory is `getDatabase()` (src/db/connection.ts), exactly like
 * constrained.ts and registry.ts already do.
 */

/**
 * Creates `timeline_adjudications_open` if it doesn't already exist, and
 * unconditionally clears every row it holds. Called from
 * `src/db/schema.ts`'s `initializeSchema()`, BEFORE
 * `timeline_facts_resolve_only` (the trigger that reads this table) is
 * created -- a `WHEN` clause referencing a table that doesn't exist yet
 * would fail at `CREATE TRIGGER` time, not silently defer.
 *
 * THE STARTUP DELETE IS NOT HOUSEKEEPING -- it closes a fail-OPEN hole that
 * would otherwise be the worst failure mode a guard can have. `withAdjudicationOpen`'s
 * `finally` closes the window on a throw, but nothing in JS runs if the
 * PROCESS itself dies between the INSERT and the DELETE (SIGKILL, OOM, the
 * host losing power) -- and better-sqlite3's default journal mode commits
 * each statement as it runs, so a row that made it to disk stays there.
 * Without this cleanup, that one surviving row would make `adjudicationOpen()`
 * return `true` FOREVER, on every future startup, for the life of the
 * database -- which does not refuse writes (the failure a reviewer would
 * notice) but PERMITS every one of them: `timeline_facts_resolve_only`'s
 * `NOT EXISTS (SELECT 1 FROM timeline_adjudications_open)` would never be
 * satisfied again, silently turning `resolve_only` into a no-op. A guard
 * that quietly stops guarding is worse than one that is visibly broken.
 *
 * WHY UNCONDITIONAL DELETE IS SAFE: startup and "an adjudicating call is in
 * flight" are mutually exclusive by construction. `initializeSchema()` runs
 * once, synchronously, before this process serves anything -- there is no
 * caller that could be mid-`withAdjudicationOpen` while it executes, because
 * the only thing that could be running one is THIS process, and this
 * process is, at this exact moment, inside its own startup path, not inside
 * a request. So any row found here was never going to be closed by the code
 * that opened it -- that code is gone -- and the only correct reading of a
 * leftover row is "not open, and never going to become open on its own."
 * Clearing it fails CLOSED (enforcement resumes) rather than leaving it to
 * fail OPEN (enforcement silently stays off), which is the direction every
 * ambiguous case in this module resolves toward.
 *
 * No index: this table is expected to hold at most a small handful of rows
 * at any instant (one per adjudicating call currently in flight, plus one
 * per level of re-entrant nesting) and every query against it is either "do
 * any rows exist" or "delete this one row by its primary key" -- neither
 * benefits from one.
 */
export function initializeAdjudicationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_adjudications_open (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      opened_at TEXT NOT NULL
    )
  `);
  db.exec(`DELETE FROM timeline_adjudications_open`);
}

/**
 * Is ANY adjudication window currently open? Not scoped to a game --
 * `timeline_facts_resolve_only`'s own `WHEN` clause (src/db/schema.ts) isn't
 * either, and the whole point of "one source of truth read in two places"
 * above is that this function and that trigger can never answer the
 * question differently. A resolver call for game A opening a window does,
 * as a consequence, also permit a resolve_only write for game B for the
 * duration -- an acceptable widening given there is exactly one process,
 * exactly one adjudicating call site (issue #10), and no concurrent-game
 * resolution happening on this connection at once. Narrowing this to
 * `game_id` later is possible without changing the trigger's shape (add
 * `AND game_id = NEW.<something-that-names-the-game>` to both sides at
 * once) but is not needed for the window mechanism itself to be correct
 * today, and inventing that requirement ahead of an actual caller needing
 * it would be exactly the "nothing enters the core against an imagined
 * client" mistake root CLAUDE.md's hard rule 1 warns against.
 */
export function adjudicationOpen(): boolean {
  const db = getDatabase();
  const row = db.prepare(`SELECT 1 FROM timeline_adjudications_open LIMIT 1`).get();
  return row !== undefined;
}

/**
 * Runs `fn` with the adjudication window open, and guarantees the window
 * this call opened is closed again before returning or throwing -- a
 * throwing adjudication must never leave `resolve_only` permanently
 * unenforceable for the rest of the process's life.
 *
 * RE-ENTRANCY: each call inserts its OWN row (a fresh uuid, never reused)
 * and its `finally` deletes only that row, by id -- never every row in the
 * table. Nesting therefore composes correctly with no special-casing: if an
 * adjudicating call invokes another adjudicating call while its own window
 * is open (or, for that matter, if two unrelated adjudications happen to be
 * in flight on this one synchronous connection at the same instant, which
 * given the single-connection note above means one nested inside the
 * other), the inner call's own finally block removes only the inner row.
 * `adjudicationOpen()` asks "does at least one row exist", so the outer
 * window is still reported open for as long as the outer row remains --
 * whether or not the inner call already finished, and whether or not the
 * inner call threw. A DELETE keyed on `WHERE id = ?` (this call's own row),
 * rather than `DELETE FROM timeline_adjudications_open` (every row), is
 * what makes an inner close unable to ever close an outer window.
 *
 * `gameId` is recorded on the row for the same reason `opened_at` is --
 * legibility for anyone inspecting the table mid-flight (e.g. while
 * debugging a wedged process) -- not because any reader queries by it; see
 * `adjudicationOpen()`'s doc comment above for why the read side is
 * deliberately unscoped.
 */
export function withAdjudicationOpen<R>(gameId: string, fn: () => R): R {
  const db = getDatabase();
  const id = uuidv4();
  db.prepare(`INSERT INTO timeline_adjudications_open (id, game_id, opened_at) VALUES (?, ?, ?)`).run(
    id,
    gameId,
    new Date().toISOString()
  );
  try {
    return fn();
  } finally {
    db.prepare(`DELETE FROM timeline_adjudications_open WHERE id = ?`).run(id);
  }
}
