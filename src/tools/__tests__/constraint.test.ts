import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../game.js";
import { createResource } from "../resource.js";
import {
  declareBoundedConstraint,
  declareMonotonicConstraint,
  declareConservedConstraint,
  listConstraints,
  getConstraintsForResource,
  removeConstraint,
} from "../constraint.js";

describe("resource constraint registry", () => {
  let gameId: string;

  beforeEach(() => {
    createTestDb();
    gameId = createGame({ name: "Test Game", setting: "test", style: "test" }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  describe("bounded", () => {
    it("declares a bounded constraint on a resource that has min/max set", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 50,
        minValue: 0,
        maxValue: 100,
      });

      const constraint = declareBoundedConstraint({ gameId, resourceId: resource.id });

      expect(constraint.kind).toBe("bounded");
      expect(constraint.gameId).toBe(gameId);
      expect(constraint.resourceIds).toEqual([resource.id]);
      expect(constraint.id).toBeTruthy();
      expect(constraint.createdAt).toBeTruthy();
    });

    it("rejects declaring a bounded constraint on a resource with no bounds", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });

      expect(() => declareBoundedConstraint({ gameId, resourceId: resource.id })).toThrow();
    });

    it("rejects declaring a second bounded constraint on the same resource", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 50,
        minValue: 0,
        maxValue: 100,
      });
      declareBoundedConstraint({ gameId, resourceId: resource.id });

      expect(() => declareBoundedConstraint({ gameId, resourceId: resource.id })).toThrow();
    });

    it("rejects declaring a constraint on a nonexistent resource", () => {
      expect(() =>
        declareBoundedConstraint({ gameId, resourceId: "does-not-exist" })
      ).toThrow();
    });
  });

  describe("monotonic", () => {
    it("declares a never-decreasing (increasing) constraint", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "population", value: 10 });

      const constraint = declareMonotonicConstraint({
        gameId,
        resourceId: resource.id,
        direction: "increasing",
      });

      expect(constraint.kind).toBe("monotonic");
      expect(constraint.direction).toBe("increasing");
      expect(constraint.resourceIds).toEqual([resource.id]);
    });

    it("declares a never-increasing (decreasing) constraint", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "treasury_debt", value: 10 });

      const constraint = declareMonotonicConstraint({
        gameId,
        resourceId: resource.id,
        direction: "decreasing",
      });

      expect(constraint.direction).toBe("decreasing");
    });

    it("rejects a second monotonic constraint on the same resource", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "population", value: 10 });
      declareMonotonicConstraint({ gameId, resourceId: resource.id, direction: "increasing" });

      expect(() =>
        declareMonotonicConstraint({ gameId, resourceId: resource.id, direction: "decreasing" })
      ).toThrow();
    });
  });

  // Full enforcement (transfer_resource_value, the ambiguous-single-write
  // rejection, delete/update guards, atomicity, float drift, etc.) is
  // covered exhaustively in conserved.test.ts. This block covers only
  // declare-time validation of the registry entry itself.
  describe("conserved: declaration validation", () => {
    it("registers a conserved constraint across a set of resources whose values already sum to total", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });

      const constraint = declareConservedConstraint({
        gameId,
        resourceIds: [a.id, b.id],
        total: 100,
      });

      expect(constraint.kind).toBe("conserved");
      expect(constraint.resourceIds.sort()).toEqual([a.id, b.id].sort());
      expect(constraint.total).toBe(100);
      expect(constraint.direction).toBeNull();
    });

    it("registers a conserved constraint across 3+ resources", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 20 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 30 });
      const c = createResource({ gameId, ownerType: "game", name: "seed_grain", value: 50 });

      const constraint = declareConservedConstraint({
        gameId,
        resourceIds: [a.id, b.id, c.id],
        total: 100,
      });

      expect(constraint.resourceIds.sort()).toEqual([a.id, b.id, c.id].sort());
    });

    it("rejects a conserved constraint with fewer than two resources", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });

      expect(() =>
        declareConservedConstraint({ gameId, resourceIds: [a.id], total: 40 })
      ).toThrow();
    });

    it("rejects a conserved constraint with an empty resource list", () => {
      expect(() =>
        declareConservedConstraint({ gameId, resourceIds: [], total: 0 })
      ).toThrow();
    });

    it("rejects when a listed resource does not exist", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });

      expect(() =>
        declareConservedConstraint({ gameId, resourceIds: [a.id, "does-not-exist"], total: 40 })
      ).toThrow();
    });

    it("rejects when the game does not exist", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });

      expect(() =>
        declareConservedConstraint({ gameId: "does-not-exist", resourceIds: [a.id, b.id], total: 100 })
      ).toThrow();
    });

    it("rejects a declaration whose members' current values do not already sum to the declared total", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });

      expect(() =>
        declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 999 })
      ).toThrow(/sum/i);

      // Must NOT have silently "fixed" either resource's value to make it true.
      expect(a.value).toBe(40);
      expect(b.value).toBe(60);
    });

    it("does not silently adjust resource values when the declared total is wrong", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });

      expect(() =>
        declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 50 })
      ).toThrow();

      expect(getConstraintsForResource(a.id)).toEqual([]);
      expect(getConstraintsForResource(b.id)).toEqual([]);
    });

    it("rejects a non-finite total (NaN)", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });

      expect(() =>
        declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: NaN })
      ).toThrow();
    });

    it("rejects a non-finite total (Infinity)", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });

      expect(() =>
        declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: Infinity })
      ).toThrow();
    });

    it("dedupes a repeated resourceId in the input and validates the sum against the unique set", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });

      const constraint = declareConservedConstraint({
        gameId,
        resourceIds: [a.id, b.id, a.id],
        total: 100,
      });

      expect(constraint.resourceIds.sort()).toEqual([a.id, b.id].sort());
    });

    it("rejects declaring a second conserved constraint that overlaps membership with an existing one", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      const c = createResource({ gameId, ownerType: "game", name: "seed_grain", value: 10 });
      declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      // 'a' is already a member of a conserved set -- a second, overlapping
      // conserved set would make it ambiguous which set a transfer touching
      // 'a' is supposed to preserve.
      expect(() =>
        declareConservedConstraint({ gameId, resourceIds: [a.id, c.id], total: 50 })
      ).toThrow(/already belongs to a 'conserved' constraint/i);
    });

    it("allows a resource with a 'bounded' constraint to also join a 'conserved' set", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40, minValue: 0, maxValue: 100 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareBoundedConstraint({ gameId, resourceId: a.id });

      const constraint = declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });
      expect(constraint.kind).toBe("conserved");

      const forA = getConstraintsForResource(a.id).map((c) => c.kind).sort();
      expect(forA).toEqual(["bounded", "conserved"]);
    });

    it("allows a resource with a 'monotonic' constraint to also join a 'conserved' set", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      declareMonotonicConstraint({ gameId, resourceId: a.id, direction: "increasing" });

      const constraint = declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });
      expect(constraint.kind).toBe("conserved");
    });
  });

  describe("listConstraints / getConstraintsForResource / removeConstraint", () => {
    it("lists constraints for a game, optionally filtered by resource", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 50, minValue: 0, maxValue: 100 });
      const b = createResource({ gameId, ownerType: "game", name: "population", value: 10 });

      const c1 = declareBoundedConstraint({ gameId, resourceId: a.id });
      const c2 = declareMonotonicConstraint({ gameId, resourceId: b.id, direction: "increasing" });

      const all = listConstraints(gameId);
      expect(all.map((c) => c.id).sort()).toEqual([c1.id, c2.id].sort());

      const forA = listConstraints(gameId, a.id);
      expect(forA.map((c) => c.id)).toEqual([c1.id]);
    });

    it("getConstraintsForResource finds constraints where the resource is a member, including conserved sets", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      const conserved = declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      expect(getConstraintsForResource(a.id).map((c) => c.id)).toEqual([conserved.id]);
      expect(getConstraintsForResource(b.id).map((c) => c.id)).toEqual([conserved.id]);
    });

    it("removes a constraint by id", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50, minValue: 0, maxValue: 100 });
      const constraint = declareBoundedConstraint({ gameId, resourceId: resource.id });

      expect(removeConstraint(constraint.id)).toBe(true);
      expect(getConstraintsForResource(resource.id)).toEqual([]);
      expect(removeConstraint(constraint.id)).toBe(false);
    });
  });
});
