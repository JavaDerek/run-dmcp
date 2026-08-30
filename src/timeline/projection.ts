import { getDatabase, withTransaction } from "../db/connection.js";
import type { EntityKind } from "./kinds.js";
import type Database from "better-sqlite3";

/**
 * One row of live world state, kept in sync with the timeline by generated
 * triggers (issue #2). `kind` is typed `EntityKind`, not `string` -- a typo
 * here is a compile error, not a runtime FK violation discovered later.
 *
 * These are exactly design §8's "Core, and this is the correction" row:
 * entity/property concepts (a game, a character, a location, a thing owned
 * by one of those, a numeric value, a link between two entities, a group,
 * a fact someone may or may not know). Dice, combat, abilities, status
 * effects, random tables and quests are the RPG layer built ON this core,
 * not part of it -- they are out of scope for Phase 1 (design §11) and
 * nothing about this registry needs them to exist.
 *
 * Adding a table later -- when the RPG layer's own phase arrives, or when
 * some other real caller needs one -- is one row here. Nothing else changes,
 * because `installProjectionTriggers` and `reconcileTimeline` below are both
 * generated from this list plus the table's live column set: there is no
 * second place carrying a parallel field list to fall out of sync.
 */
export interface ProjectedTable {
  table: string;
  kind: EntityKind;
  gameIdColumn: string;
  nameColumn: string | null;
}

export const PROJECTED_TABLES: ProjectedTable[] = [
  { table: "games", kind: "game", gameIdColumn: "id", nameColumn: "name" },
  { table: "characters", kind: "character", gameIdColumn: "game_id", nameColumn: "name" },
  { table: "locations", kind: "location", gameIdColumn: "game_id", nameColumn: "name" },
  { table: "items", kind: "item", gameIdColumn: "game_id", nameColumn: "name" },
  { table: "resources", kind: "resource", gameIdColumn: "game_id", nameColumn: "name" },
  { table: "relationships", kind: "relationship", gameIdColumn: "game_id", nameColumn: null },
  { table: "factions", kind: "faction", gameIdColumn: "game_id", nameColumn: "name" },
  { table: "secrets", kind: "secret", gameIdColumn: "game_id", nameColumn: "name" },
];

/**
 * The live column list for `table`, excluding `id`. Fact keys are every
 * column except `id` -- reading this from `pragma_table_info` rather than
 * carrying a hand-written field list per table is the entire point: a
 * column added by one of `src/db/schema.ts`'s idempotent `ALTER TABLE`
 * blocks is picked up the next time this runs, with no second place to
 * remember to update. See `installProjectionTriggers`'s doc comment for why
 * this is re-read on every call rather than cached.
 *
 * Exported so the checkpoint (issue #4) reads fact keys from this exact
 * function rather than carrying a second copy of the same query -- one
 * owner for the column list, or a checkpoint could pass while comparing a
 * different set of columns than the triggers actually project.
 */
export function liveColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
    .map((r) => r.name)
    .filter((name) => name !== "id");
}

/**
 * The single expression, reused everywhere `t` is needed inside a trigger
 * body: the current position of `gidExpr`'s sequence clock. Centralized so
 * every call site spells it identically -- and every occurrence inside one
 * trigger body evaluates to the same value, because the clock is advanced
 * exactly once, at the top of the body, and this expression only reads it.
 */
function tExpr(gidExpr: string): string {
  return `(SELECT current_t FROM timeline_clock WHERE game_id = ${gidExpr})`;
}

/**
 * `AFTER INSERT`: ensure the game's clock row exists, advance it, insert the
 * entity, insert one fact per non-NULL column, insert a `<kind>.created`
 * event. Column names are interpolated directly (never bound as parameters)
 * because they come from this codebase's own `pragma_table_info`, never
 * from anything a caller supplied -- there is no user input anywhere in
 * this SQL (trigger-sql-skeleton trap #6).
 */
function buildInsertTrigger(row: ProjectedTable, cols: string[]): string {
  const gid = `NEW.${row.gameIdColumn}`;
  const t = tExpr(gid);
  const nameExpr = row.nameColumn ? `NEW.${row.nameColumn}` : "NULL";

  const factInserts = cols
    .map(
      (col) => `
  INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible)
    SELECT lower(hex(randomblob(16))), NEW.id, '${col}', CAST(NEW.${col} AS TEXT), ${t}, NULL, 0
    WHERE NEW.${col} IS NOT NULL;`
    )
    .join("\n");

  return `
    DROP TRIGGER IF EXISTS timeline_${row.table}_ai;
    CREATE TRIGGER timeline_${row.table}_ai AFTER INSERT ON ${row.table}
    BEGIN
      INSERT OR IGNORE INTO timeline_clock (game_id, current_t, axis_kind, axis_unit, declared_at)
        VALUES (${gid}, 0, 'sequence', 'write', '');
      UPDATE timeline_clock SET current_t = current_t + 1
        WHERE game_id = ${gid} AND axis_kind = 'sequence';

      INSERT INTO entities (id, game_id, kind, name, created_at_t, destroyed_at_t)
        VALUES (NEW.id, ${gid}, '${row.kind}', ${nameExpr}, ${t}, NULL);
${factInserts}

      INSERT INTO events (id, game_id, at_t, kind, description, causes)
        VALUES (lower(hex(randomblob(16))), ${gid}, ${t}, '${row.kind}.created', '${row.kind} created',
                json_object('table', '${row.table}', 'row_id', NEW.id));
    END;
  `;
}

/**
 * `AFTER UPDATE`: for each column, close the currently-open fact if the new
 * value differs (`IS NOT`, never `<>` -- see trap #4: `<>` against NULL is
 * NULL, so the WHEN/comparison silently never fires on exactly the rows
 * that matter), then open a new one if the new value is non-NULL and
 * differs from whatever is still open. Close-then-open, in that order, per
 * column: reversed, the open's subquery would still see the value the
 * close was about to retire and write nothing (trap #3). The five-case
 * table this produces is walked by the test suite, not re-derived here.
 */
function buildUpdateTrigger(row: ProjectedTable, cols: string[]): string {
  const gid = `NEW.${row.gameIdColumn}`;
  const t = tExpr(gid);

  const perColumn = cols
    .map(
      (col) => `
      UPDATE facts SET valid_to_t = ${t}
        WHERE entity_id = NEW.id AND key = '${col}' AND valid_to_t IS NULL
          AND CAST(NEW.${col} AS TEXT) IS NOT value;

      INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible)
        SELECT lower(hex(randomblob(16))), NEW.id, '${col}', CAST(NEW.${col} AS TEXT), ${t}, NULL, 0
        WHERE NEW.${col} IS NOT NULL
          AND CAST(NEW.${col} AS TEXT) IS NOT
              (SELECT value FROM facts WHERE entity_id = NEW.id AND key = '${col}' AND valid_to_t IS NULL);`
    )
    .join("\n");

  return `
    DROP TRIGGER IF EXISTS timeline_${row.table}_au;
    CREATE TRIGGER timeline_${row.table}_au AFTER UPDATE ON ${row.table}
    BEGIN
      UPDATE timeline_clock SET current_t = current_t + 1
        WHERE game_id = ${gid} AND axis_kind = 'sequence';
${perColumn}

      INSERT INTO events (id, game_id, at_t, kind, description, causes)
        VALUES (lower(hex(randomblob(16))), ${gid}, ${t}, '${row.kind}.updated', '${row.kind} updated',
                json_object('table', '${row.table}', 'row_id', NEW.id));
    END;
  `;
}

/**
 * `AFTER DELETE`: close every open fact for the entity, set
 * `destroyed_at_t`, insert a `<kind>.destroyed` event. `games` gets one
 * more thing: a belt-and-braces sweep that closes every open fact and
 * destroys every entity of that game directly, regardless of whether
 * `ON DELETE CASCADE` on the child tables' own foreign keys already fired
 * their `_ad` triggers. Measured (see timeline-architecture.md): cascade
 * *does* fire the child triggers in this engine, which makes the sweep
 * redundant in the common case -- it stays anyway, `WHERE ... IS NULL`
 * throughout so it is idempotent, because it makes the guarantee
 * (a destroyed game leaves no live entity or open fact behind) independent
 * of that cascade setting rather than resting on it.
 */
function buildDeleteTrigger(row: ProjectedTable): string {
  const gid = `OLD.${row.gameIdColumn}`;
  const t = tExpr(gid);

  const gameSweep =
    row.table === "games"
      ? `
      UPDATE facts SET valid_to_t = ${t}
        WHERE valid_to_t IS NULL
          AND entity_id IN (SELECT id FROM entities WHERE game_id = OLD.id AND destroyed_at_t IS NULL);
      UPDATE entities SET destroyed_at_t = ${t} WHERE game_id = OLD.id AND destroyed_at_t IS NULL;`
      : "";

  return `
    DROP TRIGGER IF EXISTS timeline_${row.table}_ad;
    CREATE TRIGGER timeline_${row.table}_ad AFTER DELETE ON ${row.table}
    BEGIN
      UPDATE timeline_clock SET current_t = current_t + 1
        WHERE game_id = ${gid} AND axis_kind = 'sequence';

      UPDATE facts SET valid_to_t = ${t}
        WHERE entity_id = OLD.id AND valid_to_t IS NULL;

      UPDATE entities SET destroyed_at_t = ${t}
        WHERE id = OLD.id AND destroyed_at_t IS NULL;
${gameSweep}

      INSERT INTO events (id, game_id, at_t, kind, description, causes)
        VALUES (lower(hex(randomblob(16))), ${gid}, ${t}, '${row.kind}.destroyed', '${row.kind} destroyed',
                json_object('table', '${row.table}', 'row_id', OLD.id));
    END;
  `;
}

/**
 * Installs the three generated triggers (`_ai` / `_au` / `_ad`) for every
 * row of `PROJECTED_TABLES`. `DROP TRIGGER IF EXISTS` then `CREATE`, every
 * time this runs -- not `CREATE TRIGGER IF NOT EXISTS` -- for the same
 * reason `src/timeline/schema.ts`'s append-only guards are DROP-then-CREATE:
 * the column set a trigger was generated from is exactly the thing that
 * changes when a migration adds a column, and `IF NOT EXISTS` would freeze
 * whatever set was live the first time a given database was ever opened.
 * Called from `initializeTimelineSchema()` (`src/timeline/schema.ts`) after
 * every `ALTER TABLE` in `src/db/schema.ts` has already run, so the column
 * list read here is always the final one for this startup.
 *
 * SQLite runs a trigger inside the firing statement's transaction (measured
 * behaviour, see timeline-architecture.md) -- that is what makes the state
 * write and the timeline append one unit by construction, with nothing in
 * `src/tools/` or `src/register/` needing to know any of this exists.
 */
export function installProjectionTriggers(): void {
  const db = getDatabase();
  for (const row of PROJECTED_TABLES) {
    const cols = liveColumns(db, row.table);
    db.exec(buildInsertTrigger(row, cols));
    db.exec(buildUpdateTrigger(row, cols));
    db.exec(buildDeleteTrigger(row));
  }
}

/**
 * Backfills `entities`/`facts` for every row of every projected table, so
 * that `replay(t)` (issue #3) is correct even for state the generated
 * triggers above never saw. Exactly two situations produce that gap:
 *
 *   1. a database that predates the timeline (or predates a given
 *      projected table being added to it), where every existing row was
 *      written before any trigger existed to append for it;
 *   2. a column added to a projected table by one of `src/db/schema.ts`'s
 *      `ALTER TABLE` blocks, which the *next* `initializeSchema()` picks up
 *      for triggers (via `installProjectionTriggers`) but which every row
 *      already on disk was written before that trigger existed either.
 *
 * It runs exactly once, at init, wrapped in one `withTransaction()` so a
 * failure partway through leaves nothing backfilled rather than half of it
 * -- and never mid-session, which is what keeps it from ever being asked to
 * paper over a *lossy log*: if a session-time write failed to append (a bug
 * this issue exists to make impossible), reconciliation running later would
 * quietly manufacture a fact that was never actually recorded when it
 * happened, at the wrong `t`. Startup-only means it only ever backfills
 * state nothing had a chance to record yet, never state something dropped.
 *
 * The per-column reconciliation is deliberately the same close-then-open
 * shape as the `AFTER UPDATE` trigger (`buildUpdateTrigger`), just driven by
 * a table scan instead of `NEW`, so a divergent live value is corrected the
 * same way an update would have corrected it -- including a column that
 * reverted to NULL since the last reconciliation, which closes its stale
 * open fact and opens nothing (hard rule 3: absence is the absence of a
 * fact). The instructions for issue #2 describe this case only for
 * "non-NULL column"; closing an orphaned open fact for a column that is now
 * NULL is this function's own extension of that shape, made for the same
 * reason the update trigger makes it: leaving a stale open fact behind for
 * a column with no live value is exactly the kind of drift `replay(t)` must
 * never be able to produce.
 */
export function reconcileTimeline(): void {
  withTransaction(() => {
    const db = getDatabase();
    for (const row of PROJECTED_TABLES) {
      reconcileTable(db, row);
    }
  });
}

function reconcileTable(db: Database.Database, row: ProjectedTable): void {
  const { table, gameIdColumn: gidCol } = row;

  // 1. Every game referenced by a live row in this table gets a clock row
  //    if one doesn't already exist -- covers a database with no clock rows
  //    at all (the timeline never having run against it before).
  db.prepare(
    `
    INSERT OR IGNORE INTO timeline_clock (game_id, current_t, axis_kind, axis_unit, declared_at)
    SELECT DISTINCT ${gidCol}, 0, 'sequence', 'write', '' FROM ${table}
  `
  ).run();

  // 2. Every live row gets an entity if it doesn't already have one, created
  //    at wherever its game's clock currently sits. There is no real history
  //    to backdate a pre-existing row to -- only "as of this reconciliation."
  const nameExpr = row.nameColumn ? `src.${row.nameColumn}` : "NULL";
  db.prepare(
    `
    INSERT INTO entities (id, game_id, kind, name, created_at_t, destroyed_at_t)
    SELECT src.id, src.${gidCol}, ?, ${nameExpr},
           (SELECT current_t FROM timeline_clock WHERE game_id = src.${gidCol}), NULL
    FROM ${table} src
    WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = src.id)
  `
  ).run(row.kind);

  // 3. Per column, close-then-open against the live value, restricted to
  //    entities whose domain row still exists (a destroyed entity's row is
  //    gone from `table` and must not be touched here -- its facts were
  //    already closed by the delete trigger). CAST comparisons happen in
  //    SQL end to end, never in JS -- see the measured-behaviour note in
  //    timeline-architecture.md on why comparing a fact value in JS
  //    manufactures divergences that are not real.
  for (const col of liveColumns(db, table)) {
    // `AND facts.irreversible = 0`: an irreversible fact is deliberately
    // left alone here, even when it has diverged from the live column --
    // see the doc comment above for why. Without this clause, a divergence
    // against an irreversible fact would close it and then fail to reopen
    // it (timeline_facts_irreversible in schema.ts refuses the contradicting
    // INSERT below), throwing this whole reconciliation -- and therefore
    // initializeSchema() itself -- out at startup. With it, the close is
    // simply skipped, the divergence persists for timelineDivergences()
    // (checkpoint.ts) to report, and the server still boots.
    //
    // `AND NOT EXISTS (... resolve_only ...)` (issue #13) is the identical
    // rule for the identical reason, one row over: a `resolve_only`
    // constraint's whole job is to make timeline_facts_resolve_only
    // (src/db/schema.ts) refuse an INSERT for its (entity_id, key) with no
    // adjudication window open -- and reconciliation is not an adjudicating
    // call, so the open-INSERT below would hit that trigger and abort for
    // exactly the same reason a divergent irreversible fact hits
    // timeline_facts_irreversible. Skipping the close here (so a fact this
    // guard cannot reopen is never closed in the first place) is what keeps
    // that abort from ever firing, and lets the divergence persist for
    // timelineDivergences() to report instead of taking initializeSchema()
    // down with it. The subquery mirrors timeline_facts_resolve_only's own
    // WHEN clause exactly -- same JOIN, same predicate -- because this is
    // the same question asked from the reconciliation side rather than the
    // trigger side, and a second, differently-shaped query here could
    // silently drift from what the trigger actually enforces.
    db.prepare(
      `
      UPDATE facts SET valid_to_t = (
          SELECT current_t FROM timeline_clock WHERE game_id = (
            SELECT ${gidCol} FROM ${table} WHERE id = facts.entity_id
          )
        )
        WHERE key = ?
          AND valid_to_t IS NULL
          AND entity_id IN (SELECT id FROM ${table})
          AND CAST((SELECT ${col} FROM ${table} WHERE id = facts.entity_id) AS TEXT) IS NOT value
          AND facts.irreversible = 0
          AND NOT EXISTS (
            SELECT 1 FROM resource_constraints rc
              JOIN resource_constraint_members rcm ON rcm.constraint_id = rc.id
             WHERE rc.kind = 'resolve_only'
               AND rcm.resource_id = facts.entity_id
               AND rc.fact_key = facts.key
          )
    `
    ).run(col);

    // Same guard on the open-INSERT: a resolve_only-governed key whose close
    // above was skipped still has its OLD fact open (valid_to_t IS NULL), so
    // `NOT EXISTS (SELECT 1 FROM facts f WHERE ...)` below is already false
    // for it and this INSERT's own WHERE would skip that row regardless --
    // but a resolve_only-governed key with NO fact open at all (a database
    // predating the timeline entirely, backfilling for the first time) has
    // no such fact to make the WHERE skip it, and the very first INSERT for
    // that key is itself refused with no window open. Repeating the guard
    // here, rather than trusting the close-guard's side effect, covers that
    // case too.
    db.prepare(
      `
      INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible)
      SELECT lower(hex(randomblob(16))), src.id, ?, CAST(src.${col} AS TEXT),
             (SELECT current_t FROM timeline_clock WHERE game_id = src.${gidCol}), NULL, 0
      FROM ${table} src
      WHERE src.${col} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM facts f WHERE f.entity_id = src.id AND f.key = ? AND f.valid_to_t IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM resource_constraints rc
            JOIN resource_constraint_members rcm ON rcm.constraint_id = rc.id
           WHERE rc.kind = 'resolve_only'
             AND rcm.resource_id = src.id
             AND rc.fact_key = ?
        )
    `
    ).run(col, col, col);
  }
}
