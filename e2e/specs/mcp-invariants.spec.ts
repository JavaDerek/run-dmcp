// End-to-end proof of the three server-enforced invariants (root CLAUDE.md
// hard rule 7; src/timeline/constrained.ts), driven entirely through real
// MCP tool calls against the shipped `dist/bin/run-dmcp.js` binary -- no
// direct import of `src/tools/*`, no reaching into the database.
//
// src/tools/__tests__/conserved.test.ts and
// src/tools/__tests__/expiry-consequences.test.ts already prove these
// invariants at the function-call level. This file exists to prove the SAME
// guarantees survive the trip a real caller actually takes: Zod input
// validation, JSON serialization of the result, and the MCP wire protocol
// itself. A constraint that only fires when its TypeScript function is
// called directly proves nothing about a game-master that only ever reaches
// this engine through `tools/call` -- that seam (schema validation, error
// shape, `isError`) is exactly what a unit test cannot exercise and this one
// can.
//
// Fixtures use only this engine's throwaway vocabulary -- grain, treasury,
// population (src/__tests__/engineVocabulary.test.ts) -- dressed as
// granaries, silos and mills. Never a real game's nouns.
import { test, expect } from "@playwright/test";
import { startShippedServer, textOf, type McpHarness } from "../support/mcpClient.js";

/**
 * One fresh temp-database harness per test, closed (and its temp directory
 * removed) whether the test passes or throws -- so a failure in one test can
 * never leave a stray process or a stray file for the next one to trip over.
 * `label` only shapes the temp directory's name (tempDb.ts), so it doubles
 * as a hint in a leftover directory from a crashed run.
 */
async function withHarness(label: string, run: (h: McpHarness) => Promise<void>): Promise<void> {
  const harness = await startShippedServer(label);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

/**
 * Creates a game and puts its timeline clock on the engine's default
 * `sequence` axis before anything else is created for it, via a real
 * `declare_time_axis` call -- the explicit form of the setup order
 * `src/tools/__tests__/conserved.test.ts`'s `beforeEach` relies on implicitly
 * (a fresh game, immediately followed by whatever the test needs). Every
 * write below this point needs a timeline clock to attach its `t` to
 * (`src/timeline/constrained.ts`'s `applyLiveWrite`); declaring it up front
 * means no write in this file is the one that lazily bootstraps it.
 */
async function createGameWithClock(h: McpHarness, name: string): Promise<string> {
  const game = (await h.call("create_game", { name, setting: "test", style: "test" })) as { id: string };
  await h.call("declare_time_axis", { gameId: game.id, axis: { kind: "sequence" } });
  return game.id;
}

test.describe("conserved constraint: a declared set's total is conserved, end to end", () => {
  test("a direct write to a member is rejected, naming the constraint the server itself declared", async () => {
    await withHarness("conserved-reject", async (h) => {
      const gameId = await createGameWithClock(h, "conserved reject");
      const north = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "north_granary",
        value: 40,
      })) as { id: string };
      const south = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "south_granary",
        value: 60,
      })) as { id: string };
      await h.call("declare_resource_constraint", {
        gameId,
        kind: "conserved",
        resourceIds: [north.id, south.id],
        total: 100,
      });

      const rejected = await h.callRaw("update_resource_value", {
        resourceId: north.id,
        mode: "delta",
        value: 5,
      });
      expect(rejected.isError).toBe(true);

      // Substrings the server itself produced
      // (assertConstraintsAllow in src/timeline/constrained.ts) -- never an
      // invented regex over English (root CLAUDE.md hard rule 5).
      const message = textOf(rejected);
      expect(message).toContain("conserved");
      expect(message).toContain("transfer_resource_value");

      const unchanged = (await h.call("get_resource", { resourceId: north.id })) as { value: number };
      expect(unchanged.value).toBe(40);
    });
  });

  test("both members are equally protected, and a set-mode write is rejected the same way a delta-mode one is", async () => {
    await withHarness("conserved-reject-both", async (h) => {
      const gameId = await createGameWithClock(h, "conserved reject both");
      const north = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "north_granary",
        value: 40,
      })) as { id: string };
      const south = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "south_granary",
        value: 60,
      })) as { id: string };
      await h.call("declare_resource_constraint", {
        gameId,
        kind: "conserved",
        resourceIds: [north.id, south.id],
        total: 100,
      });

      const rejected = await h.callRaw("update_resource_value", {
        resourceId: south.id,
        mode: "set",
        value: 61,
      });
      expect(rejected.isError).toBe(true);

      const unchanged = (await h.call("get_resource", { resourceId: south.id })) as { value: number };
      expect(unchanged.value).toBe(60);
    });
  });

  test("transfer_resource_value moves value between members and the total holds across several transfers, including a zero-amount one", async () => {
    await withHarness("conserved-transfer", async (h) => {
      const gameId = await createGameWithClock(h, "conserved transfer");
      const north = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "north_granary",
        value: 40,
      })) as { id: string };
      const south = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "south_granary",
        value: 60,
      })) as { id: string };
      await h.call("declare_resource_constraint", {
        gameId,
        kind: "conserved",
        resourceIds: [north.id, south.id],
        total: 100,
      });

      async function sumOfBoth(): Promise<number> {
        const n = (await h.call("get_resource", { resourceId: north.id })) as { value: number };
        const s = (await h.call("get_resource", { resourceId: south.id })) as { value: number };
        return n.value + s.value;
      }

      await h.call("transfer_resource_value", { fromResourceId: north.id, toResourceId: south.id, amount: 15 });
      expect(await sumOfBoth()).toBe(100);

      await h.call("transfer_resource_value", { fromResourceId: south.id, toResourceId: north.id, amount: 25 });
      expect(await sumOfBoth()).toBe(100);

      // A zero-amount transfer is a legal no-op, not a rejection --
      // conserved.test.ts's "transfers of amount 0 succeed as a no-op".
      await h.call("transfer_resource_value", { fromResourceId: north.id, toResourceId: south.id, amount: 0 });
      expect(await sumOfBoth()).toBe(100);

      await h.call("transfer_resource_value", { fromResourceId: north.id, toResourceId: south.id, amount: 10 });
      expect(await sumOfBoth()).toBe(100);

      const north2 = (await h.call("get_resource", { resourceId: north.id })) as { value: number };
      const south2 = (await h.call("get_resource", { resourceId: south.id })) as { value: number };
      // 40 - 15 + 25 - 0 - 10 = 40 ; 60 + 15 - 25 + 0 + 10 = 60
      expect(north2.value).toBe(40);
      expect(south2.value).toBe(60);
    });
  });

  test("a transfer to a resource outside the declared set is rejected, and neither side moves", async () => {
    await withHarness("conserved-non-member", async (h) => {
      const gameId = await createGameWithClock(h, "conserved non-member");
      const north = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "north_granary",
        value: 40,
      })) as { id: string };
      const south = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "south_granary",
        value: 60,
      })) as { id: string };
      await h.call("declare_resource_constraint", {
        gameId,
        kind: "conserved",
        resourceIds: [north.id, south.id],
        total: 100,
      });
      const outsider = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "roadside_stall",
        value: 10,
      })) as { id: string };

      const rejected = await h.callRaw("transfer_resource_value", {
        fromResourceId: north.id,
        toResourceId: outsider.id,
        amount: 5,
      });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toContain("conserved");

      const northAfter = (await h.call("get_resource", { resourceId: north.id })) as { value: number };
      const outsiderAfter = (await h.call("get_resource", { resourceId: outsider.id })) as { value: number };
      expect(northAfter.value).toBe(40);
      expect(outsiderAfter.value).toBe(10);
    });
  });
});

test.describe("bounded constraint: rejects rather than clamps", () => {
  test("writes inside the range succeed; a write above max and a write below min are both rejected, and the stored value never moved", async () => {
    await withHarness("bounded-basic", async (h) => {
      const gameId = await createGameWithClock(h, "bounded basic");
      const silo = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "grain_silo",
        value: 50,
        minValue: 0,
        maxValue: 100,
      })) as { id: string };
      await h.call("declare_resource_constraint", { gameId, kind: "bounded", resourceId: silo.id });

      const raised = (await h.call("update_resource_value", {
        resourceId: silo.id,
        mode: "set",
        value: 70,
      })) as { resource: { value: number } };
      expect(raised.resource.value).toBe(70);

      const tooHigh = await h.callRaw("update_resource_value", {
        resourceId: silo.id,
        mode: "set",
        value: 150,
      });
      expect(tooHigh.isError).toBe(true);
      expect(textOf(tooHigh)).toContain("bounded-constrained");
      expect(textOf(tooHigh)).toContain("clamping");
      // The point of this test: a rejected write must not silently land at
      // the clamped value (100) or anywhere else. It stays at 70.
      const afterHighAttempt = (await h.call("get_resource", { resourceId: silo.id })) as { value: number };
      expect(afterHighAttempt.value).toBe(70);

      const tooLow = await h.callRaw("update_resource_value", {
        resourceId: silo.id,
        mode: "set",
        value: -10,
      });
      expect(tooLow.isError).toBe(true);
      expect(textOf(tooLow)).toContain("bounded-constrained");
      const afterLowAttempt = (await h.call("get_resource", { resourceId: silo.id })) as { value: number };
      expect(afterLowAttempt.value).toBe(70);
    });
  });

  test("the boundary values themselves -- exactly min and exactly max -- are legal writes", async () => {
    await withHarness("bounded-boundary", async (h) => {
      const gameId = await createGameWithClock(h, "bounded boundary");
      const silo = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "grain_silo",
        value: 50,
        minValue: 0,
        maxValue: 100,
      })) as { id: string };
      await h.call("declare_resource_constraint", { gameId, kind: "bounded", resourceId: silo.id });

      const atMax = (await h.call("update_resource_value", {
        resourceId: silo.id,
        mode: "set",
        value: 100,
      })) as { resource: { value: number } };
      expect(atMax.resource.value).toBe(100);

      const atMin = (await h.call("update_resource_value", {
        resourceId: silo.id,
        mode: "set",
        value: 0,
      })) as { resource: { value: number } };
      expect(atMin.resource.value).toBe(0);
    });
  });
});

test.describe("scheduled event consequence: lands by itself when time passes", () => {
  test("advancing past the trigger applies the consequence and changes real state; advancing to before it does not", async () => {
    await withHarness("expiry-consequence", async (h) => {
      const gameId = await createGameWithClock(h, "expiry consequence");
      // advance_time needs a calendar (src/tools/time.ts's getTime returns
      // null without one); the default calendar starts its clock at 08:00.
      await h.call("set_calendar", { gameId, config: {} });
      const treasury = (await h.call("create_resource", {
        gameId,
        ownerType: "game",
        name: "treasury",
        value: 100,
      })) as { id: string };

      const triggerTime = { year: 1, month: 0, day: 0, hour: 10, minute: 0 };
      await h.call("schedule_event", {
        gameId,
        name: "toll collected",
        triggerTime,
        consequence: { resourceId: treasury.id, delta: -20 },
      });

      // 08:00 -> 09:00: strictly before the 10:00 trigger. Must not fire.
      const early = (await h.call("advance_time", { gameId, hours: 1 })) as {
        triggeredEvents: unknown[];
        triggeredCount: number;
      };
      expect(early.triggeredCount).toBe(0);
      expect(early.triggeredEvents).toHaveLength(0);
      const beforeTrigger = (await h.call("get_resource", { resourceId: treasury.id })) as { value: number };
      expect(beforeTrigger.value).toBe(100);

      // 09:00 -> 11:00: crosses the 10:00 trigger.
      const late = (await h.call("advance_time", { gameId, hours: 2 })) as {
        triggeredEvents: Array<{ name: string }>;
        triggeredCount: number;
      };
      expect(late.triggeredCount).toBe(1);
      expect(late.triggeredEvents).toHaveLength(1);
      expect(late.triggeredEvents[0].name).toBe("toll collected");

      // Real state change, read back independently through get_resource --
      // not merely narrated in advance_time's own response payload.
      const afterTrigger = (await h.call("get_resource", { resourceId: treasury.id })) as { value: number };
      expect(afterTrigger.value).toBe(80);
    });
  });
});

test.describe("shipped tool surface", () => {
  test("lists a healthy surface of expected tools, and no resolve or render_state_at tool -- by construction, not by omission", async () => {
    await withHarness("tool-surface", async (h) => {
      const names = await h.listToolNames();

      // A sane count, not an exact one -- an exact count would make this
      // test change every time an unrelated domain gains a tool. Just proof
      // the surface isn't suspiciously empty: a server that silently
      // registered nothing would still complete the initialize handshake.
      expect(names.length).toBeGreaterThan(40);

      for (const expected of [
        "create_game",
        "load_game",
        "create_resource",
        "get_resource",
        "update_resource_value",
        "transfer_resource_value",
        "declare_resource_constraint",
        "list_resource_constraints",
        "set_calendar",
        "schedule_event",
        "advance_time",
        "declare_time_axis",
        "replay_world_at",
        "narration_constraint_at",
      ]) {
        expect(names).toContain(expected);
      }

      // NOT a defect. src/mcp-server.ts's createCoreMcpServer only
      // registers resolve/list_mechanics when it is constructed with a
      // non-empty `mechanics` array, and only registers render_state_at
      // when constructed with a `vocabulary` -- and src/bin/run-dmcp.ts
      // calls createMcpServer() with NO arguments, so the shipped binary
      // has neither injected. A generic engine with no mechanics and no
      // vocabulary of its own has nothing a resolve tool could ever
      // dispatch and nothing a renderer could ever name, so it correctly
      // serves neither tool rather than a pair that could only ever answer
      // "unknown-mechanic" and "[]". A consumer that injects mechanics and
      // a vocabulary gets both tools; covering that server is a different
      // harness's job, not this one's.
      expect(names).not.toContain("resolve");
      expect(names).not.toContain("list_mechanics");
      expect(names).not.toContain("render_state_at");
    });
  });
});
