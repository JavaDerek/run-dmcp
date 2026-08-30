// Phase 1's checkpoint (GitHub issue #4, design §11 / §13): does replay(now)
// reproduce the live projected tables, exactly, for a database with real
// history? Design §13 makes this a stop condition -- "replay(t) cannot
// reproduce current state" -- because a lossy event log invalidates
// everything built above it. So this file has two jobs, and neither is
// optional: prove the checkpoint is GREEN against real history built through
// the real tool surface (never a hand-inserted timeline or domain row), and
// prove it is capable of turning RED -- a checkpoint that cannot fail is not
// a checkpoint. Fixtures use grain/treasury/population per root CLAUDE.md;
// this file is scanned by engineVocabulary.test.ts like everything else in
// the tree.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { initializeSchema } from "../../db/schema.js";
import { closeDatabase, getDatabase } from "../../db/connection.js";
import { timelineDivergences, type Divergence } from "../checkpoint.js";
import { PROJECTED_TABLES } from "../projection.js";
import { ENTITY_KINDS } from "../kinds.js";
import { currentStoryTime } from "../clock.js";
import { createGame, updateGame, updateGameLocation } from "../../tools/game.js";
import { createCharacter, updateCharacter, moveCharacter, deleteCharacter } from "../../tools/character.js";
import { createLocation, updateLocation, deleteLocation } from "../../tools/world.js";
import { createItem, updateItem, transferItem, deleteItem } from "../../tools/inventory.js";
import { createResource, updateResource, updateResourceValue, deleteResource } from "../../tools/resource.js";
import { createRelationship, updateRelationship, modifyRelationship } from "../../tools/relationship.js";
import { createFaction, updateFaction, addFactionGoal, addFactionTrait } from "../../tools/faction.js";
import { createSecret, updateSecret, modifySecretVisibility } from "../../tools/secrets.js";

/** Renders divergence rows into a readable failure message -- so a red
 * checkpoint is diagnosable from the test output alone, with no debugger. */
function describeDivergences(divergences: Divergence[]): string {
  if (divergences.length === 0) return "no divergences";
  return divergences
    .map((d) => {
      const parts = [`${d.reason} ${d.table}/${d.kind} entity=${d.entityId}`];
      if (d.key !== undefined) parts.push(`key=${d.key}`);
      if (d.live !== undefined) parts.push(`live=${JSON.stringify(d.live)}`);
      if (d.replayed !== undefined) parts.push(`replayed=${JSON.stringify(d.replayed)}`);
      return parts.join(" ");
    })
    .join("\n");
}

/** Live row count across every projected table for `gameId`, and the set of
 * kinds represented -- the "not vacuous" measurements bullet 3 of the issue
 * asks for. Reads the live tables directly, deliberately not through
 * `timelineDivergences` -- the checkpoint itself returns rows, never a
 * count (hard rule 2), so a floor on "how much was compared" has to come
 * from the same live tables the checkpoint reads, counted independently. */
function liveRowStats(db: Database.Database, gameId: string): { totalRows: number; kinds: Set<string> } {
  let totalRows = 0;
  const kinds = new Set<string>();
  for (const row of PROJECTED_TABLES) {
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${row.table} WHERE ${row.gameIdColumn} = ?`).get(gameId) as {
        n: number;
      }
    ).n;
    totalRows += count;
    if (count > 0) kinds.add(row.kind);
  }
  return { totalRows, kinds };
}

/** Count of facts belonging to this game's entities, open or closed --
 * every one of them is a comparison the checkpoint's per-column loop had to
 * perform (via replay()) to reach a clean result. */
function factCount(db: Database.Database, gameId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM facts f JOIN entities e ON e.id = f.entity_id WHERE e.game_id = ?`
      )
      .get(gameId) as { n: number }
  ).n;
}

/**
 * Drives a substantial run through the real tool surface, touching every
 * projected kind (games, characters, locations, items, resources,
 * relationships, factions, secrets) and every operation shape named in the
 * issue: create, update, move a character, transfer an item, change a
 * resource's value through updateResourceValue, modify a relationship,
 * add faction goals and traits, change a secret's visibility, set the
 * game's current location, and delete a character/item/resource.
 *
 * Never a hand-inserted timeline row, and never a hand-inserted domain row
 * either -- the entire point of the checkpoint is to prove real write paths
 * append correctly, which a hand-inserted row could never demonstrate.
 *
 * The three entities deleted at the end are created just for that purpose
 * and touch nothing else, so one delete's consequences can never be
 * mistaken for another's.
 */
function buildRichHistory(): { gameId: string } {
  const game = createGame({ name: "grain depot", setting: "a farming valley", style: "grounded" });

  const silo = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });
  const post = createLocation({ gameId: game.id, name: "trade post", description: "a dusty crossroads stall" });
  const storehouse = createLocation({ gameId: game.id, name: "storehouse", description: "a stone storehouse" });

  const keeper = createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false, locationId: silo.id });
  const scout = createCharacter({ gameId: game.id, name: "grain scout", isPlayer: true, locationId: post.id });
  const guard = createCharacter({ gameId: game.id, name: "caravan guard", isPlayer: false, locationId: post.id });

  const sack = createItem({ gameId: game.id, ownerId: silo.id, ownerType: "location", name: "sack of grain" });
  const ledger = createItem({ gameId: game.id, ownerId: keeper.id, ownerType: "character", name: "trade ledger" });

  const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 100, minValue: 0 });
  const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 500 });
  const population = createResource({ gameId: game.id, ownerType: "game", name: "population", value: 40 });

  const kinship = createRelationship({
    gameId: game.id,
    sourceId: guard.id,
    sourceType: "character",
    targetId: keeper.id,
    targetType: "character",
    relationshipType: "reports_to",
    value: 10,
  });

  const guild = createFaction({ gameId: game.id, name: "grain guild", description: "the local trade guild" });

  const secret = createSecret({
    gameId: game.id,
    name: "the silo's true owner",
    description: "the deed is forged",
  });

  // Updates -- at least one per projected table, exercising the five-case
  // column table issue #2 already covers in isolation; here the point is
  // only that real history includes them, mixed with everything else.
  updateGame(game.id, { setting: "a farming valley, after the drought" });
  updateCharacter(keeper.id, { notes: "counts every sack twice" });
  updateLocation(silo.id, { description: "a tall silo, freshly whitewashed" });
  updateItem(ledger.id, { name: "worn trade ledger" });
  updateResource(grain.id, { description: "threshed and bagged" });
  updateRelationship(kinship.id, { notes: "owes the keeper a debt" });
  updateFaction(guild.id, { description: "the local trade guild, now larger" });
  updateSecret(secret.id, { description: "the deed is forged, badly" });

  // The operation shapes the issue names explicitly.
  moveCharacter(guard.id, silo.id);
  transferItem(sack.id, guard.id, "character");
  updateResourceValue({ resourceId: grain.id, mode: "delta", value: -20 });
  updateResourceValue({ resourceId: treasury.id, mode: "set", value: 600 });
  updateResourceValue({ resourceId: population.id, mode: "delta", value: 5 });
  modifyRelationship({ relationshipId: kinship.id, delta: 5 });
  addFactionGoal(guild.id, "corner the grain market");
  addFactionTrait(guild.id, "cutthroat");
  modifySecretVisibility(secret.id, { revealTo: [scout.id], makePublic: false });
  updateGameLocation(game.id, silo.id);

  // Deletions -- throwaway entities, connected to nothing else, so each
  // delete's consequences are exactly its own.
  const retiredScout = createCharacter({ gameId: game.id, name: "retired scout", isPlayer: false });
  const emptyCrate = createItem({ gameId: game.id, ownerId: storehouse.id, ownerType: "location", name: "empty crate" });
  const spoilage = createResource({ gameId: game.id, ownerType: "game", name: "spoilage", value: 3 });

  deleteCharacter(retiredScout.id);
  deleteItem(emptyCrate.id);
  deleteResource(spoilage.id);

  return { gameId: game.id };
}

describe("checkpoint: replay(now) reproduces the live projected tables", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("is empty against real history driven through every tool and every operation shape", () => {
    const { gameId } = buildRichHistory();

    const divergences = timelineDivergences(gameId);
    expect(divergences, describeDivergences(divergences)).toEqual([]);
  });

  it("is not vacuous: real rows, real facts, and every one of the eight kinds were actually compared", () => {
    const { gameId } = buildRichHistory();

    // Establish the gate is green first -- the floors below are only
    // meaningful evidence of a real comparison if the comparison itself
    // passed.
    expect(timelineDivergences(gameId)).toEqual([]);

    const { totalRows, kinds } = liveRowStats(db, gameId);
    expect(totalRows, "expected a substantial number of live rows to have been compared").toBeGreaterThanOrEqual(15);
    expect(kinds.size, "expected every projected kind to be represented among the live rows").toBe(
      ENTITY_KINDS.length
    );
    expect([...kinds].sort()).toEqual([...ENTITY_KINDS].sort());

    const facts = factCount(db, gameId);
    expect(facts, "expected a substantial number of facts to have been compared").toBeGreaterThanOrEqual(40);
  });
});

describe("checkpoint: it can go red -- each of the four divergence reasons, planted and watched", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("value: dropping timeline_characters_au, then updating through the real tool, diverges the touched column -- and reconciliation repairs it", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const keeper = createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false });
    expect(timelineDivergences(game.id)).toEqual([]);

    // Remove the trigger that would have closed the old 'name' fact and
    // opened a new one, then write through the real tool exactly as any
    // caller would -- updateCharacter has no idea the trigger is gone.
    db.exec(`DROP TRIGGER IF EXISTS timeline_characters_au`);
    updateCharacter(keeper.id, { name: "grain warden" });

    const divergences = timelineDivergences(game.id);
    const found = divergences.find((d) => d.reason === "value" && d.entityId === keeper.id && d.key === "name");
    expect(found, describeDivergences(divergences)).toBeDefined();
    expect(found?.table).toBe("characters");
    expect(found?.kind).toBe("character");
    expect(found?.live).toBe("grain warden");
    expect(found?.replayed).toBe("treasury keeper");

    // Reconciliation closes the stale open fact (its value no longer
    // matches the live column) and opens a new one at the live value --
    // the same close-then-open shape the AFTER UPDATE trigger itself uses,
    // just driven by a table scan instead of NEW (projection.ts).
    initializeSchema();
    const after = timelineDivergences(game.id);
    expect(
      after.find((d) => d.reason === "value" && d.entityId === keeper.id && d.key === "name"),
      describeDivergences(after)
    ).toBeUndefined();
  });

  it("missing-entity: dropping timeline_items_ai, then creating through the real tool, leaves a live row with no entity -- and reconciliation repairs it", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const silo = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });

    db.exec(`DROP TRIGGER IF EXISTS timeline_items_ai`);
    const sack = createItem({ gameId: game.id, ownerId: silo.id, ownerType: "location", name: "sack of grain" });

    const divergences = timelineDivergences(game.id);
    const found = divergences.find((d) => d.reason === "missing-entity" && d.entityId === sack.id);
    expect(found, describeDivergences(divergences)).toBeDefined();
    expect(found?.table).toBe("items");
    expect(found?.kind).toBe("item");

    // Reconciliation backfills the missing entity and its facts (issue #2's
    // "predates the timeline" case, which this scenario is indistinguishable
    // from: a live row with no entity at all).
    initializeSchema();
    const after = timelineDivergences(game.id);
    expect(
      after.find((d) => d.reason === "missing-entity" && d.entityId === sack.id),
      describeDivergences(after)
    ).toBeUndefined();
  });

  it("missing-row: dropping timeline_locations_ad, then deleting through the real tool, leaves an entity alive with no live row", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const silo = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });
    expect(timelineDivergences(game.id)).toEqual([]);

    db.exec(`DROP TRIGGER IF EXISTS timeline_locations_ad`);
    expect(deleteLocation(silo.id)).toBe(true);

    const divergences = timelineDivergences(game.id);
    const found = divergences.find((d) => d.reason === "missing-row" && d.entityId === silo.id);
    expect(found, describeDivergences(divergences)).toBeDefined();
    expect(found?.table).toBe("locations");
    expect(found?.kind).toBe("location");

    // NOT asserted to be repaired by initializeSchema(): reconcileTimeline()
    // only ever adds an entity/fact for a live row that lacks one (issue #2:
    // "a database that predates the timeline" or "a column added by
    // ALTER") -- it has no step that marks an entity destroyed because its
    // live row disappeared. Doing so would mean fabricating a destroy time
    // reconciliation cannot know (it "runs only at init ... so it can never
    // paper over a lossy log", per projection.ts's own doc comment on
    // reconcileTimeline). So this specific divergence is expected to
    // persist across a reconciliation -- which is itself worth asserting,
    // not just leaving unchecked, since it is the one case in this file
    // where "reconciliation fixes it" would be the wrong claim.
    initializeSchema();
    const after = timelineDivergences(game.id);
    expect(
      after.find((d) => d.reason === "missing-row" && d.entityId === silo.id),
      "expected the missing-row divergence to persist -- reconciliation does not (and per its own doc comment, must not) fabricate a destroy time for a live row that vanished without its delete trigger firing"
    ).toBeDefined();
  });

  it("duplicate-fact: inserting a second open fact for an existing (entity_id, key) directly is visible to the checkpoint even though replay() would silently collapse it", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 500 });
    expect(timelineDivergences(game.id)).toEqual([]);

    const now = currentStoryTime(game.id)?.t;
    expect(now).toBeDefined();

    // Plain INSERT is permitted by the append-only guards (only UPDATE and
    // DELETE are blocked -- schema.ts), so this needs no trigger removed at
    // all: it is a legal write that simply should never happen.
    db.prepare(
      `INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible) VALUES (?, ?, 'value', ?, ?, NULL, 0)`
    ).run(uuidv4(), treasury.id, "999", now);

    const divergences = timelineDivergences(game.id);
    const found = divergences.find(
      (d) => d.reason === "duplicate-fact" && d.entityId === treasury.id && d.key === "value"
    );
    expect(found, describeDivergences(divergences)).toBeDefined();
    expect(found?.table).toBe("resources");
    expect(found?.kind).toBe("resource");
  });
});

describe("checkpoint: across a restart, on a real file", () => {
  it("timelineDivergences is still empty after closing and reopening the database", () => {
    // An in-memory database can never show a restart bug -- there is
    // nothing to close and reopen. This is the one test in the file that
    // deliberately does not use createTestDb()/destroyTestDb(); it manages
    // its own file-backed database end to end and must leave the shared
    // safety net (src/test-setup.ts's process-wide DMCP_DB_PATH=":memory:")
    // exactly as it found it, even if an assertion below throws.
    closeDatabase();
    const tmpDir = mkdtempSync(join(tmpdir(), "run-dmcp-checkpoint-"));
    // Assert the resolved path is under os.tmpdir() BEFORE writing anything
    // to it -- this test creates a real file on disk, and that must never
    // be able to land anywhere else.
    expect(tmpDir.startsWith(tmpdir())).toBe(true);
    const dbPath = join(tmpDir, "games.db");

    let gameId: string | undefined;
    try {
      process.env.DMCP_DB_PATH = dbPath;
      getDatabase();
      initializeSchema();

      gameId = buildRichHistory().gameId;
      expect(timelineDivergences(gameId)).toEqual([]);

      closeDatabase();

      // Reopen against the same file, exactly as a fresh process would.
      process.env.DMCP_DB_PATH = dbPath;
      getDatabase();
      initializeSchema();

      const divergences = timelineDivergences(gameId);
      expect(divergences, describeDivergences(divergences)).toEqual([]);
    } finally {
      closeDatabase();
      process.env.DMCP_DB_PATH = ":memory:";
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
