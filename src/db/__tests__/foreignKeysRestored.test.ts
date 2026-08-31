// Foreign-key enforcement survives a failed CHECK-rebuild migration.
//
// Two migrations in src/db/schema.ts rebuild a whole table to widen a CHECK
// SQLite cannot ALTER (`resource_constraints`, then `resources`). Both must
// turn `PRAGMA foreign_keys` OFF around the rebuild -- with enforcement on,
// `DROP TABLE` performs an implicit per-row DELETE first, so every ON DELETE
// CASCADE pointing at that table fires and empties it, turning a schema change
// into a silent mass deletion.
//
// Turning it off is therefore correct. Turning it back on only when the rebuild
// SUCCEEDS is not, and that is what both sites did: the restoring `pragma`
// call sat after the transaction, so any throw inside skipped it. `getDatabase()`
// caches one connection at module scope, so the process then continues against a
// handle with foreign keys silently disabled -- and a disabled foreign key does
// not announce itself. It means every ON DELETE CASCADE in this schema quietly
// stops working: deleting a game orphans its characters, resources, locations
// and secrets instead of taking them with it, and nothing errors.
//
// The failure is not hypothetical, and the injection below is the scenario
// rather than a contrivance: a `resources_staging` table left behind by a
// rebuild that died partway is exactly what makes the NEXT startup's
// `CREATE TABLE resources_staging` throw.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase } from "../connection.js";
import { initializeSchema } from "../schema.js";
import { createGame } from "../../tools/game.js";

function foreignKeysOn(): boolean {
  return getDatabase().pragma("foreign_keys", { simple: true }) === 1;
}

/** The pre-widening `resources` shape, so `initializeSchema()` takes the rebuild branch. */
const NARROW_RESOURCES_DDL = `
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
`;

describe("foreign-key enforcement is restored after a CHECK-rebuild migration", () => {
  afterEach(() => {
    try {
      closeDatabase();
    } catch {
      // already closed
    }
  });

  it("is on after a successful startup on a fresh database", () => {
    process.env.DMCP_DB_PATH = ":memory:";
    initializeSchema();
    expect(foreignKeysOn()).toBe(true);
  });

  it("is on after a successful in-place rebuild of an existing database", () => {
    const dir = mkdtempSync(join(tmpdir(), "dmcp-fk-restored-ok-"));
    const dbPath = join(dir, "games.db");
    try {
      process.env.DMCP_DB_PATH = dbPath;
      initializeSchema();
      const setup = getDatabase();
      createGame({ name: "grain depot", setting: "test", style: "test" });
      setup.exec(`DELETE FROM resource_constraint_members`);
      setup.exec(`DELETE FROM resource_constraints`);
      setup.exec(`DROP TABLE resources`);
      setup.exec(NARROW_RESOURCES_DDL);
      closeDatabase();

      process.env.DMCP_DB_PATH = dbPath;
      expect(() => initializeSchema()).not.toThrow();
      expect(foreignKeysOn()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is on again even when the rebuild throws partway through", () => {
    const dir = mkdtempSync(join(tmpdir(), "dmcp-fk-restored-fail-"));
    const dbPath = join(dir, "games.db");
    try {
      process.env.DMCP_DB_PATH = dbPath;
      initializeSchema();
      const setup = getDatabase();
      createGame({ name: "grain depot", setting: "test", style: "test" });
      setup.exec(`DELETE FROM resource_constraint_members`);
      setup.exec(`DELETE FROM resource_constraints`);
      setup.exec(`DROP TABLE resources`);
      setup.exec(NARROW_RESOURCES_DDL);

      // The wreckage of an earlier rebuild that died partway: the staging
      // table it created is still there, so the next attempt's own
      // `CREATE TABLE resources_staging` collides and throws.
      setup.exec(`CREATE TABLE resources_staging (id TEXT PRIMARY KEY)`);
      closeDatabase();

      process.env.DMCP_DB_PATH = dbPath;
      expect(() => initializeSchema()).toThrow();

      // The startup failed, loudly, which is fine and correct. What must NOT
      // happen is the connection surviving with enforcement silently off.
      expect(foreignKeysOn()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
