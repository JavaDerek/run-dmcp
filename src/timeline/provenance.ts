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
  id: string | null;
}

/**
 * The one hop of causality (design §5.2c), READ rather than derived (issue
 * #30). `facts.opened_by_event_id` is stamped by the projection triggers'
 * `_ai`/`_au` bodies (projection.ts) at the moment a fact opens, in the same
 * firing, via `last_insert_rowid()` against the event they just inserted --
 * so this is a direct column lookup now, not a search over `events` keyed by
 * `(at_t, causes.row_id)` with a random-hex tiebreak among rows sharing a
 * `t`. That derivation is gone, along with the failure modes it carried: it
 * could return null for an event whose `causes` was not valid JSON, and it
 * broke ties among same-`t` events arbitrarily.
 *
 * Both internal callers of this shape (`irreversible.ts`, `narration.ts`)
 * no longer call this function at all -- each already queries its own fact
 * row and now selects `opened_by_event_id` directly as part of that same
 * query, which is strictly cheaper than a second round trip through here.
 *
 * This function is kept, and re-pointed at the stored column rather than
 * removed, because it is part of this package's published library surface
 * (`src/index.ts` re-exports it) -- issue #30 did not ask for a public API
 * removal, and removing an exported function silently would be exactly the
 * kind of undocumented break root CLAUDE.md's "what we declare is what we
 * mean" section warns against. A caller that already holds
 * `(gameId, entityId, validFromT)` rather than a fact id can still use it;
 * it now does less work to answer the same question.
 */
export function openingEventId(gameId: string, entityId: string, validFromT: number): string | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT f.opened_by_event_id AS id
         FROM facts f
         JOIN entities e ON e.id = f.entity_id
        WHERE e.game_id = ?
          AND f.entity_id = ?
          AND f.valid_from_t = ?
          AND f.opened_by_event_id IS NOT NULL
        ORDER BY f.id
        LIMIT 1`
    )
    .get(gameId, entityId, validFromT) as OpeningEventRow | undefined;
  return row?.id ?? null;
}
