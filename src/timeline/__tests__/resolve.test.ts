// `resolve.ts` -- design §5.2a, GitHub issue #10: the inbound half of the
// authority contract. propose -> adjudicate -> outcome. The engine enforces
// the PROTOCOL -- resolution precedes narration, writes go through the
// audited path, declared constraints are checked -- WITHOUT knowing what any
// particular mechanic means. A caller registers its mechanics as a parameter
// at construction (createResolver), the same way initializeSchema takes
// `migrations` (src/db/schema.ts) rather than a global registry -- a registry
// would make behaviour depend on module import order, which is the disease
// the entry-point split cured. A parameter cannot be "registered too late".
//
// STOP CONDITION (issue #10, label `stop-condition`): every test below must
// be writable in neutral fixtures -- grain, treasury, population -- without
// ever naming a consumer's domain concept. Mechanic names are HARVEST,
// TITHE, CENSUS: throwaway, not a starter set anyone should build a real
// game on (src/__tests__/engineVocabulary.test.ts enforces this at the
// vocabulary level; this file additionally proves it at the API level, since
// every mechanic below is exercised entirely through generic entity/fact
// writes with no domain meaning attached to any of them).
//
// Fixture idiom copied from resolveOnly.test.ts / narration.test.ts:
// createTestDb/createGame/createResource over the real tool layer (never a
// second hand-rolled fixture), plus the real constraint/adjudication/
// constrained-write modules this protocol is built out of.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../../tools/game.js";
import { createResource, getResource } from "../../tools/resource.js";
import * as constraintTools from "../../tools/constraint.js";
import { ConstraintViolationError } from "../registry.js";
import { writeConstrainedValue, valueHistory } from "../constrained.js";
import { adjudicationOpen } from "../adjudication.js";
import { changesWithin } from "../changes.js";
import { currentStoryTime } from "../clock.js";
import {
  createResolver,
  ResolveProtocolError,
  type Mechanic,
  type AdjudicationInput,
  type Adjudication,
} from "../resolve.js";

describe("resolve protocol (design §5.2a, issue #10)", () => {
  let db: Database.Database;
  let gameId: string;
  let grainId: string;
  let treasuryId: string;
  let populationId: string;

  beforeEach(() => {
    db = createTestDb();
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    gameId = game.id;
    grainId = createResource({ gameId, ownerType: "game", name: "grain", value: 50 }).id;
    treasuryId = createResource({
      gameId,
      ownerType: "game",
      name: "treasury",
      value: 50,
      minValue: 0,
      maxValue: 100,
    }).id;
    populationId = createResource({ gameId, ownerType: "game", name: "population", value: 20 }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  /** Every `resolution.recorded` event this game has accumulated -- the one
   *  kind resolve.ts's own apply phase writes, so this doubles as "how many
   *  times has a resolution actually completed" for a rollback assertion. */
  function countResolutionEvents(): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE game_id = ? AND kind = 'resolution.recorded'`)
      .get(gameId) as { c: number };
    return row.c;
  }

  // ==========================================================================
  // createResolver -- validation at construction, modeled on validateMigrations
  // (src/db/schema.ts): reject a bad name, a duplicate name, a missing
  // adjudicate function, in the same error voice.
  // ==========================================================================
  describe("createResolver", () => {
    it("accepts an empty mechanics list -- a resolver with a generic resolve surface and nothing registered", () => {
      const resolver = createResolver({ mechanics: [] });
      expect(resolver.mechanics()).toEqual([]);
    });

    it("rejects a non-string name", () => {
      const bad = [{ name: 123 as unknown as string, adjudicate: () => ({}) }];
      expect(() => createResolver({ mechanics: bad })).toThrow(/name.*non-empty string/i);
    });

    it("rejects an empty/whitespace name", () => {
      const bad: Mechanic[] = [{ name: "   ", adjudicate: () => ({}) }];
      expect(() => createResolver({ mechanics: bad })).toThrow(/non-empty string/i);
    });

    it("rejects a duplicate mechanic name", () => {
      const bad: Mechanic[] = [
        { name: "HARVEST", adjudicate: () => ({}) },
        { name: "HARVEST", adjudicate: () => ({}) },
      ];
      expect(() => createResolver({ mechanics: bad })).toThrow(/duplicate mechanic name/i);
    });

    it("rejects a mechanic with no adjudicate function", () => {
      const bad = [{ name: "HARVEST" }] as unknown as Mechanic[];
      expect(() => createResolver({ mechanics: bad })).toThrow(/no 'adjudicate' function/i);
    });

    it("mechanics() returns every registered name in registration order -- the engine holds them, never reads meaning into them", () => {
      const resolver = createResolver({
        mechanics: [
          { name: "HARVEST", adjudicate: () => ({}) },
          { name: "TITHE", adjudicate: () => ({}) },
          { name: "CENSUS", adjudicate: () => ({}) },
        ],
      });
      expect(resolver.mechanics()).toEqual(["HARVEST", "TITHE", "CENSUS"]);
    });
  });

  // ==========================================================================
  // resolve() -- the protocol itself
  // ==========================================================================
  describe("resolve", () => {
    it("happy path: dispatches the registered mechanic, writes through the choke point, and returns an outcome", () => {
      let received: AdjudicationInput | undefined;
      const harvest: Mechanic = {
        name: "HARVEST",
        adjudicate: (input) => {
          received = input;
          return {
            changes: [{ kind: "write", entityId: grainId, key: "value", mode: "delta", value: 15, reason: "harvest" }],
            result: { magnitude: 3 },
            description: "the harvest came in",
          };
        },
      };
      const resolver = createResolver({ mechanics: [harvest] });

      const outcome = resolver.resolve({ gameId, mechanic: "HARVEST", parameters: { season: "autumn" } });

      expect(outcome.gameId).toBe(gameId);
      expect(outcome.mechanic).toBe("HARVEST");
      expect(typeof outcome.resolutionId).toBe("string");
      expect(outcome.resolutionId.length).toBeGreaterThan(0);
      expect(typeof outcome.eventId).toBe("string");
      expect(outcome.result).toEqual({ magnitude: 3 });
      expect(outcome.transitions).toHaveLength(1);
      expect(outcome.transitions[0]).toMatchObject({
        entityId: grainId,
        key: "value",
        previousValue: 50,
        newValue: 65,
        delta: 15,
      });

      expect(getResource(grainId)?.value).toBe(65);
      expect(countResolutionEvents()).toBe(1);

      // The mechanic's read surface: gameId, the mechanic's own name, a t,
      // parameters verbatim, and a constraint -- and nothing resembling a
      // database handle (it is a plain serialized object, per narration.ts).
      expect(received?.mechanic).toBe("HARVEST");
      expect(received?.gameId).toBe(gameId);
      expect(received?.parameters).toEqual({ season: "autumn" });
      expect(received?.constraint.gameId).toBe(gameId);
      expect(typeof received?.t).toBe("number");
    });

    it("refuses an unknown mechanic before anything happens -- no window, no write, no event", () => {
      const resolver = createResolver({ mechanics: [] });
      const before = getResource(grainId)?.value;

      let caught: unknown;
      try {
        resolver.resolve({ gameId, mechanic: "HARVEST" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ResolveProtocolError);
      expect((caught as ResolveProtocolError).reason).toBe("unknown-mechanic");
      expect(getResource(grainId)?.value).toBe(before);
      expect(countResolutionEvents()).toBe(0);
      expect(adjudicationOpen()).toBe(false);
    });

    it("refuses when the game has no timeline clock -- names what is missing, not a verdict about the world", () => {
      const resolver = createResolver({ mechanics: [{ name: "HARVEST", adjudicate: () => ({}) }] });

      let caught: unknown;
      try {
        resolver.resolve({ gameId: "no-such-game-has-ever-written-anything", mechanic: "HARVEST" });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ResolveProtocolError);
      expect((caught as ResolveProtocolError).reason).toBe("no-clock");
    });

    it("carries the mechanic's opaque result to the outcome verbatim, uninspected", () => {
      const payload = { yield: 12, quality: "fine", nested: { grain: true } };
      const resolver = createResolver({
        mechanics: [{ name: "HARVEST", adjudicate: () => ({ result: payload }) }],
      });

      const outcome = resolver.resolve({ gameId, mechanic: "HARVEST" });

      expect(outcome.result).toEqual(payload);
    });

    it("reads nothing into a mechanic's name -- two mechanics sharing one function differ only by the name dispatched", () => {
      const inputs: AdjudicationInput[] = [];
      const shared = (input: AdjudicationInput): Adjudication => {
        inputs.push(input);
        return { result: { tally: 7 } };
      };
      const resolver = createResolver({
        mechanics: [
          { name: "HARVEST", adjudicate: shared },
          { name: "TITHE", adjudicate: shared },
        ],
      });

      const first = resolver.resolve({ gameId, mechanic: "HARVEST" });
      const second = resolver.resolve({ gameId, mechanic: "TITHE" });

      expect(inputs).toHaveLength(2);
      expect(inputs[0].gameId).toBe(inputs[1].gameId);
      expect(inputs[0].t).toBe(inputs[1].t);
      expect(inputs[0].parameters).toEqual(inputs[1].parameters);
      expect(inputs[0].constraint).toEqual(inputs[1].constraint);
      expect(inputs[0].mechanic).toBe("HARVEST");
      expect(inputs[1].mechanic).toBe("TITHE");

      expect(first.result).toEqual(second.result);
      expect(first.t).toBe(second.t);
      expect(first.gameId).toBe(second.gameId);
      expect(first.transitions).toEqual(second.transitions);
      expect(first.constraint).toEqual(second.constraint);
      expect(first.mechanic).toBe("HARVEST");
      expect(second.mechanic).toBe("TITHE");
      // The only things unique per CALL, never per NAME.
      expect(first.resolutionId).not.toBe(second.resolutionId);
      expect(first.eventId).not.toBe(second.eventId);
    });

    it("writes land through the audited path -- valueHistory and changesWithin both see them", () => {
      const resolver = createResolver({
        mechanics: [
          {
            name: "HARVEST",
            adjudicate: () => ({
              changes: [{ kind: "write", entityId: grainId, key: "value", mode: "delta", value: 15 }],
            }),
          },
        ],
      });
      const before = currentStoryTime(gameId)?.t ?? 0;

      const outcome = resolver.resolve({ gameId, mechanic: "HARVEST" });

      const history = valueHistory(grainId, "value");
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ previousValue: 50, newValue: 65, delta: 15 });

      const changeSet = changesWithin({ gameId, t0: before, t1: outcome.constraint.t + 1 });
      const opened = changeSet.changes.find(
        (c) => c.kind === "fact" && c.entityId === grainId && c.factKey === "value" && c.endpoint === "opened"
      );
      expect(opened).toBeDefined();
    });

    it("refuses a contradicted expectation BEFORE dispatch, carrying one hop, and writes nothing (planted-and-watched-red guard)", () => {
      let calls = 0;
      const resolver = createResolver({
        mechanics: [
          {
            name: "HARVEST",
            adjudicate: () => {
              calls++;
              return { changes: [{ kind: "write", entityId: grainId, key: "value", mode: "delta", value: 15 }] };
            },
          },
        ],
      });

      let caught: unknown;
      try {
        resolver.resolve({
          gameId,
          mechanic: "HARVEST",
          expects: [{ entityId: grainId, key: "value", value: 999 }],
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ResolveProtocolError);
      const err = caught as ResolveProtocolError;
      expect(err.reason).toBe("expectation-contradicted");
      const found = err.contradictions ?? [];
      expect(found).toHaveLength(1);
      expect(found[0].claim).toMatchObject({ entityId: grainId, key: "value", value: 999 });
      expect(found[0].fact.entityId).toBe(grainId);
      expect(found[0].fact.key).toBe("value");

      // The call counter is the whole point of this test: the mechanic must
      // never see dispatch when its own caller's declared precondition does
      // not hold.
      expect(calls).toBe(0);
      expect(getResource(grainId)?.value).toBe(50);
      expect(valueHistory(grainId, "value")).toEqual([]);
      expect(countResolutionEvents()).toBe(0);
    });

    it("builds the outcome's constraint AFTER the writes land -- resolution precedes narration as a protocol property", () => {
      const resolver = createResolver({
        mechanics: [
          {
            name: "HARVEST",
            adjudicate: () => ({
              changes: [{ kind: "write", entityId: grainId, key: "value", mode: "delta", value: 15 }],
            }),
          },
        ],
      });

      const outcome = resolver.resolve({ gameId, mechanic: "HARVEST" });

      const fact = outcome.constraint.mustHonor.find((f) => f.entityId === grainId && f.key === "value");
      expect(fact).toBeDefined();
      expect(Number(fact?.value)).toBe(65);
      // The constraint's own t can never precede the write that produced it.
      expect(outcome.constraint.t).toBeGreaterThanOrEqual(outcome.t);
    });

    it("rolls back EVERY write and records NO event when a constraint is violated mid-adjudication (planted-and-watched-red guard)", () => {
      constraintTools.declareMonotonicConstraint({ gameId, resourceId: populationId, direction: "increasing" });

      const resolver = createResolver({
        mechanics: [
          {
            name: "CENSUS",
            adjudicate: () => ({
              changes: [
                // Legal on its own -- would succeed if it were the only change.
                { kind: "write", entityId: grainId, key: "value", mode: "delta", value: 15 },
                // Violates the monotonic-increasing constraint just declared.
                { kind: "write", entityId: populationId, key: "value", mode: "delta", value: -5 },
              ],
            }),
          },
        ],
      });

      expect(() => resolver.resolve({ gameId, mechanic: "CENSUS" })).toThrow(ConstraintViolationError);

      expect(getResource(grainId)?.value).toBe(50);
      expect(getResource(populationId)?.value).toBe(20);
      expect(valueHistory(grainId, "value")).toEqual([]);
      expect(valueHistory(populationId, "value")).toEqual([]);
      expect(countResolutionEvents()).toBe(0);
      expect(adjudicationOpen()).toBe(false);
    });

    it("is re-entrant: a mechanic may itself propose and resolve a second mechanic through the same resolver", () => {
      // eslint-disable-next-line prefer-const -- assigned after createResolver, read only inside a later resolve() call
      let resolver!: ReturnType<typeof createResolver>;

      const census: Mechanic = {
        name: "CENSUS",
        adjudicate: () => ({
          changes: [{ kind: "write", entityId: populationId, key: "value", mode: "delta", value: 3 }],
        }),
      };
      const harvest: Mechanic = {
        name: "HARVEST",
        adjudicate: () => {
          // Dispatch always happens BEFORE any transaction/window opens
          // (mechanics get no database handle and never write), so a full,
          // independent nested resolve() call here is a legal use of the
          // same resolver -- and proves no per-call state (a "current
          // proposal", a shared changes accumulator) leaks between calls.
          resolver.resolve({ gameId, mechanic: "CENSUS" });
          return { changes: [{ kind: "write", entityId: grainId, key: "value", mode: "delta", value: 15 }] };
        },
      };
      resolver = createResolver({ mechanics: [harvest, census] });

      const outcome = resolver.resolve({ gameId, mechanic: "HARVEST" });

      expect(getResource(grainId)?.value).toBe(65);
      expect(getResource(populationId)?.value).toBe(23);
      // The outer outcome reports only HARVEST's own change -- the nested
      // CENSUS resolution is a separate, already-completed call with its
      // own Outcome, not folded into this one.
      expect(outcome.transitions).toHaveLength(1);
      expect(outcome.transitions[0].entityId).toBe(grainId);
      expect(countResolutionEvents()).toBe(2);
      expect(adjudicationOpen()).toBe(false);
    });

    it("resolve_only payoff: a direct write is refused, and the identical change through resolve() succeeds", () => {
      constraintTools.declareResolveOnlyConstraint({ gameId, resourceId: treasuryId });

      expect(() => writeConstrainedValue({ entityId: treasuryId, key: "value", mode: "delta", value: 10 })).toThrow(
        ConstraintViolationError
      );
      expect(getResource(treasuryId)?.value).toBe(50);

      const resolver = createResolver({
        mechanics: [
          {
            name: "TITHE",
            adjudicate: () => ({
              changes: [{ kind: "write", entityId: treasuryId, key: "value", mode: "delta", value: 10 }],
            }),
          },
        ],
      });

      const outcome = resolver.resolve({ gameId, mechanic: "TITHE" });

      expect(outcome.transitions[0]).toMatchObject({ entityId: treasuryId, previousValue: 50, newValue: 60 });
      expect(getResource(treasuryId)?.value).toBe(60);
    });

    it("supports a transfer between conserved members as an IntendedTransfer", () => {
      // A conserved set needs its members to already sum to the declared
      // total -- grain (50) and treasury (50) sum to 100.
      constraintTools.declareConservedConstraint({ gameId, resourceIds: [grainId, treasuryId], total: 100 });

      const resolver = createResolver({
        mechanics: [
          {
            name: "TITHE",
            adjudicate: () => ({
              changes: [
                { kind: "transfer", fromEntityId: grainId, toEntityId: treasuryId, key: "value", amount: 10 },
              ],
            }),
          },
        ],
      });

      const outcome = resolver.resolve({ gameId, mechanic: "TITHE" });

      expect(outcome.transitions).toHaveLength(2);
      expect(getResource(grainId)?.value).toBe(40);
      expect(getResource(treasuryId)?.value).toBe(60);
    });
  });
});
