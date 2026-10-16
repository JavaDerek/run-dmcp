// An improvised write at the one choke point (hard rule 7): a write tagged
// `improvised` -- a tier key and an optional confirmation reference -- is held
// to the target's `improvisable` declaration (design §5.3) inside
// assertConstraintsAllow, exactly where every other member of the family is
// evaluated. An untagged write never meets the declaration at all.
//
// Fixtures: grain, treasury, population.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../../tools/game.js";
import { createResource, getResource } from "../../tools/resource.js";
import {
  declareImprovisableConstraint,
  declareBoundedConstraint,
  declareConservedConstraint,
} from "../../tools/constraint.js";
import { ConstraintViolationError } from "../registry.js";
import { writeConstrainedValue, transferConstrainedValue } from "../constrained.js";

const TIERS = [
  { key: "minor", cap: 2 },
  { key: "serious", cap: 5 },
  { key: "outrage", cap: 10, requiresConfirmation: true },
];

function caught(fn: () => unknown): ConstraintViolationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConstraintViolationError);
    return e as ConstraintViolationError;
  }
  throw new Error("expected a ConstraintViolationError, and nothing was thrown");
}

describe("improvised writes at the choke point", () => {
  let gameId: string;
  let grainId: string;
  let treasuryId: string;
  let populationId: string;

  beforeEach(() => {
    createTestDb();
    gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    grainId = createResource({ gameId, ownerType: "game", name: "grain", value: 50 }).id;
    treasuryId = createResource({ gameId, ownerType: "game", name: "treasury", value: 50, minValue: 0, maxValue: 100 }).id;
    populationId = createResource({ gameId, ownerType: "game", name: "population", value: 20 }).id;
    declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: TIERS });
  });

  afterEach(() => {
    destroyTestDb();
  });

  const value = (id: string) => getResource(id)?.value;

  it("an untagged write to an improvisable value is unaffected by the declaration, however far it moves", () => {
    writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: 400 });
    expect(value(grainId)).toBe(450);
  });

  it("a tagged write within its tier's cap lands", () => {
    const transition = writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: 3, improvised: { tier: "serious" } });
    expect(transition.newValue).toBe(53);
    expect(value(grainId)).toBe(53);
  });

  it("a tagged write to a value with no improvisable declaration is refused (not-improvisable), and nothing moves", () => {
    const err = caught(() => writeConstrainedValue({ entityId: populationId, key: "value", mode: "delta", value: 1, improvised: { tier: "minor" } }));
    expect(err.constraintKind).toBe("improvisable");
    expect(err.resourceId).toBe(populationId);
    expect(err.improvisation).toMatchObject({ rule: "not-improvisable", key: "value", tier: "minor", amount: 1, cap: null });
    expect(value(populationId)).toBe(20);
  });

  it("a value that is bounded but not improvisable is still out of reach", () => {
    declareBoundedConstraint({ gameId, resourceId: treasuryId });
    const err = caught(() => writeConstrainedValue({ entityId: treasuryId, key: "value", mode: "delta", value: 1, improvised: { tier: "minor" } }));
    expect(err.improvisation?.rule).toBe("not-improvisable");
    expect(value(treasuryId)).toBe(50);
  });

  it("a declaration on a different fact key does not reach this one", () => {
    declareImprovisableConstraint({ gameId, resourceId: populationId, factKey: "min_value", tiers: TIERS });
    const err = caught(() => writeConstrainedValue({ entityId: populationId, key: "value", mode: "delta", value: 1, improvised: { tier: "minor" } }));
    expect(err.improvisation?.rule).toBe("not-improvisable");
  });

  it("a tier the target does not declare is refused (undeclared-tier), naming the declared ones", () => {
    const err = caught(() => writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: 1, improvised: { tier: "cosmic" } }));
    expect(err.improvisation).toMatchObject({ rule: "undeclared-tier", tier: "cosmic", cap: null, declaredTiers: ["minor", "serious", "outrage"] });
    expect(value(grainId)).toBe(50);
  });

  it("exactly at the cap passes in either direction", () => {
    writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: 2, improvised: { tier: "minor" } });
    writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: -2, improvised: { tier: "minor" } });
    expect(value(grainId)).toBe(50);
  });

  it("past the cap by any amount is refused (over-cap) in either direction, and nothing moves", () => {
    for (const amount of [2.000001, -2.000001, 3, -300]) {
      const err = caught(() => writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: amount, improvised: { tier: "minor" } }));
      expect(err.improvisation).toMatchObject({ rule: "over-cap", tier: "minor", amount: Math.abs(amount), cap: 2 });
    }
    expect(value(grainId)).toBe(50);
  });

  it("the cap is held against the requested amount, not a re-derived difference that floating point could push over", () => {
    writeConstrainedValue({ entityId: grainId, key: "value", mode: "set", value: 0.1 });
    writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: 2, improvised: { tier: "minor" } });
    expect(value(grainId)).toBeCloseTo(2.1);
  });

  it("a set-mode tagged write is held to the distance it moves the value", () => {
    writeConstrainedValue({ entityId: grainId, key: "value", mode: "set", value: 45, improvised: { tier: "serious" } });
    expect(value(grainId)).toBe(45);
    const err = caught(() => writeConstrainedValue({ entityId: grainId, key: "value", mode: "set", value: 51, improvised: { tier: "serious" } }));
    expect(err.improvisation).toMatchObject({ rule: "over-cap", amount: 6, cap: 5 });
  });

  it("a tier that requires confirmation refuses a write without one, or with an empty one (confirmation-required)", () => {
    for (const confirmation of [undefined, null, ""]) {
      const err = caught(() =>
        writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: 8, improvised: { tier: "outrage", confirmation } })
      );
      expect(err.improvisation).toMatchObject({ rule: "confirmation-required", tier: "outrage", cap: 10 });
    }
    expect(value(grainId)).toBe(50);
  });

  it("a tier that requires confirmation accepts a write that carries a reference -- the engine records it, it does not judge it", () => {
    writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: -10, improvised: { tier: "outrage", confirmation: "second-call-7" } });
    expect(value(grainId)).toBe(40);
  });

  it("the cap is checked before confirmation: an over-cap ruling is over-cap whether or not it is confirmed", () => {
    const err = caught(() =>
      writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: 11, improvised: { tier: "outrage", confirmation: "c" } })
    );
    expect(err.improvisation?.rule).toBe("over-cap");
  });

  describe("transfers between conserved members", () => {
    beforeEach(() => {
      declareConservedConstraint({ gameId, resourceIds: [treasuryId, populationId], total: 70 });
    });

    it("a tagged transfer needs BOTH legs improvisable -- the counterpart is a value an improvised ruling moves too", () => {
      const err = caught(() => transferConstrainedValue({ fromEntityId: treasuryId, toEntityId: populationId, key: "value", amount: 1, improvised: { tier: "minor" } }));
      expect(err.improvisation?.rule).toBe("not-improvisable");
      expect([value(treasuryId), value(populationId)]).toEqual([50, 20]);

      declareImprovisableConstraint({ gameId, resourceId: treasuryId, tiers: TIERS });
      const counterpart = caught(() =>
        transferConstrainedValue({ fromEntityId: treasuryId, toEntityId: populationId, key: "value", amount: 1, improvised: { tier: "minor" } })
      );
      expect(counterpart.resourceId).toBe(populationId);
      expect(counterpart.improvisation?.rule).toBe("not-improvisable");
    });

    it("lands within the cap, holds the total, and refuses past it", () => {
      declareImprovisableConstraint({ gameId, resourceId: treasuryId, tiers: TIERS });
      declareImprovisableConstraint({ gameId, resourceId: populationId, tiers: TIERS });
      transferConstrainedValue({ fromEntityId: treasuryId, toEntityId: populationId, key: "value", amount: 5, improvised: { tier: "serious" } });
      expect([value(treasuryId), value(populationId)]).toEqual([45, 25]);
      const err = caught(() =>
        transferConstrainedValue({ fromEntityId: populationId, toEntityId: treasuryId, key: "value", amount: 5.5, improvised: { tier: "serious" } })
      );
      expect(err.improvisation).toMatchObject({ rule: "over-cap", amount: 5.5, cap: 5 });
      expect((value(treasuryId) ?? 0) + (value(populationId) ?? 0)).toBe(70);
    });

    it("a tagged single-entity write to a member that is both conserved and improvisable is still refused as conserved -- it must move by transfer", () => {
      declareImprovisableConstraint({ gameId, resourceId: treasuryId, tiers: TIERS });
      const err = caught(() => writeConstrainedValue({ entityId: treasuryId, key: "value", mode: "delta", value: 1, improvised: { tier: "minor" } }));
      expect(err.constraintKind).toBe("conserved");
    });
  });
});
