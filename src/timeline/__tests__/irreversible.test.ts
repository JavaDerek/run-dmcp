// `irreversible` -- the temporal member of the constraint family (design
// §5.3, §5.2b, §5.2c; GitHub issue #7). A fact marked irreversible can never
// be contradicted by a later assertion under the same (entity_id, key) --
// closing an interval is not a contradiction, so the record stays deletable.
//
// Enforcement lives in SQL triggers (src/timeline/schema.ts), not in JS --
// every one of the 48 write sites reaches `facts` through the projection
// triggers, so a JS check would be bypassed by all of them. These tests
// therefore exercise the trigger layer directly (raw SQL, exact control over
// intervals -- same rationale as replay.test.ts) AND through a real tool path
// (updateResourceValue / deleteResource), so the projection trigger is what
// actually carries the refusal in at least one test per rule.
//
// Every guard here is planted-and-watched-red per the project's testing rule
// (root CLAUDE.md) -- see the task report for the actual failing-first runs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { initializeSchema } from "../../db/schema.js";
import { createGame } from "../../tools/game.js";
import { createResource, deleteResource, updateResourceValue } from "../../tools/resource.js";
import { declareIrreversible, irreversibleFactFor, listIrreversibleFacts } from "../irreversible.js";

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
    overrides.key ?? "quantity",
    overrides.value ?? "50",
    overrides.validFromT ?? 0,
    overrides.validToT ?? null,
    overrides.irreversible ?? 0
  );
  return id;
}

describe("irreversible facts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  describe("timeline_facts_irreversible (INSERT guard) -- raw trigger level", () => {
    let gameId: string;
    let entityId: string;

    beforeEach(() => {
      gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      entityId = insertEntity(db, { gameId, kind: "resource", name: "population" });
    });

    it("refuses a contradicting INSERT at the same entity_id/key with a different value at t >= valid_from_t", () => {
      insertFact(db, entityId, {
        key: "status",
        value: "destroyed",
        validFromT: 10,
        validToT: null,
        irreversible: 1,
      });

      expect(() =>
        insertFact(db, entityId, { key: "status", value: "rebuilt", validFromT: 15, validToT: null })
      ).toThrow();
    });

    it("permits an INSERT re-asserting the SAME value -- not a contradiction", () => {
      const factId = insertFact(db, entityId, {
        key: "status",
        value: "destroyed",
        validFromT: 10,
        validToT: null,
        irreversible: 1,
      });

      // Close the fact first (rule 2: closing is permitted).
      db.prepare("UPDATE facts SET valid_to_t = ? WHERE id = ?").run(20, factId);

      expect(() =>
        insertFact(db, entityId, { key: "status", value: "destroyed", validFromT: 20, validToT: null })
      ).not.toThrow();
    });

    it("permits an INSERT for a DIFFERENT key on the same entity, even with a contradicting-looking value", () => {
      insertFact(db, entityId, {
        key: "status",
        value: "destroyed",
        validFromT: 10,
        validToT: null,
        irreversible: 1,
      });

      expect(() =>
        insertFact(db, entityId, { key: "reputation", value: "destroyed", validFromT: 15, validToT: null })
      ).not.toThrow();
    });

    it("permits an INSERT for the same key on a DIFFERENT entity", () => {
      insertFact(db, entityId, {
        key: "status",
        value: "destroyed",
        validFromT: 10,
        validToT: null,
        irreversible: 1,
      });
      const otherEntityId = insertEntity(db, { gameId, kind: "resource", name: "other" });

      expect(() =>
        insertFact(db, otherEntityId, { key: "status", value: "rebuilt", validFromT: 15, validToT: null })
      ).not.toThrow();
    });

    describe("valid_from_t boundary -- irreversible fact opens at t=10", () => {
      beforeEach(() => {
        insertFact(db, entityId, {
          key: "status",
          value: "destroyed",
          validFromT: 10,
          validToT: null,
          irreversible: 1,
        });
      });

      it("refuses a different value asserted exactly AT t=10 (the >= boundary)", () => {
        expect(() =>
          insertFact(db, entityId, { key: "status", value: "rebuilt", validFromT: 10, validToT: null })
        ).toThrow();
      });

      it("permits a different value asserted strictly BEFORE t=10", () => {
        expect(() =>
          insertFact(db, entityId, { key: "status", value: "pristine", validFromT: 9, validToT: null })
        ).not.toThrow();
      });

      it("refuses a different value asserted strictly AFTER t=10", () => {
        expect(() =>
          insertFact(db, entityId, { key: "status", value: "rebuilt", validFromT: 11, validToT: null })
        ).toThrow();
      });
    });

    it("closing (via a DELETE-style sweep) is permitted even with an irreversible fact open, but a later reopen with a different value is still refused", () => {
      const factId = insertFact(db, entityId, {
        key: "status",
        value: "destroyed",
        validFromT: 5,
        validToT: null,
        irreversible: 1,
      });

      // Simulates the projection layer's `_ad` delete trigger, which closes
      // every open fact for a destroyed entity -- this must not be blocked
      // just because one of those facts is irreversible (rule 2).
      expect(() => db.prepare("UPDATE facts SET valid_to_t = ? WHERE id = ?").run(10, factId)).not.toThrow();

      // Reopening the SAME key afterward with a DIFFERENT value is still
      // refused -- the guard tests every irreversible row for the key,
      // open or closed, not just the currently-open one.
      expect(() =>
        insertFact(db, entityId, { key: "status", value: "rebuilt", validFromT: 10, validToT: null })
      ).toThrow();
    });
  });

  describe("timeline_facts_immutable -- the irreversible latch (amended)", () => {
    let entityId: string;
    let factId: string;

    beforeEach(() => {
      entityId = insertEntity(db);
      factId = insertFact(db, entityId, { irreversible: 0 });
    });

    it("permits 0 -> 1", () => {
      expect(() => db.prepare("UPDATE facts SET irreversible = 1 WHERE id = ?").run(factId)).not.toThrow();
      const row = db.prepare("SELECT irreversible FROM facts WHERE id = ?").get(factId) as {
        irreversible: number;
      };
      expect(row.irreversible).toBe(1);
    });

    it("1 -> 1 is a no-op that does not abort", () => {
      db.prepare("UPDATE facts SET irreversible = 1 WHERE id = ?").run(factId);
      expect(() => db.prepare("UPDATE facts SET irreversible = 1 WHERE id = ?").run(factId)).not.toThrow();
    });

    it("refuses 1 -> 0", () => {
      db.prepare("UPDATE facts SET irreversible = 1 WHERE id = ?").run(factId);
      expect(() => db.prepare("UPDATE facts SET irreversible = 0 WHERE id = ?").run(factId)).toThrow();
    });

    it("refuses 0 -> 5 (not merely 0 -> 1 vs unchanged, any other target is rejected too)", () => {
      expect(() => db.prepare("UPDATE facts SET irreversible = 5 WHERE id = ?").run(factId)).toThrow();
    });

    it("refuses 1 -> 5", () => {
      db.prepare("UPDATE facts SET irreversible = 1 WHERE id = ?").run(factId);
      expect(() => db.prepare("UPDATE facts SET irreversible = 5 WHERE id = ?").run(factId)).toThrow();
    });
  });

  describe("real tool path: updateResourceValue through the projection trigger", () => {
    let gameId: string;
    let resourceId: string;

    beforeEach(() => {
      gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      resourceId = createResource({ gameId, ownerType: "game", name: "grain", value: 50 }).id;
    });

    it("a contradicting set is refused, the fact stays open and unchanged, the live row is untouched, and the clock does not advance", () => {
      declareIrreversible({ entityId: resourceId, key: "value" });

      const clockBefore = db.prepare("SELECT current_t FROM timeline_clock WHERE game_id = ?").get(gameId) as {
        current_t: number;
      };
      const factBefore = db
        .prepare("SELECT id, value, valid_to_t FROM facts WHERE entity_id = ? AND key = 'value'")
        .get(resourceId) as { id: string; value: string; valid_to_t: number | null };
      expect(factBefore.valid_to_t).toBeNull();

      expect(() => updateResourceValue({ resourceId, mode: "set", value: 999 })).toThrow();

      const resourceRow = db.prepare("SELECT value FROM resources WHERE id = ?").get(resourceId) as {
        value: number;
      };
      expect(resourceRow.value).toBe(50);

      const factAfter = db
        .prepare("SELECT id, value, valid_to_t FROM facts WHERE entity_id = ? AND key = 'value'")
        .get(resourceId) as { id: string; value: string; valid_to_t: number | null };
      expect(factAfter.id).toBe(factBefore.id);
      // Whatever SQLite's CAST(REAL AS TEXT) produced originally (a REAL
      // column renders as e.g. "50.0", not "50" -- see checkpoint.ts's doc
      // comment) is what must still be there; the point under test is that
      // it is UNCHANGED, not any particular string spelling.
      expect(factAfter.value).toBe(factBefore.value);
      expect(factAfter.valid_to_t).toBeNull();

      const clockAfter = db.prepare("SELECT current_t FROM timeline_clock WHERE game_id = ?").get(gameId) as {
        current_t: number;
      };
      expect(clockAfter.current_t).toBe(clockBefore.current_t);
    });

    it("re-asserting the SAME value via updateResourceValue is allowed", () => {
      declareIrreversible({ entityId: resourceId, key: "value" });
      expect(() => updateResourceValue({ resourceId, mode: "set", value: 50 })).not.toThrow();
    });

    it("deleteResource succeeds (closes the fact) even with an irreversible fact open", () => {
      declareIrreversible({ entityId: resourceId, key: "value" });

      expect(() => deleteResource(resourceId)).not.toThrow();

      const factRow = db
        .prepare("SELECT valid_to_t FROM facts WHERE entity_id = ? AND key = 'value'")
        .get(resourceId) as { valid_to_t: number | null };
      expect(factRow.valid_to_t).not.toBeNull();
    });
  });

  describe("fact granularity -- irreversible locks the WHOLE value under one key", () => {
    it("cannot independently vary part of a multi-property value once its key is declared irreversible", () => {
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "bundle" });
      const factId = insertFact(db, entityId, {
        key: "state",
        value: JSON.stringify({ a: 1, b: 2 }),
        validFromT: 0,
        validToT: null,
      });

      declareIrreversible({ entityId, key: "state" });

      db.prepare("UPDATE facts SET valid_to_t = ? WHERE id = ?").run(5, factId);

      // Only `b` changed; `a` is identical. The guard has no concept of
      // sub-fields -- it compares the whole stored value string -- so this
      // is refused exactly like changing `a` would be. This is what forces
      // a consumer that wants `a` and `b` independently irreversible to give
      // each its own fact key.
      expect(() =>
        insertFact(db, entityId, {
          key: "state",
          value: JSON.stringify({ a: 1, b: 3 }),
          validFromT: 5,
          validToT: null,
        })
      ).toThrow();
    });
  });

  describe("declareIrreversible", () => {
    it("throws a clear error naming the id for an unknown entity", () => {
      const unknownId = uuidv4();
      expect(() => declareIrreversible({ entityId: unknownId, key: "value" })).toThrow(
        new RegExp(unknownId)
      );
    });

    it("throws when there is no open fact for that key -- cannot declare irreversibility of an absence", () => {
      const entityId = insertEntity(db);
      expect(() => declareIrreversible({ entityId, key: "never-written" })).toThrow();
    });

    it("throws when the only fact for that key is already closed", () => {
      const entityId = insertEntity(db);
      insertFact(db, entityId, { key: "status", value: "x", validFromT: 0, validToT: 10 });
      expect(() => declareIrreversible({ entityId, key: "status" })).toThrow();
    });

    it("is idempotent: declaring twice does not throw and returns the same record", () => {
      const entityId = insertEntity(db);
      insertFact(db, entityId, { key: "status", value: "destroyed", validFromT: 0, validToT: null });

      const first = declareIrreversible({ entityId, key: "status" });
      let second: ReturnType<typeof declareIrreversible> | undefined;
      expect(() => {
        second = declareIrreversible({ entityId, key: "status" });
      }).not.toThrow();

      expect(second).toEqual(first);
    });

    it("marks the currently open fact irreversible, returning entityId/key/value/validFromT", () => {
      const entityId = insertEntity(db);
      insertFact(db, entityId, { key: "status", value: "destroyed", validFromT: 7, validToT: null });

      const result = declareIrreversible({ entityId, key: "status" });

      expect(result.entityId).toBe(entityId);
      expect(result.key).toBe("status");
      expect(result.value).toBe("destroyed");
      expect(result.validFromT).toBe(7);

      const row = db.prepare("SELECT irreversible FROM facts WHERE id = ?").get(result.factId) as {
        irreversible: number;
      };
      expect(row.irreversible).toBe(1);
    });
  });

  describe("openedByEventId -- one hop of causality", () => {
    it("is populated when the fact was opened by the projection triggers", () => {
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });

      const result = declareIrreversible({ entityId: resource.id, key: "value" });

      expect(result.openedByEventId).not.toBeNull();

      const eventRow = db.prepare("SELECT causes FROM events WHERE id = ?").get(result.openedByEventId) as
        | { causes: string }
        | undefined;
      expect(eventRow).toBeDefined();
      expect(JSON.parse(eventRow?.causes ?? "null")).toMatchObject({ table: "resources", row_id: resource.id });
    });

    it("is null when no matching event exists (a fact inserted by raw SQL, not through the projection triggers)", () => {
      const entityId = insertEntity(db);
      insertFact(db, entityId, { key: "status", value: "destroyed", validFromT: 0, validToT: null });

      const result = declareIrreversible({ entityId, key: "status" });

      expect(result.openedByEventId).toBeNull();
    });

    /**
     * `events.causes` has no CHECK and no json_valid constraint, so a row
     * holding something that is not JSON is storable -- and reachable in
     * practice, because timeline import (export.ts, issue #8) carries
     * `causes` through verbatim by design, which is correct: an importer
     * that rewrote a recorded cause would be inventing history.
     *
     * SQLite's `json_extract` raises "malformed JSON" rather than returning
     * NULL when it meets one, and that error is not scoped to the offending
     * row -- one bad row anywhere in the game's events would take down
     * every function in this module, including `declareIrreversible`, which
     * has nothing to do with that event. A lookup that is one hop of
     * provenance must never be able to fail the write it is annotating.
     */
    it("survives an event whose causes is not valid JSON, and still finds the right hop", () => {
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });

      const openedAt = db
        .prepare("SELECT valid_from_t FROM facts WHERE entity_id = ? AND key = 'value'")
        .get(resource.id) as { valid_from_t: number };

      // A second event at the very same t, so it is inside the candidate set
      // the lookup scans rather than merely present in the table.
      db.prepare(
        `INSERT INTO events (id, game_id, at_t, kind, description, causes) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(uuidv4(), gameId, openedAt.valid_from_t, "external.note", null, "not json at all");

      expect(() => declareIrreversible({ entityId: resource.id, key: "value" })).not.toThrow();

      const result = irreversibleFactFor(resource.id, "value");
      expect(result?.openedByEventId).not.toBeNull();
      expect(() => listIrreversibleFacts({ gameId })).not.toThrow();
    });
  });

  describe("irreversibleFactFor", () => {
    it("returns null when the entity does not exist", () => {
      expect(irreversibleFactFor(uuidv4(), "status")).toBeNull();
    });

    it("returns null when the key holds no irreversible fact", () => {
      const entityId = insertEntity(db);
      insertFact(db, entityId, { key: "status", value: "destroyed", validFromT: 0, validToT: null });
      expect(irreversibleFactFor(entityId, "status")).toBeNull();
    });

    it("returns the declared fact once one exists", () => {
      const entityId = insertEntity(db);
      insertFact(db, entityId, { key: "status", value: "destroyed", validFromT: 0, validToT: null });
      declareIrreversible({ entityId, key: "status" });

      const found = irreversibleFactFor(entityId, "status");
      expect(found?.entityId).toBe(entityId);
      expect(found?.key).toBe("status");
      expect(found?.value).toBe("destroyed");
    });
  });

  describe("listIrreversibleFacts", () => {
    it("returns only the irreversible facts for the given game, never a verdict field", () => {
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const entityA = insertEntity(db, { gameId, name: "population" });
      const entityB = insertEntity(db, { gameId, name: "treasury" });
      insertFact(db, entityA, { key: "status", value: "destroyed", validFromT: 0, validToT: null });
      insertFact(db, entityB, { key: "balance", value: "0", validFromT: 0, validToT: null });

      declareIrreversible({ entityId: entityA, key: "status" });

      const all = listIrreversibleFacts({ gameId });
      expect(all).toHaveLength(1);
      expect(all[0].entityId).toBe(entityA);
      expect(all[0]).not.toHaveProperty("isClean");
      expect(all[0]).not.toHaveProperty("severity");
    });

    it("filters by entityId when given", () => {
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const entityA = insertEntity(db, { gameId, name: "population" });
      const entityB = insertEntity(db, { gameId, name: "treasury" });
      insertFact(db, entityA, { key: "status", value: "destroyed", validFromT: 0, validToT: null });
      insertFact(db, entityB, { key: "status", value: "gone", validFromT: 0, validToT: null });
      declareIrreversible({ entityId: entityA, key: "status" });
      declareIrreversible({ entityId: entityB, key: "status" });

      const onlyA = listIrreversibleFacts({ gameId, entityId: entityA });
      expect(onlyA.map((f) => f.entityId)).toEqual([entityA]);
    });

    it("never leaks another game's irreversible facts", () => {
      const gameA = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const gameB = createGame({ name: "treasury vault", setting: "test", style: "test" }).id;
      const entityA = insertEntity(db, { gameId: gameA, name: "population" });
      const entityB = insertEntity(db, { gameId: gameB, name: "population" });
      insertFact(db, entityA, { key: "status", value: "destroyed", validFromT: 0, validToT: null });
      insertFact(db, entityB, { key: "status", value: "destroyed", validFromT: 0, validToT: null });
      declareIrreversible({ entityId: entityA, key: "status" });
      declareIrreversible({ entityId: entityB, key: "status" });

      const onlyGameA = listIrreversibleFacts({ gameId: gameA });
      expect(onlyGameA.map((f) => f.entityId)).toEqual([entityA]);
    });

    it("returns an empty array for a game with no irreversible facts", () => {
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      expect(listIrreversibleFacts({ gameId })).toEqual([]);
    });
  });

  describe("reconciliation at startup does not throw when a live column has diverged from an irreversible fact", () => {
    it("leaves the irreversible fact open and unchanged, and does not throw initializeSchema", () => {
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });

      declareIrreversible({ entityId: resource.id, key: "value" });

      // Simulate a write that bypassed the projection triggers entirely
      // (a database predating them, or an external writer) by dropping the
      // resources AFTER UPDATE trigger before writing directly to the live
      // column.
      db.exec("DROP TRIGGER IF EXISTS timeline_resources_au");
      db.prepare("UPDATE resources SET value = ? WHERE id = ?").run(999, resource.id);

      const factBefore = db
        .prepare("SELECT value, valid_to_t FROM facts WHERE entity_id = ? AND key = 'value'")
        .get(resource.id) as { value: string; valid_to_t: number | null };
      // SQLite's CAST(REAL AS TEXT) renders 50 as "50.0", not "50" (see
      // checkpoint.ts's doc comment) -- assert against that real rendering
      // rather than assume a spelling.
      expect(factBefore.value).toBe("50.0");
      expect(factBefore.valid_to_t).toBeNull();

      // Reconciliation runs inside initializeSchema() at every startup.
      // Without the `AND facts.irreversible = 0` guard on the reconcile
      // CLOSE statement, this would attempt to close the irreversible fact
      // and reopen it at the diverged value -- which the INSERT guard would
      // then abort, throwing out of initializeSchema() and refusing to boot.
      expect(() => initializeSchema()).not.toThrow();

      const factAfter = db
        .prepare("SELECT value, valid_to_t FROM facts WHERE entity_id = ? AND key = 'value'")
        .get(resource.id) as { value: string; valid_to_t: number | null };
      expect(factAfter.value).toBe(factBefore.value);
      expect(factAfter.valid_to_t).toBeNull();

      // The live row itself is left exactly as reconciliation found it --
      // the engine records the divergence (via timelineDivergences(),
      // checkpoint.ts), it does not decide about it.
      const resourceRow = db.prepare("SELECT value FROM resources WHERE id = ?").get(resource.id) as {
        value: number;
      };
      expect(resourceRow.value).toBe(999);
    });
  });

  describe("re-entrancy against an existing database", () => {
    it("running initializeSchema a second and third time leaves the irreversible guards behaving the same", () => {
      const entityId = insertEntity(db);
      insertFact(db, entityId, { key: "status", value: "destroyed", validFromT: 0, validToT: null, irreversible: 1 });

      expect(() => initializeSchema()).not.toThrow();
      expect(() => initializeSchema()).not.toThrow();

      // The INSERT guard still refuses a contradicting assertion...
      expect(() =>
        insertFact(db, entityId, { key: "status", value: "rebuilt", validFromT: 5, validToT: null })
      ).toThrow();
      // ...and the latch still only permits 0 -> 1.
      const factId = insertFact(db, entityId, { key: "population", value: "1000", validFromT: 0 });
      expect(() => db.prepare("UPDATE facts SET irreversible = 1 WHERE id = ?").run(factId)).not.toThrow();
      expect(() => db.prepare("UPDATE facts SET irreversible = 0 WHERE id = ?").run(factId)).toThrow();
    });
  });
});
