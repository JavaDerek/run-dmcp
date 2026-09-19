// `resolve.ts`, `IntendedCreate.constraints` (issue #42): a `create` leg may
// declare `bounded`/`resolve_only`/`monotonic` constraints on the entity it
// makes, applied inside the SAME `withTransaction` as the create itself --
// so a later leg of the same resolution is already held to them, and the
// whole resolution rolls back together if it is not. Until now the only way
// to get a newly-created resource under `bounded`/`resolve_only` was two
// library calls AFTER `resolve()` returned: a second write path outside the
// resolution's own transaction.
//
// `conserved` is deliberately absent from this vocabulary -- it is a
// statement about several EXISTING entities summing to a total, not about
// one being created, so a single `create` leg has nothing to attach it to.
//
// Neutral fixture, as resolveCreate.test.ts: a depot, a treasury, a newly
// created grain resource. Mechanic names are throwaway.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { closeDatabase, getDatabase } from "../../db/connection.js";
import { initializeSchema } from "../../db/schema.js";
import { createGame } from "../../tools/game.js";
import { createResource } from "../../tools/resource.js";
import * as constraintTools from "../../tools/constraint.js";
import { ConstraintViolationError } from "../registry.js";
import { createResolver, ResolveProtocolError, type Mechanic, type IntendedChange } from "../resolve.js";

describe("resolve: a `create` leg's declared constraints (issue #42)", () => {
  let db: Database.Database;
  let gameId: string;
  let treasury: string;

  beforeEach(() => {
    db = createTestDb();
    gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    treasury = createResource({ gameId, ownerType: "game", name: "treasury", value: 50, minValue: 0, maxValue: 100 }).id;
  });

  afterEach(() => destroyTestDb());

  function resolverFor(changes: readonly IntendedChange[]) {
    const mechanic: Mechanic = { name: "SOW", adjudicate: () => ({ changes, description: "sow" }) };
    return createResolver({ mechanics: [mechanic] });
  }

  const grainCreate = {
    kind: "create",
    ref: "grain",
    entityKind: "resource",
    columns: { owner_type: "game", name: "grain", value: 50, min_value: 0, max_value: 100, created_at: "2026-01-01T00:00:00.000Z" },
  } as const;

  function resourceCount(): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM resources`).get() as { c: number }).c;
  }

  function resolutionRecordedEvents(): { causes: string }[] {
    return db.prepare(`SELECT causes FROM events WHERE game_id = ? AND kind = 'resolution.recorded'`).all(gameId) as { causes: string }[];
  }

  // ==========================================================================
  // 1. A later leg of the same resolution that would exceed the declared
  //    bound rolls the whole resolution back, including the create.
  // ==========================================================================
  it("a later leg exceeding the declared bound rolls the whole resolution back, including the create", () => {
    const before = resourceCount();

    const resolver = resolverFor([
      {
        ...grainCreate,
        constraints: [
          { kind: "bounded", key: "value", minValue: 0, maxValue: 100 },
          { kind: "resolve_only", key: "value" },
        ],
      },
      { kind: "write", entityId: { ref: "grain" }, key: "value", mode: "set", value: 500, bounds: { minValue: 0, maxValue: 100 } },
    ]);

    expect(() => resolver.resolve({ gameId, mechanic: "SOW" })).toThrow(ConstraintViolationError);

    // The create itself rolled back too -- no new resources row, no
    // resolution.recorded event, and (since the constraint row shares the
    // transaction) no orphaned resource_constraints row either.
    expect(resourceCount()).toBe(before);
    expect(resolutionRecordedEvents()).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM resource_constraints`).get()).toEqual({ c: 0 });
  });

  // ==========================================================================
  // 2. After the resolution, a direct write to the created resource is
  //    refused by the EXISTING resolve_only trigger -- with no library call
  //    made after resolve() returned. This is the whole point: before this
  //    issue, getting here needed a second declareResolveOnlyConstraint()
  //    call outside the resolution's transaction.
  // ==========================================================================
  it("a direct write to the created resource is refused by the existing resolve_only trigger, with no library call after resolve() returns", () => {
    const outcome = resolverFor([{ ...grainCreate, constraints: [{ kind: "resolve_only", key: "value" }] }]).resolve({
      gameId,
      mechanic: "SOW",
    });
    const grainId = outcome.created[0].entityId;
    expect(db.prepare(`SELECT value FROM resources WHERE id = ?`).get(grainId)).toEqual({ value: 50 });

    // A raw UPDATE, bypassing writeConstrainedValue entirely -- the same
    // shape resolveOnly.test.ts uses to prove the SQL backstop, not the JS
    // choke point, is what refuses this. No library call of any kind runs
    // between resolve() returning and this statement.
    expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(999, grainId)).toThrow(/resolve_only|adjudicating call/i);
    expect(db.prepare(`SELECT value FROM resources WHERE id = ?`).get(grainId)).toEqual({ value: 50 });
  });

  // ==========================================================================
  // 3. A `constraints` entry naming a key not among the created entity's
  //    live columns is refused before dispatch, naming the key.
  // ==========================================================================
  it("a constraints entry naming a key that is not a live column of the created entity is refused, naming the key, with no write attempted", () => {
    const before = resourceCount();
    const resolver = resolverFor([{ ...grainCreate, constraints: [{ kind: "bounded", key: "does_not_exist", minValue: 0, maxValue: 10 }] }]);

    let caught: unknown;
    try {
      resolver.resolve({ gameId, mechanic: "SOW" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResolveProtocolError);
    expect((caught as ResolveProtocolError).reason).toBe("invalid-constraint-key");
    expect((caught as ResolveProtocolError).message).toContain("'does_not_exist'");

    expect(resourceCount()).toBe(before);
    expect(resolutionRecordedEvents()).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM resource_constraints`).get()).toEqual({ c: 0 });
  });

  // ==========================================================================
  // 4. listConstraints shows the declarations, with the resolution's event
  //    as their cause.
  // ==========================================================================
  it("listConstraints shows the declared constraints, caused by the resolution's own event", () => {
    const outcome = resolverFor([
      {
        ...grainCreate,
        constraints: [
          { kind: "bounded", key: "value", minValue: 0, maxValue: 100 },
          { kind: "resolve_only", key: "value" },
          { kind: "monotonic", key: "value", direction: "up" },
        ],
      },
    ]).resolve({ gameId, mechanic: "SOW" });
    const grainId = outcome.created[0].entityId;

    const declared = constraintTools.listConstraints(gameId, grainId);
    expect(declared).toHaveLength(3);
    expect(declared.every((c) => c.causedByEventId === outcome.eventId)).toBe(true);
    expect(declared.map((c) => c.kind).sort()).toEqual(["bounded", "monotonic", "resolve_only"]);

    const bounded = declared.find((c) => c.kind === "bounded");
    expect(bounded?.factKey).toBe("value");
    expect(bounded?.minValue).toBe(0);
    expect(bounded?.maxValue).toBe(100);
    expect(bounded?.resourceIds).toEqual([grainId]);

    const monotonic = declared.find((c) => c.kind === "monotonic");
    expect(monotonic?.direction).toBe("increasing");

    // A constraint declared the ordinary way (outside any resolution) still
    // carries no cause -- this is not a blanket change to every declaration.
    const ordinary = constraintTools.declareBoundedConstraint({ gameId, resourceId: treasury });
    expect(ordinary.causedByEventId).toBeNull();
  });
});

describe("resolve: a create leg's declared constraints against an existing database, not only a fresh one (issue #42)", () => {
  it("a database written by an earlier process, reopened, declares create-time constraints that outlive the process boundary", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "dmcp-resolve-create-constraints-existing-"));
    const dbPath = join(tmpDir, "games.db");
    try {
      process.env.DMCP_DB_PATH = dbPath;
      initializeSchema();
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      closeDatabase();

      // A second process: reopen, reinstall triggers, resolve.
      initializeSchema();
      const db = getDatabase();
      const mechanic: Mechanic = {
        name: "SOW",
        adjudicate: () => ({
          changes: [
            {
              kind: "create",
              ref: "grain",
              entityKind: "resource",
              columns: { owner_type: "game", name: "grain", value: 50, min_value: 0, max_value: 100, created_at: "2026-01-01T00:00:00.000Z" },
              constraints: [
                { kind: "bounded", key: "value", minValue: 0, maxValue: 100 },
                { kind: "resolve_only", key: "value" },
              ],
            },
          ],
        }),
      };
      const outcome = createResolver({ mechanics: [mechanic] }).resolve({ gameId, mechanic: "SOW" });
      const grainId = outcome.created[0].entityId;

      const declared = constraintTools.listConstraints(gameId, grainId);
      expect(declared.map((c) => c.kind).sort()).toEqual(["bounded", "resolve_only"]);
      expect(declared.every((c) => c.causedByEventId === outcome.eventId)).toBe(true);

      expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(999, grainId)).toThrow(/resolve_only|adjudicating call/i);
    } finally {
      closeDatabase();
      process.env.DMCP_DB_PATH = ":memory:";
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
