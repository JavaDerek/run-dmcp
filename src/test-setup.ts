// Vitest setupFiles entry (see vitest.config.ts). This MUST run before any
// test file's own imports: src/db/connection.ts:19-46 resolves the database
// path once, at module-evaluation time, into module-level constants. Setting
// DMCP_DB_PATH inside a test file's beforeEach() is too late -- by then
// connection.ts has already been imported (transitively, e.g. via a tools
// module) and locked in the real on-disk path. A setupFiles module is
// imported by the runner before the test file itself, so this side effect
// lands first.
process.env.DMCP_DB_PATH = ":memory:";
