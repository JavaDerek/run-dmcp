// `resolve.ts`, the `create` and `destroy` intents (issue #34): a resolution
// brings an entity into existence, or ends one. Until now an item or a
// location was created by a tool-layer call outside any resolution -- a
// second write path, the shape #32 closed for columns.
//
// A `create` names an entity kind and the columns of its live row; the
// engine allocates the id, fills the game column from the proposal, and the
// projection insert trigger does the timeline work (`<kind>.created`, one
// fact per column). A mechanic has no database handle and cannot know the
// new id, so it labels the create with a `ref` and a later leg of the same
// resolution may say `{ ref }` wherever it would say an entity id. A
// `destroy` deletes the live row; the delete trigger closes its facts.
//
// The engine never learns what a created entity is for, what it was made
// from, or why something was destroyed. "Derived from" is the caller's to
// record.
//
// Neutral fixture, as resolveSet.test.ts: a depot, two stewards, a granary
// and a storehouse, one sack of grain, a treasury. Mechanic names are
// throwaway.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { closeDatabase, getDatabase } from "../../db/connection.js";
import { initializeSchema } from "../../db/schema.js";
import { createGame } from "../../tools/game.js";
import { createCharacter } from "../../tools/character.js";
import { createLocation } from "../../tools/world.js";
import { createItem } from "../../tools/inventory.js";
import { createResource } from "../../tools/resource.js";
import * as constraintTools from "../../tools/constraint.js";
import { declareIrreversible } from "../irreversible.js";
import { ConstraintViolationError } from "../registry.js";
import { replay } from "../replay.js";
import { createResolver, ResolveProtocolError, type Mechanic, type IntendedChange } from "../resolve.js";

describe("resolve: the `create` and `destroy` intents (issue #34)", () => {
  let db: Database.Database;
  let gameId: string;
  let stewardA: string;
  let stewardB: string;
  let granary: string;
  let sack: string;
  let treasury: string;

  beforeEach(() => {
    db = createTestDb();
    gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    granary = createLocation({ gameId, name: "granary", description: "test" }).id;
    stewardA = createCharacter({ gameId, name: "steward a", isPlayer: false, locationId: granary }).id;
    stewardB = createCharacter({ gameId, name: "steward b", isPlayer: false, locationId: granary }).id;
    sack = createItem({ gameId, ownerId: stewardA, ownerType: "character", name: "sack of grain" }).id;
    treasury = createResource({ gameId, ownerType: "game", name: "treasury", value: 50, minValue: 0, maxValue: 100 }).id;
  });

  afterEach(() => destroyTestDb());

  function resolverFor(changes: readonly IntendedChange[]) {
    const mechanic: Mechanic = { name: "SPLIT", adjudicate: () => ({ changes, description: "split" }) };
    return createResolver({ mechanics: [mechanic] });
  }

  function liveRow(table: string, id: string): Record<string, unknown> | undefined {
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  }

  function entityRow(id: string): { kind: string; game_id: string; created_at_t: number; destroyed_at_t: number | null } | undefined {
    return db.prepare(`SELECT kind, game_id, created_at_t, destroyed_at_t FROM entities WHERE id = ?`).get(id) as
      | { kind: string; game_id: string; created_at_t: number; destroyed_at_t: number | null }
      | undefined;
  }

  function facts(entityId: string): { key: string; value: string; valid_to_t: number | null }[] {
    return db.prepare(`SELECT key, value, valid_to_t FROM facts WHERE entity_id = ? ORDER BY key`).all(entityId) as {
      key: string;
      value: string;
      valid_to_t: number | null;
    }[];
  }

  function events(kind: string): { causes: string; at_t: number }[] {
    return db.prepare(`SELECT causes, at_t FROM events WHERE game_id = ? AND kind = ?`).all(gameId, kind) as { causes: string; at_t: number }[];
  }

  const halfSack = { kind: "create", ref: "half", entityKind: "item", columns: { owner_id: "PLACEHOLDER", owner_type: "character", name: "half sack" } } as const;

  it("creates an item owned by an existing entity: live row, entity, item.created event, one open fact per non-null column, outcome.created with the real id, change_count counting it", () => {
    const outcome = resolverFor([{ ...halfSack, columns: { ...halfSack.columns, owner_id: stewardA } }]).resolve({ gameId, mechanic: "SPLIT" });

    expect(outcome.created).toHaveLength(1);
    const created = outcome.created[0];
    expect(created.ref).toBe("half");
    expect(created.entityKind).toBe("item");
    expect(created.entityId).toEqual(expect.any(String));
    expect(created.entityId).not.toBe("half");

    const row = liveRow("items", created.entityId);
    expect(row).toEqual(expect.objectContaining({ game_id: gameId, owner_id: stewardA, owner_type: "character", name: "half sack" }));
    expect(entityRow(created.entityId)).toEqual(expect.objectContaining({ kind: "item", game_id: gameId, destroyed_at_t: null }));

    // One open fact per non-null column of the live row, the trigger's own rule.
    const nonNullColumns = Object.entries(row ?? {})
      .filter(([column, value]) => column !== "id" && value !== null)
      .map(([column]) => column)
      .sort();
    const opened = facts(created.entityId);
    expect(opened.map((f) => f.key)).toEqual(nonNullColumns);
    expect(opened.every((f) => f.valid_to_t === null)).toBe(true);
    expect(opened.find((f) => f.key === "owner_id")?.value).toBe(stewardA);

    const createdEvents = events("item.created").filter((e) => JSON.parse(e.causes).row_id === created.entityId);
    expect(createdEvents).toHaveLength(1);
    expect(created.eventId).toEqual(expect.any(String));
    expect(created.t).toBe(createdEvents[0].at_t);

    expect(JSON.parse(events("resolution.recorded")[0].causes).change_count).toBe(1);
    expect(outcome.destroyed).toEqual([]);
    expect(outcome.transitions).toEqual([]);
    expect(outcome.sets).toEqual([]);
  });

  it("a later leg says { ref } for an entity id: a set on the new item, a write to a new resource, and another entity's column set to the new entity", () => {
    const outcome = resolverFor([
      { kind: "create", ref: "half", entityKind: "item", columns: { owner_id: stewardA, owner_type: "character", name: "half sack" } },
      { kind: "set", entityId: { ref: "half" }, key: "owner_id", value: stewardB },
      {
        kind: "create",
        ref: "levy",
        entityKind: "resource",
        columns: { owner_type: "game", name: "levy", value: 0, min_value: 0, max_value: 100, created_at: "2026-01-01T00:00:00.000Z" },
      },
      { kind: "write", entityId: { ref: "levy" }, key: "value", mode: "delta", value: 7, bounds: { minValue: 0, maxValue: 100 } },
      { kind: "create", ref: "steward c", entityKind: "character", columns: { name: "steward c", location_id: granary, created_at: "2026-01-01T00:00:00.000Z" } },
      { kind: "set", entityId: sack, key: "owner_id", value: { ref: "steward c" } },
    ]).resolve({ gameId, mechanic: "SPLIT" });

    const byRef = Object.fromEntries(outcome.created.map((c) => [c.ref, c.entityId]));
    expect(Object.keys(byRef).sort()).toEqual(["half", "levy", "steward c"]);

    expect(liveRow("items", byRef.half)?.owner_id).toBe(stewardB);
    expect(outcome.sets[0]).toEqual(expect.objectContaining({ entityId: byRef.half, key: "owner_id", previousValue: stewardA, newValue: stewardB }));

    expect(liveRow("resources", byRef.levy)?.value).toBe(7);
    expect(outcome.transitions[0]).toEqual(expect.objectContaining({ entityId: byRef.levy, previousValue: 0, newValue: 7 }));

    expect(liveRow("items", sack)?.owner_id).toBe(byRef["steward c"]);
    expect(outcome.sets[1]).toEqual(expect.objectContaining({ entityId: sack, newValue: byRef["steward c"] }));

    expect(JSON.parse(events("resolution.recorded")[0].causes).change_count).toBe(6);
  });

  it("a { ref } naming no earlier create is refused before any write, naming the ref -- including a ref used before the create that defines it", () => {
    for (const changes of [
      [{ kind: "set", entityId: { ref: "ghost" }, key: "owner_id", value: stewardB }] as const,
      [
        { kind: "set", entityId: { ref: "half" }, key: "owner_id", value: stewardB },
        { kind: "create", ref: "half", entityKind: "item", columns: { owner_id: stewardA, owner_type: "character", name: "half sack" } },
      ] as const,
    ]) {
      let caught: unknown;
      try {
        resolverFor(changes as unknown as IntendedChange[]).resolve({ gameId, mechanic: "SPLIT" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ResolveProtocolError);
      expect((caught as ResolveProtocolError).reason).toBe("unresolved-ref");
      expect((caught as ResolveProtocolError).message).toMatch(/'(ghost|half)'/);
    }
    expect(db.prepare(`SELECT COUNT(*) AS c FROM items`).get()).toEqual({ c: 1 });
    expect(events("resolution.recorded")).toEqual([]);
  });

  it("a duplicate ref is refused before any write, naming it", () => {
    const resolver = resolverFor([
      { kind: "create", ref: "half", entityKind: "item", columns: { owner_id: stewardA, owner_type: "character", name: "half sack" } },
      { kind: "create", ref: "half", entityKind: "item", columns: { owner_id: stewardA, owner_type: "character", name: "other half" } },
    ]);
    let caught: unknown;
    try {
      resolver.resolve({ gameId, mechanic: "SPLIT" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResolveProtocolError);
    expect((caught as ResolveProtocolError).reason).toBe("duplicate-ref");
    expect((caught as ResolveProtocolError).message).toContain("'half'");
    expect(db.prepare(`SELECT COUNT(*) AS c FROM items`).get()).toEqual({ c: 1 });
    expect(events("resolution.recorded")).toEqual([]);
  });

  it("a create with a column the table does not have is refused, naming it, and nothing lands", () => {
    const resolver = resolverFor([{ kind: "create", ref: "half", entityKind: "item", columns: { owner_id: stewardA, owner_type: "character", name: "x", colour: "gold" } }]);
    expect(() => resolver.resolve({ gameId, mechanic: "SPLIT" })).toThrow(/colour/);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM items`).get()).toEqual({ c: 1 });
    expect(events("resolution.recorded")).toEqual([]);
  });

  it("the game column and the id are never caller-settable: the engine fills one from the proposal and allocates the other", () => {
    const attempts: Record<string, string>[] = [
      { game_id: "another game", owner_id: stewardA, owner_type: "character", name: "x" },
      { id: "chosen-id", owner_id: stewardA, owner_type: "character", name: "x" },
    ];
    for (const columns of attempts) {
      const resolver = resolverFor([{ kind: "create", ref: "half", entityKind: "item", columns }]);
      expect(() => resolver.resolve({ gameId, mechanic: "SPLIT" })).toThrow(/game_id|\bid\b/);
    }
    expect(db.prepare(`SELECT COUNT(*) AS c FROM items`).get()).toEqual({ c: 1 });
  });

  it("a resolution belongs to a game and cannot create one", () => {
    const resolver = resolverFor([{ kind: "create", ref: "g", entityKind: "game", columns: { name: "x", setting: "x", style: "x" } }]);
    expect(() => resolver.resolve({ gameId, mechanic: "SPLIT" })).toThrow(/game/);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM games`).get()).toEqual({ c: 1 });
  });

  it("a create missing a column the table requires fails inside the transaction, and nothing lands", () => {
    // `owner_id` is NOT NULL on items: the engine does not know that, SQLite does.
    const resolver = resolverFor([{ kind: "create", ref: "half", entityKind: "item", columns: { owner_type: "character", name: "x" } }]);
    expect(() => resolver.resolve({ gameId, mechanic: "SPLIT" })).toThrow(/owner_id/);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM items`).get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM entities WHERE kind = 'item'`).get()).toEqual({ c: 1 });
    expect(events("resolution.recorded")).toEqual([]);
  });

  it("destroys an entity: live row gone, every fact closed, destroyed_at_t set, item.destroyed event, outcome.destroyed, change_count counting it", () => {
    const before = facts(sack);
    expect(before.every((f) => f.valid_to_t === null)).toBe(true);

    const outcome = resolverFor([{ kind: "destroy", entityId: sack }]).resolve({ gameId, mechanic: "SPLIT" });

    expect(liveRow("items", sack)).toBeUndefined();
    const entity = entityRow(sack);
    expect(entity?.destroyed_at_t).not.toBeNull();
    const after = facts(sack);
    expect(after).toHaveLength(before.length);
    expect(after.every((f) => f.valid_to_t === entity?.destroyed_at_t)).toBe(true);

    expect(outcome.destroyed).toEqual([expect.objectContaining({ entityId: sack, entityKind: "item", t: entity?.destroyed_at_t })]);
    expect(outcome.destroyed[0].eventId).toEqual(expect.any(String));
    expect(events("item.destroyed").filter((e) => JSON.parse(e.causes).row_id === sack)).toHaveLength(1);
    expect(JSON.parse(events("resolution.recorded")[0].causes).change_count).toBe(1);
  });

  it("destroying an entity that does not exist, or one already destroyed, is refused naming it", () => {
    expect(() => resolverFor([{ kind: "destroy", entityId: "no-such-entity" }]).resolve({ gameId, mechanic: "SPLIT" })).toThrow(/no-such-entity/);

    resolverFor([{ kind: "destroy", entityId: sack }]).resolve({ gameId, mechanic: "SPLIT" });
    expect(() => resolverFor([{ kind: "destroy", entityId: sack }]).resolve({ gameId, mechanic: "SPLIT" })).toThrow(new RegExp(sack));
    expect(events("resolution.recorded")).toHaveLength(1);
  });

  it("destroy may name a { ref } created earlier in the same resolution", () => {
    const outcome = resolverFor([
      { kind: "create", ref: "half", entityKind: "item", columns: { owner_id: stewardA, owner_type: "character", name: "half sack" } },
      { kind: "destroy", entityId: { ref: "half" } },
    ]).resolve({ gameId, mechanic: "SPLIT" });
    const id = outcome.created[0].entityId;
    expect(outcome.destroyed).toEqual([expect.objectContaining({ entityId: id })]);
    expect(liveRow("items", id)).toBeUndefined();
    expect(entityRow(id)?.destroyed_at_t).not.toBeNull();
  });

  it("partial failure: a create plus a numeric leg that violates bounded rolls the create back -- no row, no entity, no facts, no event", () => {
    constraintTools.declareBoundedConstraint({ gameId, resourceId: treasury });
    const resolver = resolverFor([
      { kind: "create", ref: "half", entityKind: "item", columns: { owner_id: stewardA, owner_type: "character", name: "half sack" } },
      { kind: "write", entityId: treasury, key: "value", mode: "set", value: 500, bounds: { minValue: 0, maxValue: 100 } },
    ]);
    expect(() => resolver.resolve({ gameId, mechanic: "SPLIT" })).toThrow(ConstraintViolationError);

    expect(db.prepare(`SELECT COUNT(*) AS c FROM items`).get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM entities WHERE kind = 'item'`).get()).toEqual({ c: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE entity_id NOT IN (SELECT id FROM entities)`).get()).toEqual({ c: 0 });
    expect(events("item.created")).toHaveLength(1); // the fixture's own sack, and nothing else
    expect(events("resolution.recorded")).toEqual([]);
  });

  it("partial failure the other way: a destroy plus a violating numeric leg rolls the destroy back", () => {
    constraintTools.declareBoundedConstraint({ gameId, resourceId: treasury });
    const resolver = resolverFor([
      { kind: "destroy", entityId: sack },
      { kind: "write", entityId: treasury, key: "value", mode: "set", value: 500, bounds: { minValue: 0, maxValue: 100 } },
    ]);
    expect(() => resolver.resolve({ gameId, mechanic: "SPLIT" })).toThrow(ConstraintViolationError);
    expect(liveRow("items", sack)).toBeDefined();
    expect(entityRow(sack)?.destroyed_at_t).toBeNull();
    expect(facts(sack).every((f) => f.valid_to_t === null)).toBe(true);
  });

  it("a destroy of an entity carrying an irreversible fact is refused, with the one hop attached, and the entity stands", () => {
    const fact = declareIrreversible({ entityId: sack, key: "owner_id" });
    let caught: unknown;
    try {
      resolverFor([{ kind: "destroy", entityId: sack }]).resolve({ gameId, mechanic: "SPLIT" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConstraintViolationError);
    expect((caught as ConstraintViolationError).constraintKind).toBe("irreversible");
    expect((caught as ConstraintViolationError).contradictedFact?.factId).toBe(fact.factId);
    expect((caught as ConstraintViolationError).contradictedFact?.value).toBe(stewardA);
    expect(liveRow("items", sack)).toBeDefined();
    expect(entityRow(sack)?.destroyed_at_t).toBeNull();
    expect(events("resolution.recorded")).toEqual([]);
  });

  it("a destroy of an entity carrying a resolve_only fact succeeds inside the resolution -- the window is open, which is all resolve_only asks", () => {
    constraintTools.declareResolveOnlyConstraint({ gameId, resourceId: treasury });
    const outcome = resolverFor([{ kind: "destroy", entityId: treasury }]).resolve({ gameId, mechanic: "SPLIT" });
    expect(outcome.destroyed).toEqual([expect.objectContaining({ entityId: treasury, entityKind: "resource" })]);
    expect(liveRow("resources", treasury)).toBeUndefined();
    expect(facts(treasury).every((f) => f.valid_to_t !== null)).toBe(true);
  });

  it("replay: the created entity is absent before the resolution and present after; a destroyed one the other way round", () => {
    const outcome = resolverFor([
      { kind: "create", ref: "half", entityKind: "item", columns: { owner_id: stewardA, owner_type: "character", name: "half sack" } },
      { kind: "destroy", entityId: sack },
    ]).resolve({ gameId, mechanic: "SPLIT" });
    const created = outcome.created[0];

    const before = replay({ gameId, t: outcome.t });
    expect(before.entities.map((e) => e.id)).toContain(sack);
    expect(before.entities.map((e) => e.id)).not.toContain(created.entityId);

    const after = replay({ gameId, t: outcome.constraint.t });
    expect(after.entities.map((e) => e.id)).not.toContain(sack);
    const half = after.entities.find((e) => e.id === created.entityId);
    expect(half?.kind).toBe("item");
    expect(half?.facts.owner_id.value).toBe(stewardA);
    expect(half?.facts.name.value).toBe("half sack");
  });

  it("a mechanic that resolves the created entity's id from the outcome can act on it in a later resolution", () => {
    const first = resolverFor([{ kind: "create", ref: "half", entityKind: "item", columns: { owner_id: stewardA, owner_type: "character", name: "half sack" } }]).resolve({ gameId, mechanic: "SPLIT" });
    const id = first.created[0].entityId;
    const second = resolverFor([{ kind: "set", entityId: id, key: "owner_id", value: stewardB }]).resolve({ gameId, mechanic: "SPLIT" });
    expect(second.sets[0]).toEqual(expect.objectContaining({ entityId: id, newValue: stewardB }));
  });
});

describe("resolve: create and destroy against an existing database, not only a fresh one (issue #34)", () => {
  it("a database written by an earlier process, reopened, creates and destroys through a resolution", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "dmcp-resolve-create-existing-"));
    const dbPath = join(tmpDir, "games.db");
    try {
      process.env.DMCP_DB_PATH = dbPath;
      initializeSchema();
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const granary = createLocation({ gameId, name: "granary", description: "test" }).id;
      const steward = createCharacter({ gameId, name: "steward", isPlayer: false, locationId: granary }).id;
      const sack = createItem({ gameId, ownerId: steward, ownerType: "character", name: "sack of grain" }).id;
      closeDatabase();

      // A second process: reopen, reinstall triggers, resolve.
      initializeSchema();
      const db = getDatabase();
      const mechanic: Mechanic = {
        name: "SPLIT",
        adjudicate: () => ({
          changes: [
            { kind: "create", ref: "half", entityKind: "item", columns: { owner_id: steward, owner_type: "character", name: "half sack" } },
            { kind: "destroy", entityId: sack },
          ],
        }),
      };
      const outcome = createResolver({ mechanics: [mechanic] }).resolve({ gameId, mechanic: "SPLIT" });
      const half = outcome.created[0].entityId;
      expect(db.prepare(`SELECT name FROM items WHERE id = ?`).get(half)).toEqual({ name: "half sack" });
      expect(db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE entity_id = ? AND valid_to_t IS NULL`).get(half)).not.toEqual({ c: 0 });
      expect(db.prepare(`SELECT id FROM items WHERE id = ?`).get(sack)).toBeUndefined();
      expect(db.prepare(`SELECT destroyed_at_t FROM entities WHERE id = ?`).get(sack)).not.toEqual({ destroyed_at_t: null });
    } finally {
      closeDatabase();
      process.env.DMCP_DB_PATH = ":memory:";
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
