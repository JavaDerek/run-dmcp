import type Database from "better-sqlite3";
import { closeDatabase, getDatabase } from "../connection.js";
import { initializeSchema } from "../schema.js";

/**
 * Test fixture: gives each test a clean, fully migrated, isolated SQLite
 * database, backed by an in-memory database rather than a file on disk.
 *
 * Why this is needed: `getDatabase()` in `src/db/connection.ts` caches a
 * single database handle at module scope. Without resetting it, every test
 * in a process would share one connection and bleed state into each other.
 *
 * Usage:
 *   let db: Database.Database;
 *   beforeEach(() => {
 *     db = createTestDb();
 *   });
 *   afterEach(() => {
 *     destroyTestDb();
 *   });
 *
 * Call `destroyTestDb()` in `afterEach` (not just before the next
 * `createTestDb()`) so a failed/skipped test doesn't leak its connection
 * into whichever test happens to run next.
 */
export function createTestDb(): Database.Database {
  process.env.DMCP_DB_PATH = ":memory:";
  const db = getDatabase();
  initializeSchema();
  return db;
}

/**
 * Tears down the database created by `createTestDb()`.
 *
 * Deliberately does NOT delete `DMCP_DB_PATH`. `src/test-setup.ts` sets it
 * process-wide as a safety net so that any `getDatabase()` call -- including
 * one made outside this fixture, e.g. at module scope in a test file -- can
 * never open the real on-disk database. Clearing it here would punch a hole
 * in that net for every test that ran after the first teardown.
 */
export function destroyTestDb(): void {
  closeDatabase();
}
