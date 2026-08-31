import { readFileSync, writeFileSync } from "node:fs";
import { getDatabase, withTransaction } from "../db/connection.js";
import type { T } from "./t.js";
import type { EntityKind } from "./kinds.js";

/**
 * Timeline export/import (GitHub issue #8, design §6): "a client must be
 * able to freeze the entire timeline -- every entity, every fact interval,
 * every event -- into a file it owns. Not a live query. Not a session
 * handle. A file." This module is the library half of that; an MCP tool
 * wrapper (if one is ever added) belongs elsewhere, over these two
 * functions, per §6's "library functions first, MCP tools second."
 *
 * WHAT IS IN THE ARTIFACT: `entities`, `facts` (every column, including
 * `irreversible`), `events`, and the game's `timeline_clock` row (its
 * declared axis and `current_t`). Nothing else.
 *
 * WHAT IS DELIBERATELY NOT IN IT -- and this is a requirement, not an
 * omission:
 *
 * No media references of any kind. A `file_path` in a frozen artifact
 * cannot satisfy the re-import-and-replay exit criterion: the path names a
 * file on the exporting machine, the importing machine has no such file,
 * and `replay(t)` would then differ between the two even though the export
 * claimed they were identical. `file_path` lives only in `stored_images`
 * and `stored_audio` (see `src/db/schema.ts`); neither table appears in
 * `PROJECTED_TABLES` (`./projection.ts`), so no fact -- and therefore
 * nothing this module reads -- can ever carry one. That is verified, not
 * assumed: `src/timeline/__tests__/export.test.ts` creates a stored-image
 * and stored-audio row for the game under test and asserts the exported
 * artifact contains no `file_path` anywhere and that those rows
 * contributed nothing (not even an extra entity).
 *
 * DECISION(#18): the frozen artifact carries no per-principal projection.
 *
 * No visibility filtering either, and the same "requirement, not omission"
 * applies (issue #18): the artifact is the omniscient timeline. Whether a
 * per-principal export should exist is not a small question deferred for
 * tidiness -- it decides whether §6's "one file a deterministic consumer
 * depends on" becomes N files plus a rule for choosing between them. That
 * is a decision for the caller that first needs it to own, and it cannot be
 * made well against no caller, so it is not made here.
 *
 * No live tables either. The live projected tables (`games`, `characters`,
 * `resources`, ...) are a projection of the timeline, not a second source
 * of truth (design §5.4's decided destination) -- a file carrying both
 * would contain two answers to the same question. After `importTimeline`
 * runs, the target database has a timeline and no live rows for the
 * imported game, and that is correct: `replay(t)` reads only the timeline,
 * which is exactly what the exit criterion measures. A caller that wants
 * live rows back would need a separate, as-yet-unbuilt step that replays
 * the timeline forward through the projection triggers -- not this
 * module's job, and not attempted here.
 *
 * TYPES: `facts.irreversible` is stored in SQLite as the INTEGER 0/1 this
 * codebase's triggers write (`projection.ts`). This module converts it to
 * a real `boolean` on the way out (`Boolean(row.irreversible)`) and back to
 * 0/1 on the way in, consistently in both directions -- the artifact itself
 * never carries the raw integer.
 *
 * DETERMINISM: every array below is sorted by a total order that can never
 * tie, because every one of them ends in the row's own primary key, which
 * SQLite guarantees is unique: entities by `(created_at_t, id)`, facts by
 * `(valid_from_t, entity_id, key, id)`, events by `(at_t, id)`. Exporting
 * the same world twice therefore produces byte-identical
 * `JSON.stringify` output -- see the determinism test in
 * `export.test.ts`.
 */
export const TIMELINE_FORMAT_VERSION = 1;

export interface TimelineExportEntity {
  id: string;
  gameId: string;
  kind: EntityKind;
  name: string | null;
  createdAtT: T;
  destroyedAtT: T | null;
}

export interface TimelineExportFact {
  id: string;
  entityId: string;
  key: string;
  value: string;
  validFromT: T;
  validToT: T | null;
  irreversible: boolean;
}

export interface TimelineExportEvent {
  id: string;
  gameId: string;
  atT: T;
  kind: string;
  description: string | null;
  causes: string | null;
}

export interface TimelineExportClock {
  currentT: T;
  axisKind: "sequence" | "elapsed" | "counter";
  axisUnit: string;
}

/** The frozen artifact itself -- design §6's "a file it owns." */
export interface TimelineExport {
  formatVersion: number;
  gameId: string;
  clock: TimelineExportClock | null;
  entities: TimelineExportEntity[];
  facts: TimelineExportFact[];
  events: TimelineExportEvent[];
}

/** What `importTimeline` restored, for a caller that wants to report it. */
export interface TimelineImportResult {
  gameId: string;
  entities: number;
  facts: number;
  events: number;
}

interface EntityRow {
  id: string;
  game_id: string;
  kind: EntityKind;
  name: string | null;
  created_at_t: number;
  destroyed_at_t: number | null;
}

interface FactRow {
  id: string;
  entity_id: string;
  key: string;
  value: string;
  valid_from_t: number;
  valid_to_t: number | null;
  irreversible: number;
}

interface EventRow {
  id: string;
  game_id: string;
  at_t: number;
  kind: string;
  description: string | null;
  causes: string | null;
}

interface ClockRow {
  current_t: number;
  axis_kind: "sequence" | "elapsed" | "counter";
  axis_unit: string;
}

/**
 * Freezes one game's entire timeline into a plain, serializable object.
 * Reads only -- see the module doc comment above for what is deliberately
 * excluded and why.
 *
 * An unknown `gameId` (nothing has ever been declared or written for it)
 * exports an empty-but-valid artifact -- `clock: null`, three empty arrays
 * -- rather than throwing. This falls out of the queries below with no
 * special-casing: each one simply returns zero rows for a `gameId` nothing
 * matches.
 *
 * The four reads are wrapped in one transaction even though nothing here
 * writes. A frozen artifact whose halves came from different moments is not
 * frozen: without this, a write landing between the entity query and the
 * fact query would export an entity with facts that postdate it, or facts
 * whose entity is missing -- and `replay(t)` over the re-imported result
 * would then disagree with the original at exactly the `t` nobody thought to
 * check. SQLite holds one consistent read view for the life of a
 * transaction, which is the cheapest way to make the artifact a snapshot of
 * a single instant rather than of four consecutive ones.
 */
export function exportTimeline(gameId: string): TimelineExport {
  return withTransaction(() => readTimeline(gameId));
}

function readTimeline(gameId: string): TimelineExport {
  const db = getDatabase();

  const clockRow = db
    .prepare(`SELECT current_t, axis_kind, axis_unit FROM timeline_clock WHERE game_id = ?`)
    .get(gameId) as ClockRow | undefined;

  const entityRows = db
    .prepare(
      `SELECT id, game_id, kind, name, created_at_t, destroyed_at_t
       FROM entities
       WHERE game_id = ?
       ORDER BY created_at_t, id`
    )
    .all(gameId) as EntityRow[];

  // Facts have no game_id column of their own (design §5.1's schema) --
  // scoped by joining back to entities, exactly the way replay.ts scopes
  // "what was true of them" to "who was alive."
  const factRows = db
    .prepare(
      `SELECT f.id, f.entity_id, f.key, f.value, f.valid_from_t, f.valid_to_t, f.irreversible
       FROM facts f
       JOIN entities e ON e.id = f.entity_id
       WHERE e.game_id = ?
       ORDER BY f.valid_from_t, f.entity_id, f.key, f.id`
    )
    .all(gameId) as FactRow[];

  const eventRows = db
    .prepare(
      `SELECT id, game_id, at_t, kind, description, causes
       FROM events
       WHERE game_id = ?
       ORDER BY at_t, id`
    )
    .all(gameId) as EventRow[];

  return {
    formatVersion: TIMELINE_FORMAT_VERSION,
    gameId,
    clock: clockRow
      ? { currentT: clockRow.current_t, axisKind: clockRow.axis_kind, axisUnit: clockRow.axis_unit }
      : null,
    entities: entityRows.map((row) => ({
      id: row.id,
      gameId: row.game_id,
      kind: row.kind,
      name: row.name,
      createdAtT: row.created_at_t,
      destroyedAtT: row.destroyed_at_t,
    })),
    facts: factRows.map((row) => ({
      id: row.id,
      entityId: row.entity_id,
      key: row.key,
      value: row.value,
      validFromT: row.valid_from_t,
      validToT: row.valid_to_t,
      irreversible: Boolean(row.irreversible),
    })),
    events: eventRows.map((row) => ({
      id: row.id,
      gameId: row.game_id,
      atT: row.at_t,
      kind: row.kind,
      description: row.description,
      causes: row.causes,
    })),
  };
}

/**
 * Throws with a clear, specific message unless `artifact` has the shape
 * `TimelineExport` requires. Nothing here coerces -- a wrong type is a
 * refusal, never a silent cast, per the issue's own instruction not to
 * "silently coerce anything."
 */
function assertValidArtifactShape(artifact: unknown): asserts artifact is TimelineExport {
  if (typeof artifact !== "object" || artifact === null) {
    throw new Error("timeline import: artifact must be an object, got " + typeof artifact);
  }
  const a = artifact as Record<string, unknown>;

  if (typeof a.gameId !== "string" || a.gameId.length === 0) {
    throw new Error("timeline import: artifact is missing a non-empty string gameId");
  }
  if (typeof a.formatVersion !== "number") {
    throw new Error("timeline import: artifact is missing a numeric formatVersion");
  }
  if (!Array.isArray(a.entities)) {
    throw new Error(`timeline import: artifact.entities must be an array for game '${a.gameId}'`);
  }
  if (!Array.isArray(a.facts)) {
    throw new Error(`timeline import: artifact.facts must be an array for game '${a.gameId}'`);
  }
  if (!Array.isArray(a.events)) {
    throw new Error(`timeline import: artifact.events must be an array for game '${a.gameId}'`);
  }
}

/**
 * Refuses, naming both ids, if any row in the artifact belongs to a game
 * other than `artifact.gameId`.
 *
 * This is what makes `assertTargetIsEmpty` below mean what it says. That
 * check interrogates `artifact.gameId` and nothing else, so on its own it
 * only guarantees "import into an empty game" for artifacts whose rows all
 * belong to that game. A hand-edited or hand-assembled one naming a
 * different game in its rows would pass the emptiness check for the innocent
 * id and then land entities and events on top of a populated timeline that
 * was never examined -- attaching one world's history to another, silently,
 * which is design §14's failure moved off the time axis and onto the
 * identity axis. `exportTimeline` can never produce such an artifact; a text
 * file a human can open trivially can, which is the whole point of §6.
 *
 * `facts` are not checked here because they carry no `gameId` of their own
 * (design §5.1) -- their game is whichever entity they point at, and
 * `facts.entity_id` is a real foreign key, so a fact can only ever reach a
 * game through an entity this function has already vouched for.
 */
function assertRowsBelongToGame(artifact: TimelineExport): void {
  for (const entity of artifact.entities) {
    if (entity.gameId !== artifact.gameId) {
      throw new Error(
        `timeline import: artifact declares game '${artifact.gameId}' but entity '${entity.id}' belongs to ` +
          `game '${entity.gameId}'. Refusing to import an artifact whose rows do not all belong to the game ` +
          `it names -- importing it would attach one world's history to another.`
      );
    }
  }

  for (const event of artifact.events) {
    if (event.gameId !== artifact.gameId) {
      throw new Error(
        `timeline import: artifact declares game '${artifact.gameId}' but event '${event.id}' belongs to ` +
          `game '${event.gameId}'. Refusing to import an artifact whose rows do not all belong to the game ` +
          `it names -- importing it would attach one world's history to another.`
      );
    }
  }
}

/**
 * Refuses, naming what was found, if `gameId` already has any recorded
 * history in this database. Checked as three independent conditions
 * (`timeline_clock`, `entities`, `events`) because any one of them alone is
 * evidence this game's timeline is not empty, and merging two timelines
 * would interleave two worlds' `t` with no way to tell them apart
 * afterward -- the whole reason import refuses rather than merges.
 */
function assertTargetIsEmpty(gameId: string): void {
  const db = getDatabase();

  const existingClock = db.prepare(`SELECT 1 FROM timeline_clock WHERE game_id = ?`).get(gameId);
  if (existingClock) {
    throw new Error(
      `timeline import: refusing to import into game '${gameId}' -- a timeline_clock row already exists for ` +
        `it. Importing would merge two timelines' t with no way to tell them apart afterward; import into an ` +
        `empty game, never an existing one.`
    );
  }

  const existingEntity = db.prepare(`SELECT 1 FROM entities WHERE game_id = ? LIMIT 1`).get(gameId);
  if (existingEntity) {
    throw new Error(
      `timeline import: refusing to import into game '${gameId}' -- entities already exist for it. Importing ` +
        `would merge two timelines' t with no way to tell them apart afterward; import into an empty game, ` +
        `never an existing one.`
    );
  }

  const existingEvent = db.prepare(`SELECT 1 FROM events WHERE game_id = ? LIMIT 1`).get(gameId);
  if (existingEvent) {
    throw new Error(
      `timeline import: refusing to import into game '${gameId}' -- events already exist for it. Importing ` +
        `would merge two timelines' t with no way to tell them apart afterward; import into an empty game, ` +
        `never an existing one.`
    );
  }
}

/**
 * Restores a frozen artifact into this database, verbatim. Everything runs
 * inside one `withTransaction()` -- a partial import is worse than none
 * (root CLAUDE.md's first inherited gotcha: `withTransaction()` was dead
 * code until it was wired; this is exactly the kind of multi-table write it
 * exists for).
 *
 * Nothing here is re-derived or re-numbered: ids, every `t` value, and the
 * `irreversible` flag are carried through byte-for-byte. An import that
 * renumbered `t` would be design §14's silent-attachment failure with the
 * engine itself as the culprit.
 *
 * The `timeline_clock` row is restored by a direct INSERT, never through
 * `declareTimeAxis` (`./clock.ts`) -- import is restoring recorded history,
 * not declaring an axis. `declareTimeAxis` enforces "`t` never runs
 * backwards" and refuses to change an already-declared axis, both of which
 * are the right rules for a *live* game choosing its axis going forward,
 * and the wrong rules for replacing an empty clock row with one that
 * already has a history behind it -- `declareTimeAxis` has no path that
 * starts a `counter` or `elapsed` axis already sitting at a nonzero
 * `current_t` with a history of facts/events that predate it, which is
 * exactly what a restored artifact is. `declared_at` (bookkeeping about
 * when the axis was chosen, not part of the frozen timeline data per the
 * artifact shape above) is stamped fresh at import time; it was never
 * exported and never round-trips.
 *
 * `entities` are inserted before `facts` because `facts.entity_id` is a
 * real foreign key and this database runs with `PRAGMA foreign_keys = ON`
 * (`../db/connection.ts`) -- inserting out of order would fail loudly
 * rather than silently, but there is no reason to invite the failure.
 */
export function importTimeline(artifact: TimelineExport): TimelineImportResult {
  assertValidArtifactShape(artifact);

  if (artifact.formatVersion !== TIMELINE_FORMAT_VERSION) {
    throw new Error(
      `timeline import: artifact has formatVersion ${artifact.formatVersion}, but this build of run-dmcp reads ` +
        `and writes formatVersion ${TIMELINE_FORMAT_VERSION}. Refusing to import rather than guess at a ` +
        `translation between versions.`
    );
  }

  assertRowsBelongToGame(artifact);

  return withTransaction(() => {
    const db = getDatabase();

    assertTargetIsEmpty(artifact.gameId);

    if (artifact.clock) {
      db.prepare(
        `INSERT INTO timeline_clock (game_id, current_t, axis_kind, axis_unit, declared_at) VALUES (?, ?, ?, ?, ?)`
      ).run(
        artifact.gameId,
        artifact.clock.currentT,
        artifact.clock.axisKind,
        artifact.clock.axisUnit,
        new Date().toISOString()
      );
    }

    const insertEntity = db.prepare(
      `INSERT INTO entities (id, game_id, kind, name, created_at_t, destroyed_at_t) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const entity of artifact.entities) {
      insertEntity.run(entity.id, entity.gameId, entity.kind, entity.name, entity.createdAtT, entity.destroyedAtT);
    }

    const insertFact = db.prepare(
      `INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const fact of artifact.facts) {
      insertFact.run(
        fact.id,
        fact.entityId,
        fact.key,
        fact.value,
        fact.validFromT,
        fact.validToT,
        fact.irreversible ? 1 : 0
      );
    }

    const insertEvent = db.prepare(
      `INSERT INTO events (id, game_id, at_t, kind, description, causes) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const event of artifact.events) {
      insertEvent.run(event.id, event.gameId, event.atT, event.kind, event.description, event.causes);
    }

    return {
      gameId: artifact.gameId,
      entities: artifact.entities.length,
      facts: artifact.facts.length,
      events: artifact.events.length,
    };
  });
}

/**
 * Thin file wrapper -- the whole point of design §6 is that the artifact is
 * a FILE, not a live query or a session handle. Nothing clever: plain
 * `JSON.stringify(artifact, null, 2)` via `node:fs`.
 */
export function exportTimelineToFile(params: { gameId: string; filePath: string }): TimelineExport {
  const artifact = exportTimeline(params.gameId);
  writeFileSync(params.filePath, JSON.stringify(artifact, null, 2));
  return artifact;
}

/**
 * Thin file wrapper for the other direction. Reads and parses are each
 * wrapped so a caller gets a message naming the path, rather than a bare
 * `ENOENT` or `SyntaxError` with no context about which import failed.
 */
export function importTimelineFromFile(filePath: string): TimelineImportResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(
      `timeline import: could not read export file at '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let artifact: unknown;
  try {
    artifact = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `timeline import: export file at '${filePath}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return importTimeline(artifact as TimelineExport);
}
