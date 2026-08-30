// Timeline export/import (GitHub issue #8, design §6): "a client must be able
// to freeze the entire timeline -- every entity, every fact interval, every
// event -- into a file it owns. Not a live query. Not a session handle. A
// file." This file has three jobs, none optional:
//
//   1. prove exportTimeline/importTimeline round-trip real history built
//      through the real tool surface, never a hand-inserted timeline;
//   2. prove the artifact is deterministic, scoped strictly to one game, and
//      structurally carries no media reference and no live-table row; and
//   3. prove THE EXIT CRITERION -- export, re-import into a genuinely fresh
//      database, and replay(t) answers identically at every recorded
//      transition point, plus just below/above the range and between two
//      points.
//
// Fixtures use grain/treasury/population per root CLAUDE.md; this file is
// scanned by engineVocabulary.test.ts like everything else in the tree.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { getDatabase } from "../../db/connection.js";
import { replay, type Snapshot } from "../replay.js";
import { declareTimeAxis, currentStoryTime } from "../clock.js";
import {
  TIMELINE_FORMAT_VERSION,
  exportTimeline,
  importTimeline,
  exportTimelineToFile,
  importTimelineFromFile,
  type TimelineExport,
} from "../export.js";
import { createGame } from "../../tools/game.js";
import { createResource, updateResourceValue, deleteResource } from "../../tools/resource.js";

/** A trivially empty, structurally valid artifact for `gameId` -- the
 * shape every "refuses to import" test needs, minus the one thing under
 * test. */
function emptyArtifact(gameId: string): TimelineExport {
  return { formatVersion: TIMELINE_FORMAT_VERSION, gameId, clock: null, entities: [], facts: [], events: [] };
}

/** Every recorded transition point for `gameId`: the union of every
 * entity's created_at_t and non-null destroyed_at_t, every fact's
 * valid_from_t and non-null valid_to_t, and every event's at_t. Read
 * directly off the tables, deliberately not through exportTimeline (the
 * function under test), so this is an independent measurement of "how much
 * history is really there." */
function collectTransitionPoints(db: Database.Database, gameId: string): number[] {
  const points = new Set<number>();

  const entityRows = db
    .prepare(`SELECT created_at_t, destroyed_at_t FROM entities WHERE game_id = ?`)
    .all(gameId) as Array<{ created_at_t: number; destroyed_at_t: number | null }>;
  for (const row of entityRows) {
    points.add(row.created_at_t);
    if (row.destroyed_at_t !== null) points.add(row.destroyed_at_t);
  }

  const factRows = db
    .prepare(
      `SELECT f.valid_from_t, f.valid_to_t FROM facts f JOIN entities e ON e.id = f.entity_id WHERE e.game_id = ?`
    )
    .all(gameId) as Array<{ valid_from_t: number; valid_to_t: number | null }>;
  for (const row of factRows) {
    points.add(row.valid_from_t);
    if (row.valid_to_t !== null) points.add(row.valid_to_t);
  }

  const eventRows = db.prepare(`SELECT at_t FROM events WHERE game_id = ?`).all(gameId) as Array<{ at_t: number }>;
  for (const row of eventRows) points.add(row.at_t);

  return [...points].sort((a, b) => a - b);
}

describe("exportTimeline", () => {
  beforeEach(() => {
    createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("exports an empty-but-valid artifact for an unknown gameId, rather than throwing", () => {
    const artifact = exportTimeline("no-such-game");
    expect(artifact).toEqual(emptyArtifact("no-such-game"));
  });

  it("writes nothing to the database", () => {
    const db = getDatabase();
    const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });
    createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 100 });

    const before = tableCounts(db);
    exportTimeline(game.id);
    const after = tableCounts(db);

    expect(after).toEqual(before);
  });

  it("scopes strictly to gameId: exporting one of two games contains not a single row of the other", () => {
    const gameA = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });
    const gameB = createGame({ name: "second depot", setting: "a second valley", style: "grounded" });

    createResource({ gameId: gameA.id, ownerType: "game", name: "grain", value: 10 });
    const resB = createResource({ gameId: gameB.id, ownerType: "game", name: "treasury", value: 20 });
    updateResourceValue({ resourceId: resB.id, mode: "delta", value: 5 });
    expect(deleteResource(resB.id)).toBe(true);

    const artifact = exportTimeline(gameA.id);

    expect(artifact.gameId).toBe(gameA.id);
    expect(artifact.entities.every((e) => e.gameId === gameA.id)).toBe(true);
    expect(artifact.events.every((e) => e.gameId === gameA.id)).toBe(true);
    expect(artifact.entities.some((e) => e.id === resB.id)).toBe(false);
    expect(artifact.facts.some((f) => f.entityId === resB.id)).toBe(false);

    // Belt and braces: gameB's own id must not appear anywhere in the
    // serialized artifact, not just absent from the typed fields above.
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(gameB.id);
    expect(serialized).not.toContain(resB.id);
  });

  it("is deterministic: exporting the same world twice produces byte-identical JSON", () => {
    const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });
    const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 100, minValue: 0 });
    const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 500 });
    updateResourceValue({ resourceId: grain.id, mode: "delta", value: -20 });
    updateResourceValue({ resourceId: treasury.id, mode: "set", value: 600 });
    expect(deleteResource(grain.id)).toBe(true);

    const first = JSON.stringify(exportTimeline(game.id));
    const second = JSON.stringify(exportTimeline(game.id));

    expect(second).toBe(first);
  });

  it("excludes every media reference: stored_images/stored_audio rows contribute nothing to the artifact", () => {
    const db = getDatabase();
    const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });

    const somePath = "/private/tmp/run-dmcp-media-test/portrait.png";
    const otherPath = "/private/tmp/run-dmcp-media-test/clip.mp3";

    db.prepare(
      `INSERT INTO stored_images (id, game_id, entity_id, entity_type, file_path, file_size, mime_type, source, created_at)
       VALUES (?, ?, ?, 'game', ?, ?, 'image/png', 'generated', ?)`
    ).run(uuidv4(), game.id, game.id, somePath, 1234, new Date().toISOString());

    db.prepare(
      `INSERT INTO stored_audio (id, game_id, entity_id, entity_type, file_path, file_size, mime_type, source, created_at)
       VALUES (?, ?, ?, 'game', ?, ?, 'audio/mpeg', 'generated', ?)`
    ).run(uuidv4(), game.id, game.id, otherPath, 5678, new Date().toISOString());

    const artifact = exportTimeline(game.id);
    const serialized = JSON.stringify(artifact);

    expect(serialized).not.toContain("file_path");
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain(somePath);
    expect(serialized).not.toContain(otherPath);
    expect(serialized).not.toContain(".png");
    expect(serialized).not.toContain(".mp3");

    // The stored rows contributed nothing at all -- the only entity in this
    // artifact is the game itself, created by createGame, not two more for
    // the media rows.
    expect(artifact.entities).toHaveLength(1);
    expect(artifact.entities[0]?.kind).toBe("game");
  });
});

describe("importTimeline: refusals", () => {
  beforeEach(() => {
    createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("refuses an artifact whose formatVersion does not match, naming both versions", () => {
    const artifact = { ...emptyArtifact("some-game"), formatVersion: 999 };
    expect(() => importTimeline(artifact)).toThrow(/999/);
    expect(() => importTimeline(artifact)).toThrow(new RegExp(String(TIMELINE_FORMAT_VERSION)));
  });

  it("refuses a structurally invalid artifact: missing gameId", () => {
    const bad = { formatVersion: TIMELINE_FORMAT_VERSION, clock: null, entities: [], facts: [], events: [] };
    expect(() => importTimeline(bad as unknown as TimelineExport)).toThrow(/gameId/);
  });

  it("refuses a structurally invalid artifact: entities is not an array", () => {
    const bad = { ...emptyArtifact("some-game"), entities: "nope" };
    expect(() => importTimeline(bad as unknown as TimelineExport)).toThrow(/entities/);
  });

  it("refuses a structurally invalid artifact: facts is not an array", () => {
    const bad = { ...emptyArtifact("some-game"), facts: null };
    expect(() => importTimeline(bad as unknown as TimelineExport)).toThrow(/facts/);
  });

  it("refuses a structurally invalid artifact: events is missing", () => {
    const bad: Record<string, unknown> = { ...emptyArtifact("some-game") };
    delete bad.events;
    expect(() => importTimeline(bad as unknown as TimelineExport)).toThrow(/events/);
  });

  /**
   * The emptiness check above interrogates `artifact.gameId` and nothing
   * else, so it only actually guarantees "import into an empty game" while
   * every row in the artifact belongs to that game. A hand-edited or
   * hand-assembled artifact whose rows name a DIFFERENT game would sail past
   * it and land entities and events on top of a populated timeline the check
   * never looked at -- silently attaching one world's history to another,
   * which is design §14's failure on the identity axis rather than the time
   * axis. Refuse it at the door instead, naming both ids.
   */
  it("refuses an artifact whose entities name a different game than artifact.gameId", () => {
    const occupied = `occupied-${uuidv4()}`;
    declareTimeAxis({ gameId: occupied, axis: { kind: "sequence" } });

    const artifact: TimelineExport = {
      ...emptyArtifact(`innocent-${uuidv4()}`),
      entities: [
        {
          id: uuidv4(),
          gameId: occupied,
          kind: "resource",
          name: "grain",
          createdAtT: 0,
          destroyedAtT: null,
        },
      ],
    };

    expect(() => importTimeline(artifact)).toThrow(new RegExp(occupied));
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM entities").get()).toEqual({ n: 0 });
  });

  it("refuses an artifact whose events name a different game than artifact.gameId", () => {
    const other = `other-${uuidv4()}`;
    const artifact: TimelineExport = {
      ...emptyArtifact(`innocent-${uuidv4()}`),
      events: [
        { id: uuidv4(), gameId: other, atT: 0, kind: "resource.created", description: null, causes: null },
      ],
    };

    expect(() => importTimeline(artifact)).toThrow(new RegExp(other));
    expect(getDatabase().prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });

  it("refuses to import when a timeline_clock row already exists for the target game, naming the game", () => {
    const gameId = `isolated-clock-${uuidv4()}`;
    declareTimeAxis({ gameId, axis: { kind: "sequence" } });

    expect(() => importTimeline(emptyArtifact(gameId))).toThrow(new RegExp(gameId));
  });

  it("refuses to import when entities already exist for the target game, naming the game", () => {
    const db = getDatabase();
    const gameId = `isolated-entities-${uuidv4()}`;
    db.prepare(
      `INSERT INTO entities (id, game_id, kind, name, created_at_t, destroyed_at_t) VALUES (?, ?, 'resource', 'grain', 0, NULL)`
    ).run(uuidv4(), gameId);

    expect(() => importTimeline(emptyArtifact(gameId))).toThrow(new RegExp(gameId));
  });

  it("refuses to import when events already exist for the target game, naming the game", () => {
    const db = getDatabase();
    const gameId = `isolated-events-${uuidv4()}`;
    db.prepare(
      `INSERT INTO events (id, game_id, at_t, kind, description, causes) VALUES (?, ?, 0, 'test.marker', NULL, NULL)`
    ).run(uuidv4(), gameId);

    expect(() => importTimeline(emptyArtifact(gameId))).toThrow(new RegExp(gameId));
  });

  it("is a no-op that does not throw for an artifact exported from an unknown game", () => {
    const artifact = exportTimeline(`nobody-has-this-game-${uuidv4()}`);
    const result = importTimeline(artifact);
    expect(result).toEqual({ gameId: artifact.gameId, entities: 0, facts: 0, events: 0 });
  });
});

describe("round trip: specific properties survive byte-for-byte", () => {
  beforeEach(() => {
    createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("preserves the irreversible flag on a fact", () => {
    const db = getDatabase();
    const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });
    const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 100 });
    const now = currentStoryTime(game.id)?.t;
    expect(now).toBeDefined();

    // No tool surface sets `irreversible` (and the append-only guard trigger
    // blocks UPDATE from ever flipping it on an existing row) -- a fresh
    // INSERT is the only legal way to plant one, the same technique
    // checkpoint.test.ts's duplicate-fact case uses.
    db.prepare(
      `INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible) VALUES (?, ?, 'sealed', 'true', ?, NULL, 1)`
    ).run(uuidv4(), grain.id, now);

    const before = exportTimeline(game.id);
    const sealedFact = before.facts.find((f) => f.entityId === grain.id && f.key === "sealed");
    expect(sealedFact?.irreversible).toBe(true);

    destroyTestDb();
    createTestDb();
    importTimeline(before);

    const after = exportTimeline(game.id);
    expect(after).toEqual(before);
    const reimportedFact = after.facts.find((f) => f.entityId === grain.id && f.key === "sealed");
    expect(reimportedFact?.irreversible).toBe(true);
  });

  it("preserves a declared non-sequence axis and its current_t", () => {
    const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });
    createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 100 });

    const declared = declareTimeAxis({ gameId: game.id, axis: { kind: "elapsed", unit: "day" }, startAt: 100 });
    expect(declared.axis).toEqual({ kind: "elapsed", unit: "day" });

    const before = exportTimeline(game.id);
    expect(before.clock).toEqual({ currentT: 100, axisKind: "elapsed", axisUnit: "day" });

    destroyTestDb();
    createTestDb();
    importTimeline(before);

    const restored = currentStoryTime(game.id);
    expect(restored).toEqual({ gameId: game.id, t: 100, axis: { kind: "elapsed", unit: "day" } });

    const after = exportTimeline(game.id);
    expect(after).toEqual(before);
  });

  it("preserves a destroyed entity and its closed facts", () => {
    const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });
    const spoilage = createResource({ gameId: game.id, ownerType: "game", name: "spoilage", value: 3 });
    updateResourceValue({ resourceId: spoilage.id, mode: "delta", value: 1 });
    expect(deleteResource(spoilage.id)).toBe(true);

    const before = exportTimeline(game.id);
    const entity = before.entities.find((e) => e.id === spoilage.id);
    expect(entity?.destroyedAtT).not.toBeNull();

    const closedFacts = before.facts.filter((f) => f.entityId === spoilage.id);
    expect(closedFacts.length).toBeGreaterThan(0);
    expect(closedFacts.every((f) => f.validToT !== null)).toBe(true);

    destroyTestDb();
    createTestDb();
    importTimeline(before);

    const after = exportTimeline(game.id);
    expect(after).toEqual(before);
  });
});

describe("file wrappers: the artifact is a real file", () => {
  let tmpDir: string;

  beforeEach(() => {
    createTestDb();
    tmpDir = mkdtempSync(join(tmpdir(), "run-dmcp-export-"));
  });

  afterEach(() => {
    destroyTestDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exportTimelineToFile writes a real file containing valid JSON identical to the returned artifact", () => {
    const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });
    createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 100 });
    const filePath = join(tmpDir, "artifact.json");

    const returned = exportTimelineToFile({ gameId: game.id, filePath });

    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(returned);
  });

  it("importTimelineFromFile reads back what exportTimelineToFile wrote", () => {
    const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });
    const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 100 });
    updateResourceValue({ resourceId: grain.id, mode: "delta", value: -10 });
    const filePath = join(tmpDir, "artifact.json");
    const written = exportTimelineToFile({ gameId: game.id, filePath });

    destroyTestDb();
    createTestDb();

    const result = importTimelineFromFile(filePath);
    expect(result).toEqual({
      gameId: game.id,
      entities: written.entities.length,
      facts: written.facts.length,
      events: written.events.length,
    });
    expect(exportTimeline(game.id)).toEqual(written);
  });

  it("importTimelineFromFile throws a clear error for a path that does not exist", () => {
    const missingPath = join(tmpDir, "does-not-exist.json");
    expect(() => importTimelineFromFile(missingPath)).toThrow();
    expect(() => importTimelineFromFile(missingPath)).toThrow(/does-not-exist\.json/);
  });
});

describe("THE EXIT CRITERION: export, re-import into a fresh database, replay(t) matches at every recorded transition point", () => {
  it("matches at every transition point, just below the range, just above it, and between two points", () => {
    createTestDb();
    let tmpDir: string | undefined;

    try {
      const db = getDatabase();
      const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 100, minValue: 0 });
      const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 500 });
      const population = createResource({ gameId: game.id, ownerType: "game", name: "population", value: 40 });

      updateResourceValue({ resourceId: grain.id, mode: "delta", value: -20 });
      updateResourceValue({ resourceId: treasury.id, mode: "set", value: 600 });
      updateResourceValue({ resourceId: population.id, mode: "delta", value: 5 });
      updateResourceValue({ resourceId: grain.id, mode: "delta", value: 10 });

      expect(deleteResource(population.id)).toBe(true);

      const points = collectTransitionPoints(db, game.id);
      // Guard against a vacuous pass: this world creates a game (1 entity)
      // and three resources (3 more), updates values four times, and
      // destroys one entity -- there must be a real, non-trivial number of
      // distinct transition points, not zero and not one.
      expect(points.length).toBeGreaterThanOrEqual(6);

      const before: Snapshot[] = points.map((t) => replay({ gameId: game.id, t }));

      const min = Math.min(...points);
      const max = Math.max(...points);
      const belowRange = min - 0.5;
      const aboveRange = max + 0.5;
      const betweenPoints = (points[0] + points[1]) / 2;

      const beforeBelow = replay({ gameId: game.id, t: belowRange });
      const beforeAbove = replay({ gameId: game.id, t: aboveRange });
      const beforeBetween = replay({ gameId: game.id, t: betweenPoints });

      tmpDir = mkdtempSync(join(tmpdir(), "run-dmcp-exit-criterion-"));
      const filePath = join(tmpDir, "timeline.json");
      exportTimelineToFile({ gameId: game.id, filePath });

      destroyTestDb();
      createTestDb();

      importTimelineFromFile(filePath);

      const after: Snapshot[] = points.map((t) => replay({ gameId: game.id, t }));
      expect(after).toEqual(before);

      expect(replay({ gameId: game.id, t: belowRange })).toEqual(beforeBelow);
      expect(replay({ gameId: game.id, t: aboveRange })).toEqual(beforeAbove);
      expect(replay({ gameId: game.id, t: betweenPoints })).toEqual(beforeBetween);
    } finally {
      destroyTestDb();
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/** Row counts across every timeline table, for the "writes nothing" test. */
function tableCounts(db: Database.Database): Record<string, number> {
  const tables = ["entities", "facts", "events", "timeline_clock"];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return counts;
}
