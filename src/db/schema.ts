import type Database from "better-sqlite3";
import { getDatabase, withTransaction } from "./connection.js";
import { createLogger } from "../utils/logger.js";
import { initializeTimelineSchema } from "../timeline/schema.js";
import { initializeAdjudicationSchema } from "../timeline/adjudication.js";

const log = createLogger("schema");

/**
 * A schema change a consuming application wants applied to the same SQLite
 * file the engine's own tables live in, during the engine's own startup
 * pass. Passed as an array to `initializeSchema()`, not registered through
 * a global function: a registry would make the engine's schema depend on
 * module import order and on side effects at import time, which is exactly
 * what this release is removing elsewhere. A parameter can't be "registered
 * too late" -- it's either in the array passed to the one call that matters,
 * or it isn't.
 *
 * There is no framework: no version table, no record of what already ran,
 * no down-migrations. Every migration in the array runs on every startup,
 * exactly like the engine's own DDL below, which is what forces `up` to be
 * idempotent (`CREATE TABLE IF NOT EXISTS`, and
 * `try { db.exec("ALTER TABLE ...") } catch {}` for added columns).
 *
 * Migrations run after every core table has been created, so `up` may
 * declare a foreign key into one (e.g. `games`).
 */
export interface SchemaMigration {
  /** Stable identifier. Used for duplicate detection and error messages. */
  name: string;
  /** Applies the migration. MUST be idempotent: it runs on every startup. */
  up(db: Database.Database): void;
}

/**
 * Run one whole-table CHECK rebuild with foreign-key enforcement suspended,
 * and verify afterwards that nothing was left dangling.
 *
 * SQLite cannot ALTER a CHECK, so widening one means rebuilding the table:
 * copy the rows aside, DROP, CREATE with the new CHECK, copy back. Two
 * migrations in this file do that, and both need the same two guarantees.
 *
 * ENFORCEMENT MUST BE OFF ACROSS THE DROP. With it on, `DROP TABLE` performs
 * an implicit per-row DELETE first, precisely so that any ON DELETE action
 * declared against that table fires as though each row had genuinely been
 * deleted -- which for both of these tables means cascade-emptying the tables
 * that reference them. Suspending it is what makes the drop a schema
 * operation instead of a silent mass deletion. It is toggled out here rather
 * than inside `withTransaction`, because `PRAGMA foreign_keys` is a
 * documented no-op while a transaction is pending.
 *
 * AND IT MUST GO BACK ON WHEN THE REBUILD THROWS, which is why the restore is
 * in a `finally` and why this is a shared function rather than two copies.
 * Both call sites previously restored it on the success path only.
 * `getDatabase()` caches one connection at module scope, so a rebuild that
 * threw handed the rest of the process a handle with foreign keys still
 * disabled -- and a disabled foreign key does not announce itself. It means
 * every ON DELETE CASCADE in this schema quietly stops working: deleting a
 * game orphans its characters, resources, locations and secrets instead of
 * taking them with it, and nothing errors. The scenario is not exotic -- a
 * staging table left behind by a rebuild that died partway is exactly what
 * makes the next startup's `CREATE TABLE ..._staging` throw. Covered by
 * `src/db/__tests__/foreignKeysRestored.test.ts`.
 */
function rebuildWithForeignKeysSuspended(
  db: Database.Database,
  label: string,
  rebuild: () => void
): void {
  db.pragma("foreign_keys = OFF");
  try {
    withTransaction(rebuild);

    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `${label} CHECK migration left dangling foreign keys: ` + JSON.stringify(violations)
      );
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export function initializeSchema(options?: { migrations?: readonly SchemaMigration[] }): void {
  const db = getDatabase();

  // ============================================================================
  // MIGRATION: Rename 'sessions' to 'games' and 'session_id' to 'game_id'
  // This handles existing databases that use the old 'session' terminology
  // ============================================================================

  // Check if the old 'sessions' table exists and migrate to 'games'
  const sessionsTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
  ).get();

  if (sessionsTableExists) {
    // Rename the main sessions table to games
    db.exec(`ALTER TABLE sessions RENAME TO games`);

    // Rename session_id columns to game_id in all tables that have them
    const tablesWithSessionId = [
      'characters', 'locations', 'items', 'quests', 'narrative_events',
      'combats', 'resources', 'game_time', 'scheduled_events', 'timers',
      'random_tables', 'secrets', 'relationships', 'factions', 'abilities',
      'status_effects', 'tags', 'notes', 'external_updates', 'pause_states',
      'stored_images', 'stored_audio'
    ];

    for (const table of tablesWithSessionId) {
      try {
        db.exec(`ALTER TABLE ${table} RENAME COLUMN session_id TO game_id`);
      } catch {
        // Column doesn't exist or already renamed
      }
    }

    // Rename session_themes table to game_themes if it exists
    try {
      // First rename the column, then rename the table
      db.exec(`ALTER TABLE session_themes RENAME COLUMN session_id TO game_id`);
      db.exec(`ALTER TABLE session_themes RENAME TO game_themes`);
    } catch {
      // Table doesn't exist or already renamed
    }
  }

  // Fix for edge case where game_themes table exists but has session_id column
  // This can happen if the above RENAME COLUMN failed but RENAME TO succeeded
  const gameThemesHasSessionId = db.prepare(
    "SELECT name FROM pragma_table_info('game_themes') WHERE name = 'session_id'"
  ).get();

  if (gameThemesHasSessionId) {
    // Recreate the table with correct column name
    db.exec(`
      CREATE TABLE game_themes_fixed (
        game_id TEXT PRIMARY KEY,
        config TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
      INSERT INTO game_themes_fixed (game_id, config, updated_at)
        SELECT session_id, config, updated_at FROM game_themes;
      DROP TABLE game_themes;
      ALTER TABLE game_themes_fixed RENAME TO game_themes;
    `);
  }

  // Games table (formerly sessions)
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      setting TEXT NOT NULL,
      style TEXT NOT NULL,
      rules TEXT,
      preferences TEXT,
      current_location_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Add preferences column if it doesn't exist (migration)
  try {
    db.exec(`ALTER TABLE games ADD COLUMN preferences TEXT`);
  } catch {
    // Column already exists
  }

  // Add title_image_id column if it doesn't exist (migration)
  try {
    db.exec(`ALTER TABLE games ADD COLUMN title_image_id TEXT`);
  } catch {
    // Column already exists
  }

  // Add favicon_image_id column if it doesn't exist (migration)
  try {
    db.exec(`ALTER TABLE games ADD COLUMN favicon_image_id TEXT`);
  } catch {
    // Column already exists
  }

  // Characters table
  db.exec(`
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_player INTEGER NOT NULL DEFAULT 0,
      attributes TEXT NOT NULL DEFAULT '{}',
      skills TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT '{}',
      location_id TEXT,
      notes TEXT DEFAULT '',
      voice TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Add voice column if it doesn't exist (migration for existing databases)
  try {
    db.exec(`ALTER TABLE characters ADD COLUMN voice TEXT`);
  } catch {
    // Column already exists
  }

  // Add image_gen column to characters
  try {
    db.exec(`ALTER TABLE characters ADD COLUMN image_gen TEXT`);
  } catch {
    // Column already exists
  }

  // Locations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}',
      image_gen TEXT,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Add image_gen column to locations
  try {
    db.exec(`ALTER TABLE locations ADD COLUMN image_gen TEXT`);
  } catch {
    // Column already exists
  }

  // Items table
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('character', 'location')),
      name TEXT NOT NULL,
      properties TEXT NOT NULL DEFAULT '{}',
      image_gen TEXT,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Add image_gen column to items
  try {
    db.exec(`ALTER TABLE items ADD COLUMN image_gen TEXT`);
  } catch {
    // Column already exists
  }

  // Quests table
  db.exec(`
    CREATE TABLE IF NOT EXISTS quests (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      objectives TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed', 'abandoned')),
      rewards TEXT,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Narrative events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS narrative_events (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Combat table
  db.exec(`
    CREATE TABLE IF NOT EXISTS combats (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      participants TEXT NOT NULL DEFAULT '[]',
      current_turn INTEGER NOT NULL DEFAULT 0,
      round INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
      log TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Resources table (for tracking currency, reputation, counters, etc.)
  //
  // `RESOURCES_DDL` is a shared constant, not a literal inlined here, for the
  // same reason `RESOURCE_CONSTRAINTS_DDL` further down is one: the CHECK-
  // rebuild migration immediately below needs this exact text executed in
  // TWO places -- here, for a fresh database, and again inside the rebuild,
  // for a database that still carries the OLD two-member CHECK. Sharing one
  // JS string is what makes "a fresh database and a migrated database
  // converge on byte-identical `sqlite_master.sql` for this table" true BY
  // CONSTRUCTION rather than by two hand-written literals happening to agree
  // today.
  const RESOURCES_DDL = `
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      owner_id TEXT,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('game', 'character', 'faction', 'location')),
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      value REAL NOT NULL DEFAULT 0,
      min_value REAL,
      max_value REAL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `;
  db.exec(RESOURCES_DDL);

  // Migration: widen `resources.owner_type` to admit 'faction' and
  // 'location' alongside 'game' and 'character'. A resource owned by a
  // faction or a location is generic mechanism -- the engine already has
  // `factions` and `locations` tables; this just lets `resources` point at
  // either the way it already points at a `game` or a `character` -- so it
  // belongs here rather than behind a downstream application's own migration.
  //
  // SQLite cannot ALTER a CHECK constraint, so a database that already has
  // `resources` rows under the OLD two-member CHECK needs the same full-
  // table-rebuild recipe the `resource_constraints` CHECK-widening migration
  // uses further down this function (see that block's comment for the
  // detailed reasoning this one leans on): build a replacement table with
  // the new CHECK, copy every row across, drop the old table, put the
  // replacement in its place.
  //
  // DETECTION IS IDEMPOTENT AND LITERAL, not a guess: read this codebase's
  // OWN generated DDL back out of `sqlite_master` and check whether it
  // already contains the token 'faction' -- the same "a literal check for a
  // token we defined in output we generated is fine" carve-out the
  // `resource_constraints` migration's own comment cites (hard rule 4 in the
  // downstream game's own engineering standards; this engine has no
  // narrative-language rule of its own to point at, but the reasoning is the
  // same: this is a substring check against SQL text THIS FUNCTION generated
  // a few lines above, never against anything a player or a model wrote). A
  // truly fresh database never takes the branch below: `RESOURCES_DDL`'s
  // `CREATE TABLE IF NOT EXISTS` a few lines up already carries the widened
  // CHECK, so by the time this runs, this database's own `resources` already
  // contains 'faction'.
  const resourcesDdl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'`)
    .get() as { sql: string } | undefined;

  if (resourcesDdl && !resourcesDdl.sql.includes("faction")) {
    // DROP THE PROJECTION TRIGGERS FIRST, UNCONDITIONALLY, IF THEY EXIST.
    // `timeline_resources_ai`/`_au`/`_ad` are defined ON `resources` itself
    // (`AFTER INSERT/UPDATE/DELETE ON resources`), so SQLite drops them
    // automatically the moment `DROP TABLE resources` below runs -- but
    // dropping them here too, explicitly, costs nothing and removes any
    // dependence on that implicit behaviour being exactly right. They are
    // unconditionally reinstalled, generated fresh off the rebuilt table's
    // own `pragma_table_info`, by `installProjectionTriggers()`
    // (`src/timeline/projection.ts`), which `initializeTimelineSchema()`
    // calls LAST in this function -- see the comment on that call for why it
    // runs after every migration above it, this one included.
    db.exec(`DROP TRIGGER IF EXISTS timeline_resources_ai`);
    db.exec(`DROP TRIGGER IF EXISTS timeline_resources_au`);
    db.exec(`DROP TRIGGER IF EXISTS timeline_resources_ad`);

    // Enforcement has to be suspended across the drop, and put back
    // afterwards on every path -- see `rebuildWithForeignKeysSuspended`. Here
    // the tables that would be cascade-emptied are `resource_history` and
    // `resource_constraint_members`, both of which declare
    // `FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE`.
    rebuildWithForeignKeysSuspended(db, "resources.owner_type", () => {
      // 1. Copy the OLD table's rows into a staging table under a temporary
      //    name, already carrying the widened CHECK.
      db.exec(`
        CREATE TABLE resources_staging (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          owner_id TEXT,
          owner_type TEXT NOT NULL CHECK (owner_type IN ('game', 'character', 'faction', 'location')),
          name TEXT NOT NULL,
          description TEXT,
          category TEXT,
          value REAL NOT NULL DEFAULT 0,
          min_value REAL,
          max_value REAL,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO resources_staging (id, game_id, owner_id, owner_type, name, description, category, value, min_value, max_value, created_at)
        SELECT id, game_id, owner_id, owner_type, name, description, category, value, min_value, max_value, created_at FROM resources
      `);

      // 2. Drop the OLD table outright -- not renamed. Renaming it out of
      //    the way first would rewrite `resource_history` and
      //    `resource_constraint_members`'s own stored FOREIGN KEY clauses to
      //    point at the temporary name (RENAME TO rewrites every OTHER
      //    table's FK text that references the renamed table, regardless of
      //    the `foreign_keys` pragma), leaving them permanently dangling
      //    once that temporary table is dropped a few steps later. `DROP
      //    TABLE`, unlike `RENAME TO`, does not rewrite other tables'
      //    references -- there is nothing to rewrite them TO -- so this
      //    recipe never renames the table other tables' foreign keys point
      //    at; the FINAL name is produced by a genuine `CREATE TABLE`
      //    instead, and `resource_history`/`resource_constraint_members`'s
      //    FK text is never touched by anything in this block.
      db.exec(`DROP TABLE resources`);

      // 3. Recreate under the FINAL name using the exact same DDL text the
      //    fresh-database path executed above -- `RESOURCES_DDL` itself, not
      //    a second hand-copied literal -- so its stored SQL matches the
      //    fresh-database path byte for byte.
      db.exec(RESOURCES_DDL);

      // 4. Copy every row back across from the staging table with an
      //    EXPLICIT column list -- never SELECT * -- and drop the staging
      //    table. Every id was copied verbatim, so `resource_history` and
      //    `resource_constraint_members`'s own `FOREIGN KEY (resource_id)
      //    REFERENCES resources(id)` -- never touched by any of the steps
      //    above -- is satisfied by the replacement table throughout,
      //    verified for real by the `PRAGMA foreign_key_check` below, not
      //    merely assumed here.
      db.exec(`
        INSERT INTO resources (id, game_id, owner_id, owner_type, name, description, category, value, min_value, max_value, created_at)
        SELECT id, game_id, owner_id, owner_type, name, description, category, value, min_value, max_value, created_at FROM resources_staging
      `);
      db.exec(`DROP TABLE resources_staging`);
    });
  }

  // Resource history table (tracks all changes) -- FROZEN, see the trigger
  // immediately below. Kept for existing rows only; nothing writes here any
  // more.
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_history (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      previous_value REAL NOT NULL,
      new_value REAL NOT NULL,
      delta REAL NOT NULL,
      reason TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
    )
  `);

  // Design §5.4 option (C) / issue #9, Phase 3: `resource_history` stops
  // being a mechanism. Interval-versioned `facts` (via the timeline's one
  // choke point, writeConstrainedValue/transferConstrainedValue in
  // src/timeline/constrained.ts) are now the ONLY record of what a
  // resource's value used to be -- see valueHistory() there, and
  // getResourceHistory() in src/tools/resource.ts, which reads through it.
  // This trigger makes the second write path this project spent its whole
  // history accumulating (see engineVocabulary.test.ts's epigraph on
  // resource_history/relationship_history) UNCONSTRUCTABLE rather than
  // merely undocumented: any INSERT here -- from old code nobody rewrote,
  // from a copy-pasted query, from anything -- aborts loudly instead of
  // silently reintroducing a second history.
  //
  // The table is frozen, not dropped. This project has no down-migrations
  // (root CLAUDE.md) and no framework beyond "idempotent DDL runs on every
  // startup" -- a migration that DROPped this table would destroy rows a
  // user's existing database may still hold, permanently, the first time
  // they upgraded, which is a strictly worse outcome than a table that
  // simply stops growing. Nothing reads it (getResourceHistory() no longer
  // does) and nothing writes it (this trigger); the rows already on disk
  // are inert history, not a mechanism.
  //
  // DROP TRIGGER IF EXISTS then CREATE, not CREATE TRIGGER IF NOT EXISTS --
  // the same reasoning src/timeline/schema.ts's append-only guards give for
  // their own triggers: IF NOT EXISTS would freeze whatever guard first
  // shipped for a given on-disk database forever, so a later fix to this
  // trigger's logic or message would silently never reach a database that
  // already had an older version installed. Dropping and recreating on
  // every startup keeps the guard a database actually has in sync with the
  // guard this build believes it deployed.
  db.exec(`
    DROP TRIGGER IF EXISTS resource_history_frozen;
    CREATE TRIGGER resource_history_frozen BEFORE INSERT ON resource_history
    BEGIN
      SELECT RAISE(ABORT, 'resource_history is frozen -- interval-versioned facts are now the only record of what a resource value used to be (design section 5.4 option C); write through writeConstrainedValue in src/timeline/constrained.ts instead');
    END;
  `);

  // Resource constraints table -- optional, server-enforced invariants on
  // resource values (see src/tools/constraint.ts). Opt-in: a resource with
  // no row here (directly or via resource_constraint_members) behaves
  // exactly as before this feature existed.
  //
  // `RESOURCE_CONSTRAINTS_DDL` is a shared constant, not a literal inlined
  // here, because issue #13's `resolve_only` (design §5.3's fourth
  // row-based member) needs this exact CHECK-widened text executed in TWO
  // places: here, for a fresh database, and again inside the CHECK-rebuild
  // migration further below, for a database that still carries the OLD
  // three-member CHECK (SQLite cannot ALTER a CHECK constraint -- widening
  // one needs a full table rebuild; see that block's comment for the
  // recipe). Sharing one JS string is what makes "a fresh database and a
  // migrated database converge on byte-identical `sqlite_master.sql` for
  // this table" true BY CONSTRUCTION rather than by two hand-written
  // literals happening to agree today -- resolveOnly.test.ts asserts
  // exactly that equality, and it would be a permanent, silent trap to
  // maintain as two copies.
  const RESOURCE_CONSTRAINTS_DDL = `
    CREATE TABLE IF NOT EXISTS resource_constraints (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('bounded', 'monotonic', 'conserved', 'resolve_only')),
      direction TEXT CHECK (direction IN ('increasing', 'decreasing')),
      total REAL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `;
  db.exec(RESOURCE_CONSTRAINTS_DDL);

  // Add fact_key column to resource_constraints (migration, Phase 3 / issue
  // #9 step 1, design §5.4 option (C)). A constraint governs a numeric
  // *fact key* on an entity, not an entire row -- once the generic
  // (entityId, factKey) choke point this column exists to prepare for
  // lands, an entity can carry more than one numeric fact, and a constraint
  // must say which one it governs or it would silently apply to all of
  // them. 'value' is the default because every constraint that exists
  // today (declared through declareBoundedConstraint/declareMonotonicConstraint/
  // declareConservedConstraint in src/tools/constraint.ts) governs
  // `resources.value` -- the sole numeric fact key any of them has ever
  // constrained -- so defaulting means an existing database needs no data
  // migration to keep reading its own constraints correctly. This column belongs on
  // resource_constraints (the constraint), NOT on resource_constraint_members
  // below: a 'conserved' set's members all share one key by construction
  // (they are summed against a single total), and putting it on the member
  // row would permit a set whose members are constrained on different
  // keys -- a generality nothing has asked for.
  //
  // Shared for the same reason RESOURCE_CONSTRAINTS_DDL is above: the
  // CHECK-rebuild migration below re-adds this exact column to its
  // replacement table, and reusing the identical statement text (rather
  // than a second hand-written ALTER) is what makes the fresh and migrated
  // paths' final stored SQL provably identical instead of coincidentally
  // similar.
  const RESOURCE_CONSTRAINTS_ADD_FACT_KEY_DDL = `ALTER TABLE resource_constraints ADD COLUMN fact_key TEXT NOT NULL DEFAULT 'value'`;
  try {
    db.exec(RESOURCE_CONSTRAINTS_ADD_FACT_KEY_DDL);
  } catch {
    // Column already exists
  }

  // Issue #13 / design §5.3, §5.4 option (C): widen resource_constraints'
  // `kind` CHECK to admit 'resolve_only', the fourth row-based constraint
  // family member. SQLite cannot ALTER a CHECK constraint -- unlike the
  // fact_key column just above, there is no `ALTER TABLE ... ADD` for
  // "loosen this CHECK" -- so a database that already has resource_constraints
  // rows under the OLD three-member CHECK needs SQLite's own documented
  // recipe for "other kinds of table schema changes": build a replacement
  // table with the new CHECK, copy every row across, drop the old table, and
  // put the replacement in its place. This is the riskiest part of issue #13
  // precisely because it is a real ALTER on a table other code already
  // depends on (resource_constraint_members' own FOREIGN KEY points at it),
  // so every step below is deliberate -- see resolveOnly.test.ts for the
  // "an existing database survives the rebuild with every row and every FK
  // intact" test this comment describes.
  //
  // DETECTION IS IDEMPOTENT AND LITERAL, not a guess: read this codebase's
  // OWN generated DDL back out of `sqlite_master` and check whether it
  // already contains the token 'resolve_only'. Hard rule 4 (never
  // pattern-match meaning) forbids deriving state by matching words or
  // phrases against natural language -- narrative text a model wrote, or a
  // player typed. This is neither: it is a literal substring check against
  // SQL text THIS FUNCTION generated a few lines above, for a token THIS
  // FUNCTION defined (the CHECK's own enum member). Rule 4 explicitly
  // permits exactly that ("a literal check for a token we defined in output
  // we generated is fine; understanding English is not") -- flagged here in
  // as many words because a future reader skimming a string-literal
  // `.includes()` check might otherwise mistake it for the thing rule 4
  // bans. A truly fresh database never takes the branch below:
  // RESOURCE_CONSTRAINTS_DDL's CREATE TABLE IF NOT EXISTS a few lines up
  // already carries the widened CHECK, so by the time this runs, this
  // database's own resource_constraints already contains 'resolve_only'.
  const resourceConstraintsDdl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_constraints'`)
    .get() as { sql: string } | undefined;

  if (resourceConstraintsDdl && !resourceConstraintsDdl.sql.includes("resolve_only")) {
    // DROP THE resolve_only TRIGGER FIRST, UNCONDITIONALLY, IF IT EXISTS --
    // made ORDER-INDEPENDENT rather than relying on "this trigger has never
    // been created yet the one time this branch runs." That reliance was
    // real on today's code (this block runs before initializeTimelineSchema()
    // ever installs timeline_facts_resolve_only for the very first time, so
    // on the one startup that performs a rebuild, the trigger genuinely does
    // not exist yet) -- but it is an ACCIDENT OF ORDERING, not a structural
    // guarantee, and root CLAUDE.md's "test against an existing database,
    // not just a fresh one" warning exists precisely because accidents of
    // ordering are how this kind of bug survives review. The trigger's own
    // `WHEN` clause names `resource_constraints`, and SQLite revalidates
    // every trigger body during schema surgery on a table it references
    // (measured, not assumed -- see resolveOnly.test.ts, whose migration
    // fixture hit exactly this: `ALTER TABLE ... RENAME TO resource_constraints`
    // failed with "no such table: resource_constraints" while this trigger
    // still existed and the table was transiently absent mid-rebuild) --
    // so a database where the trigger was somehow installed before a rebuild
    // runs (a future change that reorders trigger installation, or widens
    // this CHECK a second time some other way) would break at startup with
    // the schema half-rebuilt. Dropping it here costs nothing: the
    // DROP-then-CREATE discipline every trigger in this codebase already
    // follows (see the trigger's own creation site, far below, and the
    // reasoning timeline_facts_irreversible gives for the same pattern)
    // means it is unconditionally reinstalled before this function returns
    // regardless -- this is that discipline paying for itself a second time.
    db.exec(`DROP TRIGGER IF EXISTS timeline_facts_resolve_only`);

    // Enforcement has to be suspended across the drop, and put back
    // afterwards on every path -- see `rebuildWithForeignKeysSuspended`. Here
    // the table that would be cascade-emptied is `resource_constraint_members`,
    // which declares
    // `FOREIGN KEY (constraint_id) REFERENCES resource_constraints(id) ON DELETE CASCADE`.
    rebuildWithForeignKeysSuspended(db, "resource_constraints (resolve_only, issue #13)", () => {
      // EMPIRICALLY MEASURED, NOT ASSUMED (see resolveOnly.test.ts, whose
      // FK-check assertion caught a real bug in an earlier version of this
      // block): `ALTER TABLE ... RENAME TO` does not just rename the table
      // being renamed -- it also rewrites the stored FOREIGN KEY clause of
      // every OTHER table that references it by name (here,
      // resource_constraint_members' `FOREIGN KEY (constraint_id)
      // REFERENCES resource_constraints(id)`), REGARDLESS of the
      // `foreign_keys` pragma above. Renaming the OLD table out of the way
      // (the obvious first move) would therefore silently rewrite
      // resource_constraint_members to reference the OLD table's new,
      // temporary name -- and once that old table is dropped a few steps
      // later, that reference is permanently dangling, with no further
      // rename ever pointed at it to fix it back. `DROP TABLE`, unlike
      // `RENAME TO`, does NOT rewrite other tables' references (there is
      // nothing to rewrite them TO), so this recipe routes around the
      // problem entirely: the old table is copied out of and then DROPped
      // (never renamed), and the FINAL name is produced by a genuine
      // `CREATE TABLE` (also never a rename target) -- so
      // resource_constraint_members' FK text is never touched by anything
      // in this block, and is simply valid again the moment step 4 below
      // recreates a table under the name it always pointed at.
      //
      // 1. Copy the OLD table's rows into a staging table under a temporary
      //    name -- widened CHECK, and fact_key included from the start
      //    (unlike the final table a few steps down, this one is never
      //    compared to RESOURCE_CONSTRAINTS_DDL's stored text, so there is
      //    no reason to reproduce the fresh path's "add fact_key later via
      //    ALTER" shape here).
      db.exec(`
        CREATE TABLE resource_constraints_staging (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('bounded', 'monotonic', 'conserved', 'resolve_only')),
          direction TEXT CHECK (direction IN ('increasing', 'decreasing')),
          total REAL,
          created_at TEXT NOT NULL,
          fact_key TEXT NOT NULL DEFAULT 'value'
        )
      `);
      db.exec(`
        INSERT INTO resource_constraints_staging (id, game_id, kind, direction, total, created_at, fact_key)
        SELECT id, game_id, kind, direction, total, created_at, fact_key FROM resource_constraints
      `);

      // 2. Drop the OLD table outright -- not renamed, per the note above.
      db.exec(`DROP TABLE resource_constraints`);

      // 3. Recreate under the FINAL name using the exact same DDL text the
      //    fresh-database path executed above -- RESOURCE_CONSTRAINTS_DDL
      //    itself, not a second hand-copied literal. This is a genuine
      //    `CREATE TABLE resource_constraints (...)`, never a rename
      //    target, so its stored SQL stays unquoted -- matching the
      //    fresh-database path byte for byte (verified empirically, see
      //    resolveOnly.test.ts's "byte-identical" assertion) rather than
      //    picking up RENAME TO's habit of re-quoting the identifier.
      db.exec(RESOURCE_CONSTRAINTS_DDL);

      // 4. Copy every row across from the staging table with an EXPLICIT
      //    column list -- never SELECT * -- naming every column except
      //    fact_key, which the just-recreated table does not have yet. It
      //    is added next, the same way the fresh path adds it.
      db.exec(`
        INSERT INTO resource_constraints (id, game_id, kind, direction, total, created_at)
        SELECT id, game_id, kind, direction, total, created_at FROM resource_constraints_staging
      `);

      // 5. Add fact_key via the IDENTICAL statement text the fresh path
      //    uses (RESOURCE_CONSTRAINTS_ADD_FACT_KEY_DDL, not a hand-written
      //    equivalent). This is what makes the two paths' stored SQL
      //    provably byte-identical after this point: SQLite's ALTER TABLE
      //    ADD COLUMN rewrites a table's stored CREATE TABLE text by
      //    inserting the new column definition right after the last
      //    existing column and before any table-level constraint (verified
      //    empirically, not assumed -- see resolveOnly.test.ts) -- running
      //    the same statement against two structurally identical tables
      //    produces the same rewritten text, with no need to hand-guess
      //    that formatting.
      db.exec(RESOURCE_CONSTRAINTS_ADD_FACT_KEY_DDL);

      // 6. The ALTER above just backfilled every just-copied row's fact_key
      //    with its DEFAULT 'value' -- correct for every row that can exist
      //    today (every declare*Constraint() function other than
      //    declareResolveOnlyConstraint hardcodes factKey 'value', and
      //    declareResolveOnlyConstraint cannot have written a row before
      //    this migration exists to run), but this UPDATE restores each
      //    row's ACTUAL prior fact_key from the staging table by id rather
      //    than leaning on that staying true forever. An UPDATE never
      //    touches sqlite_master, so it cannot disturb the byte-identical
      //    DDL text step 5 just produced.
      db.exec(`
        UPDATE resource_constraints
           SET fact_key = (
             SELECT fact_key FROM resource_constraints_staging
              WHERE resource_constraints_staging.id = resource_constraints.id
           )
      `);

      // 7. Drop the staging table. Every id was copied verbatim in step 4,
      //    so resource_constraint_members' FOREIGN KEY (constraint_id)
      //    REFERENCES resource_constraints(id) -- never touched by any of
      //    the steps above -- is satisfied by the replacement table
      //    throughout, verified for real by the PRAGMA foreign_key_check
      //    below, not merely assumed here.
      db.exec(`DROP TABLE resource_constraints_staging`);
    });
  }

  // Members of a resource constraint. 'bounded' and 'monotonic' constraints
  // have exactly one member (the resource they govern); 'conserved'
  // constraints have two or more (the set that must sum to a fixed total).
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_constraint_members (
      constraint_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      PRIMARY KEY (constraint_id, resource_id),
      FOREIGN KEY (constraint_id) REFERENCES resource_constraints(id) ON DELETE CASCADE,
      FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
    )
  `);

  // The adjudication window (design §5.3, §5.2a; issue #13): created here,
  // BEFORE `timeline_facts_resolve_only` (the trigger that reads it, added
  // near the end of this function once `facts` exists) -- see
  // src/timeline/adjudication.ts for the table's own doc comment, including
  // why its startup pass unconditionally clears every row.
  initializeAdjudicationSchema(db);

  // Game time table (one per game)
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_time (
      game_id TEXT PRIMARY KEY,
      current_time TEXT NOT NULL,
      calendar_config TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Scheduled events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_events (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      trigger_time TEXT NOT NULL,
      recurring TEXT,
      triggered INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Add consequence column to scheduled_events (migration). Holds an
  // optional JSON-encoded ExpiryConsequence ({resourceId, delta}) that
  // advanceTime() applies itself, atomically with marking the event
  // triggered, when its trigger time is crossed. Null/absent means "no
  // consequence" -- behavior is unchanged from before this feature existed.
  try {
    db.exec(`ALTER TABLE scheduled_events ADD COLUMN consequence TEXT`);
  } catch {
    // Column already exists
  }

  // Timers table (countdowns, stopwatches, clocks)
  db.exec(`
    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      timer_type TEXT NOT NULL CHECK (timer_type IN ('countdown', 'stopwatch', 'clock')),
      current_value INTEGER NOT NULL,
      max_value INTEGER,
      direction TEXT DEFAULT 'down' CHECK (direction IN ('up', 'down')),
      trigger_at INTEGER,
      triggered INTEGER DEFAULT 0,
      unit TEXT DEFAULT 'tick',
      visible_to_players INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Add consequence column to timers (migration). Same shape and semantics
  // as scheduled_events.consequence, applied by tickTimer() the moment the
  // timer crosses trigger_at.
  try {
    db.exec(`ALTER TABLE timers ADD COLUMN consequence TEXT`);
  } catch {
    // Column already exists
  }

  // Random tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS random_tables (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      entries TEXT NOT NULL DEFAULT '[]',
      roll_expression TEXT DEFAULT '1d100',
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Secrets table
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT,
      related_entity_id TEXT,
      related_entity_type TEXT,
      revealed_to TEXT DEFAULT '[]',
      is_public INTEGER DEFAULT 0,
      clues TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Relationships table
  db.exec(`
    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      value INTEGER DEFAULT 0,
      label TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Relationship history table -- FROZEN, see the trigger immediately below.
  // Kept for existing rows only; nothing writes here any more.
  db.exec(`
    CREATE TABLE IF NOT EXISTS relationship_history (
      id TEXT PRIMARY KEY,
      relationship_id TEXT NOT NULL,
      previous_value INTEGER,
      new_value INTEGER,
      reason TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (relationship_id) REFERENCES relationships(id) ON DELETE CASCADE
    )
  `);

  // Design §5.4 option (C) / issue #9, Phase 3 step 3: `relationship_history`
  // stops being a mechanism, same as `resource_history` immediately above --
  // see that trigger's comment for the shared reasoning (why frozen and not
  // dropped, why DROP-then-CREATE on every startup). The one thing specific
  // here: `relationships` was already a `PROJECTED_TABLES` row (projection.ts)
  // before this trigger existed, so its `value` column was already being
  // dual-written into interval-versioned `facts` -- this freeze is what makes
  // that the ONLY record, by routing every relationship value write through
  // writeConstrainedValue() (src/timeline/constrained.ts) and cutting off the
  // second path this table represented. See valueHistory() there, and
  // getRelationshipHistory() in src/tools/relationship.ts, which reads
  // through it.
  db.exec(`
    DROP TRIGGER IF EXISTS relationship_history_frozen;
    CREATE TRIGGER relationship_history_frozen BEFORE INSERT ON relationship_history
    BEGIN
      SELECT RAISE(ABORT, 'relationship_history is frozen -- interval-versioned facts are now the only record of what a relationship value used to be (design section 5.4 option C); write through writeConstrainedValue in src/timeline/constrained.ts instead');
    END;
  `);

  // Factions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS factions (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      leader_id TEXT,
      headquarters_id TEXT,
      resources TEXT DEFAULT '{}',
      goals TEXT DEFAULT '[]',
      traits TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'disbanded', 'hidden')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Abilities table
  db.exec(`
    CREATE TABLE IF NOT EXISTS abilities (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      owner_id TEXT,
      owner_type TEXT CHECK (owner_type IN ('template', 'character')),
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      cost TEXT DEFAULT '{}',
      cooldown INTEGER,
      current_cooldown INTEGER DEFAULT 0,
      effects TEXT DEFAULT '[]',
      requirements TEXT DEFAULT '{}',
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Status effects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS status_effects (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      effect_type TEXT CHECK (effect_type IN ('buff', 'debuff', 'neutral')),
      duration INTEGER,
      stacks INTEGER DEFAULT 1,
      max_stacks INTEGER,
      effects TEXT DEFAULT '{}',
      source_id TEXT,
      source_type TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Tags table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      tag TEXT NOT NULL,
      color TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
      UNIQUE (game_id, entity_id, entity_type, tag)
    )
  `);

  // Notes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      pinned INTEGER DEFAULT 0,
      related_entity_id TEXT,
      related_entity_type TEXT,
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // External updates table - enables multi-agent collaboration
  // External agents can push updates that the primary DM agent receives
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_updates (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,

      -- Source identification
      source_agent TEXT NOT NULL,
      source_description TEXT,

      -- Update content
      update_type TEXT NOT NULL,
      category TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      structured_data TEXT,

      -- Targeting (what entities this relates to)
      target_entity_id TEXT,
      target_entity_type TEXT,

      -- Priority and status
      priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'applied', 'rejected')),

      -- Timestamps
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      applied_at TEXT,

      -- DM notes on how update was used
      dm_notes TEXT,

      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Pause states table - captures agent context for seamless resume
  db.exec(`
    CREATE TABLE IF NOT EXISTS pause_states (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL UNIQUE,

      -- Current scene/moment context
      current_scene TEXT NOT NULL,
      scene_atmosphere TEXT,
      immediate_situation TEXT NOT NULL,

      -- Pending player interaction
      pending_player_action TEXT,
      awaiting_response_to TEXT,
      presented_choices TEXT,

      -- Active narrative threads
      active_threads TEXT DEFAULT '[]',

      -- DM's plans and notes
      dm_short_term_plans TEXT,
      dm_long_term_plans TEXT,
      upcoming_reveals TEXT DEFAULT '[]',

      -- NPC states (not persisted elsewhere)
      npc_attitudes TEXT DEFAULT '{}',
      active_conversations TEXT DEFAULT '[]',

      -- Important context that might be lost
      recent_tone TEXT,
      player_apparent_goals TEXT,
      unresolved_hooks TEXT DEFAULT '[]',

      -- Metadata
      pause_reason TEXT,
      created_at TEXT NOT NULL,
      model_used TEXT,

      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Stored images table - file-based image storage
  // entity_type is flexible to support any entity (character, location, item, scene, faction, quest, ability, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stored_images (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,

      -- File information
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,

      -- Metadata
      label TEXT,
      description TEXT,
      source TEXT NOT NULL CHECK (source IN ('generated', 'uploaded', 'url')),
      source_url TEXT,
      generation_tool TEXT,
      generation_prompt TEXT,

      -- Flags
      is_primary INTEGER DEFAULT 0,

      -- Timestamps
      created_at TEXT NOT NULL,

      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Migration: Remove entity_type CHECK constraint to allow any entity type
  // SQLite doesn't support ALTER CHECK, so we need to recreate the table
  const storedImagesInfo = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='stored_images'"
  ).get() as { sql: string } | undefined;

  if (storedImagesInfo && storedImagesInfo.sql.includes("entity_type IN")) {
    db.exec(`
      CREATE TABLE stored_images_new (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        label TEXT,
        description TEXT,
        source TEXT NOT NULL CHECK (source IN ('generated', 'uploaded', 'url')),
        source_url TEXT,
        generation_tool TEXT,
        generation_prompt TEXT,
        is_primary INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
      INSERT INTO stored_images_new SELECT * FROM stored_images;
      DROP TABLE stored_images;
      ALTER TABLE stored_images_new RENAME TO stored_images;
    `);
  }

  // Display configuration table (global, one row)
  db.exec(`
    CREATE TABLE IF NOT EXISTS display_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `);

  // Per-game theme configuration
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_themes (
      game_id TEXT PRIMARY KEY,
      config TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Stored audio table - file-based audio storage for TTS/voice clips
  // entity_type is flexible to support any entity (character, location, game, scene, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS stored_audio (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,

      -- File information
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      duration_ms INTEGER,
      sample_rate INTEGER,

      -- Metadata
      label TEXT,
      description TEXT,
      source TEXT NOT NULL CHECK (source IN ('generated', 'uploaded', 'url')),
      source_url TEXT,

      -- TTS-specific metadata
      tts_engine TEXT,
      tts_voice TEXT,
      tts_text TEXT,
      tts_settings TEXT,

      -- Voice reference metadata (for voice cloning)
      is_voice_reference INTEGER DEFAULT 0,
      voice_name TEXT,
      voice_description TEXT,

      -- Flags
      is_primary INTEGER DEFAULT 0,

      -- Timestamps
      created_at TEXT NOT NULL,

      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    )
  `);

  // Create indexes for common queries
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_characters_game ON characters(game_id);
    CREATE INDEX IF NOT EXISTS idx_characters_location ON characters(location_id);
    CREATE INDEX IF NOT EXISTS idx_locations_game ON locations(game_id);
    CREATE INDEX IF NOT EXISTS idx_items_game ON items(game_id);
    CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id, owner_type);
    CREATE INDEX IF NOT EXISTS idx_quests_game ON quests(game_id);
    CREATE INDEX IF NOT EXISTS idx_quests_status ON quests(status);
    CREATE INDEX IF NOT EXISTS idx_narrative_game ON narrative_events(game_id);
    CREATE INDEX IF NOT EXISTS idx_narrative_timestamp ON narrative_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_combats_game ON combats(game_id);
    CREATE INDEX IF NOT EXISTS idx_combats_status ON combats(status);
    CREATE INDEX IF NOT EXISTS idx_resources_game ON resources(game_id);
    CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_id, owner_type);
    CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category);
    CREATE INDEX IF NOT EXISTS idx_resource_history_resource ON resource_history(resource_id);
    CREATE INDEX IF NOT EXISTS idx_resource_constraints_game ON resource_constraints(game_id);
    CREATE INDEX IF NOT EXISTS idx_resource_constraint_members_resource ON resource_constraint_members(resource_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_events_game ON scheduled_events(game_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_events_trigger ON scheduled_events(trigger_time);
    CREATE INDEX IF NOT EXISTS idx_timers_game ON timers(game_id);
    CREATE INDEX IF NOT EXISTS idx_random_tables_game ON random_tables(game_id);
    CREATE INDEX IF NOT EXISTS idx_random_tables_category ON random_tables(category);
    CREATE INDEX IF NOT EXISTS idx_secrets_game ON secrets(game_id);
    CREATE INDEX IF NOT EXISTS idx_secrets_category ON secrets(category);
    CREATE INDEX IF NOT EXISTS idx_relationships_game ON relationships(game_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id, source_type);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id, target_type);
    CREATE INDEX IF NOT EXISTS idx_relationship_history_rel ON relationship_history(relationship_id);
    CREATE INDEX IF NOT EXISTS idx_factions_game ON factions(game_id);
    CREATE INDEX IF NOT EXISTS idx_factions_status ON factions(status);
    CREATE INDEX IF NOT EXISTS idx_abilities_game ON abilities(game_id);
    CREATE INDEX IF NOT EXISTS idx_abilities_owner ON abilities(owner_id, owner_type);
    CREATE INDEX IF NOT EXISTS idx_abilities_category ON abilities(category);
    CREATE INDEX IF NOT EXISTS idx_status_effects_game ON status_effects(game_id);
    CREATE INDEX IF NOT EXISTS idx_status_effects_target ON status_effects(target_id);
    CREATE INDEX IF NOT EXISTS idx_tags_game ON tags(game_id);
    CREATE INDEX IF NOT EXISTS idx_tags_entity ON tags(entity_id, entity_type);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
    CREATE INDEX IF NOT EXISTS idx_notes_game ON notes(game_id);
    CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category);
    CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(pinned);
    CREATE INDEX IF NOT EXISTS idx_pause_states_game ON pause_states(game_id);
    CREATE INDEX IF NOT EXISTS idx_external_updates_game ON external_updates(game_id);
    CREATE INDEX IF NOT EXISTS idx_external_updates_status ON external_updates(status);
    CREATE INDEX IF NOT EXISTS idx_external_updates_priority ON external_updates(priority);
    CREATE INDEX IF NOT EXISTS idx_stored_images_game ON stored_images(game_id);
    CREATE INDEX IF NOT EXISTS idx_stored_images_entity ON stored_images(entity_id, entity_type);
    CREATE INDEX IF NOT EXISTS idx_stored_images_primary ON stored_images(entity_id, entity_type, is_primary);
    CREATE INDEX IF NOT EXISTS idx_stored_audio_game ON stored_audio(game_id);
    CREATE INDEX IF NOT EXISTS idx_stored_audio_entity ON stored_audio(entity_id, entity_type);
    CREATE INDEX IF NOT EXISTS idx_stored_audio_primary ON stored_audio(entity_id, entity_type, is_primary);
    CREATE INDEX IF NOT EXISTS idx_stored_audio_voice_ref ON stored_audio(game_id, is_voice_reference);
  `);

  // Consumer-registered migrations (see `SchemaMigration` above) run after
  // every core table above exists.
  runConsumerMigrations(db, options?.migrations);

  // Timeline substrate (design §5.1), and it must be LAST -- after the
  // consumer's migrations, not merely after this function's own DDL.
  //
  // The projection triggers are generated from a live `pragma_table_info`
  // read of each projected table (see timeline/projection.ts), so whatever
  // ran most recently is what they are built against. A consumer migration
  // that adds a column to a projected table therefore gets that column
  // projected as a fact key, and reconciliation backfills it, with no code
  // change on either side. Run this before `runConsumerMigrations` instead
  // and such a column would be silently absent from the timeline until some
  // later startup happened to regenerate -- which is precisely the drift the
  // Phase 1 checkpoint exists to catch, arriving through the one door the
  // engine hands a consumer.
  initializeTimelineSchema();

  // Issue #13 / design §5.3, §5.2a: `resolve_only`'s enforcement backstop --
  // the SQL-level twin of the `resolve_only` branch in assertConstraintsAllow()
  // (src/timeline/constrained.ts). That JS check covers every write that
  // goes through writeConstrainedValue/transferConstrainedValue; THIS
  // trigger is what makes a write that skips those functions entirely --
  // a raw `UPDATE resources SET value = ...`, old code nobody rewrote, a
  // copy-pasted query -- unconstructable rather than merely unchecked. It
  // has to live HERE, not inside initializeTimelineSchema() (src/timeline/schema.ts)
  // alongside timeline_facts_irreversible (the trigger it is modeled on):
  // it reads resource_constraints/resource_constraint_members, which are
  // src/db/schema.ts's own tables, AND facts, which initializeTimelineSchema()
  // just created a line above -- and initializeTimelineSchema() is the LAST
  // thing this function calls (see the comment above it), so `facts` does
  // not exist at any point before that call returns. Creating this trigger
  // any earlier would `CREATE TRIGGER` against a table that isn't there
  // yet.
  //
  // ORDERING REQUIREMENT, STATED EXPLICITLY SO NOBODY MOVES THIS LATER: this
  // CREATE must run AFTER resource_constraints, resource_constraint_members
  // and timeline_adjudications_open all exist (true from here on, since all
  // three are created earlier in this same function) AND after the CHECK
  // -rebuild migration above has already run for this call. The rebuild
  // block enforces the second half of that itself -- it unconditionally
  // `DROP TRIGGER IF EXISTS`s this exact trigger before doing any table
  // surgery, precisely so that surgery can never run while this trigger
  // still exists to have its `WHEN` clause revalidated mid-rebuild against a
  // table that is transiently missing (see that block's own comment). Do
  // not reorder this CREATE ahead of that block on the theory that "it
  // always ran after anyway" -- that theory is exactly what the rebuild
  // block's DROP now makes irrelevant, and reordering would silently
  // reintroduce the dependency the DROP exists to remove.
  //
  // SCOPED PER (entity_id, key), unlike timeline_facts_irreversible's
  // per-(entity_id, key) VALUE comparison -- resolve_only has no value to
  // compare, only a declaration to look up, via the same JOIN
  // registry.ts's constraintsFor() runs in JS: is there a 'resolve_only'
  // constraint whose member list includes NEW.entity_id and whose fact_key
  // matches NEW.key. AND conditional on the window: the second half of the
  // WHEN clause, `NOT EXISTS (SELECT 1 FROM timeline_adjudications_open)`,
  // reads the exact same table `adjudicationOpen()` (src/timeline/adjudication.js)
  // reads in JS -- see that module's doc comment for why this is one source
  // of truth read in two places, never two independent checks that happen
  // to agree.
  //
  // BEFORE INSERT ON facts, not UPDATE: facts are append-only
  // (timeline_facts_immutable, src/timeline/schema.ts), so a new value for a
  // key always arrives as a fresh INSERT. This is deliberately an INSERT
  // guard for the same reason timeline_facts_irreversible is one: closing an
  // interval is `UPDATE facts SET valid_to_t = ...`, a different table
  // event entirely, and is NOT a write of a new value -- it never reaches
  // this trigger. That is what keeps destroying an entity, or otherwise
  // closing a resolve_only-governed fact, legal even with no adjudication
  // window open: the engine records decisions, it does not impose policy on
  // top of them (hard rule 2), and refusing to let an entity be destroyed
  // because it happens to carry a resolve_only fact would be exactly that.
  //
  // DROP-then-CREATE, never CREATE TRIGGER IF NOT EXISTS -- the same
  // reasoning timeline_facts_irreversible and every other trigger in this
  // codebase give for themselves: IF NOT EXISTS would freeze whatever guard
  // first shipped for a given on-disk database forever, so a later fix to
  // this trigger's logic or wording would silently never reach a database
  // that already had an older version installed. Dropping and recreating on
  // every startup keeps the guard a database actually has in sync with the
  // guard this build believes it deployed.
  //
  // NOTE FOR THE NEXT READER OF reconcileTimeline() (src/timeline/projection.ts):
  // reconciliation runs at the end of every startup and, per column, closes
  // a diverged fact and opens a new one -- an INSERT that would hit this
  // very trigger for a resolve_only-governed key with no window open
  // (reconciliation is not an adjudicating call). projection.ts's
  // reconcileTable() carries its own guard for exactly that, modeled on the
  // one it already had for `irreversible` -- see the comment on its
  // close-UPDATE and open-INSERT statements.
  db.exec(`
    DROP TRIGGER IF EXISTS timeline_facts_resolve_only;
    CREATE TRIGGER timeline_facts_resolve_only
    BEFORE INSERT ON facts
    WHEN EXISTS (
      SELECT 1 FROM resource_constraints rc
        JOIN resource_constraint_members rcm ON rcm.constraint_id = rc.id
       WHERE rc.kind = 'resolve_only'
         AND rcm.resource_id = NEW.entity_id
         AND rc.fact_key = NEW.key
    ) AND NOT EXISTS (SELECT 1 FROM timeline_adjudications_open)
    BEGIN
      SELECT RAISE(ABORT, 'timeline: ''' || NEW.key || ''' on this entity is resolve_only-constrained; direct writes are refused -- this value can only change through the adjudicating call that opens the resolution window');
    END;
  `);
}

function runConsumerMigrations(
  db: Database.Database,
  migrations: readonly SchemaMigration[] | undefined
): void {
  if (!migrations || migrations.length === 0) {
    return;
  }

  validateMigrations(migrations);

  for (const migration of migrations) {
    try {
      db.transaction(() => {
        migration.up(db);
      })();
    } catch (err) {
      log.error("Consumer schema migration failed", {
        migration: migration.name,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Schema migration '${migration.name}' failed`, { cause: err });
    }
  }
}

function validateMigrations(migrations: readonly SchemaMigration[]): void {
  const seen = new Set<string>();

  for (const migration of migrations) {
    const name = migration?.name;

    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(
        `Invalid schema migration: 'name' must be a non-empty string, got ${JSON.stringify(name)}`
      );
    }

    if (seen.has(name)) {
      throw new Error(`Duplicate schema migration name: '${name}'`);
    }
    seen.add(name);

    if (typeof migration.up !== "function") {
      throw new Error(`Schema migration '${name}' has no 'up' function`);
    }
  }
}
