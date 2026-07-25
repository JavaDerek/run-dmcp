// Exhaustive coverage for 'conserved' constraint enforcement.
//
// A 'conserved' constraint declares that a *set* of resources must always
// sum to a fixed total. Enforcing it means: a write to one member cannot be
// accepted or rejected in isolation, because the server has no way to know
// where the counterpart delta should come from. See transferResourceValue()
// in resource.ts for the chosen API (an explicit two-resource transfer) and
// the rejection of the ambiguous single-resource write.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { getDatabase, withTransaction } from "../../db/connection.js";
import { createGame } from "../game.js";
import {
  createResource,
  getResource,
  getResourceHistory,
  updateResourceValue,
  updateResource,
  deleteResource,
  transferResourceValue,
} from "../resource.js";
import {
  declareConservedConstraint,
  declareBoundedConstraint,
  declareMonotonicConstraint,
  removeConstraint,
  ConstraintViolationError,
} from "../constraint.js";

describe("conserved constraint enforcement", () => {
  let gameId: string;

  beforeEach(() => {
    createTestDb();
    gameId = createGame({ name: "Test Game", setting: "test", style: "test" }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  function makePair(aValue: number, bValue: number, total = aValue + bValue) {
    const a = createResource({ gameId, ownerType: "game", name: "grain", value: aValue });
    const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: bValue });
    const constraint = declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total });
    return { a, b, constraint };
  }

  // --------------------------------------------------------------------
  // The ambiguous single-resource write
  // --------------------------------------------------------------------
  describe("update_resource_value against a conserved member (ambiguous single write)", () => {
    it("rejects a delta-mode write to a conserved member", () => {
      const { a } = makePair(40, 60);

      expect(() =>
        updateResourceValue({ resourceId: a.id, mode: "delta", value: 5 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(a.id)?.value).toBe(40);
    });

    it("rejects a set-mode write to a conserved member", () => {
      const { a } = makePair(40, 60);

      expect(() =>
        updateResourceValue({ resourceId: a.id, mode: "set", value: 41 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(a.id)?.value).toBe(40);
    });

    it("rejects even a zero-delta write (still ambiguous, still rejected)", () => {
      const { a } = makePair(40, 60);

      expect(() =>
        updateResourceValue({ resourceId: a.id, mode: "delta", value: 0 })
      ).toThrow(ConstraintViolationError);
    });

    it("the rejection error names the constraint kind and points at the transfer tool", () => {
      const { a } = makePair(40, 60);

      try {
        updateResourceValue({ resourceId: a.id, mode: "delta", value: 5 });
        expect.unreachable("expected updateResourceValue to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ConstraintViolationError);
        const violation = error as ConstraintViolationError;
        expect(violation.constraintKind).toBe("conserved");
        expect(violation.resourceId).toBe(a.id);
        expect(violation.message).toMatch(/transfer_resource_value|transferResourceValue/i);
      }
    });

    it("writes no history row for a rejected conserved-member write", () => {
      const { a } = makePair(40, 60);

      expect(() => updateResourceValue({ resourceId: a.id, mode: "delta", value: 5 })).toThrow();
      expect(getResourceHistory(a.id)).toHaveLength(0);
    });

    it("both members of the set are equally protected, not just the first-declared one", () => {
      const { b } = makePair(40, 60);

      expect(() =>
        updateResourceValue({ resourceId: b.id, mode: "delta", value: -5 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(b.id)?.value).toBe(60);
    });

    it("after the constraint is removed, direct writes to the former member work normally again", () => {
      const { a, constraint } = makePair(40, 60);
      removeConstraint(constraint.id);

      const result = updateResourceValue({ resourceId: a.id, mode: "delta", value: 5 });
      expect(result?.resource.value).toBe(45);
    });
  });

  // --------------------------------------------------------------------
  // transferResourceValue: happy paths
  // --------------------------------------------------------------------
  describe("transferResourceValue: happy paths", () => {
    it("moves value from one member to the other, preserving the total", () => {
      const { a, b } = makePair(40, 60);

      const result = transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15 });

      expect(result.from.value).toBe(25);
      expect(result.to.value).toBe(75);
      expect(result.from.value + result.to.value).toBe(100);
    });

    it("persists both new values to the database", () => {
      const { a, b } = makePair(40, 60);

      transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15 });

      expect(getResource(a.id)?.value).toBe(25);
      expect(getResource(b.id)?.value).toBe(75);
    });

    it("returns a ResourceChange for each side with correct previous/new/delta", () => {
      const { a, b } = makePair(40, 60);

      const result = transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15, reason: "trade" });

      expect(result.fromChange).toMatchObject({
        resourceId: a.id,
        previousValue: 40,
        newValue: 25,
        delta: -15,
        reason: "trade",
      });
      expect(result.toChange).toMatchObject({
        resourceId: b.id,
        previousValue: 60,
        newValue: 75,
        delta: 15,
        reason: "trade",
      });
    });

    it("writes one resource_history row per side", () => {
      const { a, b } = makePair(40, 60);

      transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15, reason: "trade" });

      expect(getResourceHistory(a.id)).toHaveLength(1);
      expect(getResourceHistory(b.id)).toHaveLength(1);
    });

    it("defaults reason to null when not provided", () => {
      const { a, b } = makePair(40, 60);

      transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15 });

      expect(getResourceHistory(a.id)[0].reason).toBeNull();
      expect(getResourceHistory(b.id)[0].reason).toBeNull();
    });

    it("transfers of amount 0 succeed as a no-op (values unchanged, still logged)", () => {
      const { a, b } = makePair(40, 60);

      const result = transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 0 });

      expect(result.from.value).toBe(40);
      expect(result.to.value).toBe(60);
      expect(getResourceHistory(a.id)).toHaveLength(1);
      expect(getResourceHistory(a.id)[0].delta).toBe(0);
    });

    it("transfers the full balance, leaving the source at exactly zero", () => {
      const { a, b } = makePair(40, 60);

      const result = transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 40 });

      expect(result.from.value).toBe(0);
      expect(result.to.value).toBe(100);
    });

    it("allows a member to go negative when it has no minValue set", () => {
      const { a, b } = makePair(40, 60);

      const result = transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 55 });

      expect(result.from.value).toBe(-15);
      expect(result.to.value).toBe(115);
      expect(result.from.value + result.to.value).toBe(100);
    });

    it("chains correctly across multiple sequential transfers", () => {
      const { a, b } = makePair(40, 60);

      transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 10 });
      transferResourceValue({ fromResourceId: b.id, toResourceId: a.id, amount: 25 });
      transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 5 });

      // 40-10+25-5 = 50 ; 60+10-25+5 = 50
      expect(getResource(a.id)?.value).toBe(50);
      expect(getResource(b.id)?.value).toBe(50);
    });

    it("leaves the third member of a 3-member set untouched by a transfer between the other two", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 20 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 30 });
      const c = createResource({ gameId, ownerType: "game", name: "seed_grain", value: 50 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id, c.id], total: 100 });

      transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 10 });

      expect(getResource(a.id)?.value).toBe(10);
      expect(getResource(b.id)?.value).toBe(40);
      expect(getResource(c.id)?.value).toBe(50);
      const sum = (getResource(a.id)?.value ?? 0) + (getResource(b.id)?.value ?? 0) + (getResource(c.id)?.value ?? 0);
      expect(sum).toBe(100);
    });

    it("two independent conserved sets in the same game do not interfere with each other", () => {
      const { a, b } = makePair(40, 60); // set 1, total 100
      const c = createResource({ gameId, ownerType: "game", name: "population", value: 5 });
      const d = createResource({ gameId, ownerType: "game", name: "casualties", value: 5 });
      declareConservedConstraint({ gameId, resourceIds: [c.id, d.id], total: 10 }); // set 2

      transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 20 });

      expect(getResource(c.id)?.value).toBe(5);
      expect(getResource(d.id)?.value).toBe(5);
    });
  });

  // --------------------------------------------------------------------
  // transferResourceValue: rejection paths
  // --------------------------------------------------------------------
  describe("transferResourceValue: rejection paths", () => {
    it("rejects when fromResourceId does not exist", () => {
      const { b } = makePair(40, 60);
      expect(() =>
        transferResourceValue({ fromResourceId: "does-not-exist", toResourceId: b.id, amount: 5 })
      ).toThrow();
    });

    it("rejects when toResourceId does not exist", () => {
      const { a } = makePair(40, 60);
      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: "does-not-exist", amount: 5 })
      ).toThrow();
    });

    it("rejects transferring a resource to itself", () => {
      const { a } = makePair(40, 60);
      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: a.id, amount: 5 })
      ).toThrow(/itself/i);
    });

    it("rejects a negative amount", () => {
      const { a, b } = makePair(40, 60);
      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: -5 })
      ).toThrow(/negative|>= 0/i);
      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(b.id)?.value).toBe(60);
    });

    it("rejects a NaN amount", () => {
      const { a, b } = makePair(40, 60);
      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: NaN })
      ).toThrow();
    });

    it("rejects an Infinity amount", () => {
      const { a, b } = makePair(40, 60);
      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: Infinity })
      ).toThrow();
    });

    it("rejects a transfer between two resources that are not in any conserved constraint", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 10 });
      const b = createResource({ gameId, ownerType: "game", name: "treasury", value: 10 });

      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 5 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(a.id)?.value).toBe(10);
      expect(getResource(b.id)?.value).toBe(10);
    });

    it("rejects a transfer where only the source is a conserved member", () => {
      const { a } = makePair(40, 60);
      const outsider = createResource({ gameId, ownerType: "game", name: "treasury", value: 10 });

      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: outsider.id, amount: 5 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(outsider.id)?.value).toBe(10);
    });

    it("rejects a transfer where only the destination is a conserved member", () => {
      const { b } = makePair(40, 60);
      const outsider = createResource({ gameId, ownerType: "game", name: "treasury", value: 10 });

      expect(() =>
        transferResourceValue({ fromResourceId: outsider.id, toResourceId: b.id, amount: 5 })
      ).toThrow(ConstraintViolationError);
    });

    it("rejects a transfer between members of two different conserved constraints", () => {
      const { a } = makePair(40, 60); // set 1
      const c = createResource({ gameId, ownerType: "game", name: "population", value: 5 });
      const d = createResource({ gameId, ownerType: "game", name: "casualties", value: 5 });
      declareConservedConstraint({ gameId, resourceIds: [c.id, d.id], total: 10 }); // set 2

      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: c.id, amount: 5 })
      ).toThrow(ConstraintViolationError);
    });

    it("never clamps: rejects (not clamps) a transfer that would take a bounded source below its minValue", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40, minValue: 0 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 50 })
      ).toThrow();
      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(b.id)?.value).toBe(60);
    });

    it("never clamps: rejects a transfer that would push the destination above its maxValue", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60, maxValue: 70 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15 })
      ).toThrow();
      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(b.id)?.value).toBe(60);
    });

    it("respects an explicit 'bounded' constraint on a member (rejects a violating transfer)", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40, minValue: 0, maxValue: 100 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });
      declareBoundedConstraint({ gameId, resourceId: a.id });

      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 41 })
      ).toThrow(ConstraintViolationError);
    });

    it("respects a 'monotonic' constraint on a member (rejects a transfer that would decrease an increasing-only resource)", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });
      declareMonotonicConstraint({ gameId, resourceId: b.id, direction: "increasing" });

      // Moving grain -> reserve_grain increases b, which is fine...
      expect(() =>
        transferResourceValue({ fromResourceId: b.id, toResourceId: a.id, amount: 5 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(b.id)?.value).toBe(60);
    });

    it("a rejected transfer leaves no history rows on either side", () => {
      const { a, b } = makePair(40, 60);
      const outsider = createResource({ gameId, ownerType: "game", name: "treasury", value: 10 });

      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: outsider.id, amount: 5 })
      ).toThrow();

      expect(getResourceHistory(a.id)).toHaveLength(0);
      expect(getResourceHistory(outsider.id)).toHaveLength(0);
      void b;
    });
  });

  // --------------------------------------------------------------------
  // Atomicity
  // --------------------------------------------------------------------
  describe("transferResourceValue: atomicity", () => {
    it("leaves NO partial write when the second resource's history insert fails mid-operation", () => {
      const { a, b } = makePair(40, 60);

      // Fault injection: fail the resource_history insert specifically for
      // the destination resource, simulating a failure after the source's
      // update (and possibly its history row) has already been applied
      // in-transaction.
      const db = getDatabase();
      db.exec(`
        CREATE TRIGGER fail_history_for_b
        BEFORE INSERT ON resource_history
        WHEN NEW.resource_id = '${b.id}'
        BEGIN
          SELECT RAISE(ABORT, 'simulated failure');
        END;
      `);

      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15, reason: "trade" })
      ).toThrow();

      // Neither side may have moved -- a partially-applied transfer is
      // exactly the invariant break this feature exists to prevent.
      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(b.id)?.value).toBe(60);
      expect(getResourceHistory(a.id)).toHaveLength(0);
      expect(getResourceHistory(b.id)).toHaveLength(0);
    });

    it("leaves NO partial write when the second resource's value UPDATE fails mid-operation", () => {
      const { a, b } = makePair(40, 60);

      const db = getDatabase();
      db.exec(`
        CREATE TRIGGER fail_update_for_b
        BEFORE UPDATE ON resources
        WHEN NEW.id = '${b.id}'
        BEGIN
          SELECT RAISE(ABORT, 'simulated failure');
        END;
      `);

      expect(() =>
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15 })
      ).toThrow();

      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(b.id)?.value).toBe(60);
      expect(getResourceHistory(a.id)).toHaveLength(0);
      expect(getResourceHistory(b.id)).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------
  // Nested / re-entrant transactions
  // --------------------------------------------------------------------
  describe("transferResourceValue: nested transaction behavior", () => {
    it("a transfer nested inside an outer withTransaction() that later throws is fully rolled back", () => {
      const { a, b } = makePair(40, 60);

      expect(() => {
        withTransaction(() => {
          transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15 });
          throw new Error("outer failure after transfer");
        });
      }).toThrow("outer failure after transfer");

      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(b.id)?.value).toBe(60);
      expect(getResourceHistory(a.id)).toHaveLength(0);
      expect(getResourceHistory(b.id)).toHaveLength(0);
    });

    it("a transfer nested inside an outer withTransaction() that succeeds commits normally", () => {
      const { a, b } = makePair(40, 60);

      const outcome = withTransaction(() => {
        return transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15 });
      });

      expect(outcome.from.value).toBe(25);
      expect(getResource(a.id)?.value).toBe(25);
      expect(getResource(b.id)?.value).toBe(75);
    });

    it("chains two transfers inside one outer transaction; if the second fails, BOTH roll back", () => {
      const { a, b } = makePair(40, 60);
      const c = createResource({ gameId, ownerType: "game", name: "population", value: 5 });
      const d = createResource({ gameId, ownerType: "game", name: "casualties", value: 5 });
      declareConservedConstraint({ gameId, resourceIds: [c.id, d.id], total: 10 });

      expect(() => {
        withTransaction(() => {
          transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 15 });
          // Second leg targets an unrelated conserved set incorrectly (a is
          // not a member of it) -- must throw, and must take the first leg
          // down with it since they share the outer transaction.
          transferResourceValue({ fromResourceId: c.id, toResourceId: a.id, amount: 1 });
        });
      }).toThrow(ConstraintViolationError);

      expect(getResource(a.id)?.value).toBe(40);
      expect(getResource(b.id)?.value).toBe(60);
      expect(getResource(c.id)?.value).toBe(5);
    });

    it("chains two valid transfers inside one outer transaction and commits both together", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 30 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 30 });
      const c = createResource({ gameId, ownerType: "game", name: "seed_grain", value: 40 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id, c.id], total: 100 });

      withTransaction(() => {
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 10 });
        transferResourceValue({ fromResourceId: b.id, toResourceId: c.id, amount: 20 });
      });

      expect(getResource(a.id)?.value).toBe(20);
      expect(getResource(b.id)?.value).toBe(20);
      expect(getResource(c.id)?.value).toBe(60);
    });
  });

  // --------------------------------------------------------------------
  // Floating point accumulation
  // --------------------------------------------------------------------
  describe("transferResourceValue: floating-point accumulation", () => {
    it("keeps the set within a tiny epsilon of the declared total after many fractional transfers", () => {
      const { a, b } = makePair(100, 0, 100);

      for (let i = 0; i < 1000; i++) {
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 0.1 });
      }

      const sum = (getResource(a.id)?.value ?? 0) + (getResource(b.id)?.value ?? 0);
      // Not asserting exact equality -- IEEE 754 doubles cannot represent
      // 0.1 exactly, so some drift after 1000 operations is expected and
      // acceptable. What matters is it stays vanishingly small.
      expect(Math.abs(sum - 100)).toBeLessThan(1e-6);
    });

    it("keeps the set within epsilon after many transfers alternating direction", () => {
      const { a, b } = makePair(50, 50, 100);

      for (let i = 0; i < 500; i++) {
        transferResourceValue({ fromResourceId: a.id, toResourceId: b.id, amount: 0.3 });
        transferResourceValue({ fromResourceId: b.id, toResourceId: a.id, amount: 0.1 });
      }

      const sum = (getResource(a.id)?.value ?? 0) + (getResource(b.id)?.value ?? 0);
      expect(Math.abs(sum - 100)).toBeLessThan(1e-6);
    });
  });

  // --------------------------------------------------------------------
  // deleteResource() protection for conserved members
  // --------------------------------------------------------------------
  describe("deleteResource() on a conserved member", () => {
    it("rejects deleting a resource that is a member of a conserved constraint", () => {
      const { a } = makePair(40, 60);

      expect(() => deleteResource(a.id)).toThrow(ConstraintViolationError);
      expect(getResource(a.id)).not.toBeNull();
    });

    it("rejects deleting either member, not just the first-declared one", () => {
      const { b } = makePair(40, 60);

      expect(() => deleteResource(b.id)).toThrow(ConstraintViolationError);
      expect(getResource(b.id)).not.toBeNull();
    });

    it("after removing the constraint, the former member can be deleted normally", () => {
      const { a, constraint } = makePair(40, 60);
      removeConstraint(constraint.id);

      expect(deleteResource(a.id)).toBe(true);
      expect(getResource(a.id)).toBeNull();
    });

    it("deleting a resource with no conserved constraint works exactly as before", () => {
      const plain = createResource({ gameId, ownerType: "game", name: "treasury", value: 10 });
      expect(deleteResource(plain.id)).toBe(true);
      expect(getResource(plain.id)).toBeNull();
    });

    it("deleting a nonexistent resource still returns false, not a thrown error", () => {
      expect(deleteResource("does-not-exist")).toBe(false);
    });
  });

  // --------------------------------------------------------------------
  // updateResource() protection for conserved members (bounds reclamp)
  // --------------------------------------------------------------------
  describe("updateResource() on a conserved member", () => {
    it("rejects a bounds change that would silently reclamp a conserved member's current value", () => {
      const { a } = makePair(40, 60);

      expect(() => updateResource(a.id, { maxValue: 30 })).toThrow(ConstraintViolationError);

      // Neither the bounds nor the value may have changed.
      const reloaded = getResource(a.id);
      expect(reloaded?.value).toBe(40);
      expect(reloaded?.maxValue).toBeNull();
    });

    it("rejects a minValue change that would silently reclamp a conserved member upward", () => {
      const { a } = makePair(40, 60);

      expect(() => updateResource(a.id, { minValue: 50 })).toThrow(ConstraintViolationError);
      expect(getResource(a.id)?.value).toBe(40);
    });

    it("allows a bounds change on a conserved member that does not affect its current value", () => {
      const { a } = makePair(40, 60);

      const updated = updateResource(a.id, { minValue: 0, maxValue: 1000 });
      expect(updated?.minValue).toBe(0);
      expect(updated?.maxValue).toBe(1000);
      expect(updated?.value).toBe(40);
    });

    it("allows non-bounds metadata changes on a conserved member unconditionally", () => {
      const { a } = makePair(40, 60);

      const updated = updateResource(a.id, { name: "renamed_grain", description: "new desc" });
      expect(updated?.name).toBe("renamed_grain");
      expect(updated?.value).toBe(40);
    });

    it("updateResource on a non-conserved resource still clamps as before", () => {
      const plain = createResource({ gameId, ownerType: "game", name: "population", value: 40 });
      const updated = updateResource(plain.id, { maxValue: 30 });
      expect(updated?.value).toBe(30);
    });
  });

  // --------------------------------------------------------------------
  // Unconstrained resources are completely unaffected
  // --------------------------------------------------------------------
  describe("unconstrained resources are unaffected by any of this", () => {
    it("createResource, updateResourceValue, updateResource, deleteResource all behave as before, even in a game that also has a conserved set", () => {
      makePair(40, 60); // unrelated conserved set exists in this game

      const plain = createResource({ gameId, ownerType: "game", name: "treasury", value: 5, minValue: 0, maxValue: 10 });

      const afterDelta = updateResourceValue({ resourceId: plain.id, mode: "delta", value: 100 });
      expect(afterDelta?.resource.value).toBe(10); // clamped, not rejected

      const afterUpdate = updateResource(plain.id, { maxValue: 3 });
      expect(afterUpdate?.value).toBe(3); // silently reclamped, as always

      expect(deleteResource(plain.id)).toBe(true);
    });

    it("transferResourceValue between two unconstrained resources is rejected (not silently allowed as a generic bank transfer)", () => {
      const x = createResource({ gameId, ownerType: "game", name: "gold", value: 10 });
      const y = createResource({ gameId, ownerType: "game", name: "silver", value: 10 });

      expect(() =>
        transferResourceValue({ fromResourceId: x.id, toResourceId: y.id, amount: 5 })
      ).toThrow(ConstraintViolationError);
    });
  });
});
