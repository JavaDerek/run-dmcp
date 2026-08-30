import { getDatabase } from "../db/connection.js";
import { assertT, compareT, type T } from "./t.js";

/**
 * One event as it landed inside the window. `causes` is the raw JSON string
 * as stored (design §5.2c's one hop of provenance) -- it is returned
 * untouched, never parsed or interpreted here (hard rule 4: nothing in this
 * codebase derives meaning by reading generated text).
 */
export interface EventChange {
  kind: "event";
  t: T;
  eventId: string;
  eventKind: string;
  description: string | null;
  causes: string | null;
}

/**
 * One TRANSITION of one fact's interval, not one row per fact. A fact whose
 * interval opens AND closes inside the window produces two `FactChange`
 * rows -- an `"opened"` at `validFromT` and a `"closed"` at `validToT` --
 * because a single row cannot carry two different `t` values to sort on. A
 * tri-state "both" field was considered and rejected for exactly that
 * reason: two rows sort correctly by `t`, and a caller that wants "did this
 * fact both open and close in my window" recovers it for free by grouping
 * the returned rows on `factId`.
 *
 * `endpoint` says which end of the fact's own interval this row is -- a
 * mechanical property of the row against the window predicate, not a
 * judgement about the fact's meaning. This is deliberately the only
 * "extra" piece of information this module hands back beyond the raw
 * columns (see the module doc comment on why nothing else is).
 */
export interface FactChange {
  kind: "fact";
  t: T;
  factId: string;
  entityId: string;
  factKey: string;
  value: string;
  /** Which endpoint of this fact's interval landed in the window. */
  endpoint: "opened" | "closed";
  validFromT: T;
  validToT: T | null;
}

export type Change = EventChange | FactChange;

/**
 * design §5.5: "the engine provides the query; the client declares the
 * policy." `changes` is rows, nothing more -- no `isClean`, no severity, no
 * contiguity flag, no count that implies a threshold. A continuous-take
 * renderer reads a non-empty `changes` as a defect to fail; a turn-based
 * consumer reads the same rows to *build* a summary of what happened since
 * last look. Baking either reading into this type would hand the second
 * caller the first caller's policy (root CLAUDE.md hard rule 2). If a
 * future contributor is tempted to add `spansEntireInterval` or
 * `durationCovered` here: don't -- that is a verdict wearing a shape.
 */
export interface ChangeSet {
  gameId: string;
  t0: T;
  t1: T;
  changes: Change[];
}

interface EventRow {
  id: string;
  at_t: number;
  kind: string;
  description: string | null;
  causes: string | null;
}

interface FactRow {
  id: string;
  entity_id: string;
  key: string;
  value: string;
  valid_from_t: number;
  valid_to_t: number | null;
}

/**
 * The deterministic total order every `changesWithin` result is sorted
 * into: `t` ascending, then a tiebreaker chain that can never itself tie,
 * so two rows can never come back in a different order across two runs of
 * the same query (design §6's reproducibility depends on this for anyone
 * freezing an artifact from these rows).
 *
 * Tiebreak chain, in order:
 *   1. `t` (via `compareT`, the one comparator this codebase orders `t`
 *      through).
 *   2. `kind` -- "event" sorts before "fact"; fixed and arbitrary, but
 *      fixed is all determinism requires.
 *   3. The row's own id (`eventId` or `factId`) -- both are primary keys,
 *      so this alone would already be unique EXCEPT for one case:
 *   4. `endpoint` -- a zero-width fact interval (`validFromT === validToT`)
 *      produces two rows sharing both `t` and `factId`; only `endpoint`
 *      ("closed" < "opened") separates them.
 */
function compareChanges(a: Change, b: Change): number {
  const byT = compareT(a.t, b.t);
  if (byT !== 0) return byT;

  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1;
  }

  if (a.kind === "event" && b.kind === "event") {
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  }

  // Both "fact" at this point (the `a.kind !== b.kind` branch above already
  // returned otherwise), but TypeScript can't narrow a discriminated union
  // through two independent variables -- assert what's already established.
  const factA = a as FactChange;
  const factB = b as FactChange;
  if (factA.factId !== factB.factId) {
    return factA.factId < factB.factId ? -1 : 1;
  }
  return factA.endpoint < factB.endpoint ? -1 : factA.endpoint > factB.endpoint ? 1 : 0;
}

/**
 * `changesWithin(t0, t1)` -- design §5.5's "because units have duration":
 * every event and fact-interval transition recorded in one game's history
 * during the half-open window `[t0, t1)`.
 *
 * Half-open, matching `replay.ts`'s intervals exactly and for the same
 * reason (design §5.1): `t0` is in, `t1` is not. An event at exactly `t1`,
 * or a fact endpoint landing exactly at `t1`, belongs to whatever window
 * starts there, never to this one.
 *
 * `t1 === t0` is a legal empty window (returns zero rows, refused nowhere).
 * `t1 < t0` is refused loudly, naming both values, before either query
 * runs -- silently returning zero rows for a caller's off-by-one would be
 * far more expensive to track down than a thrown error naming the mistake.
 *
 * Exactly two queries, never one per entity -- same reasoning as
 * `replay()`: this runs over a whole game's history, and one prepared
 * statement per entity would both hit SQLite's bound-variable limit on a
 * large game and defeat better-sqlite3's prepared-statement cache. Facts
 * are scoped to the game via a JOIN to `entities` on `entity_id` (there is
 * no FK-enforced game_id on `facts` itself, and `facts.entity_id` is a real
 * foreign key with referential integrity -- see the task briefing on why
 * that JOIN, not a raw string match, is the identity axis to scope on).
 * Events carry `game_id` directly and need no join.
 *
 * Deliberately NOT filtered by entity aliveness. `replay(t)` answers "what
 * was true at an instant" and needs "alive at t" to make that meaningful;
 * this answers "what transitions were recorded in a window", and a
 * transition belonging to an entity that was later destroyed is still a
 * transition that was recorded -- destroying the entity afterward doesn't
 * retroactively un-happen it. Filtering these rows by aliveness would be
 * exactly the kind of policy this module isn't allowed to have an opinion
 * on (see `ChangeSet`'s doc comment).
 *
 * Omniscient for the same reason and by the same decision as `replay()` --
 * see its doc comment for the argument. Every transition in the window is
 * returned regardless of which principal could have observed it, and a
 * later per-principal filter arrives as one predicate on the two queries
 * below (issue #18).
 */
export function changesWithin(params: { gameId: string; t0: T; t1: T }): ChangeSet {
  const { gameId, t0, t1 } = params;
  // A Date, a string, NaN or +-Infinity gets refused here, loudly, on
  // either bound, before it can silently compare unequal to every row and
  // produce a confidently wrong empty result.
  assertT(t0);
  assertT(t1);
  // Through `compareT`, not a bare `<`, for the reason t.ts gives: it is the
  // one comparator everything in the timeline that ORDERS `t` goes through,
  // so a future axis can never introduce a second notion of "later" that
  // this guard alone disagrees with. Same shape clock.ts uses for its own
  // never-run-backwards refusals.
  if (compareT(t1, t0) < 0) {
    throw new Error(`timeline: changesWithin requires t1 >= t0, got t0=${t0}, t1=${t1}`);
  }

  const db = getDatabase();
  const changes: Change[] = [];

  // Query 1 of 2: events at_t in [t0, t1), scoped directly by game_id.
  const eventRows = db
    .prepare(
      `SELECT id, at_t, kind, description, causes
       FROM events
       WHERE game_id = ?
         AND at_t >= ?
         AND at_t < ?`
    )
    .all(gameId, t0, t1) as EventRow[];

  for (const row of eventRows) {
    changes.push({
      kind: "event",
      t: row.at_t,
      eventId: row.id,
      eventKind: row.kind,
      description: row.description,
      causes: row.causes,
    });
  }

  // Query 2 of 2: every fact whose valid_from_t OR valid_to_t landed in the
  // window, joined back to entities so scoping is by game_id via the real
  // FK-backed identity chain rather than a column on `facts` itself. Same
  // half-open predicate as query 1, applied independently to each endpoint
  // -- a fact can have one endpoint in the window and the other outside it
  // (that's the "opened before t0, closes inside" / "opens inside, still
  // open" cases below), so this is deliberately an OR over two half-open
  // checks, not one range check over the whole interval.
  const factRows = db
    .prepare(
      `SELECT f.id, f.entity_id, f.key, f.value, f.valid_from_t, f.valid_to_t
       FROM facts f
       JOIN entities e ON e.id = f.entity_id
       WHERE e.game_id = ?
         AND (
           (f.valid_from_t >= ? AND f.valid_from_t < ?)
           OR (f.valid_to_t IS NOT NULL AND f.valid_to_t >= ? AND f.valid_to_t < ?)
         )`
    )
    .all(gameId, t0, t1, t0, t1) as FactRow[];

  for (const row of factRows) {
    const opensInWindow = row.valid_from_t >= t0 && row.valid_from_t < t1;
    const closesInWindow = row.valid_to_t !== null && row.valid_to_t >= t0 && row.valid_to_t < t1;

    if (opensInWindow) {
      changes.push({
        kind: "fact",
        t: row.valid_from_t,
        factId: row.id,
        entityId: row.entity_id,
        factKey: row.key,
        value: row.value,
        endpoint: "opened",
        validFromT: row.valid_from_t,
        validToT: row.valid_to_t,
      });
    }
    if (closesInWindow) {
      changes.push({
        kind: "fact",
        // row.valid_to_t is not null here (closesInWindow already checked).
        t: row.valid_to_t as number,
        factId: row.id,
        entityId: row.entity_id,
        factKey: row.key,
        value: row.value,
        endpoint: "closed",
        validFromT: row.valid_from_t,
        validToT: row.valid_to_t,
      });
    }
  }

  changes.sort(compareChanges);

  return { gameId, t0, t1, changes };
}
