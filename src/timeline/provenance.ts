import { getDatabase } from "../db/connection.js";
import { type T } from "./t.js";

/**
 * §5.2c's one hop of causality, as the shape every carrier of a
 * fact-with-provenance shares -- there is exactly one owner of this shape
 * in the codebase, here, not one copy per caller.
 *
 * Before this module existed, the one hop was written out twice: once as
 * `irreversible.ts`'s `IrreversibleFact` (with its own module-private
 * `findOpenedByEventId`), and once implicitly wherever `ConstraintFact`
 * (narration.ts, design §5.2b) would otherwise have re-declared the same
 * five fields and re-implemented the same lookup. Two copies of a five-line
 * shape looks harmless right up until someone fixes a bug -- an off-by-one
 * in the tiebreak, say -- in one and not the other, and the two carriers of
 * "the fact and what opened it" silently disagree about what one hop means.
 * `ConstraintViolationError.contradictedFact` (registry.ts) is typed as
 * `IrreversibleFact`, which is itself now `FactProvenance` with nothing
 * added -- so a THIRD fork was never created for that carrier either.
 *
 * Deliberately just the fact plus one edge, never a chain, never a trace of
 * how the engine reached a verdict or which rules it consulted (§5.2c,
 * design's own words: "One hop -- never a trace"). A caller that wants more
 * than this is asking the wrong question of the engine.
 */
export interface FactProvenance {
  factId: string;
  entityId: string;
  key: string;
  value: string;
  validFromT: T;
  /** The event that opened this fact, or null if none is recorded. One hop --
   *  never a chain, never a trace of how the engine reached a verdict. */
  openedByEventId: string | null;
}

interface OpeningEventRow {
  id: string;
}

/**
 * The one hop of causality (design §5.2c): the event of `gameId` whose
 * `at_t` equals the fact's `valid_from_t` and whose `causes` JSON names this
 * entity as the row it was written for. `causes` is produced entirely by
 * this codebase's own projection triggers (`json_object('table', ...,
 * 'row_id', NEW.id)` in projection.ts) -- matching `$.row_id` here is a
 * literal comparison against a token we defined in output we generated, not
 * an attempt to understand what any event "means" (hard rule 4). Ordered
 * deterministically (`at_t`, then `id`) and only the first row is taken --
 * one hop, never a chain, never a trace of how the engine got here.
 *
 * The `CASE WHEN json_valid(causes)` wrapper is load-bearing, not defensive
 * decoration. `events.causes` has no CHECK constraint, and SQLite's
 * `json_extract` RAISES "malformed JSON" rather than returning NULL when it
 * meets a value that is not JSON -- and that error belongs to the whole
 * query, not to the offending row, so a single bad row anywhere in this
 * game's events would make every function that calls this throw, including
 * ones that have nothing to do with that event. That is reachable in
 * practice: timeline import (export.ts) carries `causes` through verbatim
 * by design, because an importer that rewrote a recorded cause would be
 * inventing history. A hop of provenance must never be able to fail the
 * write it annotates, so a row we cannot read simply does not match.
 * Written as CASE rather than `json_valid(causes) AND json_extract(...)`
 * because SQLite does not guarantee the evaluation order of AND operands --
 * the planner may reorder them, and then the guard is decoration that
 * happens to work today.
 *
 * Moved here verbatim (SQL, doc comment and all) from `irreversible.ts`'s
 * former module-private `findOpenedByEventId` -- this is the ONE owner of
 * §5.2c's hop now; `irreversible.ts` and `narration.ts` both call this
 * rather than each keeping a copy of the query.
 */
export function openingEventId(gameId: string, entityId: string, validFromT: number): string | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT id FROM events
        WHERE game_id = ?
          AND at_t = ?
          AND json_extract(CASE WHEN json_valid(causes) THEN causes END, '$.row_id') = ?
        ORDER BY at_t, id
        LIMIT 1`
    )
    .get(gameId, validFromT, entityId) as OpeningEventRow | undefined;
  return row?.id ?? null;
}
