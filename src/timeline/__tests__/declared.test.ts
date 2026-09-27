// GitHub issue #41: mechanics, gates and end conditions as DECLARED DATA a
// stock server can load. Today a game's mechanics are TypeScript handed to
// createResolver by whoever assembled the server, so a stock `run-dmcp`
// cannot load that game at all.
//
// Scope, per the issue's own admission paragraph: the first real caller's
// mechanics are bounded changes to numeric facts plus threshold gates. That
// subset, and nothing that would make this a rules language:
//
//   - a CONDITION is a named set of clauses compared structurally against the
//     facts at t (`all` or `any`; a clause may name another condition). Its
//     `for` and `then` are opaque text the engine carries and never reads --
//     which is what makes a principal's condition list a projection of the
//     SAME data that enforces its gates, rather than prose kept in step with
//     the gates by a test;
//   - a DECLARED MECHANIC applies `legs` when every condition in `when` holds,
//     and `otherwise` legs (or nothing) when one does not, recording which;
//   - a leg is `adjust` (current +/- amount, clamped to bounds) or `set`.
//
// Anything else stays a TypeScript `Mechanic`, which is the escape hatch: the
// two kinds register side by side on one resolver.
//
// Rows, never a verdict (hard rule 2): `holds` is a structural comparison of a
// stored value against a declared one -- the same kind of fact
// `contradictions()` reports -- never "the game is won". What a holding
// condition means is the caller's.
//
// Fixtures: grain, treasury, population.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../../tools/game.js";
import { createResource } from "../../tools/resource.js";
import { createResolver, type Mechanic } from "../resolve.js";
import { declareTimeAxis, setStoryTime } from "../clock.js";
import { declaredMechanics, evaluateConditions, validateDeclaredRules, type DeclaredRules } from "../declared.js";

const RULES = (ids: { grain: string; treasury: string }): DeclaredRules => ({
  conditions: [
    {
      id: "granary-full",
      for: "steward",
      then: "the surplus may be sold",
      all: [{ entity: ids.grain, key: "value", op: ">=", value: 80, text: "the granary holds at least 80" }],
    },
    {
      id: "coffers-low",
      all: [{ entity: { named: "treasury" }, key: "value", op: "<=", value: 20 }],
    },
    { id: "trade-open", for: "steward", then: "trade may begin", any: [{ condition: "granary-full" }, { condition: "coffers-low" }] },
  ],
  mechanics: [
    {
      name: "HARVEST",
      legs: [{ kind: "adjust", entity: { param: "store" }, key: "value", amount: { param: "amount" }, min: 0, max: 100 }],
    },
    {
      name: "SPEND",
      legs: [{ kind: "adjust", entity: { param: "store" }, key: "value", sign: -1, amount: { param: "amount" }, min: 0, max: 100 }],
    },
    {
      name: "SELL_SURPLUS",
      when: ["granary-full"],
      legs: [
        { kind: "adjust", entity: ids.grain, key: "value", sign: -1, amount: 30, min: 0, max: 100 },
        { kind: "adjust", entity: ids.treasury, key: "value", amount: 30, min: 0, max: 100 },
      ],
      otherwise: [{ kind: "adjust", entity: ids.treasury, key: "value", sign: -1, amount: 1, min: 0, max: 100 }],
    },
  ],
});

describe("declared rules (issue #41)", () => {
  let db: Database.Database;
  let gameId: string;
  let grain: string;
  let treasury: string;

  beforeEach(() => {
    db = createTestDb();
    gameId = createGame({ name: "depot", setting: "test", style: "test" }).id;
    declareTimeAxis({ gameId, axis: { kind: "counter", unit: "turn" } });
    grain = createResource({ gameId, ownerType: "game", name: "grain", value: 50, minValue: 0, maxValue: 100 }).id;
    treasury = createResource({ gameId, ownerType: "game", name: "treasury", value: 40, minValue: 0, maxValue: 100 }).id;
    setStoryTime({ gameId, t: 10 });
  });
  afterEach(() => destroyTestDb());

  const resolver = (extra: readonly Mechanic[] = []) =>
    createResolver({ mechanics: [...declaredMechanics(RULES({ grain, treasury })), ...extra] });
  const valueOf = (id: string) => (db.prepare(`SELECT value FROM resources WHERE id = ?`).get(id) as { value: number }).value;

  describe("declared mechanics", () => {
    it("adjust applies current + amount, clamped to its bounds, from proposal parameters", () => {
      const outcome = resolver().resolve({ gameId, mechanic: "HARVEST", parameters: { store: grain, amount: 70 } });
      expect(valueOf(grain)).toBe(100);
      expect(outcome.result).toEqual({ applied: "legs", when: [], legs: [{ entityId: grain, key: "value", before: 50, after: 100 }] });
    });

    it("sign -1 subtracts, and the clamp holds at the floor", () => {
      resolver().resolve({ gameId, mechanic: "SPEND", parameters: { store: treasury, amount: 90 } });
      expect(valueOf(treasury)).toBe(0);
    });

    it("a gate that holds applies `legs`, all in one resolution", () => {
      resolver().resolve({ gameId, mechanic: "HARVEST", parameters: { store: grain, amount: 40 } });
      setStoryTime({ gameId, t: 11 });
      const outcome = resolver().resolve({ gameId, mechanic: "SELL_SURPLUS" });
      expect([valueOf(grain), valueOf(treasury)]).toEqual([60, 70]);
      expect(outcome.result).toMatchObject({ applied: "legs", when: [{ id: "granary-full", holds: true }] });
    });

    it("a gate that does not hold applies `otherwise`, and records which condition failed", () => {
      const outcome = resolver().resolve({ gameId, mechanic: "SELL_SURPLUS" });
      expect([valueOf(grain), valueOf(treasury)]).toEqual([50, 39]);
      expect(outcome.result).toMatchObject({ applied: "otherwise", when: [{ id: "granary-full", holds: false }] });
    });

    it("a gate that does not hold with no `otherwise` changes nothing and says so", () => {
      const rules: DeclaredRules = {
        conditions: RULES({ grain, treasury }).conditions,
        mechanics: [{ name: "GATED", when: ["granary-full"], legs: [{ kind: "set", entity: grain, key: "value", value: 0 }] }],
      };
      const outcome = createResolver({ mechanics: declaredMechanics(rules) }).resolve({ gameId, mechanic: "GATED" });
      expect(valueOf(grain)).toBe(50);
      expect(outcome.result).toMatchObject({ applied: "none", legs: [] });
      expect(outcome.transitions).toEqual([]);
    });

    it("a set with bounds behaves exactly like the hand-written write with the same bounds -- one choke point", () => {
      const rules: DeclaredRules = {
        conditions: [],
        mechanics: [{ name: "OVERFILL", legs: [{ kind: "set", entity: grain, key: "value", value: 150, min: 0, max: 100 }] }],
      };
      const handWritten: Mechanic = {
        name: "OVERFILL_TS",
        adjudicate: () => ({ changes: [{ kind: "write", entityId: grain, key: "value", mode: "set", value: 150, bounds: { minValue: 0, maxValue: 100 } }] }),
      };
      const r = createResolver({ mechanics: [...declaredMechanics(rules), handWritten] });
      let declaredError: unknown, tsError: unknown;
      try { r.resolve({ gameId, mechanic: "OVERFILL" }); } catch (e) { declaredError = e; }
      const afterDeclared = valueOf(grain);
      try { r.resolve({ gameId, mechanic: "OVERFILL_TS" }); } catch (e) { tsError = e; }
      expect(String(declaredError)).toBe(String(tsError));
      expect(afterDeclared).toBe(valueOf(grain));
    });

    it("a string `set` becomes a non-numeric set leg", () => {
      const rules: DeclaredRules = {
        conditions: [],
        mechanics: [{ name: "RENAME", legs: [{ kind: "set", entity: { param: "who" }, key: "name", value: { param: "to" } }] }],
      };
      const outcome = createResolver({ mechanics: declaredMechanics(rules) }).resolve({
        gameId,
        mechanic: "RENAME",
        parameters: { who: grain, to: "seed grain" },
      });
      expect(outcome.sets).toEqual([expect.objectContaining({ entityId: grain, key: "name", previousValue: "grain", newValue: "seed grain" })]);
    });

    it("a gate evaluates only the conditions it names (and theirs), never an unrelated condition's parameters", () => {
      const rules: DeclaredRules = {
        conditions: [
          { id: "store-full", all: [{ entity: { param: "store" }, key: "value", op: ">=", value: 50 }] },
          { id: "other", all: [{ entity: { param: "somethingElse" }, key: "value", op: "==", value: 1 }] },
        ],
        mechanics: [{ name: "DRAW", when: ["store-full"], legs: [{ kind: "adjust", entity: { param: "store" }, key: "value", sign: -1, amount: 5 }] }],
      };
      const outcome = createResolver({ mechanics: declaredMechanics(rules) }).resolve({ gameId, mechanic: "DRAW", parameters: { store: grain } });
      expect(outcome.result).toMatchObject({ applied: "legs", when: [{ id: "store-full", holds: true }] });
      expect(valueOf(grain)).toBe(45);
    });

    it("declared and hand-written mechanics share one resolver; a clash of names is refused at construction", () => {
      const ts: Mechanic = { name: "TALLY", adjudicate: () => ({ result: { counted: true } }) };
      expect(resolver([ts]).resolve({ gameId, mechanic: "TALLY" }).result).toEqual({ counted: true });
      expect(() => resolver([{ name: "HARVEST", adjudicate: () => ({}) }])).toThrow(/HARVEST/);
    });

    it("an adjust on a fact that does not exist is refused with the entity and key named", () => {
      expect(() => resolver().resolve({ gameId, mechanic: "HARVEST", parameters: { store: "no-such-entity", amount: 1 } })).toThrow(
        /no numeric fact 'value' on entity 'no-such-entity'/
      );
    });

    it("a missing or wrong-typed parameter is refused naming it", () => {
      expect(() => resolver().resolve({ gameId, mechanic: "HARVEST", parameters: { store: grain } })).toThrow(/parameter 'amount'/);
      expect(() => resolver().resolve({ gameId, mechanic: "HARVEST", parameters: { store: grain, amount: "7" } })).toThrow(
        /parameter 'amount'/
      );
    });
  });

  describe("evaluateConditions: the condition list, from the same data", () => {
    it("reports every condition with holds and each clause's observed value", () => {
      const rows = evaluateConditions({ gameId, t: 10, rules: RULES({ grain, treasury }) });
      expect(rows.map((r) => [r.id, r.holds])).toEqual([
        ["granary-full", false],
        ["coffers-low", false],
        ["trade-open", false],
      ]);
      expect(rows[0]).toMatchObject({
        for: "steward",
        then: "the surplus may be sold",
        clauses: [{ entityId: grain, key: "value", op: ">=", value: 80, observed: 50, holds: false, text: "the granary holds at least 80" }],
      });
    });

    it("any/all and condition references compose, evaluated at the t asked", () => {
      createResolver({ mechanics: declaredMechanics(RULES({ grain, treasury })) }).resolve({
        gameId,
        mechanic: "SPEND",
        parameters: { store: treasury, amount: 25 },
      });
      const rows = evaluateConditions({ gameId, t: 10, rules: RULES({ grain, treasury }) });
      expect(rows.map((r) => [r.id, r.holds])).toEqual([
        ["granary-full", false],
        ["coffers-low", true],
        ["trade-open", true],
      ]);
    });

    it("`for` narrows to one principal's list, in declared order", () => {
      const rows = evaluateConditions({ gameId, t: 10, rules: RULES({ grain, treasury }), for: "steward" });
      expect(rows.map((r) => r.id)).toEqual(["granary-full", "trade-open"]);
    });

    it("a named entity that is absent or ambiguous is reported, and its clause does not hold", () => {
      createResource({ gameId, ownerType: "game", name: "treasury", value: 5, minValue: 0, maxValue: 100 });
      const rows = evaluateConditions({ gameId, t: 10, rules: RULES({ grain, treasury }) });
      expect(rows[1].clauses[0]).toMatchObject({ entityId: null, resolution: "ambiguous", holds: false });
    });

    it("string values compare by equality only; an ordering against a non-number does not hold", () => {
      const rules: DeclaredRules = {
        conditions: [
          { id: "named-grain", all: [{ entity: grain, key: "name", op: "==", value: "grain" }] },
          { id: "not-named", all: [{ entity: grain, key: "name", op: "!=", value: "rice" }] },
          { id: "ordered-text", all: [{ entity: grain, key: "name", op: ">", value: 3 }] },
        ],
        mechanics: [],
      };
      expect(evaluateConditions({ gameId, t: 10, rules }).map((r) => r.holds)).toEqual([true, true, false]);
    });
  });

  describe("validateDeclaredRules refuses a malformed declaration before anything runs", () => {
    const ok = () => RULES({ grain: "g", treasury: "t" });
    const cases: Array<[string, (r: DeclaredRules) => DeclaredRules, RegExp]> = [
      ["duplicate condition id", (r) => ({ ...r, conditions: [...r.conditions, r.conditions[0]] }), /duplicate condition id 'granary-full'/],
      ["duplicate mechanic name", (r) => ({ ...r, mechanics: [...r.mechanics, r.mechanics[0]] }), /duplicate mechanic name 'HARVEST'/],
      ["a gate naming no condition", (r) => ({ ...r, mechanics: [{ name: "X", when: ["nope"], legs: [] }] }), /unknown condition 'nope'/],
      ["a clause naming no condition", (r) => ({ ...r, conditions: [{ id: "c", all: [{ condition: "nope" }] }] }), /unknown condition 'nope'/],
      [
        "a cycle of conditions",
        (r) => ({ ...r, conditions: [{ id: "a", all: [{ condition: "b" }] }, { id: "b", any: [{ condition: "a" }] }] }),
        /cycle: a -> b -> a/,
      ],
      ["both all and any", (r) => ({ ...r, conditions: [{ id: "c", all: [], any: [] } as never] }), /exactly one of 'all' or 'any'/],
      ["an empty clause list", (r) => ({ ...r, conditions: [{ id: "c", all: [] }] }), /at least one clause/],
      ["an unknown operator", (r) => ({ ...r, conditions: [{ id: "c", all: [{ entity: "g", key: "v", op: "~" as never, value: 1 }] }] }), /operator '~'/],
      ["an unknown leg kind", (r) => ({ ...r, mechanics: [{ name: "X", legs: [{ kind: "burn" } as never] }] }), /leg kind 'burn'/],
      ["adjust with a string amount", (r) => ({ ...r, mechanics: [{ name: "X", legs: [{ kind: "adjust", entity: "g", key: "v", amount: "5" as never }] }] }), /amount/],
    ];
    it("accepts the fixture", () => expect(() => validateDeclaredRules(ok())).not.toThrow());
    for (const [name, mutate, message] of cases) {
      it(name, () => expect(() => validateDeclaredRules(mutate(ok()))).toThrow(message));
    }
    it("declaredMechanics validates too", () => {
      expect(() => declaredMechanics({ conditions: [], mechanics: [{ name: "X", when: ["nope"], legs: [] }] })).toThrow(/unknown condition/);
    });
  });

  it("the whole declaration round-trips through JSON unchanged -- it is data, loadable from a file", () => {
    const rules = RULES({ grain, treasury });
    const reloaded = JSON.parse(JSON.stringify(rules)) as DeclaredRules;
    const a = evaluateConditions({ gameId, t: 10, rules });
    const b = evaluateConditions({ gameId, t: 10, rules: reloaded });
    expect(b).toEqual(a);
  });
});
