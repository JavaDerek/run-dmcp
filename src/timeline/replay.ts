import { getDatabase } from "../db/connection.js";
import { assertT, type T } from "./t.js";
import type { EntityKind } from "./kinds.js";

/**
 * One fact as it read at the replayed `t`. `validFromT` is carried because
 * design §5.2c's one hop of causality needs the moment a fact opened --
 * nothing more than that is in scope here. In particular there is no
 * `validToT`: at the replayed instant the fact is simply open, and whether
 * or when it later closes is not a property of *this* snapshot.
 */
export interface ReplayedFact {
  value: string;
  validFromT: T;
}

/**
 * One entity as it read at the replayed `t`, with every fact that was valid
 * then. `facts` is keyed by `key` because at most one fact per key can be
 * valid at a single `t` -- interval versioning (schema.ts) guarantees that
 * for well-formed data, and the query below is written so a duplicate key
 * (malformed data) resolves deterministically rather than by map-insertion
 * order.
 */
export interface ReplayedEntity {
  id: string;
  kind: EntityKind;
  name: string | null;
  createdAtT: T;
  facts: Record<string, ReplayedFact>;
}

/** A full world snapshot: every entity alive at `t`, with every fact valid at `t`. */
export interface Snapshot {
  gameId: string;
  t: T;
  entities: ReplayedEntity[];
}

interface EntityRow {
  id: string;
  kind: EntityKind;
  name: string | null;
  created_at_t: number;
}

interface FactRow {
  entity_id: string;
  key: string;
  value: string;
  valid_from_t: number;
}

/**
 * The "alive at t" half of both queries below, as one shared string.
 *
 * This has to be a single constant, not two hand-matched copies, because
 * the whole point of replay is that "who was alive" and "what was true of
 * them" describe the same instant. Two copies would compile and pass review
 * right up until someone edited one -- silently reintroducing entities whose
 * facts vanished, or facts belonging to nobody the snapshot admits exists.
 * Always used against an `entities` row aliased `e` (see both queries).
 */
const ALIVE_AT_T = "e.created_at_t <= ? AND (e.destroyed_at_t IS NULL OR e.destroyed_at_t > ?)";

/**
 * `replay(t)` -- design §5.1's "whole feature": the state of one game's
 * world at any point in its recorded history, not only at "now".
 *
 * Half-open intervals, everywhere and identically (design §5.1, and the
 * architecture note's flagged likeliest bug):
 *
 *   alive at t: created_at_t <= t AND (destroyed_at_t IS NULL OR destroyed_at_t > t)
 *   valid at t: valid_from_t <= t AND (valid_to_t   IS NULL OR valid_to_t   > t)
 *
 * A fact valid [a, b) is present at a and gone at b -- b itself belongs to
 * whatever superseded it, never to both. A zero-width interval (valid_from_t
 * == valid_to_t, which two writes at one declared t produce) is therefore
 * invisible at every t: it opens and closes at the same instant, so the
 * "> t" half of its own close condition is never satisfied at the t it
 * would need to be visible at.
 *
 * Exactly two queries, never one per entity -- this runs over a whole
 * world. The first finds who was alive; the second finds what was true of
 * them, via a JOIN back to `entities` rather than a per-entity-id `IN (...)`
 * list: this snapshot is meant to run over an entire world, and binding one
 * parameter per entity would both hit SQLite's bound-variable limit on a
 * large one and make every distinct entity count its own SQL text, which
 * defeats better-sqlite3's prepared-statement cache. Fixed SQL, two binds
 * of `t`, regardless of how many entities exist.
 */
export function replay(params: { gameId: string; t: T }): Snapshot {
  const { gameId, t } = params;
  // A Date, a string, NaN or +-Infinity gets refused here, loudly, before
  // it can silently compare unequal to every row and produce a confidently
  // wrong empty snapshot.
  assertT(t);

  const db = getDatabase();

  // Query 1 of 2: which entities were alive at t, in the caller-diffable
  // order the design calls for (created_at_t, then id -- id as the
  // tiebreaker for entities created at the same t, so the order never
  // depends on SQLite's unspecified tie behavior).
  const entityRows = db
    .prepare(
      `SELECT e.id, e.kind, e.name, e.created_at_t
       FROM entities e
       WHERE e.game_id = ?
         AND ${ALIVE_AT_T}
       ORDER BY e.created_at_t, e.id`
    )
    .all(gameId, t, t) as EntityRow[];

  const entities: ReplayedEntity[] = entityRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAtT: row.created_at_t,
    facts: {},
  }));

  // Nothing alive means nothing that could own a fact. Not load-bearing for
  // correctness the way it was before the JOIN -- query 2 below is valid
  // SQL and would themselves return zero rows -- but it is still a genuine
  // short-circuit: an empty game skips a JOIN entirely rather than running
  // it to find nothing.
  if (entities.length === 0) {
    return { gameId, t, entities };
  }

  const byId = new Map(entities.map((entity) => [entity.id, entity]));

  // Query 2 of 2: every fact valid at t, joined back to `entities` so
  // "valid" is scoped to exactly the entities `ALIVE_AT_T` says were alive
  // -- the same predicate, not a hand-matched copy of it. Ordered by
  // valid_from_t so that if malformed data ever puts two facts for the same
  // key in the visible window at once -- which correct writers never
  // produce -- the one opened later (the one that superseded the other) is
  // the one left standing, rather than whichever row SQLite happened to
  // return first.
  const factRows = db
    .prepare(
      `SELECT f.entity_id, f.key, f.value, f.valid_from_t
       FROM facts f
       JOIN entities e ON e.id = f.entity_id
       WHERE e.game_id = ?
         AND ${ALIVE_AT_T}
         AND f.valid_from_t <= ?
         AND (f.valid_to_t IS NULL OR f.valid_to_t > ?)
       ORDER BY f.valid_from_t`
    )
    .all(gameId, t, t, t, t) as FactRow[];

  for (const factRow of factRows) {
    const entity = byId.get(factRow.entity_id);
    // Cannot happen: every fact row came from a JOIN against entities e
    // filtered by the same game_id and ALIVE_AT_T as query 1, so its
    // entity_id is always a key already in byId. Guarded anyway rather than
    // asserted, because a snapshot query has no business throwing over its
    // own bookkeeping.
    if (!entity) continue;
    entity.facts[factRow.key] = { value: factRow.value, validFromT: factRow.valid_from_t };
  }

  return { gameId, t, entities };
}
