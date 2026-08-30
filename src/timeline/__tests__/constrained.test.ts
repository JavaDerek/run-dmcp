// Phase 3 / issue #9, step 2 (design §5.4 option (C)): the generic write
// choke point. Every test here is written against the CLAIM the option (C)
// merge makes -- that a constrained numeric fact key writes through exactly
// one path, and that interval-versioned `facts` (plus the one annotation
// event a write leaves behind) is a strictly more complete history than
// `resource_history` ever was, not merely an equivalent one.
//
// TDD: this file was written, and run, before src/timeline/constrained.ts
// existed -- `npx vitest run src/timeline/__tests__/constrained.test.ts`
// failed at import time (`Cannot find module '../constrained.js'`), which is
// the "failed for the right reason" checkpoint root CLAUDE.md's testing
// section asks for.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { getDatabase } from "../../db/connection.js";
import { createGame } from "../../tools/game.js";
import { createResource, getResource, updateResourceValue, transferResourceValue, updateResource } from "../../tools/resource.js";
import {
  declareBoundedConstraint,
  declareMonotonicConstraint,
  declareConservedConstraint,
} from "../../tools/constraint.js";
import { ConstraintViolationError } from "../registry.js";
import { writeConstrainedValue, transferConstrainedValue, valueHistory } from "../constrained.js";
import { declareIrreversible, irreversibleFactFor } from "../irreversible.js";
import { replay } from "../replay.js";
import { changesWithin } from "../changes.js";

describe("timeline/constrained: the generic (entityId, factKey) choke point", () => {
  let gameId: string;

  beforeEach(() => {
    createTestDb();
    gameId = createGame({ name: "Test Game", setting: "test", style: "test" }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  // --------------------------------------------------------------------
  // The payoff: option (C) claims the timeline IS the history now.
  // --------------------------------------------------------------------
  describe("the payoff -- replay() and changesWithin() see constrained writes directly", () => {
    it("replay(t) at each recorded t reports the value that held then", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });

      const t0 = writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 20 }).t;
      const t1 = writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 5 }).t;
      const t2 = writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 100 }).t;

      const factAt = (t: number) => replay({ gameId, t }).entities.find((e) => e.id === resource.id)?.facts.value.value;

      // resources.value is a REAL column; the projection triggers CAST it
      // to TEXT (projection.ts), and SQLite's REAL->TEXT cast for a whole
      // number renders "20.0", not "20" -- see checkpoint.ts's doc comment
      // for the same measured behaviour.
      expect(factAt(t0)).toBe("20.0");
      expect(factAt(t1)).toBe("25.0");
      expect(factAt(t2)).toBe("100.0");
    });

    it("changesWithin(t0, t1) returns the 'value' fact transitions in the window", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "treasury", value: 0 });

      const first = writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 50 });
      const second = writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 75 });

      const window = changesWithin({ gameId, t0: first.t, t1: second.t + 1 });
      const valueOpens = window.changes.filter(
        (c) => c.kind === "fact" && c.factKey === "value" && c.entityId === resource.id && c.endpoint === "opened"
      );

      expect(valueOpens).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: "50.0", t: first.t }),
          expect.objectContaining({ value: "75.0", t: second.t }),
        ])
      );
    });
  });

  // --------------------------------------------------------------------
  // writeConstrainedValue: both modes, with and without bounds.
  // --------------------------------------------------------------------
  describe("writeConstrainedValue", () => {
    it("mode 'set' replaces the value outright", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      const transition = writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 42 });

      expect(transition.previousValue).toBe(10);
      expect(transition.newValue).toBe(42);
      expect(transition.delta).toBe(32);
      expect(getResource(resource.id)?.value).toBe(42);
    });

    it("mode 'delta' adds to the current value", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      const transition = writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: -3 });

      expect(transition.newValue).toBe(7);
      expect(getResource(resource.id)?.value).toBe(7);
    });

    it("clamps into bounds when bounds are supplied and no constraint rejects first", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "population", value: 90 });
      const transition = writeConstrainedValue({
        entityId: resource.id,
        key: "value",
        mode: "delta",
        value: 50,
        bounds: { minValue: 0, maxValue: 100 },
      });

      expect(transition.newValue).toBe(100);
    });

    it("clamping happens AFTER the constraint check -- a declared 'bounded' constraint rejects the unclamped intent instead of being satisfied by the clamp", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 50,
        minValue: 0,
        maxValue: 100,
      });
      declareBoundedConstraint({ gameId, resourceId: resource.id });

      expect(() =>
        writeConstrainedValue({
          entityId: resource.id,
          key: "value",
          mode: "set",
          value: 150,
          bounds: { minValue: 0, maxValue: 100 },
        })
      ).toThrow(ConstraintViolationError);

      // Rejected outright -- not silently clamped to 100.
      expect(getResource(resource.id)?.value).toBe(50);
    });

    it("records the reason on the annotation event", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      const transition = writeConstrainedValue({
        entityId: resource.id,
        key: "value",
        mode: "delta",
        value: 5,
        reason: "harvest",
      });

      expect(transition.reason).toBe("harvest");
      expect(transition.eventId).not.toBeNull();
      expect(transition.at).not.toBeNull();
    });

    it("defaults reason to null when omitted", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      const transition = writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 1 });

      expect(transition.reason).toBeNull();
    });
  });

  // --------------------------------------------------------------------
  // Rejection paths.
  // --------------------------------------------------------------------
  describe("rejection paths", () => {
    it("bounded: rejects instead of clamping", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 50,
        minValue: 0,
        maxValue: 100,
      });
      declareBoundedConstraint({ gameId, resourceId: resource.id });

      try {
        writeConstrainedValue({
          entityId: resource.id,
          key: "value",
          mode: "set",
          value: 999,
          bounds: { minValue: 0, maxValue: 100 },
        });
        expect.unreachable("expected writeConstrainedValue to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ConstraintViolationError);
        expect((error as ConstraintViolationError).constraintKind).toBe("bounded");
      }
      expect(getResource(resource.id)?.value).toBe(50);
    });

    it("monotonic increasing: rejects a decrease", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "population", value: 100 });
      declareMonotonicConstraint({ gameId, resourceId: resource.id, direction: "increasing" });

      expect(() =>
        writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: -1 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(resource.id)?.value).toBe(100);
    });

    it("monotonic decreasing: rejects an increase", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "countdown", value: 10 });
      declareMonotonicConstraint({ gameId, resourceId: resource.id, direction: "decreasing" });

      expect(() =>
        writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 20 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(resource.id)?.value).toBe(10);
    });

    it("conserved: rejects a direct write to a conserved member, naming the transfer tool", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      try {
        writeConstrainedValue({ entityId: a.id, key: "value", mode: "delta", value: 5 });
        expect.unreachable("expected writeConstrainedValue to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ConstraintViolationError);
        const violation = error as ConstraintViolationError;
        expect(violation.constraintKind).toBe("conserved");
        expect(violation.resourceId).toBe(a.id);
        expect(violation.message).toMatch(/transfer_resource_value|transferResourceValue/i);
      }
      expect(getResource(a.id)?.value).toBe(40);
    });
  });

  // --------------------------------------------------------------------
  // No-op writes.
  // --------------------------------------------------------------------
  describe("a no-op write (newValue === previousValue)", () => {
    it("produces factId: null and opens no new fact", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      const db = getDatabase();
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE entity_id = ? AND key = 'value'`).get(resource.id) as { n: number }).n;

      const transition = writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 0 });

      expect(transition.factId).toBeNull();
      const after = (db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE entity_id = ? AND key = 'value'`).get(resource.id) as { n: number }).n;
      expect(after).toBe(before);
    });

    it("still appears in valueHistory", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 0, reason: "no-op check" });

      const history = valueHistory(resource.id, "value");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ previousValue: 10, newValue: 10, delta: 0, factId: null, reason: "no-op check" });
      expect(history[0].eventId).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------
  // valueHistory: more than resource_history ever held.
  // --------------------------------------------------------------------
  describe("valueHistory", () => {
    it("excludes the creation fact -- history is empty before any write", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      expect(valueHistory(resource.id, "value")).toEqual([]);
    });

    it("includes an UNANNOTATED transition -- a direct SQL write with no reason, eventId or at", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      const db = getDatabase();
      // Bypasses the choke point entirely -- exercises the projection
      // trigger directly, the way a startup reconciliation or a bug
      // elsewhere might, with no annotation event to explain it.
      db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(99, resource.id);

      const history = valueHistory(resource.id, "value");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ previousValue: 10, newValue: 99, delta: 89, reason: null, eventId: null, at: null });
      expect(history[0].factId).not.toBeNull();
    });

    it("newest first, ordered by t", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 0 });
      writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 5, reason: "first" });
      writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 3, reason: "second" });

      const history = valueHistory(resource.id, "value");
      expect(history).toHaveLength(2);
      expect(history[0].reason).toBe("second");
      expect(history[1].reason).toBe("first");
    });

    it("limit applies after ordering", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 0 });
      writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 1, reason: "a" });
      writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 1, reason: "b" });
      writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 1, reason: "c" });

      const history = valueHistory(resource.id, "value", 2);
      expect(history).toHaveLength(2);
      expect(history.map((h) => h.reason)).toEqual(["c", "b"]);
    });
  });

  // --------------------------------------------------------------------
  // Key scoping.
  // --------------------------------------------------------------------
  describe("constraints are key-scoped", () => {
    it("a monotonic constraint on 'value' does not govern a write to a different numeric column of the same entity", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 40, minValue: 0 });
      declareMonotonicConstraint({ gameId, resourceId: resource.id, direction: "increasing" });

      // min_value is a different live column of the SAME resources row. A
      // decrease here would violate an 'increasing' monotonic constraint IF
      // that constraint governed this key -- it doesn't, because it was
      // declared on 'value', not 'min_value'.
      const transition = writeConstrainedValue({ entityId: resource.id, key: "min_value", mode: "set", value: -50 });

      expect(transition.newValue).toBe(-50);
      expect(getResource(resource.id)?.minValue).toBe(-50);
    });
  });

  // --------------------------------------------------------------------
  // Rollback: the live value and the annotation event land together.
  // --------------------------------------------------------------------
  describe("rollback", () => {
    it("a failure inserting the annotation event rolls back the live write too", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      const db = getDatabase();
      db.exec(`
        CREATE TRIGGER fail_value_changed_event
        BEFORE INSERT ON events
        WHEN NEW.kind = 'value.changed'
        BEGIN
          SELECT RAISE(ABORT, 'simulated failure');
        END;
      `);

      expect(() =>
        writeConstrainedValue({ entityId: resource.id, key: "value", mode: "delta", value: 5 })
      ).toThrow();

      expect(getResource(resource.id)?.value).toBe(10);
      expect(valueHistory(resource.id, "value")).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------
  // transferConstrainedValue -- exercised via the public tool surface too,
  // see conserved.test.ts for exhaustive coverage of transferResourceValue.
  // --------------------------------------------------------------------
  describe("transferConstrainedValue", () => {
    it("moves value between two conserved members atomically and returns a ValueTransition for each side", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      const result = transferConstrainedValue({
        fromEntityId: a.id,
        toEntityId: b.id,
        key: "value",
        amount: 15,
        fromLabel: a.name,
        toLabel: b.name,
      });

      expect(result.from.newValue).toBe(25);
      expect(result.to.newValue).toBe(75);
      expect(getResource(a.id)?.value).toBe(25);
      expect(getResource(b.id)?.value).toBe(75);
    });
  });

  // --------------------------------------------------------------------
  // Design decision #7 / §5.2c: a rejected irreversible-fact write is
  // translated into a typed ConstraintViolationError carrying one hop of
  // causality. The rule itself stays enforced entirely by
  // timeline_facts_irreversible (schema.ts) -- every test below asserts
  // about the TRANSLATION only: whether it fires (and carries the hop) or,
  // just as importantly, whether it correctly stays out of the way of an
  // unrelated failure.
  // --------------------------------------------------------------------
  describe("irreversible: translated to a typed ConstraintViolationError", () => {
    it("writeConstrainedValue against a contradicted irreversible fact throws ConstraintViolationError carrying the one hop", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });
      declareIrreversible({ entityId: resource.id, key: "value" });
      const before = irreversibleFactFor(resource.id, "value");

      let caught: ConstraintViolationError | undefined;
      try {
        writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 999 });
        expect.unreachable("expected writeConstrainedValue to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ConstraintViolationError);
        caught = error as ConstraintViolationError;
      }

      expect(caught?.constraintKind).toBe("irreversible");
      expect(caught?.resourceId).toBe(resource.id);
      expect(caught?.contradictedFact).toEqual(before);
      // resources.value is REAL; SQLite's CAST(REAL AS TEXT) for a whole
      // number renders "50.0", not "50" (checkpoint.ts's measured trap).
      expect(caught?.contradictedFact?.value).toBe("50.0");
      expect(caught?.contradictedFact?.validFromT).toBe(before?.validFromT);
      expect(caught?.contradictedFact?.openedByEventId).not.toBeNull();
    });

    it("re-asserting the SAME value still succeeds -- the trigger permits it and nothing here changes that", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });
      declareIrreversible({ entityId: resource.id, key: "value" });

      expect(() =>
        writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 50 })
      ).not.toThrow();
    });

    it("rollback is intact: live column unchanged, no new fact opened, and no annotation event written", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });
      declareIrreversible({ entityId: resource.id, key: "value" });
      const db = getDatabase();
      const eventsBefore = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
      const factsBefore = (
        db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE entity_id = ?`).get(resource.id) as { n: number }
      ).n;

      expect(() =>
        writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 999 })
      ).toThrow(ConstraintViolationError);

      expect(getResource(resource.id)?.value).toBe(50);
      const eventsAfter = (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
      const factsAfter = (
        db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE entity_id = ?`).get(resource.id) as { n: number }
      ).n;
      expect(eventsAfter).toBe(eventsBefore);
      expect(factsAfter).toBe(factsBefore);
    });

    it("updateResourceValue (the real tool path) surfaces the same typed error, not a raw SqliteError", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });
      declareIrreversible({ entityId: resource.id, key: "value" });

      let caught: unknown;
      try {
        updateResourceValue({ resourceId: resource.id, mode: "set", value: 999 });
        expect.unreachable("expected updateResourceValue to throw");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConstraintViolationError);
      expect((caught as ConstraintViolationError).constraintKind).toBe("irreversible");
    });

    it("a transfer leg refused by irreversibility rejects the whole transfer -- both sides unmoved", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });
      declareIrreversible({ entityId: a.id, key: "value" });

      let caught: unknown;
      try {
        transferConstrainedValue({ fromEntityId: a.id, toEntityId: b.id, key: "value", amount: 15 });
        expect.unreachable("expected transferConstrainedValue to throw");
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConstraintViolationError);
      expect((caught as ConstraintViolationError).constraintKind).toBe("irreversible");
      expect((caught as ConstraintViolationError).resourceId).toBe(a.id);
      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(b.id)?.value).toBe(60);
    });

    it("an unrelated failure is NOT translated -- the original error escapes untouched", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });
      declareIrreversible({ entityId: resource.id, key: "value" });
      const db = getDatabase();
      db.exec(`
        CREATE TRIGGER fail_value_changed_event_unrelated
        BEFORE INSERT ON events
        WHEN NEW.kind = 'value.changed'
        BEGIN
          SELECT RAISE(ABORT, 'simulated unrelated failure');
        END;
      `);

      let caught: unknown;
      try {
        // Re-asserting the SAME value: the irreversible trigger permits it,
        // so the ONLY thing that can fail this write is the fault-injection
        // trigger above -- proving the translation does not fire just
        // because the entity happens to carry an irreversible fact, only
        // when it actually contradicts what was written.
        writeConstrainedValue({ entityId: resource.id, key: "value", mode: "set", value: 50 });
        expect.unreachable("expected writeConstrainedValue to throw");
      } catch (error) {
        caught = error;
      }

      expect(caught).not.toBeInstanceOf(ConstraintViolationError);
    });
  });

  // --------------------------------------------------------------------
  // Planted violations -- run and watched red before being trusted.
  // --------------------------------------------------------------------
  describe("planted violations", () => {
    it("a direct INSERT into resource_history is refused by resource_history_frozen", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      const db = getDatabase();

      expect(() =>
        db
          .prepare(
            `INSERT INTO resource_history (id, resource_id, previous_value, new_value, delta, reason, timestamp)
             VALUES ('planted', ?, 0, 1, 1, NULL, '2026-01-01T00:00:00.000Z')`
          )
          .run(resource.id)
      ).toThrow(/frozen/i);
    });

    it("no code path under createResource/updateResourceValue/transferResourceValue/updateResource writes to resource_history", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });
      const plain = createResource({ gameId, ownerType: "game", name: "population", value: 5, minValue: 0, maxValue: 10 });

      updateResourceValue({ resourceId: plain.id, mode: "delta", value: 3 });
      transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 10 });
      updateResource(plain.id, { maxValue: 3 });

      const db = getDatabase();
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM resource_history`).get() as { n: number }).n;
      expect(count).toBe(0);
    });
  });
});
