// Minimal in-memory database fixture for tool-layer tests.
//
// DMCP has no shared test harness yet (see connection.ts:19-44 for the
// DMCP_DB_PATH seam). This file is intentionally small and self-contained so
// it's easy to reconcile if a shared harness lands from parallel work on
// another branch -- don't grow it beyond what constraint-layer tests need.
//
// DMCP_DB_PATH=":memory:" is set process-wide by src/test-setup.ts (a
// Vitest `setupFiles` entry) rather than here, because connection.ts reads
// it once at module-evaluation time (src/db/connection.ts:46) -- setting it
// from inside a test file's beforeEach() would run after connection.ts has
// already been imported and resolved the real on-disk path.
import { closeDatabase } from "../../db/connection.js";
import { initializeSchema } from "../../db/schema.js";

/**
 * Point the singleton connection at a fresh in-memory database and create
 * the schema. Call in `beforeEach`.
 */
export function setupTestDb(): void {
  closeDatabase();
  initializeSchema();
}

/** Close the connection. Call in `afterEach`. */
export function teardownTestDb(): void {
  closeDatabase();
}
