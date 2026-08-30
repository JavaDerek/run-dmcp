import { getDatabase } from "../db/connection.js";
import { ENTITY_KINDS } from "./kinds.js";

/**
 * The timeline substrate (design §5.1): `entities`, `facts`, `events`, and
 * the per-game `timeline_clock` that tells a `sequence` axis what its next
 * ordinal is. Strictly additive -- nothing here is read by any existing
 * tool yet, and every statement is idempotent so calling this at every
 * startup (the project's only migration mechanism; see root CLAUDE.md) is
 * safe against both a fresh database and one that predates the timeline.
 *
 * What makes recorded `t` actually immutable is the trigger block at the
 * bottom of this function, not application discipline -- see the comment
 * there.
 */
export function initializeTimelineSchema(): void {
  const db = getDatabase();

  // entity_kinds -- the allowed values of entities.kind, enforced by FK
  // rather than a CHECK constraint. SQLite cannot ALTER a CHECK, so a
  // CHECK here would force a full table rebuild the day issue #2 (or
  // anything later) adds a projected kind; a reference table just gets one
  // more row via INSERT OR IGNORE, on every init, forever. This is the
  // same shape as the inherited gotcha it exists to avoid: `stored_audio`
  // and friends carry an unconstrained entity_type that can typo silently
  // and read back never. `kinds.ts` is the single owner of the vocabulary
  // seeded here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_kinds (
      kind TEXT PRIMARY KEY
    )
  `);
  const seedKind = db.prepare("INSERT OR IGNORE INTO entity_kinds (kind) VALUES (?)");
  for (const kind of ENTITY_KINDS) {
    seedKind.run(kind);
  }

  // entities -- one row per timeline-tracked thing. `name` is the name at
  // creation and never changes; the current name (if the projection layer
  // ever changes it) is a `name` fact instead, so nothing here can drift
  // out from under a caller relying on it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      kind TEXT NOT NULL REFERENCES entity_kinds(kind),
      name TEXT,
      created_at_t REAL NOT NULL,
      destroyed_at_t REAL,
      CHECK (destroyed_at_t IS NULL OR destroyed_at_t >= created_at_t)
    )
  `);

  // facts -- interval-versioned key/value history for an entity. `value` is
  // NOT NULL on purpose: a NULL column on the live row produces no fact at
  // all (absence is the absence of a fact, never a fact of absence -- hard
  // rule 3). No ON DELETE CASCADE and no FK to `games`: deleting a game
  // deletes its live rows, but the timeline of that game survives.
  // `irreversible` is a per-fact flag, not a per-entity or per-value one --
  // so any property a future consumer wants to declare irreversible has to
  // live under its own fact key; you cannot flag half a blob.
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      valid_from_t REAL NOT NULL,
      valid_to_t REAL,
      irreversible INTEGER NOT NULL DEFAULT 0,
      CHECK (valid_to_t IS NULL OR valid_to_t >= valid_from_t)
    )
  `);

  // events -- the append-only log entry itself. `causes` carries one hop of
  // provenance (design §5.2c) as a JSON string; nothing here is inferred
  // from anything anyone wrote (hard rule 4) -- `kind`/`description` are
  // tokens this codebase defines.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      at_t REAL NOT NULL,
      kind TEXT NOT NULL,
      description TEXT,
      causes TEXT
    )
  `);

  // timeline_clock -- one row per game, tracking the declared axis and its
  // current position. A game that never declares an axis still needs one
  // of these once its first entity/fact/event is written, with axis_kind
  // 'sequence' (#6 owns declareTimeAxis/setStoryTime; this table just
  // holds the row).
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_clock (
      game_id TEXT PRIMARY KEY,
      current_t REAL NOT NULL,
      axis_kind TEXT NOT NULL CHECK (axis_kind IN ('sequence', 'elapsed', 'counter')),
      axis_unit TEXT NOT NULL,
      declared_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entities_game_kind ON entities(game_id, kind);
    CREATE INDEX IF NOT EXISTS idx_entities_game_created ON entities(game_id, created_at_t);
    CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity_id, key);
    CREATE INDEX IF NOT EXISTS idx_facts_entity_key_valid_to ON facts(entity_id, key, valid_to_t);
    CREATE INDEX IF NOT EXISTS idx_facts_valid_from ON facts(valid_from_t);
    CREATE INDEX IF NOT EXISTS idx_events_game_at ON events(game_id, at_t);
  `);

  // Append-only guard triggers.
  //
  // Recorded `t` must be impossible to rewrite, not merely discouraged --
  // that is the whole point of a substrate the checkpoint (#4) can trust.
  // Every column comparison below uses IS NOT rather than <>, because <>
  // with a NULL operand evaluates to NULL (neither true nor false) and the
  // WHEN clause would silently fail to fire on exactly the rows -- open
  // intervals -- where firing matters most.
  //
  // Each table gets exactly one permitted mutation: closing an open
  // interval once (`facts.valid_to_t`, `entities.destroyed_at_t`, both
  // NULL -> value). Every other UPDATE, and every DELETE, aborts.
  //
  // Every trigger below is DROP-then-CREATE, not CREATE TRIGGER IF NOT
  // EXISTS. The column set being fixed is not the risk that decides this --
  // it's that IF NOT EXISTS makes whatever guard shipped in the build that
  // first created a given database permanent for that database. If this
  // logic is ever tightened or a bug in it is fixed, that fix would
  // silently never reach any database that already had the old trigger,
  // which is exactly the "test against an existing database, not just a
  // fresh one" trap this project has already been bitten by once. Dropping
  // and recreating on every init means the guard a database has always
  // matches the guard this build believes it deployed.
  db.exec(`
    DROP TRIGGER IF EXISTS timeline_entities_immutable;
    CREATE TRIGGER timeline_entities_immutable
    BEFORE UPDATE ON entities
    WHEN NEW.id IS NOT OLD.id
      OR NEW.game_id IS NOT OLD.game_id
      OR NEW.kind IS NOT OLD.kind
      OR NEW.name IS NOT OLD.name
      OR NEW.created_at_t IS NOT OLD.created_at_t
      OR (OLD.destroyed_at_t IS NOT NULL AND NEW.destroyed_at_t IS NOT OLD.destroyed_at_t)
    BEGIN
      SELECT RAISE(ABORT, 'timeline: entities are append-only; only destroyed_at_t may be set, once');
    END;
  `);

  db.exec(`
    DROP TRIGGER IF EXISTS timeline_facts_immutable;
    CREATE TRIGGER timeline_facts_immutable
    BEFORE UPDATE ON facts
    WHEN NEW.id IS NOT OLD.id
      OR NEW.entity_id IS NOT OLD.entity_id
      OR NEW.key IS NOT OLD.key
      OR NEW.value IS NOT OLD.value
      OR NEW.valid_from_t IS NOT OLD.valid_from_t
      OR NEW.irreversible IS NOT OLD.irreversible
      OR (OLD.valid_to_t IS NOT NULL AND NEW.valid_to_t IS NOT OLD.valid_to_t)
    BEGIN
      SELECT RAISE(ABORT, 'timeline: facts are append-only; valid_from_t cannot be rewritten, and valid_to_t may only be closed once');
    END;
  `);

  db.exec(`
    DROP TRIGGER IF EXISTS timeline_events_immutable;
    CREATE TRIGGER timeline_events_immutable
    BEFORE UPDATE ON events
    BEGIN
      SELECT RAISE(ABORT, 'timeline: an event never changes once recorded');
    END;
  `);

  db.exec(`
    DROP TRIGGER IF EXISTS timeline_entities_no_delete;
    CREATE TRIGGER timeline_entities_no_delete
    BEFORE DELETE ON entities
    BEGIN
      SELECT RAISE(ABORT, 'timeline: entities are append-only; rows are never deleted');
    END;
  `);

  db.exec(`
    DROP TRIGGER IF EXISTS timeline_facts_no_delete;
    CREATE TRIGGER timeline_facts_no_delete
    BEFORE DELETE ON facts
    BEGIN
      SELECT RAISE(ABORT, 'timeline: facts are append-only; rows are never deleted');
    END;
  `);

  db.exec(`
    DROP TRIGGER IF EXISTS timeline_events_no_delete;
    CREATE TRIGGER timeline_events_no_delete
    BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'timeline: events are append-only; rows are never deleted');
    END;
  `);
}
