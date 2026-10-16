// `improvisable` -- the constraint family's member that says "this value may
// receive bounded improvised rulings" (design §5.3). Declaring it is the game
// naming, on purpose, a value an unlisted act may move, and how far one ruling
// may move it per tier. A value WITHOUT it can never receive one; that is how a
// world's hard values stay structurally out of reach of an improvised ruling.
//
// This file covers the DECLARATION side: the declare function, its refusals,
// the row round-tripping through the registry, the MCP tool, and the CHECK
// migration on a database that predates the kind. Enforcement against a write
// lives in src/timeline/__tests__/improvised.test.ts.
//
// Fixtures are grain, treasury, population -- throwaway vocabulary for
// exercising mechanism, never a starter set.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { closeDatabase, getDatabase } from "../../db/connection.js";
import { initializeSchema } from "../../db/schema.js";
import { createGame } from "../game.js";
import { createResource } from "../resource.js";
import {
  declareImprovisableConstraint,
  declareBoundedConstraint,
  declareConservedConstraint,
  listConstraints,
  getConstraintsForResource,
  removeConstraint,
} from "../constraint.js";
import { constraintsFor } from "../../timeline/registry.js";

const TIERS = [
  { key: "minor", cap: 2 },
  { key: "serious", cap: 5 },
  { key: "outrage", cap: 10, requiresConfirmation: true },
];

describe("declareImprovisableConstraint", () => {
  let gameId: string;
  let grainId: string;

  beforeEach(() => {
    createTestDb();
    gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    grainId = createResource({ gameId, ownerType: "game", name: "grain", value: 50 }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("declares an ordered tier list on one resource, defaulting factKey to 'value' and requiresConfirmation to false", () => {
    const constraint = declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: TIERS });
    expect(constraint.kind).toBe("improvisable");
    expect(constraint.resourceIds).toEqual([grainId]);
    expect(constraint.factKey).toBe("value");
    expect(constraint.tiers).toEqual([
      { key: "minor", cap: 2, requiresConfirmation: false },
      { key: "serious", cap: 5, requiresConfirmation: false },
      { key: "outrage", cap: 10, requiresConfirmation: true },
    ]);
  });

  it("round-trips through the registry with its tiers in declared order", () => {
    const reversed = [...TIERS].reverse();
    const declared = declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: reversed });
    const [read] = constraintsFor(grainId, "value");
    expect(read).toEqual(declared);
    expect(read.tiers?.map((t) => t.key)).toEqual(["outrage", "serious", "minor"]);
    expect(listConstraints(gameId)).toEqual([declared]);
    expect(getConstraintsForResource(grainId)).toEqual([declared]);
  });

  it("every other kind carries tiers: null", () => {
    const treasuryId = createResource({ gameId, ownerType: "game", name: "treasury", value: 5, minValue: 0, maxValue: 10 }).id;
    expect(declareBoundedConstraint({ gameId, resourceId: treasuryId }).tiers).toBeNull();
    expect(constraintsFor(treasuryId, "value")[0].tiers).toBeNull();
  });

  it("is scoped by factKey: two keys on one resource are two independent declarations", () => {
    declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: TIERS });
    const other = declareImprovisableConstraint({ gameId, resourceId: grainId, factKey: "min_value", tiers: [{ key: "minor", cap: 1 }] });
    expect(other.factKey).toBe("min_value");
    expect(constraintsFor(grainId, "value")).toHaveLength(1);
    expect(constraintsFor(grainId, "min_value")).toHaveLength(1);
  });

  it("refuses a second declaration on the same (resource, factKey)", () => {
    declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: TIERS });
    expect(() => declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: TIERS })).toThrow(/already has an 'improvisable' constraint/);
  });

  it("refuses an unknown game or resource", () => {
    expect(() => declareImprovisableConstraint({ gameId: "no-such-game", resourceId: grainId, tiers: TIERS })).toThrow();
    expect(() => declareImprovisableConstraint({ gameId, resourceId: "no-such-resource", tiers: TIERS })).toThrow(/not found/);
  });

  it("refuses an empty tier list", () => {
    expect(() => declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: [] })).toThrow(/at least one tier/);
  });

  it("refuses a tier with an empty key, or two tiers with the same key", () => {
    expect(() => declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: [{ key: "", cap: 1 }] })).toThrow(/non-empty/);
    expect(() =>
      declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: [{ key: "minor", cap: 1 }, { key: "minor", cap: 2 }] })
    ).toThrow(/duplicate tier key 'minor'/);
  });

  it("refuses a cap that is not a finite number above zero", () => {
    for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: [{ key: "minor", cap }] })).toThrow(/cap/);
    }
  });

  it("nothing is written when a declaration is refused", () => {
    expect(() => declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: [{ key: "minor", cap: -1 }] })).toThrow();
    expect(listConstraints(gameId)).toEqual([]);
  });

  it("coexists with a conserved declaration on the same resource -- the two are orthogonal", () => {
    const treasuryId = createResource({ gameId, ownerType: "game", name: "treasury", value: 50 }).id;
    declareConservedConstraint({ gameId, resourceIds: [grainId, treasuryId], total: 100 });
    const improvisable = declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: TIERS });
    expect(constraintsFor(grainId, "value").map((c) => c.kind).sort()).toEqual(["conserved", "improvisable"]);
    expect(removeConstraint(improvisable.id)).toBe(true);
    expect(constraintsFor(grainId, "value").map((c) => c.kind)).toEqual(["conserved"]);
  });
});

describe("declare_resource_constraint over MCP: kind 'improvisable'", () => {
  afterEach(() => {
    destroyTestDb();
  });

  it("declares tiers through a real client, and refuses a missing tier list", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createCoreMcpServer } = await import("../../mcp-server.js");
    createTestDb();
    const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    const grainId = createResource({ gameId, ownerType: "game", name: "grain", value: 50 }).id;
    const server = createCoreMcpServer();
    const [cs, ss] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "improvisable", version: "0" });
    await Promise.all([server.connect(ss), client.connect(cs)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };

    const missing = await call("declare_resource_constraint", { gameId, kind: "improvisable", resourceId: grainId });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/tiers/);

    const ok = await call("declare_resource_constraint", {
      gameId,
      kind: "improvisable",
      resourceId: grainId,
      tiers: [{ key: "minor", cap: 2 }, { key: "outrage", cap: 10, requiresConfirmation: true }],
    });
    expect(ok.isError).not.toBe(true);
    const body = JSON.parse(ok.content[0].text);
    expect(body.kind).toBe("improvisable");
    expect(body.tiers).toEqual([
      { key: "minor", cap: 2, requiresConfirmation: false },
      { key: "outrage", cap: 10, requiresConfirmation: true },
    ]);

    const listed = await call("list_resource_constraints", { gameId });
    expect(JSON.parse(listed.content[0].text)[0].tiers).toHaveLength(2);
    await client.close();
  });
});

// ============================================================================
// The CHECK migration. SQLite cannot ALTER a CHECK, so admitting a new kind on
// a database that predates it is a table rebuild -- and this one runs on
// databases that already carry rows with min_value/max_value/caused_by_event_id
// (issue #42), which an earlier version of the rebuild did not copy.
// ============================================================================
describe("resource_constraints CHECK migration (improvisable)", () => {
  afterEach(() => {
    process.env.DMCP_DB_PATH = ":memory:";
    try {
      closeDatabase();
    } catch {
      // already closed
    }
  });

  function constraintsSql(db: Database.Database): string {
    return (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_constraints'`).get() as { sql: string }).sql;
  }

  it("a fresh database already admits 'improvisable'", () => {
    process.env.DMCP_DB_PATH = ":memory:";
    initializeSchema();
    expect(constraintsSql(getDatabase())).toContain("'improvisable'");
  });

  it("an existing database with the four-member CHECK keeps every row and every column value (including issue #42's), admits the new kind, and converges byte-for-byte on a fresh database's DDL", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "dmcp-improvisable-migration-"));
    const dbPath = join(tmpDir, "games.db");
    try {
      process.env.DMCP_DB_PATH = dbPath;
      initializeSchema();
      const setup = getDatabase();
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 25 });
      const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 75 });

      // Fabricate the pre-improvisable shape exactly as the previous release
      // left it: the four-member CHECK, then fact_key, min_value, max_value,
      // caused_by_event_id added by ALTER, in that order.
      setup.exec(`DROP TRIGGER IF EXISTS timeline_facts_resolve_only`);
      setup.exec(`DELETE FROM resource_constraint_members`);
      setup.exec(`DROP TABLE resource_constraints`);
      setup.exec(`
        CREATE TABLE resource_constraints (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('bounded', 'monotonic', 'conserved', 'resolve_only')),
          direction TEXT CHECK (direction IN ('increasing', 'decreasing')),
          total REAL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
        )
      `);
      setup.exec(`ALTER TABLE resource_constraints ADD COLUMN fact_key TEXT NOT NULL DEFAULT 'value'`);
      setup.exec(`ALTER TABLE resource_constraints ADD COLUMN min_value REAL`);
      setup.exec(`ALTER TABLE resource_constraints ADD COLUMN max_value REAL`);
      setup.exec(`ALTER TABLE resource_constraints ADD COLUMN caused_by_event_id TEXT`);
      setup
        .prepare(
          `INSERT INTO resource_constraints (id, game_id, kind, direction, total, created_at, fact_key, min_value, max_value, caused_by_event_id)
           VALUES ('c-bounded', ?, 'bounded', NULL, NULL, '2020-01-01T00:00:00.000Z', 'value', 1, 99, 'event-from-a-create-leg')`
        )
        .run(game.id);
      setup
        .prepare(
          `INSERT INTO resource_constraints (id, game_id, kind, direction, total, created_at, fact_key)
           VALUES ('c-resolve-only', ?, 'resolve_only', NULL, NULL, '2020-01-02T00:00:00.000Z', 'min_value')`
        )
        .run(game.id);
      setup
        .prepare(
          `INSERT INTO resource_constraints (id, game_id, kind, direction, total, created_at, fact_key)
           VALUES ('c-conserved', ?, 'conserved', NULL, 100, '2020-01-03T00:00:00.000Z', 'value')`
        )
        .run(game.id);
      setup.prepare(`INSERT INTO resource_constraint_members (constraint_id, resource_id) VALUES ('c-bounded', ?)`).run(grain.id);
      setup.prepare(`INSERT INTO resource_constraint_members (constraint_id, resource_id) VALUES ('c-resolve-only', ?)`).run(grain.id);
      setup
        .prepare(`INSERT INTO resource_constraint_members (constraint_id, resource_id) VALUES ('c-conserved', ?), ('c-conserved', ?)`)
        .run(grain.id, treasury.id);
      expect(constraintsSql(setup)).not.toContain("improvisable");
      closeDatabase();

      // The call under test.
      process.env.DMCP_DB_PATH = dbPath;
      expect(() => initializeSchema()).not.toThrow();
      const migrated = getDatabase();

      expect(migrated.prepare(`SELECT * FROM resource_constraints WHERE id = 'c-bounded'`).get()).toMatchObject({
        kind: "bounded",
        fact_key: "value",
        min_value: 1,
        max_value: 99,
        caused_by_event_id: "event-from-a-create-leg",
        tiers: null,
      });
      expect(migrated.prepare(`SELECT * FROM resource_constraints WHERE id = 'c-resolve-only'`).get()).toMatchObject({
        kind: "resolve_only",
        fact_key: "min_value",
      });
      expect(migrated.prepare(`SELECT * FROM resource_constraints WHERE id = 'c-conserved'`).get()).toMatchObject({
        kind: "conserved",
        total: 100,
      });
      expect((migrated.prepare(`SELECT COUNT(*) AS n FROM resource_constraint_members`).get() as { n: number }).n).toBe(4);
      expect(migrated.pragma("foreign_key_check")).toEqual([]);

      // The new kind is admitted for real, not merely present in the DDL text.
      const declared = declareImprovisableConstraint({ gameId: game.id, resourceId: treasury.id, tiers: TIERS });
      expect(constraintsFor(treasury.id, "value").find((c) => c.id === declared.id)?.tiers).toHaveLength(3);

      // The resolve_only backstop survived the rebuild.
      expect(() => migrated.prepare(`UPDATE resources SET min_value = 3 WHERE id = ?`).run(grain.id)).toThrow();

      const migratedSql = constraintsSql(migrated);
      closeDatabase();

      process.env.DMCP_DB_PATH = ":memory:";
      initializeSchema();
      const freshSql = constraintsSql(getDatabase());
      closeDatabase();
      expect(migratedSql).toBe(freshSql);

      // Idempotent: a second startup changes nothing.
      process.env.DMCP_DB_PATH = dbPath;
      expect(() => initializeSchema()).not.toThrow();
      const reopened = getDatabase();
      expect(constraintsSql(reopened)).toBe(migratedSql);
      expect((reopened.prepare(`SELECT COUNT(*) AS n FROM resource_constraints`).get() as { n: number }).n).toBe(4);
    } finally {
      process.env.DMCP_DB_PATH = ":memory:";
      try {
        closeDatabase();
      } catch {
        // already closed
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
