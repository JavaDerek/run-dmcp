// `resolve.ts`, the `set` intent (issue #32): a mechanic's first non-numeric
// consequence. Until now `IntendedChange` was two numeric shapes, so a
// resolution could not move a thing between owners or a character between
// places -- a caller had to call the tool layer after `resolve()` returned,
// a second write path outside the resolution's transaction.
//
// A `set` names a live column of an entity's projected table and a value.
// The engine stores what it is handed and never learns what the column
// means: the projection triggers version it like any other column write.
//
// Neutral fixture, as resolve.test.ts: a depot, two stewards, a granary and
// a storehouse, one sack of grain. Mechanic names are throwaway.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../../tools/game.js";
import { createCharacter } from "../../tools/character.js";
import { createLocation } from "../../tools/world.js";
import { createItem } from "../../tools/inventory.js";
import { createResource } from "../../tools/resource.js";
import * as constraintTools from "../../tools/constraint.js";
import { declareIrreversible } from "../irreversible.js";
import { ConstraintViolationError } from "../registry.js";
import { createResolver, type Mechanic, type IntendedChange } from "../resolve.js";

describe("resolve: the `set` intent (issue #32)", () => {
  let db: Database.Database;
  let gameId: string;
  let stewardA: string;
  let stewardB: string;
  let granary: string;
  let storehouse: string;
  let sack: string;
  let treasury: string;

  beforeEach(() => {
    db = createTestDb();
    gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    granary = createLocation({ gameId, name: "granary", description: "test" }).id;
    storehouse = createLocation({ gameId, name: "storehouse", description: "test" }).id;
    stewardA = createCharacter({ gameId, name: "steward a", isPlayer: false, locationId: granary }).id;
    stewardB = createCharacter({ gameId, name: "steward b", isPlayer: false, locationId: granary }).id;
    sack = createItem({ gameId, ownerId: stewardA, ownerType: "character", name: "sack of grain" }).id;
    treasury = createResource({ gameId, ownerType: "game", name: "treasury", value: 50, minValue: 0, maxValue: 100 }).id;
  });

  afterEach(() => destroyTestDb());

  function resolverFor(changes: readonly IntendedChange[]) {
    const mechanic: Mechanic = { name: "HAND_OVER", adjudicate: () => ({ changes, description: "handed over" }) };
    return createResolver({ mechanics: [mechanic] });
  }

  function live(table: string, id: string, column: string): unknown {
    return (db.prepare(`SELECT ${column} AS v FROM ${table} WHERE id = ?`).get(id) as { v: unknown }).v;
  }

  function openFacts(entityId: string, key: string): { value: string; valid_to_t: number | null }[] {
    return db.prepare(`SELECT value, valid_to_t FROM facts WHERE entity_id = ? AND key = ? ORDER BY valid_from_t`).all(entityId, key) as {
      value: string;
      valid_to_t: number | null;
    }[];
  }

  function resolutionEvents(): { causes: string }[] {
    return db.prepare(`SELECT causes FROM events WHERE game_id = ? AND kind = 'resolution.recorded'`).all(gameId) as { causes: string }[];
  }

  it("moves an item between owners inside the resolution: live row, versioned fact, outcome.sets, one event counting it", () => {
    const outcome = resolverFor([{ kind: "set", entityId: sack, key: "owner_id", value: stewardB }]).resolve({ gameId, mechanic: "HAND_OVER" });

    expect(live("items", sack, "owner_id")).toBe(stewardB);
    const facts = openFacts(sack, "owner_id");
    expect(facts.map((f) => f.value)).toEqual([stewardA, stewardB]);
    expect(facts[0].valid_to_t).not.toBeNull();
    expect(facts[1].valid_to_t).toBeNull();

    expect(outcome.sets).toEqual([
      expect.objectContaining({ entityId: sack, key: "owner_id", previousValue: stewardA, newValue: stewardB, t: outcome.constraint.t }),
    ]);
    expect(outcome.sets[0].factId).toEqual(expect.any(String));
    expect(outcome.transitions).toEqual([]); // numeric transitions stay numeric
    expect(JSON.parse(resolutionEvents()[0].causes).change_count).toBe(1);
  });

  it("moves a character to another location, with owner-style multi-column changes landing together", () => {
    const outcome = resolverFor([
      { kind: "set", entityId: stewardA, key: "location_id", value: storehouse },
      { kind: "set", entityId: sack, key: "owner_id", value: storehouse },
      { kind: "set", entityId: sack, key: "owner_type", value: "location" },
    ]).resolve({ gameId, mechanic: "HAND_OVER" });

    expect(live("characters", stewardA, "location_id")).toBe(storehouse);
    expect(live("items", sack, "owner_id")).toBe(storehouse);
    expect(live("items", sack, "owner_type")).toBe("location");
    expect(outcome.sets.map((s) => s.key)).toEqual(["location_id", "owner_id", "owner_type"]);
  });

  it("a set that names a column the entity's table does not have is refused, naming it, and nothing lands", () => {
    const resolver = resolverFor([{ kind: "set", entityId: sack, key: "colour", value: "gold" }]);
    expect(() => resolver.resolve({ gameId, mechanic: "HAND_OVER" })).toThrow(/colour/);
    expect(resolutionEvents()).toEqual([]);
  });

  it("the column that places an entity in its game is never settable", () => {
    const resolver = resolverFor([{ kind: "set", entityId: sack, key: "game_id", value: "another game" }]);
    expect(() => resolver.resolve({ gameId, mechanic: "HAND_OVER" })).toThrow(/game_id/);
    expect(live("items", sack, "game_id")).toBe(gameId);
  });

  it("a set on a key that carries a numeric constraint is refused: that value moves by a write, where the constraint is evaluated", () => {
    constraintTools.declareBoundedConstraint({ gameId, resourceId: treasury });
    const resolver = resolverFor([{ kind: "set", entityId: treasury, key: "value", value: 1000 }]);
    expect(() => resolver.resolve({ gameId, mechanic: "HAND_OVER" })).toThrow(/bounded/);
    expect(live("resources", treasury, "value")).toBe(50);
  });

  it("partial failure: a numeric leg that violates bounded rolls the set back too, and no event is recorded", () => {
    constraintTools.declareBoundedConstraint({ gameId, resourceId: treasury });
    const resolver = resolverFor([
      { kind: "set", entityId: sack, key: "owner_id", value: stewardB },
      { kind: "write", entityId: treasury, key: "value", mode: "set", value: 500, bounds: { minValue: 0, maxValue: 100 } },
    ]);
    expect(() => resolver.resolve({ gameId, mechanic: "HAND_OVER" })).toThrow(ConstraintViolationError);
    expect(live("items", sack, "owner_id")).toBe(stewardA);
    expect(openFacts(sack, "owner_id").map((f) => f.value)).toEqual([stewardA]);
    expect(resolutionEvents()).toEqual([]);
  });

  it("a set to the value already held opens no new fact and reports previousValue === newValue", () => {
    const outcome = resolverFor([{ kind: "set", entityId: sack, key: "owner_id", value: stewardA }]).resolve({ gameId, mechanic: "HAND_OVER" });
    expect(openFacts(sack, "owner_id")).toHaveLength(1);
    expect(outcome.sets[0]).toEqual(expect.objectContaining({ previousValue: stewardA, newValue: stewardA, factId: null }));
  });

  it("an irreversible fact refuses a set that contradicts it, with the one hop attached", () => {
    declareIrreversible({ entityId: sack, key: "owner_id" });
    const resolver = resolverFor([{ kind: "set", entityId: sack, key: "owner_id", value: stewardB }]);
    let caught: unknown;
    try {
      resolver.resolve({ gameId, mechanic: "HAND_OVER" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConstraintViolationError);
    expect((caught as ConstraintViolationError).constraintKind).toBe("irreversible");
    expect((caught as ConstraintViolationError).contradictedFact?.value).toBe(stewardA);
    expect(live("items", sack, "owner_id")).toBe(stewardA);
    expect(resolutionEvents()).toEqual([]);
  });

  it("a set on a resolve_only key succeeds inside the resolution, the one door to it", () => {
    constraintTools.declareResolveOnlyConstraint({ gameId, resourceId: treasury, factKey: "name" });
    const outcome = resolverFor([{ kind: "set", entityId: treasury, key: "name", value: "reserve" }]).resolve({ gameId, mechanic: "HAND_OVER" });
    expect(live("resources", treasury, "name")).toBe("reserve");
    expect(outcome.sets[0].newValue).toBe("reserve");
  });

  it("an entity that does not exist is refused, naming it", () => {
    const resolver = resolverFor([{ kind: "set", entityId: "no-such-entity", key: "owner_id", value: stewardB }]);
    expect(() => resolver.resolve({ gameId, mechanic: "HAND_OVER" })).toThrow(/no-such-entity/);
  });
});
