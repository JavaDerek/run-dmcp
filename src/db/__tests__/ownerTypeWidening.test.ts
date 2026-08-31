// resources.owner_type widening -- 'faction' and 'location' join 'game' and
// 'character' as legal owners of a resource. Nothing about "a resource can be
// owned by a faction or a location" is specific to any one consuming
// application: the engine already has `factions` and `locations` tables, this
// just lets a resource point at either the way it already points at a `game`
// or a `character`.
//
// SQLite cannot ALTER a CHECK constraint, so a database that already has a
// `resources` table under the OLD two-member CHECK needs the same full-table-
// rebuild recipe `src/db/schema.ts` already uses for `resource_constraints`
// (issue #13's `resolve_only` widening) and for `stored_images` (the
// entity_type CHECK removal). This file exercises both paths: a fresh
// database (which never takes the rebuild branch, because its CREATE TABLE
// already carries the widened CHECK) and an existing on-disk database
// fabricated under the pre-widening shape.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, destroyTestDb } from "./testDb.js";
import { getDatabase, closeDatabase } from "../connection.js";
import { initializeSchema } from "../schema.js";
import { createGame } from "../../tools/game.js";
import { createResource, getResource } from "../../tools/resource.js";
// The timeline's read paths are a deliberate single choke point (issue #18,
// enforced by src/__tests__/deferredDecisions.test.ts): no module outside
// src/timeline/ may issue SQL against entities/facts/events/timeline_clock.
// This file inspects projected state through replay() -- the same sanctioned
// reader src/tools/__tests__/relationship.test.ts uses -- rather than
// querying those tables directly.
import { replay } from "../../timeline/replay.js";
import { currentStoryTime } from "../../timeline/clock.js";

/** The current story `t` for a game that has written at least once (every
 * test below creates a resource before calling this, which always writes
 * through the projection triggers, so the clock always exists). */
function requireStoryT(gameId: string): number {
  const story = currentStoryTime(gameId);
  if (!story) {
    throw new Error(`test setup error: game '${gameId}' has no timeline clock`);
  }
  return story.t;
}

/** The projected `owner_type`/`owner_id` facts for a resource, read through
 * replay() -- never raw SQL against `facts` (see the import comment above). */
function ownerFactsFor(gameId: string, resourceId: string) {
  const entity = replay({ gameId, t: requireStoryT(gameId) }).entities.find((e) => e.id === resourceId);
  return {
    kind: entity?.kind,
    ownerType: entity?.facts.owner_type?.value,
    ownerId: entity?.facts.owner_id?.value,
  };
}

describe("resources.owner_type widening (faction, location)", () => {
  describe("against a fresh database", () => {
    beforeEach(() => {
      createTestDb();
    });

    afterEach(() => {
      destroyTestDb();
    });

    it("accepts a faction-owned resource, through the real tool function and back out again", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const resource = createResource({
        gameId: game.id,
        ownerType: "faction",
        ownerId: "guild-1",
        name: "grain",
        value: 40,
      });
      expect(resource.ownerType).toBe("faction");

      const reloaded = getResource(resource.id);
      expect(reloaded?.ownerType).toBe("faction");
      expect(reloaded?.ownerId).toBe("guild-1");
      expect(reloaded?.value).toBe(40);
    });

    it("accepts a location-owned resource, through the real tool function and back out again", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const resource = createResource({
        gameId: game.id,
        ownerType: "location",
        ownerId: "settlement-1",
        name: "population",
        value: 120,
      });
      expect(resource.ownerType).toBe("location");

      const reloaded = getResource(resource.id);
      expect(reloaded?.ownerType).toBe("location");
      expect(reloaded?.ownerId).toBe("settlement-1");
    });

    it("still rejects a genuinely invalid owner_type -- the widening is not a removal of the CHECK", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const db = getDatabase();
      expect(() =>
        db
          .prepare(
            `INSERT INTO resources (id, game_id, owner_id, owner_type, name, value, created_at)
             VALUES (?, ?, NULL, 'not_a_real_owner_type', 'grain', 0, ?)`
          )
          .run("bad-owner-type", game.id, new Date().toISOString())
      ).toThrow(/CHECK constraint failed/);
    });

    it("projects a faction-owned resource onto the timeline the same as any other owner (entity + owner_type fact)", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const resource = createResource({
        gameId: game.id,
        ownerType: "faction",
        ownerId: "guild-1",
        name: "grain",
        value: 40,
      });

      const projected = ownerFactsFor(game.id, resource.id);
      expect(projected.kind).toBe("resource");
      expect(projected.ownerType).toBe("faction");
      expect(projected.ownerId).toBe("guild-1");
    });
  });

  describe("against an existing on-disk database created under the OLD narrow CHECK", () => {
    afterEach(() => {
      try {
        closeDatabase();
      } catch {
        // already closed
      }
    });

    it("a fresh database's resources CHECK already admits 'faction' and 'location' -- no rebuild needed", () => {
      process.env.DMCP_DB_PATH = ":memory:";
      initializeSchema();
      const db = getDatabase();
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'`)
        .get() as { sql: string };
      expect(row.sql).toContain("faction");
      expect(row.sql).toContain("location");
    });

    it(
      "migrates an existing database in place: existing rows survive with values intact, faction/location " +
        "become insertable, invalid owner_type is still rejected, every FK is intact, fresh vs. migrated " +
        "sqlite_master.sql are byte-identical, and re-running initializeSchema() is idempotent",
      () => {
        const tmpDir = mkdtempSync(join(tmpdir(), "dmcp-owner-type-migration-"));
        const dbPath = join(tmpDir, "games.db");

        try {
          // Build a REAL, fully-shaped on-disk database via this build's own
          // initializeSchema() and real tool functions, then deliberately
          // downgrade ONLY `resources` back to the pre-widening shape --
          // mirroring src/timeline/__tests__/resolveOnly.test.ts's own CHECK
          // migration fixture for resource_constraints.
          process.env.DMCP_DB_PATH = dbPath;
          initializeSchema();
          const setupDb = getDatabase();
          const game = createGame({ name: "grain depot", setting: "test", style: "test" });
          const grain = createResource({
            gameId: game.id,
            ownerType: "game",
            name: "grain",
            value: 25,
          });
          const treasury = createResource({
            gameId: game.id,
            ownerType: "character",
            ownerId: "char-1",
            name: "treasury",
            value: 75,
          });

          // Downgrade `resources` to the OLD two-member CHECK, in place. DROP
          // then CREATE directly under the FINAL name, deliberately never
          // RENAME TO -- resolveOnly.test.ts's own comment explains why:
          // SQLite revalidates every trigger that references a table as part
          // of renaming another table INTO that table's name, and this
          // database already has timeline_resources_ai/au/ad (AFTER INSERT/
          // UPDATE/DELETE ON resources) installed from the initializeSchema()
          // call above.
          setupDb.exec(`DELETE FROM resource_constraint_members`);
          setupDb.exec(`DELETE FROM resource_constraints`);
          setupDb.exec(`DROP TABLE resources`);
          setupDb.exec(`
            CREATE TABLE resources (
              id TEXT PRIMARY KEY,
              game_id TEXT NOT NULL,
              owner_id TEXT,
              owner_type TEXT NOT NULL CHECK (owner_type IN ('game', 'character')),
              name TEXT NOT NULL,
              description TEXT,
              category TEXT,
              value REAL NOT NULL DEFAULT 0,
              min_value REAL,
              max_value REAL,
              created_at TEXT NOT NULL,
              FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
            )
          `);
          setupDb
            .prepare(
              `INSERT INTO resources (id, game_id, owner_id, owner_type, name, description, category, value, min_value, max_value, created_at)
               VALUES (?, ?, NULL, 'game', 'grain', '', NULL, 25, NULL, NULL, ?)`
            )
            .run(grain.id, game.id, grain.createdAt);
          setupDb
            .prepare(
              `INSERT INTO resources (id, game_id, owner_id, owner_type, name, description, category, value, min_value, max_value, created_at)
               VALUES (?, ?, 'char-1', 'character', 'treasury', '', NULL, 75, NULL, NULL, ?)`
            )
            .run(treasury.id, game.id, treasury.createdAt);
          closeDatabase();

          // Reopen -- THIS is the call under test: initializeSchema() must
          // detect the old CHECK and rebuild it.
          process.env.DMCP_DB_PATH = dbPath;
          expect(() => initializeSchema()).not.toThrow();

          const migrated = getDatabase();

          // Every row, and every value, survived.
          const grainRow = migrated.prepare(`SELECT * FROM resources WHERE id = ?`).get(grain.id) as
            | Record<string, unknown>
            | undefined;
          expect(grainRow).toMatchObject({
            id: grain.id,
            game_id: game.id,
            owner_type: "game",
            name: "grain",
            value: 25,
          });

          const treasuryRow = migrated.prepare(`SELECT * FROM resources WHERE id = ?`).get(treasury.id) as
            | Record<string, unknown>
            | undefined;
          expect(treasuryRow).toMatchObject({
            id: treasury.id,
            owner_type: "character",
            owner_id: "char-1",
            name: "treasury",
            value: 75,
          });

          // The widened CHECK actually admits 'faction' and 'location' now --
          // proven by successfully inserting rows of those kinds, not merely
          // by inspecting the DDL text.
          expect(() =>
            migrated
              .prepare(
                `INSERT INTO resources (id, game_id, owner_id, owner_type, name, value, created_at)
                 VALUES (?, ?, 'guild-1', 'faction', 'grain reserve', 10, ?)`
              )
              .run("faction-owned", game.id, new Date().toISOString())
          ).not.toThrow();
          expect(() =>
            migrated
              .prepare(
                `INSERT INTO resources (id, game_id, owner_id, owner_type, name, value, created_at)
                 VALUES (?, ?, 'settlement-1', 'location', 'population', 100, ?)`
              )
              .run("location-owned", game.id, new Date().toISOString())
          ).not.toThrow();

          // A genuinely invalid owner_type is STILL rejected post-migration --
          // the widening did not become an outright removal of the CHECK.
          expect(() =>
            migrated
              .prepare(
                `INSERT INTO resources (id, game_id, owner_id, owner_type, name, value, created_at)
                 VALUES (?, ?, NULL, 'not_a_real_owner_type', 'grain', 0, ?)`
              )
              .run("still-bad", game.id, new Date().toISOString())
          ).toThrow(/CHECK constraint failed/);

          // Every foreign key -- resources.game_id -> games.id, plus anything
          // that references resources.id (resource_history, resource_constraint_members)
          // -- is intact after the rebuild.
          const fkViolations = migrated.pragma("foreign_key_check");
          expect(fkViolations).toEqual([]);

          const migratedSql = migrated
            .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'`)
            .get() as { sql: string };
          expect(migratedSql.sql).toContain("faction");
          expect(migratedSql.sql).toContain("location");

          // The rebuild must not have dropped the projection triggers: insert
          // a fresh faction-owned resource through the real tool path and
          // confirm it is still projected onto the timeline (entity + facts).
          const guildResource = createResource({
            gameId: game.id,
            ownerType: "faction",
            ownerId: "guild-2",
            name: "second reserve",
            value: 5,
          });
          const projected = ownerFactsFor(game.id, guildResource.id);
          expect(projected.kind).toBe("resource");
          expect(projected.ownerType).toBe("faction");

          closeDatabase();

          // A completely fresh database, for the byte-identical comparison.
          process.env.DMCP_DB_PATH = ":memory:";
          initializeSchema();
          const freshSql = getDatabase()
            .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'`)
            .get() as { sql: string };
          closeDatabase();

          expect(migratedSql.sql).toBe(freshSql.sql);

          // Idempotent: running initializeSchema() again against the ALREADY
          // migrated on-disk database must not re-rebuild, must not throw,
          // and must leave the schema text and the row count exactly as they
          // are (5 rows: grain, treasury, faction-owned, location-owned,
          // second reserve).
          process.env.DMCP_DB_PATH = dbPath;
          expect(() => initializeSchema()).not.toThrow();
          const reopened = getDatabase();
          const secondPassSql = reopened
            .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'`)
            .get() as { sql: string };
          expect(secondPassSql.sql).toBe(migratedSql.sql);
          const rowCount = reopened.prepare(`SELECT COUNT(*) AS n FROM resources`).get() as { n: number };
          expect(rowCount.n).toBe(5);
        } finally {
          process.env.DMCP_DB_PATH = ":memory:";
          try {
            closeDatabase();
          } catch {
            // already closed
          }
          rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    );
  });
});
