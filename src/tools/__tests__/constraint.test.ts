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
  enforceConservedConstraint,
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

  describe("conserved (registry only -- enforcement is deferred)", () => {
    it("registers a conserved constraint across a set of resources", () => {
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
    });

    it("rejects a conserved constraint with fewer than two resources", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });

      expect(() =>
        declareConservedConstraint({ gameId, resourceIds: [a.id], total: 40 })
      ).toThrow();
    });

    // SCOPE: 'conserved' enforcement requires atomic multi-row writes.
    // withTransaction() (src/db/connection.ts:78-81) is currently dead code;
    // real transactions land on a separate branch. Enforcing this
    // non-atomically (read-check-write per row) would be a race-prone fake,
    // not a real guarantee, so it is explicitly not implemented here.
    // This test documents and pins that gap rather than faking it.
    it.todo(
      "enforces the conserved total atomically once real transactions land (see enforceConservedConstraint)"
    );

    it("enforceConservedConstraint is an explicit not-implemented seam, not a silent no-op", () => {
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 40 });
      const b = createResource({ gameId, ownerType: "game", name: "reserve_grain", value: 60 });
      const constraint = declareConservedConstraint({ gameId, resourceIds: [a.id, b.id], total: 100 });

      expect(() => enforceConservedConstraint(constraint.id)).toThrow(/not implemented/i);
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
