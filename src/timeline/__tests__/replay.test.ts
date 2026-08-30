// replay(t) tests (GitHub issue #3). Design §5.1 calls this "the whole
// feature", and the architecture note flags half-open interval boundaries
// as the single most likely thing to ship broken -- so boundaries are
// covered exhaustively, not just spot-checked, and every boundary guard is
// planted-and-watched-red per the project's testing rule (root CLAUDE.md;
// see the mutation-testing notes below each boundary describe block).
//
// Timeline rows are built with raw INSERTs, not through the projection
// trigger path (that belongs to a different issue) -- this gives exact
// control over the intervals under test, which is the entire point here.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { replay } from "../replay.js";
import type { Snapshot } from "../replay.js";

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
  }> = {}
): string {
  const id = overrides.id ?? uuidv4();
  db.prepare(
    `INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entityId,
    overrides.key ?? "quantity",
    overrides.value ?? "50",
    overrides.validFromT ?? 0,
    overrides.validToT ?? null
  );
  return id;
}

describe("replay(t)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  describe("a full snapshot", () => {
    it("returns the right entities, each with the right facts and values", () => {
      const gameId = uuidv4();
      const grainId = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 0 });
      insertFact(db, grainId, { key: "quantity", value: "50", validFromT: 0 });
      insertFact(db, grainId, { key: "quality", value: "fresh", validFromT: 10 });

      const treasuryId = insertEntity(db, {
        gameId,
        kind: "resource",
        name: "treasury",
        createdAtT: 20,
      });
      insertFact(db, treasuryId, { key: "balance", value: "200", validFromT: 20 });

      const snapshot = replay({ gameId, t: 100 });

      expect(snapshot.gameId).toBe(gameId);
      expect(snapshot.t).toBe(100);
      expect(snapshot.entities).toHaveLength(2);

      const grain = snapshot.entities.find((e) => e.id === grainId);
      expect(grain).toMatchObject({ id: grainId, kind: "resource", name: "grain", createdAtT: 0 });
      expect(grain?.facts).toEqual({
        quantity: { value: "50", validFromT: 0 },
        quality: { value: "fresh", validFromT: 10 },
      });

      const treasury = snapshot.entities.find((e) => e.id === treasuryId);
      expect(treasury?.facts).toEqual({ balance: { value: "200", validFromT: 20 } });
    });

    it("issues exactly two queries regardless of how many entities exist", () => {
      const gameId = uuidv4();
      for (let i = 0; i < 5; i++) {
        const id = insertEntity(db, { gameId, createdAtT: i });
        insertFact(db, id, { key: "quantity", value: String(i), validFromT: i });
      }

      const prepareSpy = vi.spyOn(db, "prepare");
      replay({ gameId, t: 100 });
      expect(
        prepareSpy,
        "a snapshot must issue exactly two queries -- one for alive entities, one for their facts " +
          "-- never one query per entity. If this trips, something reintroduced per-entity looping " +
          "(or per-entity-count SQL text) into replay(); that is the regression this test exists to " +
          "catch, not a number to raise."
      ).toHaveBeenCalledTimes(2);
      prepareSpy.mockRestore();
    });
  });

  describe("interval boundaries -- a fact valid [10, 20)", () => {
    // Mutation testing (root CLAUDE.md: plant the violation, watch it go
    // red): temporarily changing the facts half of replay()'s "valid at t"
    // check from `valid_to_t > ?` to `valid_to_t >= ?` turns "absent at 20"
    // red -- the fact stays visible one tick past its own close. Changing
    // `valid_from_t <= ?` to `valid_from_t < ?` turns "present at 10" red --
    // the fact doesn't appear until one tick after it actually opened.
    // Both mutations restored; see the task report for the actual run.
    let gameId: string;
    let entityId: string;

    beforeEach(() => {
      gameId = uuidv4();
      entityId = insertEntity(db, { gameId, createdAtT: 0 });
      insertFact(db, entityId, { key: "quantity", validFromT: 10, validToT: 20, value: "50" });
    });

    it("absent at 9 (before valid_from_t)", () => {
      expect(replay({ gameId, t: 9 }).entities[0].facts).toEqual({});
    });

    it("present at 10 (== valid_from_t)", () => {
      expect(replay({ gameId, t: 10 }).entities[0].facts.quantity).toEqual({
        value: "50",
        validFromT: 10,
      });
    });

    it("present at 19.999 (just under valid_to_t)", () => {
      expect(replay({ gameId, t: 19.999 }).entities[0].facts.quantity).toEqual({
        value: "50",
        validFromT: 10,
      });
    });

    it("absent at 20 (== valid_to_t -- the interval is half-open)", () => {
      expect(replay({ gameId, t: 20 }).entities[0].facts).toEqual({});
    });

    it("absent at 21 (after valid_to_t)", () => {
      expect(replay({ gameId, t: 21 }).entities[0].facts).toEqual({});
    });

    it("reopened at 20 with a new value: the snapshot at 20 shows the new value, and only it", () => {
      insertFact(db, entityId, { key: "quantity", validFromT: 20, validToT: null, value: "80" });

      const facts = replay({ gameId, t: 20 }).entities[0].facts;
      expect(Object.keys(facts)).toEqual(["quantity"]);
      expect(facts.quantity).toEqual({ value: "80", validFromT: 20 });
    });
  });

  describe("entities created and destroyed mid-timeline -- created at 5, destroyed at 15", () => {
    // Same mutation-testing story as the fact boundaries above, applied to
    // the entities half: `destroyed_at_t > ?` -> `>=` should turn "absent
    // at 15" red; `created_at_t <= ?` -> `<` should turn "present at 5" red.
    let gameId: string;
    let entityId: string;

    beforeEach(() => {
      gameId = uuidv4();
      entityId = insertEntity(db, { gameId, createdAtT: 5, destroyedAtT: 15 });
      insertFact(db, entityId, { key: "quantity", validFromT: 5, validToT: null, value: "50" });
    });

    it("absent at 4 (before created_at_t)", () => {
      expect(replay({ gameId, t: 4 }).entities).toEqual([]);
    });

    it("present at 5 (== created_at_t)", () => {
      expect(replay({ gameId, t: 5 }).entities.map((e) => e.id)).toEqual([entityId]);
    });

    it("present at 14 (just under destroyed_at_t)", () => {
      expect(replay({ gameId, t: 14 }).entities.map((e) => e.id)).toEqual([entityId]);
    });

    it("absent at 15 (== destroyed_at_t -- the interval is half-open)", () => {
      expect(replay({ gameId, t: 15 }).entities).toEqual([]);
    });

    it("absent at 100 (long after destroyed_at_t)", () => {
      expect(replay({ gameId, t: 100 }).entities).toEqual([]);
    });

    it("does not leak the destroyed entity's facts into the snapshot", () => {
      const snapshot = replay({ gameId, t: 100 });
      expect(snapshot.entities.some((e) => e.id === entityId)).toBe(false);
      // The only way a fact could "leak" is by attaching to an entity that
      // is present in the snapshot; confirm there is nothing else in this
      // game's snapshot for it to attach to.
      expect(snapshot.entities).toEqual([]);
    });
  });

  describe("facts never closed (valid_to_t IS NULL)", () => {
    it("are visible at every t >= valid_from_t, including very large t", () => {
      const gameId = uuidv4();
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      insertFact(db, entityId, { key: "population", validFromT: 3, validToT: null, value: "1000" });

      for (const t of [3, 3.001, 1000, Number.MAX_SAFE_INTEGER]) {
        expect(replay({ gameId, t }).entities[0].facts.population).toEqual({
          value: "1000",
          validFromT: 3,
        });
      }
    });
  });

  describe("zero-width intervals (valid_from_t == valid_to_t)", () => {
    it("are invisible at every t, and the fact that superseded them is the one returned", () => {
      const gameId = uuidv4();
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      // Two writes declared at the same t: the first is immediately closed
      // at the instant it opened (the "stale" write), the second stays open.
      insertFact(db, entityId, { key: "quantity", validFromT: 20, validToT: 20, value: "stale" });
      insertFact(db, entityId, { key: "quantity", validFromT: 20, validToT: null, value: "current" });

      for (const t of [19, 20, 21, 1000]) {
        const facts = replay({ gameId, t }).entities[0].facts;
        if (t < 20) {
          expect(facts).toEqual({});
        } else {
          expect(Object.keys(facts)).toEqual(["quantity"]);
          expect(facts.quantity.value).toBe("current");
        }
      }
    });
  });

  describe("scoping", () => {
    it("two games in one database never see each other's entities", () => {
      const gameA = uuidv4();
      const gameB = uuidv4();
      const entityA = insertEntity(db, { gameId: gameA, name: "grain", createdAtT: 0 });
      const entityB = insertEntity(db, { gameId: gameB, name: "treasury", createdAtT: 0 });

      const snapshotA = replay({ gameId: gameA, t: 100 });
      const snapshotB = replay({ gameId: gameB, t: 100 });

      expect(snapshotA.entities.map((e) => e.id)).toEqual([entityA]);
      expect(snapshotB.entities.map((e) => e.id)).toEqual([entityB]);
    });
  });

  describe("an entity with no facts", () => {
    it("still appears in the snapshot, asserting nothing", () => {
      const gameId = uuidv4();
      const entityId = insertEntity(db, { gameId, name: "population", createdAtT: 0 });

      const snapshot = replay({ gameId, t: 100 });

      expect(snapshot.entities).toHaveLength(1);
      expect(snapshot.entities[0].id).toBe(entityId);
      expect(snapshot.entities[0].facts).toEqual({});
    });
  });

  describe("t validation", () => {
    it.each([
      ["a Date", new Date("2026-01-01T00:00:00Z")],
      ["a numeric string", "12"],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["null", null],
    ])("rejects %s", (_label, badT) => {
      expect(() => replay({ gameId: uuidv4(), t: badT as never })).toThrow();
    });
  });

  describe("before anything existed", () => {
    it("returns an empty snapshot and does not throw", () => {
      const gameId = uuidv4();
      insertEntity(db, { gameId, createdAtT: 50 });

      expect(() => replay({ gameId, t: -1000 })).not.toThrow();
      expect(replay({ gameId, t: -1000 }).entities).toEqual([]);
    });

    it("returns an empty snapshot for a game that was never written at all", () => {
      expect(replay({ gameId: uuidv4(), t: 0 }).entities).toEqual([]);
    });
  });

  describe("determinism", () => {
    it("two calls at the same t return deeply equal snapshots, in the same order", () => {
      const gameId = uuidv4();
      for (let i = 0; i < 4; i++) {
        const id = insertEntity(db, { gameId, createdAtT: i, name: `entity-${i}` });
        insertFact(db, id, { key: "quantity", value: String(i * 10), validFromT: i });
      }

      const first: Snapshot = replay({ gameId, t: 100 });
      const second: Snapshot = replay({ gameId, t: 100 });

      expect(second).toEqual(first);
      expect(second.entities.map((e) => e.id)).toEqual(first.entities.map((e) => e.id));
    });
  });

  describe("non-integer t", () => {
    it("works as an opaque ordinal, not a turn count", () => {
      const gameId = uuidv4();
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      insertFact(db, entityId, { key: "quantity", validFromT: 6.25, validToT: 6.27, value: "50" });

      expect(replay({ gameId, t: 6.24 }).entities[0].facts).toEqual({});
      expect(replay({ gameId, t: 6.26 }).entities[0].facts.quantity).toEqual({
        value: "50",
        validFromT: 6.25,
      });
      expect(replay({ gameId, t: 6.27 }).entities[0].facts).toEqual({});
    });
  });
});
