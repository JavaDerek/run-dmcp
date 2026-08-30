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

// The timeline (design §5.1) -- the reason this engine exists, and therefore
// something a consuming application reaches directly rather than only through
// a tool call. `replay` answers what the world looked like at any `t`;
// `declareTimeAxis` is where an application says what its `t` actually is,
// which it must do before its first write for that game if it wants its own
// origin (see clock.ts).
//
// `timelineDivergences` is exported for the same reason design §13 makes it a
// stop condition rather than a nicety: an application that keeps its world
// here is entitled to ask, of its own database, whether the log it is trusting
// still reproduces its live tables. It returns rows and never a verdict.
export { replay } from "./timeline/replay.js";
export type { Snapshot, ReplayedEntity, ReplayedFact } from "./timeline/replay.js";
export { declareTimeAxis, setStoryTime, currentStoryTime } from "./timeline/clock.js";
export type { StoryTime } from "./timeline/clock.js";
export { compareT, assertT } from "./timeline/t.js";
export type { T, TimeAxis } from "./timeline/t.js";
export { timelineDivergences } from "./timeline/checkpoint.js";
export type { Divergence } from "./timeline/checkpoint.js";

// `irreversible` (design §5.3) -- the temporal member of the constraint family.
// Exported because the enforcement is structural (triggers on `facts`), which
// means an application never calls a checker: it declares, and later
// contradictions are refused at the write that attempts them. What it does need
// from here is the declaration itself, and the ability to ask which facts carry
// it -- with the one hop of provenance (§5.2c) that makes a refusal reviewable
// rather than merely obeyed.
export {
  declareIrreversible,
  irreversibleFactFor,
  listIrreversibleFacts,
} from "./timeline/irreversible.js";
export type { IrreversibleFact } from "./timeline/irreversible.js";

// Timeline export (design §6) -- the boundary that keeps both halves honest:
// conversational authoring upstream of a frozen artifact, deterministic
// consumers downstream of it. These are exported as library functions first
// and served as MCP tools second, because the consumer that most needs them
// is a process that must never call a model at runtime.
export {
  exportTimeline,
  importTimeline,
  exportTimelineToFile,
  importTimelineFromFile,
  TIMELINE_FORMAT_VERSION,
} from "./timeline/export.js";
export type {
  TimelineExport,
  TimelineExportEntity,
  TimelineExportFact,
  TimelineExportEvent,
  TimelineExportClock,
  TimelineImportResult,
} from "./timeline/export.js";
export { ENTITY_KINDS } from "./timeline/kinds.js";
export type { EntityKind } from "./timeline/kinds.js";

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
