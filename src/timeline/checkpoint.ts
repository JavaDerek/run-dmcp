import { getDatabase } from "../db/connection.js";
import { currentStoryTime } from "./clock.js";
import { replay, type ReplayedEntity } from "./replay.js";
import { PROJECTED_TABLES, liveColumns } from "./projection.js";
import type { EntityKind } from "./kinds.js";

/**
 * One row where the live tables and the replayed timeline disagree.
 *
 * This is a record, not a verdict -- hard rule 2 (design §5.5, §13): the
 * engine reports what it found and the caller decides what it means. There
 * is no `isClean`, no severity, no summary string, and `timelineDivergences`
 * returning `[]` is itself the only "everything matched" this module ever
 * says. The Phase 1 checkpoint (design §11, §13) is the caller that treats a
 * non-empty result as a stop condition; that policy lives in the test, not
 * here.
 *
 * - `missing-entity`: a live row exists with no entity of `kind` alive at
 *   `now` for its id.
 * - `missing-row`: an entity of `kind` is alive at `now` with no live row.
 * - `value`: `key` (a column of `table`) disagrees between the live row and
 *   the fact valid at `now` -- covers a value mismatch, a non-NULL column
 *   with no fact, and a fact present where the column is NULL, all as the
 *   same shape (see `timelineDivergences`'s doc comment for why one
 *   comparison catches all three).
 * - `duplicate-fact`: more than one fact is valid at `now` for the same
 *   `(entityId, key)`. Checked directly against `facts`, never through
 *   `replay()`'s `Record<string, ReplayedFact>` -- a duplicate would
 *   collapse into that Record silently, so this is the one divergence a
 *   checkpoint that only called `replay()` could never see.
 */
export interface Divergence {
  reason: "missing-entity" | "missing-row" | "value" | "duplicate-fact";
  table: string;
  kind: EntityKind;
  entityId: string;
  key?: string;
  live?: string | null;
  replayed?: string | null;
}

/**
 * Design §13's Phase 1 stop condition, made checkable: does `replay(now)`
 * reproduce the live projected tables, exactly, for `gameId`?
 *
 * This calls `replay()` -- it does not re-derive "alive at t" or "valid at
 * t" from `entities`/`facts` itself. Re-implementing those predicates here
 * would make this a test of a second copy of the logic, not of the query
 * issue #4 exists to check; the whole reason a checkpoint is worth having is
 * that it exercises the same code path a real caller would. `liveColumns` is
 * imported from `projection.ts` for the same reason -- one owner for the
 * fact-key list, so this can never compare a different set of columns than
 * the triggers actually project.
 *
 * `now` is read from `timeline_clock.current_t` via `currentStoryTime` --
 * never a caller-supplied `t` -- because "current state" (design §11's
 * checkpoint) means *this game's* current position on its own timeline, not
 * an arbitrary point a test happened to pick.
 *
 * Every live column is compared as `CAST(... AS TEXT)`, produced by SQLite
 * on both sides of every comparison (this side, and inside `replay()`'s own
 * queries and the projection triggers that wrote the facts in the first
 * place). Comparing in JS would invent divergences that are not there:
 * `CAST(100.0 AS TEXT)` is `'100.0'` in SQLite, but better-sqlite3 hands the
 * same REAL column to JS as the number `100` -- see timeline-architecture.md
 * for the measured behaviour. A single strict-equality check between the
 * live `CAST` string (or `null`) and the replayed fact's value (or `null`
 * when no fact is open) is then enough to catch all three `value` shapes at
 * once: a live NULL with an open fact, a non-NULL live column with no open
 * fact, and two non-NULL values that simply disagree -- there is no reason
 * to special-case any of them, because `null !== "x"` is already true for
 * every combination that should diverge and false for every one that
 * shouldn't.
 */
export function timelineDivergences(gameId: string): Divergence[] {
  const db = getDatabase();

  // No clock row means nothing has ever been declared or written for this
  // game -- there is no `now` to replay to, and (by construction: every
  // projection trigger bootstraps a clock row on its game's first insert)
  // no live row anywhere could exist for it either. Nothing to compare,
  // nothing to diverge.
  const clock = currentStoryTime(gameId);
  if (!clock) return [];
  const now = clock.t;

  const snapshot = replay({ gameId, t: now });

  // Index the snapshot by (kind, id) once, rather than scanning the whole
  // snapshot per projected table -- PROJECTED_TABLES has one row per kind,
  // and this runs once per checkpoint call, not once per entity.
  const aliveByKind = new Map<EntityKind, Map<string, ReplayedEntity>>();
  for (const entity of snapshot.entities) {
    let byId = aliveByKind.get(entity.kind);
    if (!byId) {
      byId = new Map();
      aliveByKind.set(entity.kind, byId);
    }
    byId.set(entity.id, entity);
  }

  const divergences: Divergence[] = [];

  for (const row of PROJECTED_TABLES) {
    const cols = liveColumns(db, row.table);
    // Every column CAST(... AS TEXT) in the same SELECT that fetches the
    // live row -- see this function's doc comment for why that CAST has to
    // happen in SQL rather than after the row reaches JS.
    const columnList = cols.map((col) => `CAST(${col} AS TEXT) AS "${col}"`).join(", ");
    const liveRows = db
      .prepare(`SELECT id, ${columnList} FROM ${row.table} WHERE ${row.gameIdColumn} = ?`)
      .all(gameId) as Array<Record<string, string | null>>;

    const aliveOfKind = aliveByKind.get(row.kind) ?? new Map<string, ReplayedEntity>();
    const liveIds = new Set<string>();

    for (const liveRow of liveRows) {
      const id = liveRow.id as string;
      liveIds.add(id);

      const entity = aliveOfKind.get(id);
      if (!entity) {
        divergences.push({ reason: "missing-entity", table: row.table, kind: row.kind, entityId: id });
        continue;
      }

      for (const col of cols) {
        const liveValue = liveRow[col];
        const fact = entity.facts[col];
        const replayedValue = fact ? fact.value : null;
        if (liveValue !== replayedValue) {
          divergences.push({
            reason: "value",
            table: row.table,
            kind: row.kind,
            entityId: id,
            key: col,
            live: liveValue,
            replayed: replayedValue,
          });
        }
      }
    }

    for (const id of aliveOfKind.keys()) {
      if (!liveIds.has(id)) {
        divergences.push({ reason: "missing-row", table: row.table, kind: row.kind, entityId: id });
      }
    }
  }

  // duplicate-fact: the one divergence replay() itself could never surface,
  // because its Record<string, ReplayedFact> is keyed by `key` -- a second
  // fact valid at `now` for the same (entity_id, key) would just overwrite
  // the first in that Record rather than raise anything. Checked directly
  // against `facts`, scoped to this game's own entities via the join.
  const tableByKind = new Map(PROJECTED_TABLES.map((r) => [r.kind, r.table]));
  const duplicateRows = db
    .prepare(
      `SELECT f.entity_id AS entityId, f.key AS key, e.kind AS kind
       FROM facts f
       JOIN entities e ON e.id = f.entity_id
       WHERE e.game_id = ?
         AND f.valid_from_t <= ?
         AND (f.valid_to_t IS NULL OR f.valid_to_t > ?)
       GROUP BY f.entity_id, f.key
       HAVING COUNT(*) > 1`
    )
    .all(gameId, now, now) as Array<{ entityId: string; key: string; kind: EntityKind }>;

  for (const dup of duplicateRows) {
    divergences.push({
      reason: "duplicate-fact",
      table: tableByKind.get(dup.kind) ?? dup.kind,
      kind: dup.kind,
      entityId: dup.entityId,
      key: dup.key,
    });
  }

  return divergences;
}
