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
// `changes_within(t0, t1)` (design §5.5) -- the range companion to `replay`,
// for a consumer whose units have duration rather than instants. It returns
// transitions and never a verdict: one caller reads a change inside a window
// as a defect, another reads the same rows to build a summary of what has
// happened since it last looked. Same primitive, opposite readings, which is
// how you can tell it belongs in the core rather than to whoever asked first.
export { changesWithin } from "./timeline/changes.js";
export type { Change, ChangeSet, EventChange, FactChange } from "./timeline/changes.js";
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
export { openingEventId } from "./timeline/provenance.js";
export type { FactProvenance } from "./timeline/provenance.js";

// The narration constraint (design §5.2b/§5.2c, GitHub issues #11 and #12)
// -- the outbound half of authority, and the half with two consumers.
// "Here is what is true; depict it, do not argue with it." Exported as a
// library function FIRST, before any MCP tool wraps it (the one tool that
// does, `narration_constraint_at`, is a thin JSON-over-stdio wrapper around
// this same call), because the consumer that most needs it is a process
// that must never call a model at runtime: its units have duration and
// everything in them is already known in advance, so its narrator output
// is generated once, reviewed by a human, committed as a file, and
// rendered hours later by a lint over that finished artifact, with no
// engine and no model in the loop (§6's "library functions first, MCP
// tools second," restated here because this is the export where it matters
// most). `contradictions` is exported alongside it for the same reason and
// takes no database handle at all -- it is a pure function over the plain
// object `narrationConstraintAt` returns, so a caller can serialize a
// constraint once, hand the JSON to an entirely separate process, and run
// the check there hours or days later. Prohibitions in the returned shape
// are derived and structural, never authored and lexical (hard rule 5): the
// engine records that a fact holds and lets a claim disagree or not,
// exactly the way `changes_within` (§5.5) records transitions rather than a
// verdict -- there is no `mustNotSay`, no severity, nothing this project's
// four recorded negative-prompt failures would recognise.
export {
  narrationConstraintAt,
  contradictions,
  NARRATION_CONSTRAINT_FORMAT_VERSION,
} from "./timeline/narration.js";
export type { NarrationConstraint, ConstraintFact, Claim, Contradiction } from "./timeline/narration.js";

// The constrained-write choke point (design §5.4 option (C)) -- the one place
// a constrained numeric fact key changes, and the reason there is no longer a
// `resource_history` table beside the timeline answering the same question.
// Exported because an application that keeps invariant-bearing numbers here
// has to be able to write them, and writing them anywhere else is precisely
// the second path option (C) exists to close: a direct UPDATE still lands in
// `facts` (the projection triggers see to that), but it arrives unchecked and
// unannotated.
//
// `valueHistory` is the read half, and it is deliberately not a separate
// mechanism -- it is `facts` and `events`, assembled. It returns rows and
// never a verdict.
//
// `ConstraintViolationError` is exported because a refusal is only reviewable
// if the caller can tell it apart from a failure. For the `irreversible`
// member it carries §5.2c's one hop -- the contradicted fact, its
// `valid_from_t`, and the event that opened it -- so a reviewer can answer
// "is the fact wrong, or is the claim wrong", which is undecidable without it.
export {
  writeConstrainedValue,
  transferConstrainedValue,
  valueHistory,
} from "./timeline/constrained.js";
export type { ValueTransition } from "./timeline/constrained.js";
export { ConstraintViolationError, constraintsFor, conservedConstraintFor } from "./timeline/registry.js";

// The resolve protocol (design §5.2a, GitHub issue #10) -- the inbound half of
// authority. The engine enforces the PROTOCOL -- resolution happens before
// narration, writes go through the audited path, declared expectations are
// checked -- without knowing what any particular mechanic MEANS. An application
// registers its mechanics by passing them to `createResolver`, and the engine
// dispatches them and never learns their names.
//
// Registration is injection at construction, exactly like `initializeSchema({
// migrations })` and for exactly the same reason: a global registry would make
// behaviour depend on module import order and on side effects at import time,
// which is the disease the entry-point split above cured. A parameter cannot be
// registered too late.
//
// NOTE WHAT IS DELIBERATELY *NOT* EXPORTED HERE: `withAdjudicationOpen` and
// `adjudicationOpen` (./timeline/adjudication.js). `resolve_only` (issue #13)
// means a value moves only through an adjudicating call, and the adjudication
// window is what "adjudicating" is measured against -- so exporting the ability
// to open one would hand every caller a one-line bypass of the constraint, and
// the fourth member of the family would be enforced against everybody except
// whoever read the export list. `resolver.resolve()` is the only public door to
// a `resolve_only` value. That is the whole point of the constraint, so the
// window stays internal to the engine that opens it.
export { createResolver, ResolveProtocolError } from "./timeline/resolve.js";
export type {
  Mechanic,
  Resolver,
  Proposal,
  Expectation,
  AdjudicationInput,
  Adjudication,
  IntendedChange,
  IntendedWrite,
  IntendedTransfer,
  Outcome,
  ResolveRefusalReason,
} from "./timeline/resolve.js";

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
