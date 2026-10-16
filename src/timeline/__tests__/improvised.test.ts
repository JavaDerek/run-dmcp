// The improvised ruling (design §5.2a, §5.3): an ordinary resolve, through an
// engine-provided MECHANIC, whose caller picks which declared-improvisable
// values move, under which tier, by how much -- with a rationale and the
// verbatim words of the act it rules on. It is a mechanic kind, not a new kind
// of outcome: `resolve()` still returns an Outcome or refuses, and Outcome
// still has no kind field. Every write goes through the one choke point, so
// resolve_only, bounds, conservation, the transaction and its rollback, and
// the `resolution.recorded` event all apply unchanged.
//
// Fixtures: grain, treasury, population. Mechanic names are throwaway.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../../tools/game.js";
import { createResource, getResource } from "../../tools/resource.js";
import {
  declareImprovisableConstraint,
  declareBoundedConstraint,
  declareConservedConstraint,
  declareResolveOnlyConstraint,
} from "../../tools/constraint.js";
import { ConstraintViolationError } from "../registry.js";
import { writeConstrainedValue } from "../constrained.js";
import { createResolver, type Mechanic, type Outcome } from "../resolve.js";
import { improvisedRulingMechanic, IMPROVISED_RULING } from "../improvised.js";

const TIERS = [
  { key: "minor", cap: 2 },
  { key: "serious", cap: 5 },
  { key: "outrage", cap: 10, requiresConfirmation: true },
];

const ACT = "lies down in the doorway and refuses to move";
const RATIONALE = "a small public embarrassment; nothing structural changes";

describe("improvised ruling mechanic", () => {
  let db: Database.Database;
  let gameId: string;
  let grainId: string;
  let treasuryId: string;
  let populationId: string;

  beforeEach(() => {
    db = createTestDb();
    gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    grainId = createResource({ gameId, ownerType: "game", name: "grain", value: 50 }).id;
    treasuryId = createResource({ gameId, ownerType: "game", name: "treasury", value: 50, minValue: 0, maxValue: 100 }).id;
    populationId = createResource({ gameId, ownerType: "game", name: "population", value: 20 }).id;
    declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: TIERS });
  });

  afterEach(() => {
    destroyTestDb();
  });

  const value = (id: string) => getResource(id)?.value;
  const resolver = () => createResolver({ mechanics: [improvisedRulingMechanic()] });
  const rule = (parameters: Record<string, unknown>): Outcome => resolver().resolve({ gameId, mechanic: IMPROVISED_RULING, parameters });
  const resolutionEvents = () =>
    db.prepare(`SELECT id, description, causes FROM events WHERE game_id = ? AND kind = 'resolution.recorded' ORDER BY rowid`).all(gameId) as {
      id: string;
      description: string | null;
      causes: string;
    }[];

  function refusal(parameters: Record<string, unknown>): ConstraintViolationError {
    try {
      rule(parameters);
    } catch (e) {
      expect(e).toBeInstanceOf(ConstraintViolationError);
      return e as ConstraintViolationError;
    }
    throw new Error("expected the ruling to be refused");
  }

  // ==========================================================================
  // Shape
  // ==========================================================================
  it("is an ordinary Mechanic with a default name, and can be registered under another", () => {
    expect(IMPROVISED_RULING).toBe("improvised_ruling");
    expect(improvisedRulingMechanic().name).toBe(IMPROVISED_RULING);
    expect(improvisedRulingMechanic({ name: "rule_it" }).name).toBe("rule_it");
    expect(createResolver({ mechanics: [improvisedRulingMechanic({ name: "rule_it" })] }).mechanics()).toEqual(["rule_it"]);
  });

  // ==========================================================================
  // Happy path and audit
  // ==========================================================================
  it("moves a declared-improvisable value within its tier's cap, and the outcome carries the ruling with no kind field", () => {
    const outcome = rule({ targets: [{ entityId: grainId, tier: "minor", amount: -2 }], rationale: RATIONALE, citedAct: ACT });
    expect(value(grainId)).toBe(48);
    expect(outcome.transitions).toHaveLength(1);
    expect(outcome.transitions[0]).toMatchObject({ entityId: grainId, key: "value", previousValue: 50, newValue: 48, reason: RATIONALE });
    expect(outcome.result).toEqual({
      rationale: RATIONALE,
      citedAct: ACT,
      precedentKey: null,
      confirmation: null,
      targets: [{ entityId: grainId, key: "value", tier: "minor", amount: -2, counterpartId: null }],
    });
    expect("kind" in outcome).toBe(false);
  });

  it("records the whole ruling on its resolution.recorded event: rationale, cited act, tier, amount, precedent key and confirmation", () => {
    declareImprovisableConstraint({ gameId, resourceId: populationId, tiers: TIERS });
    const outcome = rule({
      targets: [
        { entityId: grainId, tier: "outrage", amount: 10 },
        { entityId: populationId, key: "value", tier: "serious", amount: -4 },
      ],
      rationale: RATIONALE,
      citedAct: ACT,
      precedentKey: "obstruction:grain",
      confirmation: "second-call-1",
    });
    const [event] = resolutionEvents();
    expect(event.id).toBe(outcome.eventId);
    expect(event.description).toBe(RATIONALE);
    const causes = JSON.parse(event.causes);
    expect(causes).toMatchObject({ source: "resolve", mechanic: IMPROVISED_RULING, change_count: 2 });
    expect(causes.result).toEqual({
      rationale: RATIONALE,
      citedAct: ACT,
      precedentKey: "obstruction:grain",
      confirmation: "second-call-1",
      targets: [
        { entityId: grainId, key: "value", tier: "outrage", amount: 10, counterpartId: null },
        { entityId: populationId, key: "value", tier: "serious", amount: -4, counterpartId: null },
      ],
    });
    expect([value(grainId), value(populationId)]).toEqual([60, 16]);
  });

  // ==========================================================================
  // Every refusal path -- each through the existing ConstraintViolationError,
  // each rolling back with no event recorded
  // ==========================================================================
  it("refuses a target that is not improvisable", () => {
    const err = refusal({ targets: [{ entityId: populationId, tier: "minor", amount: 1 }], rationale: RATIONALE, citedAct: ACT });
    expect(err.constraintKind).toBe("improvisable");
    expect(err.improvisation?.rule).toBe("not-improvisable");
    expect(value(populationId)).toBe(20);
    expect(resolutionEvents()).toHaveLength(0);
  });

  it("refuses a target that is bounded but not improvisable -- a bound is not a permission", () => {
    declareBoundedConstraint({ gameId, resourceId: treasuryId });
    const err = refusal({ targets: [{ entityId: treasuryId, tier: "minor", amount: 1 }], rationale: RATIONALE, citedAct: ACT });
    expect(err.improvisation?.rule).toBe("not-improvisable");
    expect(value(treasuryId)).toBe(50);
  });

  it("refuses a tier the target does not declare", () => {
    const err = refusal({ targets: [{ entityId: grainId, tier: "cosmic", amount: 1 }], rationale: RATIONALE, citedAct: ACT });
    expect(err.improvisation?.rule).toBe("undeclared-tier");
    expect(resolutionEvents()).toHaveLength(0);
  });

  it("passes exactly at the cap, refuses cap + epsilon, in both directions", () => {
    rule({ targets: [{ entityId: grainId, tier: "serious", amount: 5 }], rationale: RATIONALE, citedAct: ACT });
    rule({ targets: [{ entityId: grainId, tier: "serious", amount: -5 }], rationale: RATIONALE, citedAct: ACT });
    expect(value(grainId)).toBe(50);
    for (const amount of [5.000001, -5.000001]) {
      expect(refusal({ targets: [{ entityId: grainId, tier: "serious", amount }], rationale: RATIONALE, citedAct: ACT }).improvisation).toMatchObject({
        rule: "over-cap",
        cap: 5,
      });
    }
    expect(value(grainId)).toBe(50);
    expect(resolutionEvents()).toHaveLength(2);
  });

  it("refuses a tier that requires confirmation when the ruling carries none, and accepts it with one", () => {
    expect(refusal({ targets: [{ entityId: grainId, tier: "outrage", amount: -8 }], rationale: RATIONALE, citedAct: ACT }).improvisation?.rule).toBe(
      "confirmation-required"
    );
    expect(value(grainId)).toBe(50);
    rule({ targets: [{ entityId: grainId, tier: "outrage", amount: -8 }], rationale: RATIONALE, citedAct: ACT, confirmation: "second-call-2" });
    expect(value(grainId)).toBe(42);
  });

  it("with several targets, one bad target rolls back every one, and no event is recorded", () => {
    declareImprovisableConstraint({ gameId, resourceId: treasuryId, tiers: TIERS });
    const err = refusal({
      targets: [
        { entityId: grainId, tier: "minor", amount: 2 },
        { entityId: treasuryId, tier: "minor", amount: -1 },
        { entityId: populationId, tier: "minor", amount: 1 },
      ],
      rationale: RATIONALE,
      citedAct: ACT,
    });
    expect(err.resourceId).toBe(populationId);
    expect([value(grainId), value(treasuryId), value(populationId)]).toEqual([50, 50, 20]);
    expect(resolutionEvents()).toHaveLength(0);
  });

  // ==========================================================================
  // Interaction with the rest of the family
  // ==========================================================================
  it("a resolve_only value that is also improvisable receives a ruling through resolve, and still refuses a direct write", () => {
    declareResolveOnlyConstraint({ gameId, resourceId: grainId });
    rule({ targets: [{ entityId: grainId, tier: "minor", amount: 1 }], rationale: RATIONALE, citedAct: ACT });
    expect(value(grainId)).toBe(51);
    expect(() => writeConstrainedValue({ entityId: grainId, key: "value", mode: "delta", value: 1 })).toThrow(ConstraintViolationError);
    expect(value(grainId)).toBe(51);
  });

  it("a ruling within its cap is still held to a declared bound", () => {
    declareImprovisableConstraint({ gameId, resourceId: treasuryId, tiers: TIERS });
    declareBoundedConstraint({ gameId, resourceId: treasuryId });
    writeConstrainedValue({ entityId: treasuryId, key: "value", mode: "set", value: 99, bounds: { minValue: 0, maxValue: 100 } });
    const err = refusal({ targets: [{ entityId: treasuryId, tier: "minor", amount: 2 }], rationale: RATIONALE, citedAct: ACT });
    expect(err.constraintKind).toBe("bounded");
    expect(value(treasuryId)).toBe(99);
  });

  describe("a conserved target moves by transfer, never by a write", () => {
    beforeEach(() => {
      declareConservedConstraint({ gameId, resourceIds: [treasuryId, populationId], total: 70 });
      declareImprovisableConstraint({ gameId, resourceId: treasuryId, tiers: TIERS });
      declareImprovisableConstraint({ gameId, resourceId: populationId, tiers: TIERS });
    });

    it("a positive amount moves value from the counterpart to the target; a negative one moves it back; the total holds", () => {
      const gain = rule({ targets: [{ entityId: treasuryId, tier: "serious", amount: 4, counterpartId: populationId }], rationale: RATIONALE, citedAct: ACT });
      expect([value(treasuryId), value(populationId)]).toEqual([54, 16]);
      expect(gain.transitions.map((t) => [t.entityId, t.delta])).toEqual([
        [populationId, -4],
        [treasuryId, 4],
      ]);
      expect(gain.result.targets).toEqual([{ entityId: treasuryId, key: "value", tier: "serious", amount: 4, counterpartId: populationId }]);
      rule({ targets: [{ entityId: treasuryId, tier: "serious", amount: -5, counterpartId: populationId }], rationale: RATIONALE, citedAct: ACT });
      expect([value(treasuryId), value(populationId)]).toEqual([49, 21]);
    });

    it("without a counterpart, the existing conserved refusal applies -- an improvised ruling cannot break conservation", () => {
      const err = refusal({ targets: [{ entityId: treasuryId, tier: "minor", amount: 1 }], rationale: RATIONALE, citedAct: ACT });
      expect(err.constraintKind).toBe("conserved");
      expect([value(treasuryId), value(populationId)]).toEqual([50, 20]);
    });

    it("the transfer is held to the cap", () => {
      const err = refusal({ targets: [{ entityId: treasuryId, tier: "minor", amount: 3, counterpartId: populationId }], rationale: RATIONALE, citedAct: ACT });
      expect(err.improvisation?.rule).toBe("over-cap");
      expect([value(treasuryId), value(populationId)]).toEqual([50, 20]);
    });

    it("a counterpart outside the target's conserved set is refused", () => {
      const err = refusal({ targets: [{ entityId: treasuryId, tier: "minor", amount: 1, counterpartId: grainId }], rationale: RATIONALE, citedAct: ACT });
      expect(err.constraintKind).toBe("conserved");
    });
  });

  // ==========================================================================
  // Malformed parameters -- refused by the mechanic before any write
  // ==========================================================================
  it("refuses malformed parameters before anything is written", () => {
    const good = { entityId: grainId, tier: "minor", amount: 1 };
    const cases: Record<string, unknown>[] = [
      { rationale: RATIONALE, citedAct: ACT },
      { targets: [], rationale: RATIONALE, citedAct: ACT },
      { targets: "grain", rationale: RATIONALE, citedAct: ACT },
      { targets: [good], citedAct: ACT },
      { targets: [good], rationale: "", citedAct: ACT },
      { targets: [good], rationale: RATIONALE },
      { targets: [good], rationale: RATIONALE, citedAct: "" },
      { targets: [{ ...good, entityId: "" }], rationale: RATIONALE, citedAct: ACT },
      { targets: [{ ...good, tier: "" }], rationale: RATIONALE, citedAct: ACT },
      { targets: [{ ...good, key: "" }], rationale: RATIONALE, citedAct: ACT },
      { targets: [{ ...good, amount: "2" }], rationale: RATIONALE, citedAct: ACT },
      { targets: [{ ...good, amount: Number.NaN }], rationale: RATIONALE, citedAct: ACT },
      { targets: [{ ...good, amount: Number.POSITIVE_INFINITY }], rationale: RATIONALE, citedAct: ACT },
      { targets: [{ ...good, counterpartId: "" }], rationale: RATIONALE, citedAct: ACT },
      { targets: [{ ...good, counterpartId: grainId }], rationale: RATIONALE, citedAct: ACT },
      { targets: [good], rationale: RATIONALE, citedAct: ACT, precedentKey: "" },
      { targets: [good], rationale: RATIONALE, citedAct: ACT, precedentKey: 7 },
      { targets: [good], rationale: RATIONALE, citedAct: ACT, confirmation: "" },
    ];
    for (const parameters of cases) {
      expect(() => rule(parameters), JSON.stringify(parameters)).toThrow(/improvised ruling/);
    }
    expect(value(grainId)).toBe(50);
    expect(resolutionEvents()).toHaveLength(0);
  });

  it("refuses the same value named twice in one ruling -- two legs under one cap would add up past it", () => {
    declareConservedConstraint({ gameId, resourceIds: [treasuryId, populationId], total: 70 });
    declareImprovisableConstraint({ gameId, resourceId: treasuryId, tiers: TIERS });
    declareImprovisableConstraint({ gameId, resourceId: populationId, tiers: TIERS });
    const twice = [
      [
        { entityId: grainId, tier: "minor", amount: 2 },
        { entityId: grainId, tier: "minor", amount: 2 },
      ],
      [
        { entityId: grainId, tier: "minor", amount: 2 },
        { entityId: grainId, key: "value", tier: "serious", amount: 1 },
      ],
      [
        { entityId: treasuryId, tier: "minor", amount: 2, counterpartId: populationId },
        { entityId: populationId, tier: "minor", amount: 2, counterpartId: treasuryId },
      ],
    ];
    for (const targets of twice) {
      expect(() => rule({ targets, rationale: RATIONALE, citedAct: ACT })).toThrow(/names '.*' more than once/);
    }
    expect([value(grainId), value(treasuryId), value(populationId)]).toEqual([50, 50, 20]);
  });

  it("the same value under two different fact keys is two values, not one named twice", () => {
    declareImprovisableConstraint({ gameId, resourceId: treasuryId, tiers: TIERS });
    declareImprovisableConstraint({ gameId, resourceId: treasuryId, factKey: "max_value", tiers: TIERS });
    rule({
      targets: [
        { entityId: treasuryId, tier: "minor", amount: 1 },
        { entityId: treasuryId, key: "max_value", tier: "minor", amount: 1 },
      ],
      rationale: RATIONALE,
      citedAct: ACT,
    });
    expect(getResource(treasuryId)).toMatchObject({ value: 51, maxValue: 101 });
  });
});

describe("the package entry", () => {
  it("exports the mechanic, its name, and the declaration a consumer needs to use it", async () => {
    const pkg = await import("../../index.js");
    expect(pkg.improvisedRulingMechanic).toBe(improvisedRulingMechanic);
    expect(pkg.IMPROVISED_RULING).toBe(IMPROVISED_RULING);
    expect(typeof pkg.declareImprovisableConstraint).toBe("function");
  });
});

// ============================================================================
// The two generic changes to resolve() this mechanic stands on
// ============================================================================
describe("resolve() for any mechanic", () => {
  let db: Database.Database;
  let gameId: string;
  let grainId: string;

  beforeEach(() => {
    db = createTestDb();
    gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    grainId = createResource({ gameId, ownerType: "game", name: "grain", value: 50 }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("records the mechanic's own result on its resolution.recorded event, verbatim", () => {
    const HARVEST: Mechanic = { name: "HARVEST", adjudicate: () => ({ changes: [], result: { yielded: 3, notes: ["dry"] } }) };
    const outcome = createResolver({ mechanics: [HARVEST] }).resolve({ gameId, mechanic: "HARVEST" });
    const causes = JSON.parse((db.prepare(`SELECT causes FROM events WHERE id = ?`).get(outcome.eventId) as { causes: string }).causes);
    expect(causes.result).toEqual({ yielded: 3, notes: ["dry"] });
  });

  it("a mechanic that returns no result records none", () => {
    const TICK: Mechanic = { name: "TICK", adjudicate: () => ({}) };
    const outcome = createResolver({ mechanics: [TICK] }).resolve({ gameId, mechanic: "TICK" });
    const causes = JSON.parse((db.prepare(`SELECT causes FROM events WHERE id = ?`).get(outcome.eventId) as { causes: string }).causes);
    expect("result" in causes).toBe(false);
  });

  it("a hand-written mechanic's write tagged `improvised` is held to the same declaration", () => {
    const NUDGE: Mechanic = {
      name: "NUDGE",
      adjudicate: ({ parameters }) => ({
        changes: [{ kind: "write", entityId: grainId, key: "value", mode: "delta", value: parameters.by as number, improvised: { tier: "minor" } }],
      }),
    };
    const resolver = createResolver({ mechanics: [NUDGE] });
    expect(() => resolver.resolve({ gameId, mechanic: "NUDGE", parameters: { by: 1 } })).toThrow(ConstraintViolationError);
    declareImprovisableConstraint({ gameId, resourceId: grainId, tiers: TIERS });
    resolver.resolve({ gameId, mechanic: "NUDGE", parameters: { by: 2 } });
    expect(getResource(grainId)?.value).toBe(52);
    expect(() => resolver.resolve({ gameId, mechanic: "NUDGE", parameters: { by: 3 } })).toThrow(/at most 2/);
  });
});

// ============================================================================
// Over MCP: the mechanic registered with createCoreMcpServer, driven through
// a real client's `resolve` -- and a refusal reaching that client as data
// ============================================================================
describe("improvised ruling over MCP", () => {
  afterEach(() => {
    destroyTestDb();
  });

  it("declare, rule, and a refusal that names its rule without the client reading a sentence", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createCoreMcpServer } = await import("../../mcp-server.js");
    createTestDb();
    const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    const grainId = createResource({ gameId, ownerType: "game", name: "grain", value: 50 }).id;
    const server = createCoreMcpServer({ mechanics: [improvisedRulingMechanic()] });
    const [cs, ss] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "improvised", version: "0" });
    await Promise.all([server.connect(ss), client.connect(cs)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { isError: r.isError === true, body: JSON.parse(r.content[0].text) };
    };

    expect((await call("list_mechanics", {})).body).toEqual([IMPROVISED_RULING]);
    expect((await call("declare_resource_constraint", { gameId, kind: "improvisable", resourceId: grainId, tiers: TIERS })).isError).toBe(false);

    const ruled = await call("resolve", {
      gameId,
      mechanic: IMPROVISED_RULING,
      parameters: { targets: [{ entityId: grainId, tier: "minor", amount: 2 }], rationale: RATIONALE, citedAct: ACT, precedentKey: "obstruction:grain" },
    });
    expect(ruled.isError).toBe(false);
    expect(ruled.body.result.precedentKey).toBe("obstruction:grain");
    expect(getResource(grainId)?.value).toBe(52);

    const refused = await call("resolve", {
      gameId,
      mechanic: IMPROVISED_RULING,
      parameters: { targets: [{ entityId: grainId, tier: "minor", amount: 3 }], rationale: RATIONALE, citedAct: ACT },
    });
    expect(refused.isError).toBe(true);
    expect(refused.body).toMatchObject({
      errorCode: "CONSTRAINT_VIOLATION",
      entityId: grainId,
      constraintKind: "improvisable",
      improvisation: { rule: "over-cap", tier: "minor", amount: 3, cap: 2 },
    });
    expect(getResource(grainId)?.value).toBe(52);
    await client.close();
  });
});
