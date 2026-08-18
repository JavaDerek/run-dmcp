// Vitest setupFiles entry (see vitest.config.ts): a process-wide safety net
// guaranteeing no test can ever open the real on-disk database.
//
// `getDatabase()` resolves DMCP_DB_PATH lazily, so the per-test fixture in
// src/db/__tests__/testDb.ts is normally sufficient. This exists for the
// cases the fixture cannot cover -- a `getDatabase()` reached at module scope,
// or from code a test imports before its own `beforeEach` runs. A setupFiles
// module is imported before the test file itself, so this lands first.
//
// Nothing should ever `delete` this env var mid-run; doing so re-opens the
// hole for every subsequent test.
process.env.DMCP_DB_PATH = ":memory:";
