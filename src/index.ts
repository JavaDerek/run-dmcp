// The library entry point: exports, and nothing else.
//
// Importing this module must do nothing to the machine -- no database file, no
// listener, no transport, no timer, no work of any kind. 0.1.0 shipped one
// entry that was both library and application, so importing the package opened
// a database inside node_modules and bound the web UI's port, and the listener
// outlived the import by hours.
//
// The rule is asserted from the outside in src/__tests__/entrypoints.test.ts:
// a child process imports this file and must be able to EXIT. Anything left
// open keeps it alive and fails the test, so the guarantee does not depend on
// anyone remembering to enumerate what must not start.
//
// Starting things is src/bin/run-dmcp.ts, which is what `bin` points at.
export { createMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp-server.js";

// The database, and where it lives. The path resolves against the consuming
// application (DMCP_DB_PATH, else an existing XDG data directory, else the
// working directory) and never against this package's install location.
export {
  getDatabase,
  closeDatabase,
  withTransaction,
  getDatabasePath,
  getDataDir,
  resolveDataPathFrom,
} from "./db/connection.js";
export type { DataPathInputs } from "./db/connection.js";

// The schema, and the hook a consuming application uses to bring up its own
// tables in the same startup pass, in the same database, under the same rules.
export { initializeSchema } from "./db/schema.js";
export type { SchemaMigration } from "./db/schema.js";

// The web UI. An application opts into serving it; importing this never does.
export { createHttpServer, startHttpServer } from "./http/server.js";
export {
  DEFAULT_HTTP_PORT,
  httpPortFromEnv,
  webUiEnabled,
  setHttpPort,
  getWebUiBaseUrl,
} from "./utils/webui.js";

export type * from "./types/index.js";
