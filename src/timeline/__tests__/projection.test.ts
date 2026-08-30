// Projection trigger tests (GitHub issue #2). Every write of world state
// also appends to the timeline, inside the same transaction as the state
// write, because SQLite runs a trigger inside the firing statement's
// transaction. Every test here drives the REAL tool surface
// (src/tools/*.ts) -- never a hand-inserted timeline row -- because the
// issue's whole point is that real write paths append without being told
// to. Fixtures use grain/treasury/population per root CLAUDE.md; this file
// is scanned by engineVocabulary.test.ts like everything else in the tree.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { initializeSchema } from "../../db/schema.js";
import { withTransaction } from "../../db/connection.js";
import { PROJECTED_TABLES } from "../projection.js";
import { createGame, deleteGame } from "../../tools/game.js";
import { createCharacter, updateCharacter, deleteCharacter } from "../../tools/character.js";
import { createLocation, updateLocation } from "../../tools/world.js";
import { createItem, deleteItem } from "../../tools/inventory.js";
import { createResource, updateResource, updateResourceValue } from "../../tools/resource.js";
import { createRelationship } from "../../tools/relationship.js";
import { createFaction } from "../../tools/faction.js";
import { createSecret } from "../../tools/secrets.js";

interface EntityRow {
  id: string;
  game_id: string;
  kind: string;
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

/** The live column list for `table`, excluding `id` -- same generation
 * strategy the implementation uses (pragma_table_info), so these tests stay
 * correct automatically when a column is added rather than carrying a
 * second hand-written field list that can drift from the real one. */
function liveColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
    .map((r) => r.name)
    .filter((name) => name !== "id");
}

function getEntity(db: Database.Database, id: string): EntityRow | undefined {
  return db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as EntityRow | undefined;
}

function openFactsFor(db: Database.Database, entityId: string): FactRow[] {
  return db
    .prepare(`SELECT * FROM facts WHERE entity_id = ? AND valid_to_t IS NULL`)
    .all(entityId) as FactRow[];
}

function allFactsFor(db: Database.Database, entityId: string): FactRow[] {
  return db.prepare(`SELECT * FROM facts WHERE entity_id = ?`).all(entityId) as FactRow[];
}

function factsForKey(db: Database.Database, entityId: string, key: string): FactRow[] {
  return db
    .prepare(`SELECT * FROM facts WHERE entity_id = ? AND key = ? ORDER BY id`)
    .all(entityId, key) as FactRow[];
}

function openFactForKey(db: Database.Database, entityId: string, key: string): FactRow | undefined {
  return db
    .prepare(`SELECT * FROM facts WHERE entity_id = ? AND key = ? AND valid_to_t IS NULL`)
    .get(entityId, key) as FactRow | undefined;
}

function eventsOfKind(db: Database.Database, gameId: string, kind: string): EventRow[] {
  return db
    .prepare(`SELECT * FROM events WHERE game_id = ? AND kind = ?`)
    .all(gameId, kind) as EventRow[];
}

/**
 * Asserts a single column's projection matches the live row, comparing
 * entirely in SQL (both sides pass through `CAST(... AS TEXT)`) so a
 * JS-vs-SQLite numeric coercion mismatch can never manufacture a false
 * divergence -- the same trap the trigger SQL itself is written to avoid.
 */
function assertColumnProjected(
  db: Database.Database,
  table: string,
  rowId: string,
  entityId: string,
  col: string
): void {
  const live = db.prepare(`SELECT CAST(${col} AS TEXT) AS v FROM ${table} WHERE id = ?`).get(rowId) as {
    v: string | null;
  };
  const fact = openFactForKey(db, entityId, col);
  if (live.v === null) {
    expect(fact, `column '${col}' is NULL but an open fact exists: ${JSON.stringify(fact)}`).toBeUndefined();
  } else {
    expect(fact, `column '${col}' = ${JSON.stringify(live.v)} but no open fact exists`).toBeDefined();
    expect(fact?.value).toBe(live.v);
  }
}

/** Asserts a create wrote exactly the entity/facts/event a real tool's
 * INSERT should produce, for any registry row -- generic over the table's
 * column list rather than hand-enumerating it per kind. */
function assertCreateProjected(db: Database.Database, table: string, kind: string, rowId: string, gameId: string): void {
  const entity = getEntity(db, rowId);
  expect(entity, `expected an entities row for ${table} ${rowId}`).toBeDefined();
  expect(entity?.kind).toBe(kind);
  expect(entity?.game_id).toBe(gameId);

  const registryRow = PROJECTED_TABLES.find((r) => r.table === table);
  const expectedName = registryRow?.nameColumn
    ? ((db.prepare(`SELECT ${registryRow.nameColumn} AS n FROM ${table} WHERE id = ?`).get(rowId) as { n: string | null }).n)
    : null;
  expect(entity?.name).toBe(expectedName);

  for (const col of liveColumns(db, table)) {
    assertColumnProjected(db, table, rowId, rowId, col);
  }

  const matching = eventsOfKind(db, gameId, `${kind}.created`).filter((e) => {
    const causes = JSON.parse(e.causes ?? "{}") as { table?: string; row_id?: string };
    return causes.table === table && causes.row_id === rowId;
  });
  expect(matching.length).toBe(1);
  expect(matching[0].at_t).toBe(entity?.created_at_t);
}

/** Drops every timeline trigger and table, simulating a database that
 * predates this feature entirely (or predates it for a table added later).
 * Mirrors src/timeline/__tests__/schema.test.ts's own "pre-timeline
 * database" fixture, extended to also drop the projection triggers (issue
 * #1's guard-trigger drop alone isn't enough here: leaving a projection
 * trigger installed while its target tables are gone would make every
 * subsequent domain write fail, since the trigger body references
 * entities/facts/events/timeline_clock directly). Discovers trigger names
 * by pattern rather than hardcoding all 30 of them, so it stays correct as
 * the registry grows. */
function dropTimelineArtifacts(db: Database.Database): void {
  const triggers = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'timeline_%'`)
    .all() as { name: string }[];
  for (const t of triggers) {
    db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
  }
  db.exec(`
    DROP TABLE IF EXISTS facts;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS entities;
    DROP TABLE IF EXISTS entity_kinds;
    DROP TABLE IF EXISTS timeline_clock;
  `);
}

describe("projection: create appends entity + facts + event", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("createGame", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    assertCreateProjected(db, "games", "game", game.id, game.id);
  });

  it("createCharacter", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const character = createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false });
    assertCreateProjected(db, "characters", "character", character.id, game.id);
  });

  it("createLocation", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const location = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });
    assertCreateProjected(db, "locations", "location", location.id, game.id);
  });

  it("createItem", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const location = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });
    const item = createItem({
      gameId: game.id,
      ownerId: location.id,
      ownerType: "location",
      name: "sack of grain",
    });
    assertCreateProjected(db, "items", "item", item.id, game.id);
  });

  it("createResource", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const resource = createResource({
      gameId: game.id,
      ownerType: "game",
      name: "treasury",
      value: 10,
      category: "currency",
    });
    assertCreateProjected(db, "resources", "resource", resource.id, game.id);
  });

  it("createRelationship", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const character = createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false });
    const location = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });
    const relationship = createRelationship({
      gameId: game.id,
      sourceId: character.id,
      sourceType: "character",
      targetId: location.id,
      targetType: "location",
      relationshipType: "resides_in",
    });
    assertCreateProjected(db, "relationships", "relationship", relationship.id, game.id);
  });

  it("createFaction", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const faction = createFaction({ gameId: game.id, name: "grain guild" });
    assertCreateProjected(db, "factions", "faction", faction.id, game.id);
  });

  it("createSecret", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const secret = createSecret({
      gameId: game.id,
      name: "the silo's true owner",
      description: "not who the deed says",
    });
    assertCreateProjected(db, "secrets", "secret", secret.id, game.id);
  });
});

describe("projection: update -- the five-case table, per column", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("a -> a: an unchanged column leaves exactly one fact row, and it is unaffected", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const resource = createResource({ gameId: game.id, ownerType: "game", name: "treasury", category: "a" });
    expect(factsForKey(db, resource.id, "category").length).toBe(1);
    const before = openFactForKey(db, resource.id, "category");

    updateResource(resource.id, { category: "a" });

    const after = factsForKey(db, resource.id, "category");
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(before?.id);
    expect(after[0].valid_to_t).toBeNull();
    assertColumnProjected(db, "resources", resource.id, resource.id, "category");
  });

  it("'a' -> 'b': closes [t0, t) and opens [t, )", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const resource = createResource({ gameId: game.id, ownerType: "game", name: "treasury", category: "a" });
    const before = openFactForKey(db, resource.id, "category");
    expect(before).toBeDefined();

    updateResource(resource.id, { category: "b" });

    const rows = factsForKey(db, resource.id, "category");
    expect(rows.length).toBe(2);
    const closed = rows.find((r) => r.id === before?.id);
    expect(closed?.valid_to_t).not.toBeNull();
    expect(closed?.valid_from_t).toBe(before?.valid_from_t);
    assertColumnProjected(db, "resources", resource.id, resource.id, "category");
  });

  it("NULL -> 'b': opens a new fact; there is nothing to close", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const resource = createResource({ gameId: game.id, ownerType: "game", name: "treasury" }); // category undefined -> NULL
    expect(factsForKey(db, resource.id, "category").length).toBe(0);

    updateResource(resource.id, { category: "b" });

    const rows = factsForKey(db, resource.id, "category");
    expect(rows.length).toBe(1);
    expect(rows[0].valid_to_t).toBeNull();
    assertColumnProjected(db, "resources", resource.id, resource.id, "category");
  });

  it("'a' -> NULL: closes the fact and opens nothing", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const resource = createResource({ gameId: game.id, ownerType: "game", name: "treasury", category: "a" });

    updateResource(resource.id, { category: null });

    const rows = factsForKey(db, resource.id, "category");
    expect(rows.length).toBe(1);
    expect(rows[0].valid_to_t).not.toBeNull();
    expect(openFactForKey(db, resource.id, "category")).toBeUndefined();
    assertColumnProjected(db, "resources", resource.id, resource.id, "category");
  });

  it("NULL -> NULL: nothing is written", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const resource = createResource({ gameId: game.id, ownerType: "game", name: "treasury" }); // category NULL
    expect(factsForKey(db, resource.id, "category").length).toBe(0);

    updateResource(resource.id, { name: "treasury renamed" }); // touch a different column; category stays NULL

    expect(factsForKey(db, resource.id, "category").length).toBe(0);
  });

  it("updateCharacter changes only the touched column, projected correctly", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const character = createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false });
    const nameFactBefore = openFactForKey(db, character.id, "name");

    updateCharacter(character.id, { name: "grain warden" });

    expect(factsForKey(db, character.id, "name").length).toBe(2);
    const closed = factsForKey(db, character.id, "name").find((r) => r.id === nameFactBefore?.id);
    expect(closed?.valid_to_t).not.toBeNull();
    for (const col of liveColumns(db, "characters")) {
      assertColumnProjected(db, "characters", character.id, character.id, col);
    }
    expect(eventsOfKind(db, game.id, "character.updated").length).toBe(1);
  });

  it("updateLocation changes only the touched column, projected correctly", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const location = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });
    const descFactBefore = openFactForKey(db, location.id, "description");

    updateLocation(location.id, { description: "a taller silo" });

    const descRows = factsForKey(db, location.id, "description");
    expect(descRows.length).toBe(2);
    expect(descRows.find((r) => r.id === descFactBefore?.id)?.valid_to_t).not.toBeNull();
    for (const col of liveColumns(db, "locations")) {
      assertColumnProjected(db, "locations", location.id, location.id, col);
    }
    expect(eventsOfKind(db, game.id, "location.updated").length).toBe(1);
  });
});

describe("projection: delete sets destroyed_at_t, closes every open fact, appends <kind>.destroyed", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("deleteCharacter", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const character = createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false });
    const before = allFactsFor(db, character.id);
    expect(before.length).toBeGreaterThan(0);

    expect(deleteCharacter(character.id)).toBe(true);

    const entity = getEntity(db, character.id);
    expect(entity?.destroyed_at_t).not.toBeNull();
    expect(openFactsFor(db, character.id)).toEqual([]);
    for (const f of allFactsFor(db, character.id)) {
      expect(f.valid_to_t).not.toBeNull();
    }
    const matching = eventsOfKind(db, game.id, "character.destroyed").filter(
      (e) => (JSON.parse(e.causes ?? "{}") as { row_id?: string }).row_id === character.id
    );
    expect(matching.length).toBe(1);
  });

  it("deleteItem", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const location = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });
    const item = createItem({ gameId: game.id, ownerId: location.id, ownerType: "location", name: "sack of grain" });

    expect(deleteItem(item.id)).toBe(true);

    const entity = getEntity(db, item.id);
    expect(entity?.destroyed_at_t).not.toBeNull();
    expect(openFactsFor(db, item.id)).toEqual([]);
    const matching = eventsOfKind(db, game.id, "item.destroyed").filter(
      (e) => (JSON.parse(e.causes ?? "{}") as { row_id?: string }).row_id === item.id
    );
    expect(matching.length).toBe(1);
  });
});

describe("projection: deleteGame cascade", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("destroys every entity of the game with no open facts, and the timeline survives the live rows", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const character = createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false });
    const location = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });
    const item = createItem({ gameId: game.id, ownerId: location.id, ownerType: "location", name: "sack of grain" });

    const ids = [game.id, character.id, location.id, item.id];

    expect(deleteGame(game.id)).toBe(true);

    // Live rows are gone.
    expect(db.prepare(`SELECT id FROM games WHERE id = ?`).get(game.id)).toBeUndefined();
    expect(db.prepare(`SELECT id FROM characters WHERE id = ?`).get(character.id)).toBeUndefined();
    expect(db.prepare(`SELECT id FROM locations WHERE id = ?`).get(location.id)).toBeUndefined();
    expect(db.prepare(`SELECT id FROM items WHERE id = ?`).get(item.id)).toBeUndefined();

    // Timeline rows survive and record the destruction of every one of them.
    for (const id of ids) {
      const entity = getEntity(db, id);
      expect(entity, `entity ${id} missing after deleteGame`).toBeDefined();
      expect(entity?.destroyed_at_t).not.toBeNull();
      expect(openFactsFor(db, id)).toEqual([]);
      expect(allFactsFor(db, id).length).toBeGreaterThan(0);
    }
  });
});

describe("projection: atomicity -- the issue's exit criterion", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("a real tool write inside withTransaction() that then throws leaves no domain row and no timeline row", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });

    expect(() =>
      withTransaction(() => {
        createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false });
        throw new Error("boom");
      })
    ).toThrow("boom");

    const domainCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM characters WHERE game_id = ?`).get(game.id) as { n: number }
    ).n;
    expect(domainCount).toBe(0);
    const entityCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE kind = 'character' AND game_id = ?`).get(game.id) as {
        n: number;
      }
    ).n;
    expect(entityCount).toBe(0);
  });

  it("planted violation: dropping the entity_kinds row makes the timeline side fail, and rolls back the domain write too -- with no withTransaction() wrapper from the caller", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    // The projection insert's FK (entities.kind REFERENCES entity_kinds)
    // will reject 'character'. createCharacter() itself is a single bare
    // INSERT statement -- proving the rollback is SQLite's (a trigger runs
    // inside the firing statement's transaction), not something every
    // caller must remember to opt into.
    db.prepare(`DELETE FROM entity_kinds WHERE kind = 'character'`).run();

    expect(() => createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false })).toThrow();

    const domainCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM characters WHERE game_id = ?`).get(game.id) as { n: number }
    ).n;
    expect(domainCount).toBe(0);
  });

  it("planted violation: a failure deep inside the trigger body (the fact-insert step, not just the entity-insert step) still rolls back the domain row", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    // Break the trigger body partway through its own work -- after it has
    // already inserted an entities row -- so a real caller sees whether
    // that partial trigger progress leaks. It must not: the whole
    // statement, including everything the trigger already did, rolls back.
    //
    // (Renaming `facts` out from under the trigger does NOT work for this:
    // SQLite's ALTER TABLE RENAME rewrites every trigger body that
    // references the renamed table to use the new name, so the projection
    // trigger keeps working against the renamed table unharmed -- verified
    // empirically while writing this test. An explicit aborting trigger on
    // `facts` itself is what actually forces a mid-body failure.)
    db.exec(`
      CREATE TRIGGER block_facts_for_test BEFORE INSERT ON facts
      BEGIN
        SELECT RAISE(ABORT, 'planted failure for test');
      END;
    `);
    try {
      expect(() => createLocation({ gameId: game.id, name: "grain silo", description: "d" })).toThrow();

      const domainCount = (
        db.prepare(`SELECT COUNT(*) AS n FROM locations WHERE game_id = ?`).get(game.id) as { n: number }
      ).n;
      expect(domainCount).toBe(0);
      const entityCount = (
        db.prepare(`SELECT COUNT(*) AS n FROM entities WHERE kind = 'location' AND game_id = ?`).get(game.id) as {
          n: number;
        }
      ).n;
      expect(entityCount).toBe(0);
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS block_facts_for_test`);
    }
  });
});

describe("projection: an uninstrumented write path still appends", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  // updateResourceValue is deliberately not called anywhere else in this
  // file. The point of "by construction" is that no test had to be written
  // teaching this specific call site to append -- proving that requires
  // picking a path none of the other tests exercise.
  it("updateResourceValue appends, though no other test in this file calls it", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const resource = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 10 });
    expect(factsForKey(db, resource.id, "value").length).toBe(1);

    const result = updateResourceValue({ resourceId: resource.id, mode: "delta", value: 5 });
    expect(result?.resource.value).toBe(15);

    const valueFacts = factsForKey(db, resource.id, "value");
    expect(valueFacts.length).toBe(2);
    assertColumnProjected(db, "resources", resource.id, resource.id, "value");
    expect(eventsOfKind(db, game.id, "resource.updated").length).toBeGreaterThan(0);
  });
});

describe("projection: trigger regeneration after ALTER TABLE ADD COLUMN", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("a column added after the triggers were generated is invisible until the next initializeSchema(), then becomes a fact key with no code change", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const resource = createResource({ gameId: game.id, ownerType: "game", name: "treasury" });

    db.exec(`ALTER TABLE resources ADD COLUMN population TEXT`);

    // Before regeneration: the trigger installed at createTestDb() time was
    // generated from the pre-ALTER column list, so it does not know
    // 'population' exists yet.
    db.prepare(`UPDATE resources SET population = ? WHERE id = ?`).run("120", resource.id);
    expect(openFactForKey(db, resource.id, "population")).toBeUndefined();

    expect(() => initializeSchema()).not.toThrow();

    // After regeneration: the same shape of write now produces a fact.
    // (No typed tool exposes this ad hoc column -- it isn't part of the
    // Resource type -- so this is a plain UPDATE, the same SQL shape any
    // future tool touching it would issue, and exactly what the
    // regenerated trigger fires on.)
    db.prepare(`UPDATE resources SET population = ? WHERE id = ?`).run("130", resource.id);
    assertColumnProjected(db, "resources", resource.id, resource.id, "population");
  });

  it("a column a CONSUMER migration adds to a projected table is projected too, because the timeline is installed after those migrations run", () => {
    // `initializeSchema({ migrations })` is the one door the engine hands a
    // consuming application for its own DDL, and a consumer is free to point
    // it at a projected table. The timeline hook therefore runs after
    // `runConsumerMigrations`, not merely after the engine's own DDL -- the
    // projection triggers are generated from a live `pragma_table_info` read,
    // so whatever ran most recently is what they are built against. Ordered
    // the other way, a consumer's column would be silently absent from the
    // timeline and the checkpoint would report a divergence the consumer had
    // no way to see coming. This test is what holds that ordering in place:
    // swap the two calls in src/db/schema.ts and it goes red.
    initializeSchema({
      migrations: [
        {
          name: "grain-store-adds-a-column",
          up(database) {
            try {
              database.exec(`ALTER TABLE factions ADD COLUMN granary TEXT`);
            } catch {
              // Already added -- migrations run on every startup by design.
            }
          },
        },
      ],
    });

    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const guild = createFaction({ gameId: game.id, name: "grain guild" });

    db.prepare(`UPDATE factions SET granary = ? WHERE id = ?`).run("full", guild.id);
    assertColumnProjected(db, "factions", guild.id, guild.id, "granary");
  });
});

describe("projection: reconciliation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("backfills entities + facts for a database that predates the timeline, and is idempotent", () => {
    dropTimelineArtifacts(db);
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities'`).get()
    ).toBeUndefined();

    // Legacy rows, written through the real tool surface with zero timeline
    // machinery installed -- exactly the shape of a database that predates
    // this feature.
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const character = createCharacter({ gameId: game.id, name: "treasury keeper", isPlayer: false });
    const location = createLocation({ gameId: game.id, name: "grain silo", description: "a tall silo" });
    const item = createItem({ gameId: game.id, ownerId: location.id, ownerType: "location", name: "sack of grain" });
    const resource = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 42 });
    const relationship = createRelationship({
      gameId: game.id,
      sourceId: character.id,
      sourceType: "character",
      targetId: location.id,
      targetType: "location",
      relationshipType: "resides_in",
    });
    const faction = createFaction({ gameId: game.id, name: "grain guild" });
    const secret = createSecret({ gameId: game.id, name: "the silo's true owner", description: "not the deed" });

    expect(() => initializeSchema()).not.toThrow();

    const rows: Array<{ table: string; kind: string; id: string }> = [
      { table: "games", kind: "game", id: game.id },
      { table: "characters", kind: "character", id: character.id },
      { table: "locations", kind: "location", id: location.id },
      { table: "items", kind: "item", id: item.id },
      { table: "resources", kind: "resource", id: resource.id },
      { table: "relationships", kind: "relationship", id: relationship.id },
      { table: "factions", kind: "faction", id: faction.id },
      { table: "secrets", kind: "secret", id: secret.id },
    ];

    for (const r of rows) {
      const entity = getEntity(db, r.id);
      expect(entity, `no entity backfilled for ${r.table} ${r.id}`).toBeDefined();
      expect(entity?.kind).toBe(r.kind);
      expect(entity?.game_id).toBe(game.id);
      for (const col of liveColumns(db, r.table)) {
        assertColumnProjected(db, r.table, r.id, r.id, col);
      }
    }

    const snapshot = () => ({
      entities: (db.prepare(`SELECT COUNT(*) AS n FROM entities`).get() as { n: number }).n,
      facts: (db.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number }).n,
      events: (db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n,
    });
    const before = snapshot();

    expect(() => initializeSchema()).not.toThrow();

    expect(snapshot()).toEqual(before);
  });
});

describe("projection: nothing existing changed behaviour", () => {
  it("PROJECTED_TABLES has exactly the eight design §8 rows", () => {
    expect(PROJECTED_TABLES.map((r) => r.table).sort()).toEqual(
      ["games", "characters", "locations", "items", "resources", "relationships", "factions", "secrets"].sort()
    );
  });
});
