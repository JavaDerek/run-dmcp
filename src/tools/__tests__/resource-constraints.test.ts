// Integration tests: does updateResourceValue() actually enforce declared
// constraints, and does it leave unconstrained resources exactly as they
// behaved before this feature existed?
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../game.js";
import { createResource, getResource, updateResourceValue } from "../resource.js";
import {
  declareBoundedConstraint,
  declareMonotonicConstraint,
  ConstraintViolationError,
} from "../constraint.js";

describe("constraint enforcement on updateResourceValue", () => {
  let gameId: string;

  beforeEach(() => {
    createTestDb();
    gameId = createGame({ name: "Test Game", setting: "test", style: "test" }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  describe("no constraint declared (baseline, must be unchanged)", () => {
    it("still silently clamps to min/max as before", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 50,
        minValue: 0,
        maxValue: 100,
      });

      const result = updateResourceValue({ resourceId: resource.id, mode: "set", value: 999 });

      expect(result?.resource.value).toBe(100);
      expect(getResource(resource.id)?.value).toBe(100);
    });

    it("allows values to move in either direction with no monotonic constraint", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "population", value: 10 });

      updateResourceValue({ resourceId: resource.id, mode: "delta", value: 5 });
      const down = updateResourceValue({ resourceId: resource.id, mode: "delta", value: -20 });

      expect(down?.resource.value).toBe(-5);
    });
  });

  describe("bounded constraint declared", () => {
    it("rejects (does not clamp) a 'set' that would exceed the max", () => {
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
        updateResourceValue({ resourceId: resource.id, mode: "set", value: 999 })
      ).toThrow(ConstraintViolationError);

      // Value must be untouched -- rejection, not a partial/clamped write.
      expect(getResource(resource.id)?.value).toBe(50);
    });

    it("rejects a delta that would go below the min", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 10,
        minValue: 0,
        maxValue: 100,
      });
      declareBoundedConstraint({ gameId, resourceId: resource.id });

      expect(() =>
        updateResourceValue({ resourceId: resource.id, mode: "delta", value: -50 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(resource.id)?.value).toBe(10);
    });

    it("allows an in-bounds change through untouched", () => {
      const resource = createResource({
        gameId,
        ownerType: "game",
        name: "grain",
        value: 50,
        minValue: 0,
        maxValue: 100,
      });
      declareBoundedConstraint({ gameId, resourceId: resource.id });

      const result = updateResourceValue({ resourceId: resource.id, mode: "delta", value: 25 });
      expect(result?.resource.value).toBe(75);
    });
  });

  describe("monotonic constraint declared", () => {
    it("rejects a decrease on an 'increasing' (never-decreasing) resource", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "population", value: 100 });
      declareMonotonicConstraint({ gameId, resourceId: resource.id, direction: "increasing" });

      expect(() =>
        updateResourceValue({ resourceId: resource.id, mode: "delta", value: -1 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(resource.id)?.value).toBe(100);
    });

    it("allows an increase on an 'increasing' resource", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "population", value: 100 });
      declareMonotonicConstraint({ gameId, resourceId: resource.id, direction: "increasing" });

      const result = updateResourceValue({ resourceId: resource.id, mode: "delta", value: 5 });
      expect(result?.resource.value).toBe(105);
    });

    it("rejects an increase on a 'decreasing' (never-increasing) resource", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "countdown", value: 10 });
      declareMonotonicConstraint({ gameId, resourceId: resource.id, direction: "decreasing" });

      expect(() =>
        updateResourceValue({ resourceId: resource.id, mode: "set", value: 20 })
      ).toThrow(ConstraintViolationError);
      expect(getResource(resource.id)?.value).toBe(10);
    });

    it("allows a value to stay the same (not a strict decrease requirement)", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "countdown", value: 10 });
      declareMonotonicConstraint({ gameId, resourceId: resource.id, direction: "decreasing" });

      const result = updateResourceValue({ resourceId: resource.id, mode: "delta", value: 0 });
      expect(result?.resource.value).toBe(10);
    });
  });

  describe("thrown error shape", () => {
    it("ConstraintViolationError carries the resourceId and constraint kind", () => {
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
        updateResourceValue({ resourceId: resource.id, mode: "set", value: 999 });
        expect.unreachable("expected updateResourceValue to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ConstraintViolationError);
        const violation = error as ConstraintViolationError;
        expect(violation.resourceId).toBe(resource.id);
        expect(violation.constraintKind).toBe("bounded");
        expect(violation.message).toBeTruthy();
      }
    });
  });
});
