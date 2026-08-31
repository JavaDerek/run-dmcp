// What a consuming application can actually reach through the package entry
// (design §8's layer table, §11 Phase 5, §12 seam 2).
//
// Phase 5 is "the client deletes its inherited files and imports them from the
// package". That is only possible for the things the package EXPORTS, and the
// core's entry point currently exports the timeline, the database, and
// `createCoreMcpServer` -- the whole assembled server, all-or-nothing -- while
// the entity/property domains §8 deliberately puts in the CORE ("factions,
// relationships-with-history, secrets, resources, locations, items... the
// client's spine. If these go up into the RPG layer, the client cannot consume
// the package without dragging the RPG layer with it") are reachable only by
// making a tool call to a server this process is also hosting.
//
// The layer ABOVE already got this right. src/rpg/index.ts ends with six
// export-stars over its own tool modules, under a comment that says it is
// using "the same shape core's index.ts uses for the timeline: a
// consumer that wants to call combat/quest/table/status/ability/dice logic
// directly, without going through an MCP tool call, can." The core never did
// the same for its own tools, so the optional layer is more consumable than
// the thing it is optional ON TOP OF. That is an oversight rather than a
// decision -- §6's rule is "library functions first, MCP tools second", and
// src/index.ts's own comments invoke it when explaining why the narration
// constraint is exported as a function before any tool wraps it.
//
// So this file is written as a CONSUMER, not as a unit test of any one module:
// it imports exclusively from `../index.js`, brings up its own table through
// the migration hook, and then drives an entire small world through library
// calls. If it can do that, a client can delete its vendored copy of the
// spine. Nothing here reaches into `../tools/*` or `../db/*` directly, and it
// must not start doing so -- an import of an internal path would make it pass
// while saying nothing about the package's surface.
//
// The world is a granary and its ledger. Neutral by construction: the
// vocabulary guard in engineVocabulary.test.ts fails on any consumer's nouns
// reaching this repository, and a fixture is the easiest place to leak one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

import {
  // The database and the schema hook (seam 2) -- already exported at 0.2.0.
  getDatabase,
  closeDatabase,
  initializeSchema,
  type SchemaMigration,

  // The spine, as library functions. None of this is exported at 0.2.0.
  createGame,
  loadGame,
  createLocation,
  listLocations,
  createFaction,
  listFactions,
  createCharacter,
  getCharacter,
  createResource,
  getResource,
  listResources,
  updateResourceValue,
  createRelationship,
  getRelationshipBetween,
  updateRelationshipValue,
  logEvent,
  getHistory,

  // What a consumer needs in order to register ITS OWN tools onto the core
  // server -- the annotations, the limits, the error envelope and the logger
  // every register/*.ts in this repository uses, which a client re-implements
  // from scratch today or copies and lets drift.
  ANNOTATIONS,
  LIMITS,
  errors,
  createError,
  formatErrorResponse,
  createLogger,
  gameEvents,

  // The timeline, to prove the spine's writes land in it through the public
  // door and not only through an internal one.
  valueHistory,
} from "../index.js";

// ---------------------------------------------------------------------------
// The consumer's own layer: one table of its own, brought up in the engine's
// startup pass, holding rows the engine knows nothing about.
// ---------------------------------------------------------------------------

const GRANARY_LEDGER: SchemaMigration = {
  name: "granary_ledger",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS granary_ledger (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        note TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );
    `);
  },
};

describe("a consuming application drives its spine through the package entry (design §8, §11 Phase 5)", () => {
  let db: Database.Database;

  // Deliberately NOT the createTestDb fixture. The fixture reaches into
  // ../connection.js and ../schema.js by internal path, which is exactly the
  // reach this file exists to prove a consumer does not need. Bringing the
  // database up out of the package's own exports IS one of the assertions, so
  // borrowing a helper that bypasses them would hollow the test out. The
  // in-memory discipline is identical (src/test-setup.ts sets DMCP_DB_PATH
  // process-wide as the net under this).
  beforeEach(() => {
    process.env.DMCP_DB_PATH = ":memory:";
    db = getDatabase();
    initializeSchema({ migrations: [GRANARY_LEDGER] });
  });

  afterEach(() => {
    closeDatabase();
  });

  it("brings up its own table in the same pass, in the same database", () => {
    const game = createGame({
      name: "The Granary",
      setting: "A store of grain and the ledger that counts it",
      style: "plain",
    });

    db.prepare(`INSERT INTO granary_ledger (id, game_id, note) VALUES (?, ?, ?)`).run(
      "ledger-1",
      game.id,
      "opening count"
    );

    const row = db.prepare(`SELECT note FROM granary_ledger WHERE game_id = ?`).get(game.id) as
      | { note: string }
      | undefined;
    expect(row?.note).toBe("opening count");
  });

  it("creates and reads back an entire world without one internal import", () => {
    const game = createGame({
      name: "The Granary",
      setting: "A store of grain and the ledger that counts it",
      style: "plain",
    });
    expect(loadGame(game.id)?.name).toBe("The Granary");

    const store = createLocation({
      gameId: game.id,
      name: "The Store",
      description: "Sacks to the rafters.",
    });
    expect(listLocations(game.id).map((l) => l.id)).toContain(store.id);

    const guild = createFaction({
      gameId: game.id,
      name: "The Millers",
      description: "They grind it.",
    });
    expect(listFactions(game.id).map((f) => f.id)).toContain(guild.id);

    const steward = createCharacter({
      gameId: game.id,
      name: "The Steward",
      isPlayer: false,
      locationId: store.id,
    });
    expect(getCharacter(steward.id)?.name).toBe("The Steward");

    logEvent({
      gameId: game.id,
      eventType: "scene",
      content: "The steward counts the sacks.",
    });
    expect(getHistory(game.id).length).toBeGreaterThan(0);
  });

  it("moves an invariant-bearing number through the exported choke point, and the timeline records it", () => {
    const game = createGame({
      name: "The Granary",
      setting: "A store of grain and the ledger that counts it",
      style: "plain",
    });

    const grain = createResource({
      gameId: game.id,
      ownerType: "game",
      name: "grain",
      value: 100,
      minValue: 0,
    });
    expect(listResources(game.id).map((r) => r.name)).toContain("grain");

    const moved = updateResourceValue({
      resourceId: grain.id,
      mode: "delta",
      value: -30,
      reason: "the winter ration",
    });
    expect(moved?.resource.value).toBe(70);
    expect(getResource(grain.id)?.value).toBe(70);

    // §5.4 option (C): the history is `facts`, assembled -- and a consumer
    // that keeps its numbers here has to be able to ask for it.
    const history = valueHistory(grain.id, "value");
    expect(history.length).toBeGreaterThan(0);
    const latest = history[history.length - 1];
    expect(latest.newValue).toBe(70);
    expect(latest.previousValue).toBe(100);
    expect(latest.reason).toBe("the winter ration");
  });

  it("relates two entities and moves the relationship's value", () => {
    const game = createGame({
      name: "The Granary",
      setting: "A store of grain and the ledger that counts it",
      style: "plain",
    });
    const guild = createFaction({ gameId: game.id, name: "The Millers" });
    const steward = createCharacter({ gameId: game.id, name: "The Steward", isPlayer: false });

    const bond = createRelationship({
      gameId: game.id,
      sourceId: steward.id,
      sourceType: "character",
      targetId: guild.id,
      targetType: "faction",
      relationshipType: "supplies",
      value: 10,
    });

    const found = getRelationshipBetween(game.id, steward.id, guild.id, "supplies");
    expect(found?.id).toBe(bond.id);

    const moved = updateRelationshipValue({
      relationshipId: bond.id,
      mode: "delta",
      value: 5,
      reason: "a fair price",
    });
    expect(moved?.relationship.value).toBe(15);
  });
});

describe("the support surface a consumer needs to register tools of its own", () => {
  it("exports the annotations every register module in this repository uses", () => {
    expect(ANNOTATIONS.READ_ONLY.readOnlyHint).toBe(true);
    expect(ANNOTATIONS.DESTRUCTIVE.destructiveHint).toBe(true);
  });

  it("exports the input limits, so a consumer's own schemas bound the same way", () => {
    expect(typeof LIMITS.NAME_MAX).toBe("number");
    expect(LIMITS.NAME_MAX).toBeGreaterThan(0);
  });

  it("exports the error envelope, so a consumer's refusals look like the engine's", () => {
    const missing = errors.gameNotFound("no-such-game");
    expect(missing.isError).toBe(true);
    expect(missing.errorCode).toBe("GAME_NOT_FOUND");

    const custom = createError("GRANARY_EMPTY", "There is no grain left.");
    const response = formatErrorResponse(custom);
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("GRANARY_EMPTY");
  });

  it("exports the logger, so a consumer's modules log to the same stream", () => {
    const log = createLogger("granary");
    expect(typeof log.info).toBe("function");
    expect(typeof log.error).toBe("function");
  });

  it("exports the event emitter, so a consumer's own writes can reach a subscriber", () => {
    expect(gameEvents.getTotalClientCount()).toBe(0);
    // No subscriber for this game: a no-op rather than a throw, which is what
    // makes it safe for a consumer to emit unconditionally from a write path.
    expect(() =>
      gameEvents.emit({
        type: "granary_counted",
        gameId: "no-such-game",
        timestamp: new Date().toISOString(),
      })
    ).not.toThrow();
  });
});
