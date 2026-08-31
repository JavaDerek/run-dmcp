import { getDatabase } from "../db/connection.js";
import { assertT } from "./t.js";
import { openingEventId, type FactProvenance } from "./provenance.js";

/**
 * DECISION(#21): contradiction is whole-value comparison under one key.
 *
 * `irreversible` -- the temporal member of the constraint family alongside
 * `bounded`, `monotonic`, and conserved sets (design §5.3). Declared per
 * fact, not per entity or per value: `facts.irreversible` is a column on the
 * fact row itself, so any property a consumer wants irreversible has to live
 * under its own fact `key` -- you cannot flag half a blob (see the schema
 * comment on `facts` in schema.ts, and the "fact granularity" tests in
 * irreversible.test.ts, which are what make that claim true rather than
 * merely asserted).
 *
 * The actual enforcement -- refusing a contradicting assertion, and locking
 * the `irreversible` flag itself to a one-way 0 -> 1 latch -- lives entirely
 * in the two triggers on `facts` in schema.ts (`timeline_facts_irreversible`,
 * `timeline_facts_immutable`). Every one of the 48 write sites in this
 * codebase reaches `facts` through the generated projection triggers in
 * projection.ts, so that is the only choke point a JS-level check could
 * never be bypassed at. This module is a thin, typed API onto that trigger
 * layer -- it never re-implements the rule, and it never returns a verdict
 * (hard rule 2 / design §5.5): no `isClean`, no severity, just the fact
 * that is or isn't there.
 */
/**
 * §5.2c's one hop of causality, specialized to an irreversible fact. The
 * shape itself now lives in `provenance.ts` as `FactProvenance` -- every
 * carrier of "a fact plus the one event that opened it" extends the same
 * interface rather than each re-declaring it and re-implementing the
 * lookup, so this type and `narration.ts`'s `ConstraintFact` can never
 * quietly disagree about what one hop means. `IrreversibleFact` adds
 * nothing beyond the shared shape; the name is kept because every caller in
 * this file, and `ConstraintViolationError.contradictedFact` (registry.ts),
 * already reads it that way. A type alias rather than an empty `extends`
 * interface -- ESLint's `no-empty-object-type` correctly rejects an
 * interface that declares no members of its own, since it is indistinguishable
 * from its supertype at every call site; a plain alias says the same thing
 * without inventing a nominal type this codebase would then have to keep
 * in sync with its supertype by hand.
 */
export type IrreversibleFact = FactProvenance;

interface FactRow {
  id: string;
  entity_id: string;
  key: string;
  value: string;
  valid_from_t: number;
}

function toIrreversibleFact(row: FactRow, gameId: string): IrreversibleFact {
  assertT(row.valid_from_t);
  return {
    factId: row.id,
    entityId: row.entity_id,
    key: row.key,
    value: row.value,
    validFromT: row.valid_from_t,
    openedByEventId: openingEventId(gameId, row.entity_id, row.valid_from_t),
  };
}

/**
 * Marks the currently-open fact for `(entityId, key)` irreversible.
 *
 * Throws, naming what's missing, rather than silently doing nothing, in
 * exactly two cases:
 *   - the entity does not exist;
 *   - there is no open fact for that key. Irreversibility can only attach to
 *     a fact that currently holds -- "say what is, never what is absent"
 *     (hard rule 3) applies here too: there is no honest way to declare the
 *     irreversibility of an absence.
 *
 * The flip itself is a single `UPDATE facts SET irreversible = 1 WHERE id =
 * ?`, which the amended `timeline_facts_immutable` latch (schema.ts)
 * permits as the one legal transition. That single statement is also what
 * makes this naturally idempotent: calling it again while the same fact is
 * still open re-sends the identical 1 -> 1 update, which the latch treats as
 * a no-op (not a change at all, so it never reaches the "reject anything but
 * 0 -> 1" branch), and this function returns the same record either way.
 */
export function declareIrreversible(params: { entityId: string; key: string }): IrreversibleFact {
  const db = getDatabase();

  const entity = db.prepare(`SELECT game_id FROM entities WHERE id = ?`).get(params.entityId) as
    | { game_id: string }
    | undefined;
  if (!entity) {
    throw new Error(
      `timeline: cannot declare irreversibility for unknown entity '${params.entityId}'`
    );
  }

  // ORDER BY / LIMIT for the same reason replay.ts orders its fact query:
  // two facts open at once for one key is malformed data (checkpoint.ts
  // reports it as `duplicate-fact`), and this module has no business
  // resolving it -- but which one it picks must not depend on query-plan
  // order. Same tiebreak as irreversibleFactFor below, so the two functions
  // can never disagree about which row they mean.
  const open = db
    .prepare(
      `SELECT id, entity_id, key, value, valid_from_t FROM facts
        WHERE entity_id = ? AND key = ? AND valid_to_t IS NULL
        ORDER BY valid_from_t DESC, id DESC
        LIMIT 1`
    )
    .get(params.entityId, params.key) as FactRow | undefined;
  if (!open) {
    throw new Error(
      `timeline: entity '${params.entityId}' has no open fact for key '${params.key}' -- ` +
        `irreversibility can only be declared for a fact that currently holds, never for an absence`
    );
  }

  db.prepare(`UPDATE facts SET irreversible = 1 WHERE id = ?`).run(open.id);

  return toIrreversibleFact(open, entity.game_id);
}

/**
 * The irreversible fact currently governing `(entityId, key)`, or `null` if
 * none has been declared. Looks at every row with `irreversible = 1` for
 * that key -- open or closed -- the same set `timeline_facts_irreversible`
 * (schema.ts) tests, so this can never report "none" for a key the guard
 * would in fact refuse to contradict. When more than one such row exists
 * (only possible after the key was closed and reopened at the SAME value,
 * per rule 1 -- a reopen at a different value is refused outright), the
 * most recently opened one is returned, ordered deterministically
 * (`valid_from_t` then `id`) rather than left to query-plan order.
 */
export function irreversibleFactFor(entityId: string, key: string): IrreversibleFact | null {
  const db = getDatabase();

  const entity = db.prepare(`SELECT game_id FROM entities WHERE id = ?`).get(entityId) as
    | { game_id: string }
    | undefined;
  if (!entity) return null;

  const row = db
    .prepare(
      `SELECT id, entity_id, key, value, valid_from_t FROM facts
        WHERE entity_id = ? AND key = ? AND irreversible = 1
        ORDER BY valid_from_t DESC, id DESC
        LIMIT 1`
    )
    .get(entityId, key) as FactRow | undefined;
  if (!row) return null;

  return toIrreversibleFact(row, entity.game_id);
}

/**
 * Every irreversible fact belonging to `gameId`, optionally narrowed to one
 * entity. A listing, not a verdict (hard rule 2) -- there is no summary
 * count, no "is this game safe" flag, just the rows. Scoped to `gameId` via
 * a join on `entities` rather than trusting a caller-supplied entity list,
 * so one game's declarations can never leak into another's listing.
 */
export function listIrreversibleFacts(params: { gameId: string; entityId?: string }): IrreversibleFact[] {
  const db = getDatabase();

  let query = `
    SELECT f.id AS id, f.entity_id AS entity_id, f.key AS key, f.value AS value, f.valid_from_t AS valid_from_t
    FROM facts f
    JOIN entities e ON e.id = f.entity_id
    WHERE e.game_id = ? AND f.irreversible = 1
  `;
  const args: string[] = [params.gameId];
  if (params.entityId !== undefined) {
    query += ` AND f.entity_id = ?`;
    args.push(params.entityId);
  }
  query += ` ORDER BY f.valid_from_t, f.id`;

  const rows = db.prepare(query).all(...args) as FactRow[];
  return rows.map((row) => toIrreversibleFact(row, params.gameId));
}
