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
//
// THIS PACKAGE ROOT IS THE CORE (design §8, issue #17): entities, facts,
// events, the timeline, and the entity/property domains a consumer cannot
// lose without losing its own spine -- resources, relationships, factions,
// secrets, locations, items. Dice, combat, abilities, status effects, random
// tables and quests are genuinely game-shaped, and they are an OPTIONAL
// layer above this, not part of it: import "run-dmcp/rpg" for
// `createMcpServer`, the full assembly this package used to export under
// that name. That is design §8's line, not an inversion of it -- the core
// stays importable, buildable and useful with nothing above it, and the
// layer stays free to depend down into the core without the core ever
// depending up into it. `src/__tests__/layerBoundary.test.ts` walks the
// static import graph from this file and fails if anything under `src/rpg/`
// is reachable from it.
// The assembled core server is NOT here. It moved to "run-dmcp/server"
// (src/server.ts) so that importing mechanism stops loading it: building a
// server costs the MCP SDK and twenty-one register modules, and a consumer
// reaching for `LIMITS` or `createGame` was paying for both -- 97.4ms per
// process against 46.8ms without it, cold, at 0.3.0. Enforced by
// src/__tests__/assemblyBoundary.test.ts, which walks this file's runtime
// import graph and fails if the assembly is reachable from it again.

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

// The state-to-text projection (design §7, GitHub issue #16) -- "say what IS
// true, never what is absent."
//
// What is exported here is the MECHANISM and the TYPE of a vocabulary. There
// is deliberately no vocabulary value, no default and no example anywhere in
// this package: a vocabulary rich enough to render a real world contains a
// caller's own nouns, and either sitting in the engine would fail
// `engineVocabulary.test.ts` on day one -- correctly (§7's closing paragraph,
// §10). `RenderVocabulary` is a parameter type; a caller supplies the words.
//
// The rule is enforced at CONSTRUCTION and never by scanning output.
// `createStateRenderer` refuses a vocabulary entry carrying any field but
// `noun` and `adjectives`, by name -- which is what stops an `avoid:` or a
// `negate:` being bolted on later -- and the renderer's only source of state
// is `replay(t)`, so a fact that does not hold produces NOTHING rather than a
// phrase about its absence. There is no differential form and never will be:
// nothing here takes two `t`s, because "render the change between these two
// states" is precisely the shape that produces "no longer" (hard rules 3 and
// 4; the four recorded negative-prompt failures across two codebases).
export { createStateRenderer } from "./timeline/render.js";
export type {
  RenderVocabulary,
  VocabularyEntry,
  StateRenderer,
  RenderedState,
  RenderedNoun,
  UnnamedFact,
} from "./timeline/render.js";

// The turn reader (design §12 seam 3, GitHub issue #15) -- one model call per
// unit of progress, answering the questions a server cannot answer with code.
//
// The engine owns the call, the citation rule, coercion to keys that actually
// exist, the safe-direction default and the fallback ladder; the caller owns
// the questions and the key vocabulary they are answered in. Answers come back
// as KEYS, never prose.
//
// NOTE WHAT IS NOT HERE, BECAUSE IT IS THE POINT: no transport. A
// `ReaderTransport` is a plain async function the CALLER writes and injects,
// so this package contains no vendor SDK, no API key, no endpoint, and no
// network code of any kind -- enforced mechanically by
// `src/reader/__tests__/noVendorTransports.test.ts`, which scans this
// directory for vendor and credential tokens the way the vocabulary test
// scans for a consumer's language. The engine is provably ignorant of what is
// on the other end of a rung, which is also why the ladder's ORDER is the
// caller's: it never learns which rung is local and which is hosted.
export { createTurnReader } from "./reader/turnReader.js";
export type {
  TurnReader,
  ReaderQuestion,
  ReaderSource,
  ReaderTransport,
  ReadRequest,
  TransportAnswer,
  ReaderResult,
  AnsweredQuestion,
  RejectedOffer,
  RejectionReason,
} from "./reader/turnReader.js";

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

// The web UI's port helpers -- no RPG dependency, so they stay here. The web
// UI server itself (`createHttpServer`/`startHttpServer`) imports quest,
// ability and combat tools and is exported from "run-dmcp/rpg" instead
// (src/rpg/index.ts), even though the file that implements it stays at
// src/http/server.ts on disk.
export {
  DEFAULT_HTTP_PORT,
  httpPortFromEnv,
  webUiEnabled,
  setHttpPort,
  getWebUiBaseUrl,
  getGameUrl,
  getCharacterUrl,
  getLocationUrl,
} from "./utils/webui.js";

// ===========================================================================
// The core's own tool modules, as library functions (design §8, §11 Phase 5).
//
// §8's layer table puts factions, relationships-with-history, secrets,
// resources, locations and items in the CORE, and gives the reason: they are
// "the client's spine. If these go up into the RPG layer, the client cannot
// consume the package without dragging the RPG layer with it -- which defeats
// the split." That reason is only satisfied if a consumer can actually IMPORT
// them. Until this block, it could not: everything above is the timeline and
// the database, and the only door to the spine was `createCoreMcpServer` --
// the whole assembled server, which a consumer would then have to make tool
// calls into, over a transport, to read its own tables.
//
// The layer ABOVE this one already got it right. src/rpg/index.ts ends with
// six export-stars over its own tool modules, under a comment saying it is
// using "the same shape core's index.ts uses for the timeline... a consumer
// that wants to call combat/quest/table/status/ability/dice logic directly,
// without going through an MCP tool call, can." The core never did
//
// (Those six are named here in prose rather than quoted as import lines on
// purpose: layerBoundary.test.ts walks this file's import graph with a
// deliberately syntactic scan for `from "<specifier>"`, and it cannot tell a
// quoted example in a comment from a real edge. That is the guard being
// conservative rather than clever, which is the right trade -- it fails loud
// and names the chain. Do not teach it to strip comments; reword instead.)
// the same for its own tools, which left the OPTIONAL layer more consumable
// than the thing it is optional on top of. That is an oversight and not a
// decision: §6's rule is "library functions first, MCP tools second", and the
// narration-constraint and timeline-export blocks above both invoke it.
//
// This changes no behaviour and adds no dependency. Every module below is
// ALREADY in this file's static import graph, reached through
// ./mcp-server.js -> ./register/* -> ./tools/*, so src/__tests__/
// layerBoundary.test.ts walks exactly the same file set before and after --
// nothing under src/rpg/ becomes reachable, and none of the six tool modules
// that moved up there is named here.
export * from "./tools/game.js";
export * from "./tools/world.js";
export * from "./tools/character.js";
export * from "./tools/faction.js";
export * from "./tools/relationship.js";
export * from "./tools/resource.js";
export * from "./tools/constraint.js";
export * from "./tools/inventory.js";
export * from "./tools/secrets.js";
export * from "./tools/narrative.js";
export * from "./tools/notes.js";
export * from "./tools/tags.js";
export * from "./tools/time.js";
export * from "./tools/timers.js";
export * from "./tools/rules.js";
export * from "./tools/pause.js";
export * from "./tools/display.js";
export * from "./tools/images.js";
export * from "./tools/audio.js";
export * from "./tools/image-prompt.js";

// The event emitter the tool modules above write to. A consumer's own write
// paths emit through the same singleton, so its tables and the engine's reach
// one SSE subscriber rather than two competing ones.
export { gameEvents } from "./events/emitter.js";
export type { GameEvent } from "./events/emitter.js";

// ===========================================================================
// What a consumer needs to register tools OF ITS OWN onto the core server.
//
// A client keeps its own MCP surface -- that is the whole point of the split;
// its mechanics are its own and the engine never learns their names. But a
// tool it registers should refuse, bound and annotate the way the engine's do,
// and today a client re-implements these or copies them and lets the copy
// drift. Named one by one rather than star-exported: these modules contain
// identifiers like `CREATE` and `UPDATE` that have no business in a package's
// root namespace.
export { ANNOTATIONS, withAnnotations } from "./utils/tool-annotations.js";
export { LIMITS, validatedSchemas, boundedString, boundedArray } from "./utils/validation.js";
export { createError, formatErrorResponse, errors } from "./utils/errors.js";
export type { AgentError } from "./utils/errors.js";
export { createLogger } from "./utils/logger.js";
export type { Logger } from "./utils/logger.js";
export { verbositySchema, applyVerbosity, filterFields } from "./utils/verbosity.js";
export type { VerbosityLevel } from "./utils/verbosity.js";
export { safeJsonParse, safeJsonParseOrNull } from "./utils/json.js";
export {
  successResponseSchema,
  textResultSchema,
  deletedResponseSchema,
  listResponseSchema,
  characterOutputSchema,
  characterStatusSchema,
  conditionModifyOutputSchema,
  tagModifyOutputSchema,
} from "./utils/output-schemas.js";
export { imageGenSchema, voiceSchema } from "./schemas/index.js";

export type * from "./types/index.js";
