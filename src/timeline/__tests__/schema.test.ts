// Timeline substrate tests (GitHub issue #1). This is additive-only: the
// timeline tables aren't read by any existing tool yet, so what matters here
// is that the schema is exactly right, that initializing it is idempotent
// and safe against a database that predates it, and that the append-only
// guard triggers actually make recorded `t` impossible to rewrite -- not
// merely discouraged. Every guard is planted-and-watched-red per the
// project's testing rule (root CLAUDE.md).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { initializeSchema } from "../../db/schema.js";
import { createGame } from "../../tools/game.js";
import { createCharacter } from "../../tools/character.js";
import { compareT, assertT } from "../t.js";
import { ENTITY_KINDS } from "../kinds.js";

const TIMELINE_TABLES = ["entities", "events", "facts", "timeline_clock"];

const TIMELINE_INDEXES = [
  "idx_entities_game_kind",
  "idx_entities_game_created",
  "idx_facts_entity_key",
  "idx_facts_entity_key_valid_to",
  "idx_facts_valid_from",
  "idx_events_game_at",
];

interface SqliteMasterRow {
  name: string;
}

function tableNames(db: Database.Database, kind: "table" | "index"): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(kind) as SqliteMasterRow[]).map(
    (r) => r.name
  );
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as SqliteMasterRow[])
    .map((r) => r.name)
    .sort();
}

function schemaSnapshot(db: Database.Database): string {
  return JSON.stringify(
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
      .all()
  );
}

/** Inserts a legal `entities` row via raw SQL and returns its id. */
function insertEntity(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    gameId: string;
    kind: string;
    name: string | null;
    createdAtT: number;
    destroyedAtT: number | null;
  }> = {}
): string {
  const id = overrides.id ?? uuidv4();
  db.prepare(
    `INSERT INTO entities (id, game_id, kind, name, created_at_t, destroyed_at_t) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.gameId ?? uuidv4(),
    overrides.kind ?? "resource",
    overrides.name ?? "grain",
    overrides.createdAtT ?? 0,
    overrides.destroyedAtT ?? null
  );
  return id;
}

/** Inserts a legal `facts` row via raw SQL and returns its id. */
function insertFact(
  db: Database.Database,
  entityId: string,
  overrides: Partial<{
    id: string;
    key: string;
    value: string;
    validFromT: number;
    validToT: number | null;
    irreversible: number;
  }> = {}
): string {
  const id = overrides.id ?? uuidv4();
  db.prepare(
    `INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entityId,
    overrides.key ?? "value",
    overrides.value ?? "50",
    overrides.validFromT ?? 0,
    overrides.validToT ?? null,
    overrides.irreversible ?? 0
  );
  return id;
}

/** Inserts a legal `events` row via raw SQL and returns its id. */
function insertEvent(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    gameId: string;
    atT: number;
    kind: string;
    description: string | null;
    causes: string | null;
  }> = {}
): string {
  const id = overrides.id ?? uuidv4();
  db.prepare(
    `INSERT INTO events (id, game_id, at_t, kind, description, causes) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.gameId ?? uuidv4(),
    overrides.atT ?? 0,
    overrides.kind ?? "resource.created",
    overrides.description ?? null,
    overrides.causes ?? null
  );
  return id;
}

describe("timeline schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  describe("fresh database", () => {
    it("creates all four timeline tables", () => {
      const tables = tableNames(db, "table");
      for (const name of TIMELINE_TABLES) {
        expect(tables).toContain(name);
      }
    });

    it("creates every declared index", () => {
      const indexes = tableNames(db, "index");
      for (const name of TIMELINE_INDEXES) {
        expect(indexes).toContain(name);
      }
    });

    it("entities has exactly the declared columns", () => {
      expect(columnNames(db, "entities")).toEqual(
        ["id", "game_id", "kind", "name", "created_at_t", "destroyed_at_t"].sort()
      );
    });

    it("facts has exactly the declared columns", () => {
      expect(columnNames(db, "facts")).toEqual(
        ["id", "entity_id", "key", "value", "valid_from_t", "valid_to_t", "irreversible"].sort()
      );
    });

    it("events has exactly the declared columns", () => {
      expect(columnNames(db, "events")).toEqual(
        ["id", "game_id", "at_t", "kind", "description", "causes"].sort()
      );
    });

    it("timeline_clock has exactly the declared columns", () => {
      expect(columnNames(db, "timeline_clock")).toEqual(
        ["game_id", "current_t", "axis_kind", "axis_unit", "declared_at"].sort()
      );
    });
  });

  describe("idempotency", () => {
    it("calling initializeSchema a second and third time throws nothing and leaves sqlite_master identical", () => {
      const before = schemaSnapshot(db);

      expect(() => initializeSchema()).not.toThrow();
      expect(() => initializeSchema()).not.toThrow();

      expect(schemaSnapshot(db)).toEqual(before);
    });
  });

  describe("against an existing (pre-timeline) database", () => {
    it("adds the timeline tables without disturbing legacy rows already present", () => {
      // Simulate a database that predates this feature: drop everything
      // this module adds, exactly as if the code that adds it had never
      // run against this file. Children before parents: facts references
      // entities, entities references entity_kinds.
      //
      // Issue #2 (src/timeline/projection.ts) added generated projection
      // triggers -- timeline_<table>_ai/_au/_ad, one set per projected
      // table -- on top of the six guard triggers this block originally
      // named individually. A real pre-timeline database would never have
      // had a chance to install them, so simulating one here must drop them
      // too; left behind, they'd still reference the tables dropped below
      // and every domain write in this test would fail with "no such
      // table". Swept dynamically (LIKE 'timeline_%') rather than
      // hand-listed so this fixture doesn't need editing again the next
      // time a projected table is added.
      const timelineTriggers = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%'`)
        .all() as { name: string }[];
      for (const trigger of timelineTriggers) {
        db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      }
      db.exec(`
        DROP TABLE IF EXISTS facts;
        DROP TABLE IF EXISTS events;
        DROP TABLE IF EXISTS entities;
        DROP TABLE IF EXISTS entity_kinds;
        DROP TABLE IF EXISTS timeline_clock;
      `);
      expect(tableNames(db, "table")).not.toContain("entities");
      expect(tableNames(db, "table")).not.toContain("entity_kinds");

      // Legacy rows, written through the real tool surface, that must
      // survive the upgrade untouched.
      const legacyGame = createGame({ name: "grain depot", setting: "test", style: "test" });
      const legacyCharacter = createCharacter({
        gameId: legacyGame.id,
        name: "treasury keeper",
        isPlayer: false,
      });

      expect(() => initializeSchema()).not.toThrow();

      const tables = tableNames(db, "table");
      for (const name of TIMELINE_TABLES) {
        expect(tables).toContain(name);
      }
      expect(tables).toContain("entity_kinds");

      // The kind vocabulary itself must be backfilled, not just the table.
      const kindRows = db.prepare("SELECT kind FROM entity_kinds").all() as { kind: string }[];
      expect(kindRows.map((r) => r.kind).sort()).toEqual([...ENTITY_KINDS].sort());

      const gameRow = db.prepare("SELECT name FROM games WHERE id = ?").get(legacyGame.id) as
        | { name: string }
        | undefined;
      expect(gameRow?.name).toBe("grain depot");

      const characterRow = db.prepare("SELECT name, game_id FROM characters WHERE id = ?").get(
        legacyCharacter.id
      ) as { name: string; game_id: string } | undefined;
      expect(characterRow?.name).toBe("treasury keeper");
      expect(characterRow?.game_id).toBe(legacyGame.id);
    });
  });

  describe("append-only guard triggers", () => {
    let gameId: string;

    beforeEach(() => {
      gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    });

    it("timeline_entities_immutable rejects rewriting kind", () => {
      const id = insertEntity(db, { gameId, kind: "resource" });
      expect(() => db.prepare("UPDATE entities SET kind = ? WHERE id = ?").run("population", id)).toThrow();
    });

    it("timeline_entities_immutable rejects rewriting name, id, game_id and created_at_t", () => {
      const id = insertEntity(db, { gameId, name: "grain" });
      expect(() => db.prepare("UPDATE entities SET name = ? WHERE id = ?").run("treasury", id)).toThrow();
      expect(() => db.prepare("UPDATE entities SET id = ? WHERE id = ?").run(uuidv4(), id)).toThrow();
      expect(() =>
        db.prepare("UPDATE entities SET game_id = ? WHERE id = ?").run(uuidv4(), id)
      ).toThrow();
      expect(() =>
        db.prepare("UPDATE entities SET created_at_t = ? WHERE id = ?").run(99, id)
      ).toThrow();
    });

    it("permits destroyed_at_t NULL -> value exactly once, and rejects a second change", () => {
      const id = insertEntity(db, { gameId, destroyedAtT: null });

      expect(() =>
        db.prepare("UPDATE entities SET destroyed_at_t = ? WHERE id = ?").run(10, id)
      ).not.toThrow();
      const row = db.prepare("SELECT destroyed_at_t FROM entities WHERE id = ?").get(id) as {
        destroyed_at_t: number;
      };
      expect(row.destroyed_at_t).toBe(10);

      expect(() =>
        db.prepare("UPDATE entities SET destroyed_at_t = ? WHERE id = ?").run(20, id)
      ).toThrow();
      expect(() =>
        db.prepare("UPDATE entities SET destroyed_at_t = NULL WHERE id = ?").run(id)
      ).toThrow();
    });

    it("timeline_entities_no_delete rejects DELETE", () => {
      const id = insertEntity(db, { gameId });
      expect(() => db.prepare("DELETE FROM entities WHERE id = ?").run(id)).toThrow();
      expect(db.prepare("SELECT id FROM entities WHERE id = ?").get(id)).toBeDefined();
    });

    it("timeline_facts_immutable rejects rewriting value, key, entity_id, id, valid_from_t and irreversible", () => {
      const entityId = insertEntity(db, { gameId });
      const factId = insertFact(db, entityId, { key: "value", value: "50" });

      expect(() =>
        db.prepare("UPDATE facts SET value = ? WHERE id = ?").run("999", factId)
      ).toThrow();
      expect(() =>
        db.prepare("UPDATE facts SET key = ? WHERE id = ?").run("other", factId)
      ).toThrow();
      expect(() =>
        db.prepare("UPDATE facts SET entity_id = ? WHERE id = ?").run(uuidv4(), factId)
      ).toThrow();
      expect(() =>
        db.prepare("UPDATE facts SET id = ? WHERE id = ?").run(uuidv4(), factId)
      ).toThrow();
      expect(() =>
        db.prepare("UPDATE facts SET valid_from_t = ? WHERE id = ?").run(5, factId)
      ).toThrow();
      expect(() =>
        db.prepare("UPDATE facts SET irreversible = 1 WHERE id = ?").run(factId)
      ).toThrow();
    });

    it("permits valid_to_t NULL -> value exactly once, and rejects a second change", () => {
      const entityId = insertEntity(db, { gameId });
      const factId = insertFact(db, entityId, { validFromT: 0, validToT: null });

      expect(() =>
        db.prepare("UPDATE facts SET valid_to_t = ? WHERE id = ?").run(10, factId)
      ).not.toThrow();
      const row = db.prepare("SELECT valid_to_t FROM facts WHERE id = ?").get(factId) as {
        valid_to_t: number;
      };
      expect(row.valid_to_t).toBe(10);

      expect(() =>
        db.prepare("UPDATE facts SET valid_to_t = ? WHERE id = ?").run(20, factId)
      ).toThrow();
      expect(() =>
        db.prepare("UPDATE facts SET valid_to_t = NULL WHERE id = ?").run(factId)
      ).toThrow();
    });

    it("timeline_facts_no_delete rejects DELETE", () => {
      const entityId = insertEntity(db, { gameId });
      const factId = insertFact(db, entityId);
      expect(() => db.prepare("DELETE FROM facts WHERE id = ?").run(factId)).toThrow();
      expect(db.prepare("SELECT id FROM facts WHERE id = ?").get(factId)).toBeDefined();
    });

    it("timeline_events_immutable rejects any UPDATE at all", () => {
      const eventId = insertEvent(db, { gameId, description: "the grain silo was built" });
      expect(() =>
        db.prepare("UPDATE events SET description = ? WHERE id = ?").run("edited", eventId)
      ).toThrow();
      // Even a no-op UPDATE (same value) is rejected -- there is no WHEN
      // clause, unlike entities/facts which permit one specific mutation.
      expect(() =>
        db.prepare("UPDATE events SET description = ? WHERE id = ?").run(
          "the grain silo was built",
          eventId
        )
      ).toThrow();
    });

    it("timeline_events_no_delete rejects DELETE", () => {
      const eventId = insertEvent(db, { gameId });
      expect(() => db.prepare("DELETE FROM events WHERE id = ?").run(eventId)).toThrow();
      expect(db.prepare("SELECT id FROM events WHERE id = ?").get(eventId)).toBeDefined();
    });

    it("re-running initializeSchema displaces an impostor trigger of the same name", () => {
      // If initializeSchema() used CREATE TRIGGER IF NOT EXISTS, a trigger
      // installed under a guard's name -- by an old build, or anything
      // else -- would survive every future initializeSchema() call
      // forever, and the real guard would never come back. Prove the
      // DROP-then-CREATE actually displaces it: install a permissive
      // impostor under the real guard's name, show it lets the forbidden
      // mutation through, then show a fresh initializeSchema() call
      // restores the real guard.
      db.exec(`
        DROP TRIGGER IF EXISTS timeline_entities_immutable;
        CREATE TRIGGER timeline_entities_immutable
        BEFORE UPDATE ON entities
        WHEN 0
        BEGIN
          SELECT RAISE(ABORT, 'impostor: this should never fire');
        END;
      `);

      const id = insertEntity(db, { gameId, kind: "resource" });
      // The impostor's WHEN 0 never matches, so this rewrite of `kind` --
      // which the real guard forbids -- goes through. That proves the
      // real guard is currently gone, not just untested.
      expect(() =>
        db.prepare("UPDATE entities SET kind = ? WHERE id = ?").run("item", id)
      ).not.toThrow();

      expect(() => initializeSchema()).not.toThrow();

      const id2 = insertEntity(db, { gameId, kind: "resource" });
      expect(() =>
        db.prepare("UPDATE entities SET kind = ? WHERE id = ?").run("item", id2)
      ).toThrow();
    });
  });

  describe("CHECK constraints", () => {
    it("rejects entities.destroyed_at_t < created_at_t", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO entities (id, game_id, kind, name, created_at_t, destroyed_at_t) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(uuidv4(), uuidv4(), "resource", "grain", 10, 5)
      ).toThrow();
    });

    it("accepts entities.destroyed_at_t == created_at_t (the CHECK is >=, not >)", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO entities (id, game_id, kind, name, created_at_t, destroyed_at_t) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run(uuidv4(), uuidv4(), "resource", "grain", 10, 10)
      ).not.toThrow();
    });

    it("rejects facts.valid_to_t < valid_from_t", () => {
      const entityId = insertEntity(db);
      expect(() =>
        db
          .prepare(
            "INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
          .run(uuidv4(), entityId, "value", "50", 10, 5, 0)
      ).toThrow();
    });
  });

  describe("facts.entity_id foreign key", () => {
    it("rejects a fact for an unknown entity", () => {
      expect(() => insertFact(db, uuidv4())).toThrow();
    });
  });

  describe("entities.kind foreign key to entity_kinds", () => {
    it("rejects a typo'd kind", () => {
      expect(() => insertEntity(db, { kind: "charcter" })).toThrow();
    });

    it.each(ENTITY_KINDS)("accepts the declared kind %s", (kind) => {
      expect(() => insertEntity(db, { kind })).not.toThrow();
    });

    it("seeds entity_kinds with exactly ENTITY_KINDS, once", () => {
      const rows = db.prepare("SELECT kind FROM entity_kinds").all() as { kind: string }[];
      expect(rows.map((r) => r.kind).sort()).toEqual([...ENTITY_KINDS].sort());
    });

    it("re-running initializeSchema does not duplicate or lose seed rows", () => {
      expect(() => initializeSchema()).not.toThrow();
      expect(() => initializeSchema()).not.toThrow();
      const count = db.prepare("SELECT COUNT(*) AS n FROM entity_kinds").get() as { n: number };
      expect(count.n).toBe(ENTITY_KINDS.length);
    });
  });
});

describe("T: compareT", () => {
  it("orders numbers ascending", () => {
    expect(compareT(1, 2)).toBeLessThan(0);
    expect(compareT(2, 1)).toBeGreaterThan(0);
    expect(compareT(5, 5)).toBe(0);
  });

  it("handles negative and fractional t", () => {
    expect(compareT(-10, -5)).toBeLessThan(0);
    expect(compareT(0.1, 0.2)).toBeLessThan(0);
  });
});

describe("T: assertT", () => {
  it.each([0, 1, -1, 3.14, -0, 1e10])("accepts the finite number %p", (value) => {
    expect(() => assertT(value)).not.toThrow();
  });

  it("rejects NaN", () => {
    expect(() => assertT(NaN)).toThrow();
  });

  it("rejects Infinity and -Infinity", () => {
    expect(() => assertT(Infinity)).toThrow();
    expect(() => assertT(-Infinity)).toThrow();
  });

  it("rejects null", () => {
    expect(() => assertT(null)).toThrow();
  });

  it("rejects undefined", () => {
    expect(() => assertT(undefined)).toThrow();
  });

  it("rejects a Date, and names it in the error", () => {
    expect(() => assertT(new Date("2026-01-01T00:00:00Z"))).toThrow(/Date/);
  });

  it("rejects a numeric string, and names it in the error", () => {
    expect(() => assertT("12")).toThrow(/"12"/);
  });

  it("rejects a non-numeric string", () => {
    expect(() => assertT("twelve")).toThrow();
  });

  it("rejects a plain object and an array", () => {
    expect(() => assertT({})).toThrow();
    expect(() => assertT([])).toThrow();
  });

  it("rejects a boolean", () => {
    expect(() => assertT(true)).toThrow();
  });
});
