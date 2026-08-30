// Phase 3 / issue #9, step 1 (design §5.4 option (C)): before the generic
// (entityId, factKey) writer can exist, the constraint registry has to be
// keyed the same way -- otherwise a constraint declared on `resources.value`
// would silently govern every fact key on that entity once that writer
// exists. These tests are what makes that claim true rather than merely
// asserted: constraintsFor()/conservedConstraintFor() must return rows for
// the (entityId, factKey) pair they were asked about and NOTHING for a
// different key on the same entity, even though the underlying row lives on
// a table keyed by resource_id alone.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { initializeSchema } from "../../db/schema.js";
import { createGame } from "../../tools/game.js";
import { createResource } from "../../tools/resource.js";
import {
  declareBoundedConstraint,
  declareMonotonicConstraint,
  declareConservedConstraint,
} from "../../tools/constraint.js";
import { constraintsFor, conservedConstraintFor } from "../registry.js";

describe("timeline constraint registry (key-scoped reads)", () => {
  let gameId: string;

  beforeEach(() => {
    createTestDb();
    gameId = createGame({ name: "Test Game", setting: "test", style: "test" }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  describe("constraintsFor", () => {
    it("returns a declared bounded constraint for (entityId, 'value') and nothing for a different key on the same entity", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 50,
        minValue: 0,
        maxValue: 100,
      });
      const declared = declareBoundedConstraint({ gameId, resourceId: resource.id });

      expect(constraintsFor(resource.id, "value").map((c) => c.id)).toEqual([declared.id]);
      expect(constraintsFor(resource.id, "some_other_key")).toEqual([]);
    });

    it("returns a declared monotonic constraint for 'value' and nothing for a different key", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "population", value: 10 });
      const declared = declareMonotonicConstraint({
        gameId,
        resourceId: resource.id,
        direction: "increasing",
      });

      expect(constraintsFor(resource.id, "value").map((c) => c.id)).toEqual([declared.id]);
      expect(constraintsFor(resource.id, "some_other_key")).toEqual([]);
    });

    it("returns a declared conserved constraint for 'value' and nothing for a different key", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      const declared = declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      expect(constraintsFor(a.id, "value").map((c) => c.id)).toEqual([declared.id]);
      expect(constraintsFor(a.id, "some_other_key")).toEqual([]);
      expect(constraintsFor(b.id, "value").map((c) => c.id)).toEqual([declared.id]);
    });

    it("returns constraints for the same (entityId, factKey) ordered by created_at", () => {
      const a = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 40,
        minValue: 0,
        maxValue: 1000,
      });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      const bounded = declareBoundedConstraint({ gameId, resourceId: a.id });
      const conserved = declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      expect(constraintsFor(a.id, "value").map((c) => c.id)).toEqual([bounded.id, conserved.id]);
    });

    it("returns [] for an entity with no constraints at all", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      expect(constraintsFor(resource.id, "value")).toEqual([]);
    });
  });

  describe("conservedConstraintFor", () => {
    it("returns the conserved constraint governing (entityId, 'value')", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      const declared = declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      expect(conservedConstraintFor(a.id, "value")?.id).toBe(declared.id);
    });

    it("returns null for a different fact key on the same entity", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      expect(conservedConstraintFor(a.id, "some_other_key")).toBeNull();
    });

    it("returns null when no conserved constraint is declared", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 50,
        minValue: 0,
        maxValue: 100,
      });
      declareBoundedConstraint({ gameId, resourceId: resource.id });

      expect(conservedConstraintFor(resource.id, "value")).toBeNull();
    });
  });

  describe("ResourceConstraint.factKey", () => {
    it("is 'value' for a bounded constraint", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 50,
        minValue: 0,
        maxValue: 100,
      });
      const declared = declareBoundedConstraint({ gameId, resourceId: resource.id });

      expect(declared.factKey).toBe("value");
      expect(constraintsFor(resource.id, "value")[0].factKey).toBe("value");
    });

    it("is 'value' for a monotonic constraint", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "population", value: 10 });
      const declared = declareMonotonicConstraint({
        gameId,
        resourceId: resource.id,
        direction: "increasing",
      });

      expect(declared.factKey).toBe("value");
    });

    it("is 'value' for a conserved constraint", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      const declared = declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      expect(declared.factKey).toBe("value");
    });
  });

  describe("schema idempotence", () => {
    it("running initializeSchema() twice does not throw and does not duplicate the fact_key column", () => {
      expect(() => initializeSchema()).not.toThrow();
      expect(() => initializeSchema()).not.toThrow();

      const cols = getDatabase().prepare("PRAGMA table_info(resource_constraints)").all() as Array<{
        name: string;
      }>;
      expect(cols.filter((c) => c.name === "fact_key")).toHaveLength(1);
    });
  });

  describe("planted violation -- proves the key-scoping guard can actually fail", () => {
    it("a constraint declared with fact_key = 'population' is NOT returned by constraintsFor(id, 'value')", () => {
      // Inserted directly, bypassing declare*(), so this does not depend on
      // any declare*() function ever supporting a non-'value' key -- only on
      // the registry actually filtering by fact_key rather than by
      // resource_id alone. See this task's final report for confirmation
      // that this assertion was watched failing against a version of
      // constraintsFor() with the fact_key filter removed.
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const db = getDatabase();
      const id = "planted-wrong-key-constraint";
      db.prepare(
        `INSERT INTO resource_constraints (id, game_id, kind, direction, total, fact_key, created_at)
         VALUES (?, ?, 'monotonic', 'increasing', NULL, 'population', ?)`
      ).run(id, gameId, new Date().toISOString());
      db.prepare(
        `INSERT INTO resource_constraint_members (constraint_id, resource_id) VALUES (?, ?)`
      ).run(id, resource.id);

      expect(constraintsFor(resource.id, "population").map((c) => c.id)).toEqual([id]);
      expect(constraintsFor(resource.id, "value")).toEqual([]);
    });
  });
});

describe("resource_constraints.fact_key migration against an existing database", () => {
  it("a pre-existing row created before fact_key existed reads back as factKey === 'value' once the migration re-runs, and is found by constraintsFor", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "dmcp-registry-migration-test-"));
    const dbPath = join(tmpDir, "games.db");

    try {
      process.env.DMCP_DB_PATH = dbPath;

      // Pass 1: a fully current, on-disk database -- games/resources/
      // resource_constraint_members all in their real current shape, with a
      // real declared constraint (and therefore a real fact_key = 'value'
      // row and a real membership row).
      initializeSchema();
      const gameId = createGame({ name: "Test Game", setting: "test", style: "test" }).id;
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const declared = declareMonotonicConstraint({
        gameId,
        resourceId: resource.id,
        direction: "increasing",
      });

      // Roll ONLY resource_constraints back to its pre-fact_key shape,
      // preserving the row inserted above -- this is what "a database that
      // predates this migration" actually looks like on disk. Same
      // recreate-and-rename technique src/db/schema.ts already uses for the
      // stored_images CHECK-constraint migration.
      let db = getDatabase();
      db.pragma("foreign_keys = OFF");
      db.exec(`
        CREATE TABLE resource_constraints_pre_fact_key (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('bounded', 'monotonic', 'conserved')),
          direction TEXT CHECK (direction IN ('increasing', 'decreasing')),
          total REAL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
        );
        INSERT INTO resource_constraints_pre_fact_key (id, game_id, kind, direction, total, created_at)
          SELECT id, game_id, kind, direction, total, created_at FROM resource_constraints;
        DROP TABLE resource_constraints;
        ALTER TABLE resource_constraints_pre_fact_key RENAME TO resource_constraints;
      `);
      db.pragma("foreign_keys = ON");

      const preMigrationCols = db.prepare("PRAGMA table_info(resource_constraints)").all() as Array<{
        name: string;
      }>;
      expect(preMigrationCols.map((c) => c.name)).not.toContain("fact_key");

      closeDatabase();

      // Pass 2: reopen the same on-disk file and re-run the startup
      // migration path, exactly as a real restart would.
      initializeSchema();
      db = getDatabase();

      const row = db
        .prepare("SELECT fact_key FROM resource_constraints WHERE id = ?")
        .get(declared.id) as { fact_key: string } | undefined;
      expect(row?.fact_key).toBe("value");

      expect(constraintsFor(resource.id, "value").map((c) => c.id)).toEqual([declared.id]);

      // And idempotence holds against the now-migrated on-disk file too.
      expect(() => initializeSchema()).not.toThrow();
      closeDatabase();
    } finally {
      process.env.DMCP_DB_PATH = ":memory:";
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
