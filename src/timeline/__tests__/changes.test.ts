// changesWithin(t0, t1) tests (GitHub issue #5). Design §5.5: "the engine
// provides the query; the client declares the policy" -- the query returns
// transitions, never a verdict (root CLAUDE.md hard rule 2). Half-open
// interval boundaries are the single most likely thing to ship broken here
// (same as replay.ts -- see replay.test.ts's own mutation-testing
// precedent), with one added axis: a fact's OPEN and its CLOSE are two
// independently-landing transitions, not one snapshot-membership check, so
// the boundary coverage below plants transitions on shared window edges and
// on both endpoints of a single fact's interval.
//
// Timeline rows are built with raw INSERTs, not through the projection
// trigger path (that belongs to a different issue) -- this gives exact
// control over the intervals under test, which is the entire point here.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { changesWithin } from "../changes.js";
import type { Change, EventChange, FactChange } from "../changes.js";

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
    overrides.kind ?? "resource.updated",
    overrides.description ?? null,
    overrides.causes ?? null
  );
  return id;
}

function isFactChange(c: Change): c is FactChange {
  return c.kind === "fact";
}

function isEventChange(c: Change): c is EventChange {
  return c.kind === "event";
}

describe("changesWithin(t0, t1)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  describe("adjacent windows -- transitions planted exactly on the shared boundary", () => {
    // Windows [0,10), [10,20), [20,30). Events planted exactly at t=10 (the
    // boundary between window 1 and window 2) and exactly at t=20 (the
    // boundary between window 2 and window 3). Half-open means each
    // boundary event belongs to the window it OPENS, never the one it
    // CLOSES: t=10 belongs to [10,20), not [0,10); t=20 belongs to [20,30),
    // not [10,20).
    //
    // Mutation-testing note (root CLAUDE.md: plant the violation, watch it
    // go red): this suite is run once against a deliberately closed-closed
    // implementation (t0 <= x <= t1 on both the events and facts queries)
    // before changesWithin is corrected to half-open. See the task report
    // for the actual run -- under closed-closed, the boundary event at t=10
    // appears in BOTH [0,10) and [10,20), and the boundary event at t=20
    // appears in BOTH [10,20) and [20,30), which this test catches directly.
    let gameId: string;
    let eventAtB: string;
    let eventAtC: string;

    beforeEach(() => {
      gameId = uuidv4();
      eventAtB = insertEvent(db, { gameId, atT: 10, kind: "resource.updated" });
      eventAtC = insertEvent(db, { gameId, atT: 20, kind: "resource.updated" });
    });

    it("window [0,10) contains neither boundary transition", () => {
      const result = changesWithin({ gameId, t0: 0, t1: 10 });
      const ids = result.changes.filter(isEventChange).map((c) => c.eventId);
      expect(ids).toEqual([]);
    });

    it("window [10,20) contains the t=10 transition and not the t=20 one", () => {
      const result = changesWithin({ gameId, t0: 10, t1: 20 });
      const ids = result.changes.filter(isEventChange).map((c) => c.eventId);
      expect(ids).toEqual([eventAtB]);
    });

    it("window [20,30) contains the t=20 transition and not the t=10 one", () => {
      const result = changesWithin({ gameId, t0: 20, t1: 30 });
      const ids = result.changes.filter(isEventChange).map((c) => c.eventId);
      expect(ids).toEqual([eventAtC]);
    });

    it("each boundary transition appears in exactly one of the three windows", () => {
      const w1 = changesWithin({ gameId, t0: 0, t1: 10 }).changes.filter(isEventChange).map((c) => c.eventId);
      const w2 = changesWithin({ gameId, t0: 10, t1: 20 }).changes.filter(isEventChange).map((c) => c.eventId);
      const w3 = changesWithin({ gameId, t0: 20, t1: 30 }).changes.filter(isEventChange).map((c) => c.eventId);

      for (const id of [eventAtB, eventAtC]) {
        const memberships = [w1, w2, w3].filter((w) => w.includes(id));
        expect(memberships, `${id} must appear in exactly one window`).toHaveLength(1);
      }
    });
  });

  describe("a fact that opens and closes inside one window", () => {
    it("returns two rows, opened before closed", () => {
      const gameId = uuidv4();
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      const factId = insertFact(db, entityId, { key: "quantity", validFromT: 5, validToT: 8, value: "50" });

      const result = changesWithin({ gameId, t0: 0, t1: 10 });
      const factChanges = result.changes.filter(isFactChange).filter((c) => c.factId === factId);

      expect(factChanges).toHaveLength(2);
      expect(factChanges.map((c) => c.endpoint)).toEqual(["opened", "closed"]);
      expect(factChanges.map((c) => c.t)).toEqual([5, 8]);
      expect(factChanges[0]).toMatchObject({
        kind: "fact",
        factId,
        entityId,
        factKey: "quantity",
        value: "50",
        validFromT: 5,
        validToT: 8,
      });
      expect(factChanges[1]).toMatchObject({
        kind: "fact",
        factId,
        entityId,
        factKey: "quantity",
        value: "50",
        validFromT: 5,
        validToT: 8,
      });
    });
  });

  describe("a fact opened before t0 that closes inside the window", () => {
    it("returns exactly one row, 'closed'", () => {
      const gameId = uuidv4();
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      const factId = insertFact(db, entityId, { key: "quantity", validFromT: 0, validToT: 5, value: "50" });

      const result = changesWithin({ gameId, t0: 3, t1: 10 });
      const factChanges = result.changes.filter(isFactChange).filter((c) => c.factId === factId);

      expect(factChanges).toHaveLength(1);
      expect(factChanges[0]).toMatchObject({ endpoint: "closed", t: 5 });
    });
  });

  describe("a fact that opens inside the window and is still open", () => {
    it("returns exactly one row, 'opened', and never a phantom 'closed' at null", () => {
      const gameId = uuidv4();
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      const factId = insertFact(db, entityId, { key: "quantity", validFromT: 5, validToT: null, value: "50" });

      const result = changesWithin({ gameId, t0: 0, t1: 10 });
      const factChanges = result.changes.filter(isFactChange).filter((c) => c.factId === factId);

      expect(factChanges).toHaveLength(1);
      expect(factChanges[0]).toMatchObject({ endpoint: "opened", t: 5, validFromT: 5, validToT: null });
    });
  });

  describe("a fact whose interval strictly contains the window", () => {
    it("opens before t0 and closes after t1 -- returns zero rows", () => {
      const gameId = uuidv4();
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      const factId = insertFact(db, entityId, { key: "quantity", validFromT: -10, validToT: 100, value: "50" });

      const result = changesWithin({ gameId, t0: 0, t1: 10 });
      const factChanges = result.changes.filter(isFactChange).filter((c) => c.factId === factId);

      expect(factChanges).toEqual([]);
    });

    it("opens before t0 and closes exactly at t1 -- still zero rows (t1 is excluded)", () => {
      const gameId = uuidv4();
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      const factId = insertFact(db, entityId, { key: "quantity", validFromT: -10, validToT: 10, value: "50" });

      const result = changesWithin({ gameId, t0: 0, t1: 10 });
      const factChanges = result.changes.filter(isFactChange).filter((c) => c.factId === factId);

      expect(factChanges).toEqual([]);
    });
  });

  describe("events -- t0 in, t1 out", () => {
    it("an event at t0 is included; an event at t1 is excluded", () => {
      const gameId = uuidv4();
      const eventAtT0 = insertEvent(db, { gameId, atT: 0, kind: "resource.updated" });
      const eventAtT1 = insertEvent(db, { gameId, atT: 10, kind: "resource.updated" });

      const result = changesWithin({ gameId, t0: 0, t1: 10 });
      const ids = result.changes.filter(isEventChange).map((c) => c.eventId);

      expect(ids).toContain(eventAtT0);
      expect(ids).not.toContain(eventAtT1);
    });

    it("carries kind, description and the raw causes string through untouched", () => {
      const gameId = uuidv4();
      const causes = JSON.stringify({ from: "some-other-event-id" });
      const eventId = insertEvent(db, {
        gameId,
        atT: 5,
        kind: "resource.updated",
        description: "grain quantity adjusted",
        causes,
      });

      const result = changesWithin({ gameId, t0: 0, t1: 10 });
      const change = result.changes.find((c) => isEventChange(c) && c.eventId === eventId) as
        | EventChange
        | undefined;

      expect(change).toMatchObject({
        kind: "event",
        eventId,
        eventKind: "resource.updated",
        description: "grain quantity adjusted",
        causes,
      });
    });
  });

  describe("deterministic total order", () => {
    it("orders by t, then kind, then id, then endpoint -- stable across repeated calls", () => {
      const gameId = uuidv4();
      const entityA = insertEntity(db, { gameId, id: "entity-a", createdAtT: 0, name: "grain" });
      const entityB = insertEntity(db, { gameId, id: "entity-b", createdAtT: 0, name: "treasury" });

      // Two events at the same t, ids chosen so string order is unambiguous.
      insertEvent(db, { gameId, id: "evt-b", atT: 15, kind: "resource.updated" });
      insertEvent(db, { gameId, id: "evt-a", atT: 15, kind: "resource.updated" });

      // Two facts opening/closing at the same t, distinct ids.
      insertFact(db, entityA, { id: "fact-a", key: "quantity", validFromT: 15, validToT: null, value: "1" });
      insertFact(db, entityB, { id: "fact-b", key: "balance", validFromT: 0, validToT: 15, value: "2" });

      // A zero-width interval at the same t: both its open and its close
      // land at 15, so factId alone cannot separate the two rows it
      // produces -- endpoint is the required final tiebreaker.
      insertFact(db, entityA, { id: "fact-c", key: "population", validFromT: 15, validToT: 15, value: "3" });

      const expectedOrder = [
        { kind: "event", key: "evt-a" },
        { kind: "event", key: "evt-b" },
        { kind: "fact", key: "fact-a:opened" },
        { kind: "fact", key: "fact-b:closed" },
        { kind: "fact", key: "fact-c:closed" },
        { kind: "fact", key: "fact-c:opened" },
      ];

      function keyOf(c: Change): { kind: string; key: string } {
        if (isEventChange(c)) return { kind: "event", key: c.eventId };
        return { kind: "fact", key: `${c.factId}:${c.endpoint}` };
      }

      const run1 = changesWithin({ gameId, t0: 15, t1: 16 }).changes.map(keyOf);
      const run2 = changesWithin({ gameId, t0: 15, t1: 16 }).changes.map(keyOf);

      expect(run1).toEqual(expectedOrder);
      expect(run2).toEqual(run1);
    });
  });

  describe("window validation", () => {
    it("t1 === t0 is a legal empty window that returns zero rows", () => {
      const gameId = uuidv4();
      insertEvent(db, { gameId, atT: 5, kind: "resource.updated" });

      const result = changesWithin({ gameId, t0: 5, t1: 5 });
      expect(result.changes).toEqual([]);
    });

    it("t1 < t0 throws, naming both values", () => {
      const gameId = uuidv4();
      expect(() => changesWithin({ gameId, t0: 10, t1: 3 })).toThrow(/10/);
      expect(() => changesWithin({ gameId, t0: 10, t1: 3 })).toThrow(/3/);
    });

    it.each([
      ["a Date", new Date("2026-01-01T00:00:00Z")],
      ["a numeric string", "12"],
      ["NaN", NaN],
      ["Infinity", Infinity],
    ])("rejects %s as t0", (_label, badT) => {
      expect(() => changesWithin({ gameId: uuidv4(), t0: badT as never, t1: 10 })).toThrow();
    });

    it.each([
      ["a Date", new Date("2026-01-01T00:00:00Z")],
      ["a numeric string", "12"],
      ["NaN", NaN],
      ["Infinity", Infinity],
    ])("rejects %s as t1", (_label, badT) => {
      expect(() => changesWithin({ gameId: uuidv4(), t0: 0, t1: badT as never })).toThrow();
    });
  });

  describe("an unknown gameId", () => {
    it("returns an empty set rather than throwing", () => {
      const result = changesWithin({ gameId: uuidv4(), t0: 0, t1: 100 });
      expect(result.changes).toEqual([]);
    });
  });

  describe("scoping across games", () => {
    it("transitions from another game never leak into the result", () => {
      const gameA = uuidv4();
      const gameB = uuidv4();

      const entityA = insertEntity(db, { gameId: gameA, createdAtT: 0, name: "grain" });
      const entityB = insertEntity(db, { gameId: gameB, createdAtT: 0, name: "treasury" });

      const factA = insertFact(db, entityA, { key: "quantity", validFromT: 5, validToT: null, value: "50" });
      const factB = insertFact(db, entityB, { key: "balance", validFromT: 5, validToT: null, value: "200" });

      const eventA = insertEvent(db, { gameId: gameA, atT: 6, kind: "resource.updated" });
      const eventB = insertEvent(db, { gameId: gameB, atT: 6, kind: "resource.updated" });

      const resultA = changesWithin({ gameId: gameA, t0: 0, t1: 10 });
      const resultB = changesWithin({ gameId: gameB, t0: 0, t1: 10 });

      const factIdsA = resultA.changes.filter(isFactChange).map((c) => c.factId);
      const factIdsB = resultB.changes.filter(isFactChange).map((c) => c.factId);
      const eventIdsA = resultA.changes.filter(isEventChange).map((c) => c.eventId);
      const eventIdsB = resultB.changes.filter(isEventChange).map((c) => c.eventId);

      expect(factIdsA).toEqual([factA]);
      expect(factIdsB).toEqual([factB]);
      expect(eventIdsA).toEqual([eventA]);
      expect(eventIdsB).toEqual([eventB]);
    });
  });

  describe("a large-ish window over several entities", () => {
    it("returns everything exactly once -- no duplicate rows from the join", () => {
      const gameId = uuidv4();
      const expectedFactIds: string[] = [];
      const expectedEventIds: string[] = [];

      for (let i = 0; i < 6; i++) {
        const entityId = insertEntity(db, { gameId, createdAtT: 0, name: `entity-${i}` });
        const factId = insertFact(db, entityId, {
          key: "quantity",
          validFromT: i * 2,
          validToT: i * 2 + 1,
          value: String(i),
        });
        expectedFactIds.push(factId);
        expectedEventIds.push(insertEvent(db, { gameId, atT: i * 2, kind: "resource.updated" }));
      }

      const result = changesWithin({ gameId, t0: 0, t1: 100 });

      const factChanges = result.changes.filter(isFactChange);
      const eventChanges = result.changes.filter(isEventChange);

      // Every fact opens and closes inside the window: 2 rows each.
      expect(factChanges).toHaveLength(expectedFactIds.length * 2);
      for (const factId of expectedFactIds) {
        const rowsForFact = factChanges.filter((c) => c.factId === factId);
        expect(rowsForFact).toHaveLength(2);
        expect(rowsForFact.map((c) => c.endpoint).sort()).toEqual(["closed", "opened"]);
      }

      expect(eventChanges).toHaveLength(expectedEventIds.length);
      expect(new Set(eventChanges.map((c) => c.eventId)).size).toBe(expectedEventIds.length);
    });
  });

  describe("result shape", () => {
    it("echoes gameId, t0 and t1 back on the returned ChangeSet", () => {
      const gameId = uuidv4();
      const result = changesWithin({ gameId, t0: 2, t1: 9 });
      expect(result.gameId).toBe(gameId);
      expect(result.t0).toBe(2);
      expect(result.t1).toBe(9);
      expect(result.changes).toEqual([]);
    });

    it("never includes a verdict field -- only 'changes' plus the echoed window", () => {
      const gameId = uuidv4();
      const result = changesWithin({ gameId, t0: 0, t1: 10 });
      expect(Object.keys(result).sort()).toEqual(["changes", "gameId", "t0", "t1"]);
    });
  });
});
