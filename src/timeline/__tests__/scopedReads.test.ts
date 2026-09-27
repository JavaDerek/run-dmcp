// GitHub issue #18, decided: a caller's per-principal view is a SELECTION the
// caller builds -- which entities a principal perceives -- and the engine's
// part is to let a read be scoped to that selection, so no caller has to read
// the omniscient world and then pick from it.
//
// The measurement #18's deferral asked for, from its first real caller (two
// principals, both `character` entities): both of its view builders select
// positively and subtract nothing, from game-specific predicates (a
// concealment threshold, containers, shared location) the engine has no
// business owning. The one friction it recorded was engine-side: `render()`
// read the whole game and took no entity scope, so the view rendered the
// omniscient world and then selected nouns by entity id. This file pins the
// fix: `replay` and `render` take an optional `entityIds`, and a scoped read
// is exactly the unscoped read restricted to those entities -- never a
// different answer, never a principal concept, never a visibility column.
//
// Semantics copied from narrationConstraintAt's existing `entityIds`: omitted
// means unscoped; an empty list narrows to nothing; an id that is not alive
// at t (unknown, not yet created, destroyed) is simply absent.
//
// Fixtures: grain, treasury, population.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { replay } from "../replay.js";
import { createStateRenderer } from "../render.js";
import { createCoreMcpServer } from "../../mcp-server.js";

function insertEntity(db: Database.Database, gameId: string, name: string, createdAtT = 0, destroyedAtT: number | null = null): string {
  const id = uuidv4();
  db.prepare(`INSERT INTO entities (id, game_id, kind, name, created_at_t, destroyed_at_t) VALUES (?, ?, 'resource', ?, ?, ?)`).run(
    id,
    gameId,
    name,
    createdAtT,
    destroyedAtT
  );
  return id;
}

function insertFact(db: Database.Database, entityId: string, key: string, value: string, validFromT = 0): void {
  db.prepare(`INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t) VALUES (?, ?, ?, ?, ?, NULL)`).run(
    uuidv4(),
    entityId,
    key,
    value,
    validFromT
  );
}

describe("entity-scoped reads (issue #18)", () => {
  let db: Database.Database;
  let gameId: string;
  let grain: string, treasury: string, population: string, ruin: string;

  beforeEach(() => {
    db = createTestDb();
    gameId = uuidv4();
    grain = insertEntity(db, gameId, "grain", 0);
    treasury = insertEntity(db, gameId, "treasury", 1);
    population = insertEntity(db, gameId, "population", 2);
    ruin = insertEntity(db, gameId, "ruin", 0, 5);
    insertFact(db, grain, "state", "full");
    insertFact(db, treasury, "state", "full");
    insertFact(db, population, "state", "full");
    insertFact(db, ruin, "state", "full");
  });

  afterEach(() => destroyTestDb());

  describe("replay({ entityIds })", () => {
    it("is exactly the unscoped snapshot restricted to the listed entities, in the unscoped order", () => {
      const full = replay({ gameId, t: 10 });
      const scoped = replay({ gameId, t: 10, entityIds: [population, grain] });
      expect(scoped.entities).toEqual(full.entities.filter((e) => e.id === grain || e.id === population));
      expect(scoped.entities.map((e) => e.id)).toEqual([grain, population]);
    });

    it("omitted is unscoped", () => {
      expect(replay({ gameId, t: 10, entityIds: undefined })).toEqual(replay({ gameId, t: 10 }));
    });

    it("an empty list narrows to nothing, not to everything", () => {
      expect(replay({ gameId, t: 10, entityIds: [] }).entities).toEqual([]);
    });

    it("an id not alive at t -- unknown, not yet created, destroyed -- is simply absent", () => {
      expect(replay({ gameId, t: 10, entityIds: [uuidv4(), ruin, grain] }).entities.map((e) => e.id)).toEqual([grain]);
      expect(replay({ gameId, t: 0, entityIds: [population] }).entities).toEqual([]);
      expect(replay({ gameId, t: 3, entityIds: [ruin] }).entities.map((e) => e.id)).toEqual([ruin]);
    });

    it("never reaches another game's entity, even when named", () => {
      const other = uuidv4();
      const foreign = insertEntity(db, other, "grain");
      expect(replay({ gameId, t: 10, entityIds: [foreign] }).entities).toEqual([]);
    });

    it("still issues exactly two queries, with fixed SQL whatever the list's length", () => {
      const spy = vi.spyOn(db, "prepare");
      replay({ gameId, t: 10, entityIds: [grain] });
      replay({ gameId, t: 10, entityIds: [grain, treasury, population] });
      expect(spy).toHaveBeenCalledTimes(4);
      expect(spy.mock.calls[0][0]).toBe(spy.mock.calls[2][0]);
      expect(spy.mock.calls[1][0]).toBe(spy.mock.calls[3][0]);
      spy.mockRestore();
    });

    it("rejects a non-string id rather than silently matching nothing", () => {
      expect(() => replay({ gameId, t: 10, entityIds: [7 as unknown as string] })).toThrow(/entityIds/);
    });
  });

  describe("render({ entityIds })", () => {
    const renderer = () => createStateRenderer({ vocabulary: { state: { full: { noun: "stores", adjectives: ["brimming"] } } } });

    it("renders only the listed entities -- the same nouns the unscoped render gives them, and no others", () => {
      const full = renderer().render({ gameId, t: 10 });
      const scoped = renderer().render({ gameId, t: 10, entityIds: [treasury] });
      expect(scoped.nouns).toEqual(full.nouns.filter((n) => n.entityId === treasury));
      expect(scoped.unnamed).toEqual([]);
    });

    it("an empty list renders nothing", () => {
      expect(renderer().render({ gameId, t: 10, entityIds: [] }).nouns).toEqual([]);
    });
  });

  describe("over MCP", () => {
    let client: Client;
    beforeEach(async () => {
      const server = createCoreMcpServer({ vocabulary: { state: { full: { noun: "stores" } } } });
      const [c, s] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: "scoped", version: "0" });
      await Promise.all([server.connect(s), client.connect(c)]);
    });
    afterEach(async () => client.close());

    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text);

    it("replay_world_at takes entityIds", async () => {
      const body = await call("replay_world_at", { gameId, t: 10, entityIds: [grain] });
      expect(body.entities.map((e: { id: string }) => e.id)).toEqual([grain]);
    });

    it("render_state_at takes entityIds", async () => {
      const body = await call("render_state_at", { gameId, t: 10, entityIds: [population] });
      expect(body.nouns.map((n: { entityId: string }) => n.entityId)).toEqual([population]);
    });
  });
});
