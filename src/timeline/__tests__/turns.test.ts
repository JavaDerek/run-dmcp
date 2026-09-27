// GitHub issue #40: a principal is due to act. "The engine records whose turn
// it is and refuses out-of-turn proposals if a game declares turns. It never
// runs the turn itself." Pull, not push: MCP servers answer calls, so
// whatever runs minds asks "who is due at t", moves the clock, and proposes
// as that principal.
//
// The first real caller alternates two principals half-round by half-round on
// a counter axis, computing each t by hand -- and has a recorded batch game
// killed by "t never runs backwards" when that hand computation was called out
// of order. This file pins the generic form: an append-only declaration of
// which entities act in what cycle from a `fromT` on, answered for any t,
// past included; and a resolve that names its `actor` refused before dispatch
// when that actor is not the one due.
//
// Fixtures: grain, treasury, population -- principals are ordinary entities.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../../tools/game.js";
import { createResource } from "../../tools/resource.js";
import { declareTimeAxis, setStoryTime, currentStoryTime } from "../clock.js";
import { createResolver, ResolveProtocolError, type Mechanic } from "../resolve.js";
import { declareTurnOrder, dueAt, advanceTurn } from "../turns.js";

describe("turn order (issue #40)", () => {
  let db: Database.Database;
  let gameId: string;
  let a: string, b: string, c: string;

  beforeEach(() => {
    db = createTestDb();
    gameId = createGame({ name: "depot", setting: "test", style: "test" }).id;
    declareTimeAxis({ gameId, axis: { kind: "counter", unit: "half-turn" } });
    a = createResource({ gameId, ownerType: "game", name: "grain", value: 1 }).id;
    b = createResource({ gameId, ownerType: "game", name: "treasury", value: 1 }).id;
    c = createResource({ gameId, ownerType: "game", name: "population", value: 1 }).id;
    setStoryTime({ gameId, t: 10 });
  });
  afterEach(() => destroyTestDb());

  describe("declare and ask", () => {
    it("cycles the principals one per t from fromT, with the cycle's round", () => {
      declareTurnOrder({ gameId, principals: [a, b], fromT: 12 });
      expect([12, 13, 14, 15].map((t) => [dueAt({ gameId, t })?.principal, dueAt({ gameId, t })?.round])).toEqual([
        [a, 1],
        [b, 1],
        [a, 2],
        [b, 2],
      ]);
    });

    it("nobody is due before the first declaration, at a non-integer offset, or in a game that declared none", () => {
      declareTurnOrder({ gameId, principals: [a, b], fromT: 12 });
      expect(dueAt({ gameId, t: 11 })).toBeNull();
      expect(dueAt({ gameId, t: 12.5 })).toBeNull();
      const other = createGame({ name: "other", setting: "test", style: "test" }).id;
      expect(dueAt({ gameId: other, t: 12 })).toBeNull();
    });

    it("a later declaration applies from its own fromT; the past still answers as it did", () => {
      declareTurnOrder({ gameId, principals: [a, b], fromT: 12 });
      setStoryTime({ gameId, t: 15 });
      declareTurnOrder({ gameId, principals: [c, a, b], fromT: 16 });
      expect([14, 15].map((t) => dueAt({ gameId, t })?.principal)).toEqual([a, b]);
      expect([16, 17, 18, 19].map((t) => dueAt({ gameId, t })?.principal)).toEqual([c, a, b, c]);
    });

    it("refuses what would make the answer ambiguous or rewrite the past", () => {
      expect(() => declareTurnOrder({ gameId, principals: [], fromT: 12 })).toThrow(/at least one principal/);
      expect(() => declareTurnOrder({ gameId, principals: [a, a], fromT: 12 })).toThrow(/appears twice/);
      expect(() => declareTurnOrder({ gameId, principals: [a, "no-such-entity"], fromT: 12 })).toThrow(/'no-such-entity' is not an entity of this game/);
      expect(() => declareTurnOrder({ gameId, principals: [a, b], fromT: 9 })).toThrow(/before the game's current t \(10\)/);
      expect(() => declareTurnOrder({ gameId, principals: [a, b], fromT: 12.5 })).toThrow(/integer/);
      declareTurnOrder({ gameId, principals: [a, b], fromT: 12 });
      expect(() => declareTurnOrder({ gameId, principals: [b, a], fromT: 12 })).toThrow(/after the latest declaration's fromT \(12\)/);
    });

    it("only on a counter axis: a turn is a count of things that happened", () => {
      const seq = createGame({ name: "seq", setting: "test", style: "test" }).id;
      const e = createResource({ gameId: seq, ownerType: "game", name: "grain", value: 1 }).id;
      expect(() => declareTurnOrder({ gameId: seq, principals: [e], fromT: 100 })).toThrow(/counter axis/);
    });

    it("is append-only in storage: a declaration row cannot be edited or deleted", () => {
      declareTurnOrder({ gameId, principals: [a, b], fromT: 12 });
      expect(() => db.prepare(`UPDATE turn_orders SET from_t = 99`).run()).toThrow(/turn orders are append-only/);
      expect(() => db.prepare(`DELETE FROM turn_orders`).run()).toThrow(/turn orders are append-only/);
    });
  });

  describe("advanceTurn", () => {
    it("moves the clock one step and says who is due there; before the first turn it jumps to fromT", () => {
      declareTurnOrder({ gameId, principals: [a, b], fromT: 12 });
      expect(advanceTurn({ gameId })).toMatchObject({ t: 12, principal: a, round: 1 });
      expect(advanceTurn({ gameId })).toMatchObject({ t: 13, principal: b, round: 1 });
      expect(currentStoryTime(gameId)?.t).toBe(13);
    });

    it("with no turn order declared, refuses rather than guessing", () => {
      expect(() => advanceTurn({ gameId })).toThrow(/no turn order/);
    });
  });

  describe("resolve refuses an out-of-turn actor, before dispatch", () => {
    let dispatched = 0;
    const TICK: Mechanic = {
      name: "TICK",
      adjudicate: () => {
        dispatched++;
        return { changes: [] };
      },
    };
    beforeEach(() => {
      dispatched = 0;
      declareTurnOrder({ gameId, principals: [a, b], fromT: 12 });
    });

    it("the due actor resolves, and the resolution records who acted", () => {
      advanceTurn({ gameId });
      const outcome = createResolver({ mechanics: [TICK] }).resolve({ gameId, mechanic: "TICK", actor: a });
      const causes = JSON.parse((db.prepare(`SELECT causes FROM events WHERE id = ?`).get(outcome.eventId) as { causes: string }).causes);
      expect(causes.actor).toBe(a);
    });

    it("an actor who is not due is refused out-of-turn, naming who is, and nothing is dispatched or written", () => {
      advanceTurn({ gameId });
      let caught: unknown;
      try {
        createResolver({ mechanics: [TICK] }).resolve({ gameId, mechanic: "TICK", actor: b });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ResolveProtocolError);
      expect((caught as ResolveProtocolError).reason).toBe("out-of-turn");
      expect((caught as Error).message).toContain(`'${a}' is due at t=12`);
      expect(dispatched).toBe(0);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'resolution.recorded'`).get()).toEqual({ n: 0 });
    });

    it("an actor at a t where nobody is due (before the first turn) is refused too", () => {
      expect(() => createResolver({ mechanics: [TICK] }).resolve({ gameId, mechanic: "TICK", actor: a })).toThrow(/nobody is due at t=10/);
    });

    it("a proposal with no actor -- the world's own mechanics -- is not a turn and is never refused for one", () => {
      advanceTurn({ gameId });
      createResolver({ mechanics: [TICK] }).resolve({ gameId, mechanic: "TICK" });
      expect(dispatched).toBe(1);
    });

    it("in a game with no turn order, an actor is recorded and nothing is refused", () => {
      const free = createGame({ name: "free", setting: "test", style: "test" }).id;
      declareTimeAxis({ gameId: free, axis: { kind: "counter", unit: "turn" } });
      const outcome = createResolver({ mechanics: [TICK] }).resolve({ gameId: free, mechanic: "TICK", actor: "anyone" });
      const causes = JSON.parse((db.prepare(`SELECT causes FROM events WHERE id = ?`).get(outcome.eventId) as { causes: string }).causes);
      expect(causes.actor).toBe("anyone");
    });
  });
});

describe("turn order over MCP (issue #40)", () => {
  it("declare_turn_order, advance_turn, due_at, and resolve's actor, through a real client", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createCoreMcpServer } = await import("../../mcp-server.js");
    createTestDb();
    try {
      const gameId = createGame({ name: "depot", setting: "test", style: "test" }).id;
      declareTimeAxis({ gameId, axis: { kind: "counter", unit: "turn" } });
      const a = createResource({ gameId, ownerType: "game", name: "grain", value: 1 }).id;
      const b = createResource({ gameId, ownerType: "game", name: "treasury", value: 1 }).id;
      const server = createCoreMcpServer({ mechanics: [{ name: "TICK", adjudicate: () => ({}) }] });
      const [cs, ss] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "turns", version: "0" });
      await Promise.all([server.connect(ss), client.connect(cs)]);
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        return { isError: r.isError === true, body: JSON.parse(r.content[0].text) };
      };
      const t0 = currentStoryTime(gameId)?.t as number;
      expect((await call("declare_turn_order", { gameId, principals: [a, b], fromT: t0 + 1 })).isError).toBe(false);
      expect((await call("advance_turn", { gameId })).body).toMatchObject({ t: t0 + 1, principal: a, round: 1 });
      expect((await call("due_at", { gameId, t: t0 + 2 })).body).toMatchObject({ principal: b });
      expect((await call("due_at", { gameId, t: t0 - 5 })).body).toEqual({ due: null });
      const refused = await call("resolve", { gameId, mechanic: "TICK", actor: b });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.body)).toContain("out-of-turn");
      expect((await call("resolve", { gameId, mechanic: "TICK", actor: a })).isError).toBe(false);
      await client.close();
    } finally {
      destroyTestDb();
    }
  });
});
