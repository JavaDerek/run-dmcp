// The resolve protocol (design §5.2a, GitHub issue #10), proven over the
// real MCP wire against a consumer-shaped assembly -- e2e/support/consumerServer.ts,
// which injects three small mechanics (TITHE, SPOIL, REDISTRIBUTE) the way a
// real consumer would, at `createMcpServer` construction. Every unit test in
// src/timeline/__tests__/resolve.test.ts already proves this protocol from
// INSIDE the engine, calling `resolver.resolve()` directly; this file proves
// the same guarantees from OUTSIDE it -- spawned as a real child process,
// speaking real JSON-RPC, reading state back through the ordinary MCP tool
// surface a real consumer would use, never a database handle.
//
// grain/treasury/population flavoured throughout (root claude.md,
// engineVocabulary.test.ts) -- a throwaway fixture for exercising mechanism,
// never a starter set.
import { test, expect } from "@playwright/test";
import { connectConsumer, type ConsumerHarness } from "../support/consumerClient.js";
import type { Outcome, ResolveRefusalReason } from "../../dist/timeline/resolve.js";
import type { ChangeSet } from "../../dist/timeline/changes.js";
import type { Resource } from "../../dist/types/index.js";
import type { StoryTime } from "../../dist/timeline/clock.js";

/** One fresh game plus three resources this whole file's tests are built
 *  from -- an unconstrained control (grain), a resource this file
 *  constrains per-test (treasury), and a resource used only as the
 *  monotonic victim in the rollback test (population). Each test gets its
 *  own harness and its own game, so declaring a constraint in one test can
 *  never leak into another. */
interface Fixture {
  gameId: string;
  grain: Resource;
  treasury: Resource;
  population: Resource;
}

async function seedFixture(harness: ConsumerHarness): Promise<Fixture> {
  const game = await harness.call<{ id: string }>("create_game", {
    name: "grain depot",
    setting: "test",
    style: "test",
  });
  const gameId = game.id;

  const grain = await harness.call<Resource>("create_resource", {
    gameId,
    ownerType: "game",
    name: "grain",
    value: 50,
  });
  const treasury = await harness.call<Resource>("create_resource", {
    gameId,
    ownerType: "game",
    name: "treasury",
    value: 50,
  });
  const population = await harness.call<Resource>("create_resource", {
    gameId,
    ownerType: "game",
    name: "population",
    value: 20,
  });

  return { gameId, grain, treasury, population };
}

async function resourceValue(harness: ConsumerHarness, resourceId: string): Promise<number> {
  const resource = await harness.call<Resource>("get_resource", { resourceId });
  return resource.value;
}

/** Every `resolution.recorded` event in the whole game's history so far --
 *  the MCP-surface equivalent of resolve.test.ts's own `countResolutionEvents`
 *  helper, which reads `events` directly. This harness has no database
 *  handle, so it asks the same question through `changes_within`, widening
 *  the window to the game's entire recorded life (t0=0, t1=current t + 1). */
async function countResolutionEvents(harness: ConsumerHarness, gameId: string): Promise<number> {
  const story = await harness.call<StoryTime>("get_story_time", { gameId });
  const changeSet = await harness.call<ChangeSet>("changes_within", { gameId, t0: 0, t1: story.t + 1 });
  return changeSet.changes.filter((c) => c.kind === "event" && c.eventKind === "resolution.recorded").length;
}

test.describe("resolve protocol over the real MCP wire (consumer-shaped assembly)", () => {
  let harness: ConsumerHarness;

  test.beforeEach(async () => {
    harness = await connectConsumer({ label: "consumer-resolve" });
  });

  test.afterEach(async () => {
    await harness.close();
  });

  test("list_mechanics returns exactly the names this harness injected -- nothing the engine invented", async () => {
    const names = await harness.call<string[]>("list_mechanics");
    expect(names).toEqual(["TITHE", "SPOIL", "REDISTRIBUTE"]);
  });

  test("resolve on a registered mechanic returns an outcome, and the state it changed is genuinely changed when read back", async () => {
    const { gameId, treasury } = await seedFixture(harness);

    const outcome = await harness.call<Outcome>("resolve", {
      gameId,
      mechanic: "TITHE",
      parameters: { resourceId: treasury.id, amount: 15 },
    });

    expect(outcome.gameId).toBe(gameId);
    expect(outcome.mechanic).toBe("TITHE");
    expect(outcome.result).toEqual({ collected: 15 });
    expect(outcome.transitions).toHaveLength(1);
    expect(outcome.transitions[0]).toMatchObject({
      entityId: treasury.id,
      key: "value",
      previousValue: 50,
      newValue: 65,
      delta: 15,
    });

    // Not the outcome's own say-so -- an INDEPENDENT read through the
    // ordinary get_resource tool, over the same MCP connection but a
    // completely separate call, confirms the write actually landed.
    expect(await resourceValue(harness, treasury.id)).toBe(65);
  });

  test("resolution happens before narration: the outcome's constraint reports the value that is actually stored", async () => {
    const { gameId, treasury } = await seedFixture(harness);

    const outcome = await harness.call<Outcome>("resolve", {
      gameId,
      mechanic: "TITHE",
      parameters: { resourceId: treasury.id, amount: 12 },
    });

    // outcome.constraint (a NarrationConstraint, design §5.2b/§5.2c) is what
    // a caller narrates FROM. It must already carry the post-write value --
    // resolve.ts builds it AFTER the writes land, inside the same
    // transaction, precisely so this is a protocol property and not a
    // convention. Read what resolve.ts actually returns (Outcome.constraint.mustHonor,
    // an array of ConstraintFact) rather than inventing a field.
    const fact = outcome.constraint.mustHonor.find((f) => f.entityId === treasury.id && f.key === "value");
    expect(fact).toBeDefined();
    expect(Number(fact?.value)).toBe(62);
    expect(outcome.constraint.t).toBeGreaterThanOrEqual(outcome.t);

    // And the authoritative value the OUTCOME reports is the value actually
    // in storage -- checked a second, independent way.
    expect(await resourceValue(harness, treasury.id)).toBe(62);
  });

  test("resolve on an unknown mechanic is refused -- nothing is written, no window opens", async () => {
    const { gameId, treasury } = await seedFixture(harness);
    const before = await resourceValue(harness, treasury.id);

    const result = await harness.callRaw("resolve", {
      gameId,
      mechanic: "HARVEST_A_MECHANIC_NOBODY_REGISTERED",
      parameters: { resourceId: treasury.id, amount: 999 },
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content.find((c) => c.type === "text") as { text: string }).text) as {
      reason: ResolveRefusalReason;
      error: string;
    };
    expect(body.reason).toBe("unknown-mechanic");
    expect(body.error).toMatch(/not a mechanic registered/i);

    expect(await resourceValue(harness, treasury.id)).toBe(before);
    expect(await countResolutionEvents(harness, gameId)).toBe(0);
  });

  test("a declared expectation that does not hold at the current t refuses the whole call before dispatch, carrying the contradiction", async () => {
    const { gameId, treasury } = await seedFixture(harness);
    const before = await resourceValue(harness, treasury.id);

    const result = await harness.callRaw("resolve", {
      gameId,
      mechanic: "TITHE",
      parameters: { resourceId: treasury.id, amount: 15 },
      expects: [{ entityId: treasury.id, key: "value", value: 999999 }],
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse((result.content.find((c) => c.type === "text") as { text: string }).text) as {
      reason: ResolveRefusalReason;
      contradictions: Array<{ claim: { entityId: string; key: string; value: number }; fact: { entityId: string; key: string } }>;
    };
    expect(body.reason).toBe("expectation-contradicted");
    expect(body.contradictions).toHaveLength(1);
    expect(body.contradictions[0].claim).toMatchObject({ entityId: treasury.id, key: "value", value: 999999 });
    expect(body.contradictions[0].fact.entityId).toBe(treasury.id);

    // The mechanic never dispatched -- the value this proposal would have
    // written is exactly where it started.
    expect(await resourceValue(harness, treasury.id)).toBe(before);
    expect(await countResolutionEvents(harness, gameId)).toBe(0);
  });

  test("a mechanic that fails mid-adjudication rolls back every change it had made and records no event", async () => {
    const { gameId, grain, treasury, population } = await seedFixture(harness);

    // treasury is left alone by this test (used elsewhere); population gets
    // a monotonic-increasing constraint SPOIL's second write is guaranteed
    // to violate, since it always moves in the DECREASING direction.
    await harness.call("declare_resource_constraint", {
      gameId,
      kind: "monotonic",
      resourceId: population.id,
      direction: "increasing",
    });

    const grainBefore = await resourceValue(harness, grain.id);
    const populationBefore = await resourceValue(harness, population.id);
    const eventsBefore = await countResolutionEvents(harness, gameId);

    // SPOIL's first change (grain -5) is legal entirely on its own -- if it
    // were the only write in this resolution, it would succeed cleanly. Its
    // second change (population -3, against a direction:"increasing"
    // constraint) is what fails, and BOTH must roll back together: this is
    // the whole point of "resolution happens inside one transaction."
    const result = await harness.callRaw("resolve", {
      gameId,
      mechanic: "SPOIL",
      parameters: {
        grainResourceId: grain.id,
        grainLoss: 5,
        secondResourceId: population.id,
        secondDelta: -3,
      },
    });

    expect(result.isError).toBe(true);
    const text = (result.content.find((c) => c.type === "text") as { text: string }).text;
    expect(text).toMatch(/constrained to never decrease|resolve_only|CONSTRAINT_VIOLATION/i);

    // The proof: grain's legal-on-its-own write, which structurally must
    // have been applied and then undone (it is not the write that failed),
    // is back to exactly where it started -- and so is population.
    expect(await resourceValue(harness, grain.id)).toBe(grainBefore);
    expect(await resourceValue(harness, population.id)).toBe(populationBefore);
    expect(await countResolutionEvents(harness, gameId)).toBe(eventsBefore);
    void treasury; // unused in this test; kept for symmetry with seedFixture's shape
  });

  test("resolve_only: a direct write is refused (update_resource_value), and the identical change succeeds through resolve()", async () => {
    const { gameId, treasury } = await seedFixture(harness);

    await harness.call("declare_resource_constraint", { gameId, kind: "resolve_only", resourceId: treasury.id });

    const directAttempt = await harness.callRaw("update_resource_value", {
      resourceId: treasury.id,
      mode: "delta",
      value: 10,
    });
    expect(directAttempt.isError).toBe(true);
    const directBody = JSON.parse((directAttempt.content.find((c) => c.type === "text") as { text: string }).text) as {
      errorCode: string;
    };
    expect(directBody.errorCode).toBe("CONSTRAINT_VIOLATION");
    expect(await resourceValue(harness, treasury.id)).toBe(50);

    // The SAME entity, key and delta -- refused a moment ago, now proposed
    // through resolve() instead.
    const outcome = await harness.call<Outcome>("resolve", {
      gameId,
      mechanic: "TITHE",
      parameters: { resourceId: treasury.id, amount: 10 },
    });
    expect(outcome.transitions[0]).toMatchObject({ entityId: treasury.id, previousValue: 50, newValue: 60 });
    expect(await resourceValue(harness, treasury.id)).toBe(60);
  });

  test("resolve_only + conserved: transfer_resource_value is ALSO refused directly, and the same transfer succeeds through resolve()", async () => {
    const { gameId, grain, treasury } = await seedFixture(harness);

    // grain (50) and treasury (50) already sum to 100 -- a conserved set
    // needs its members to already sum to the declared total.
    await harness.call("declare_resource_constraint", {
      gameId,
      kind: "conserved",
      resourceIds: [grain.id, treasury.id],
      total: 100,
    });
    await harness.call("declare_resource_constraint", { gameId, kind: "resolve_only", resourceId: treasury.id });

    // A conserved member can never move through a single-resource write --
    // not even through resolve() -- so the ONLY door left for this
    // combination is a two-leg transfer, and only via the adjudicating call.
    const directTransfer = await harness.callRaw("transfer_resource_value", {
      fromResourceId: grain.id,
      toResourceId: treasury.id,
      amount: 10,
    });
    expect(directTransfer.isError).toBe(true);
    expect(await resourceValue(harness, grain.id)).toBe(50);
    expect(await resourceValue(harness, treasury.id)).toBe(50);

    const directWrite = await harness.callRaw("update_resource_value", {
      resourceId: treasury.id,
      mode: "delta",
      value: 10,
    });
    expect(directWrite.isError).toBe(true);
    expect(await resourceValue(harness, treasury.id)).toBe(50);

    const outcome = await harness.call<Outcome>("resolve", {
      gameId,
      mechanic: "REDISTRIBUTE",
      parameters: { fromResourceId: grain.id, toResourceId: treasury.id, amount: 10 },
    });
    expect(outcome.transitions).toHaveLength(2);
    expect(await resourceValue(harness, grain.id)).toBe(40);
    expect(await resourceValue(harness, treasury.id)).toBe(60);
  });
});
