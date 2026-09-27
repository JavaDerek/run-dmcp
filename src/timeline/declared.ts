import { narrationConstraintAt, type ConstraintFact } from "./narration.js";
import { assertT, type T } from "./t.js";
import type { AdjudicationInput, Adjudication, IntendedChange, Mechanic } from "./resolve.js";

/**
 * Mechanics, gates and end conditions as DECLARED DATA (GitHub issue #41),
 * so a stock server can load a game whose rules would otherwise be
 * TypeScript handed to `createResolver` by whoever assembled it.
 *
 * DELIBERATELY SMALL. The issue's admission paragraph scopes the first cut to
 * what its real caller's rules are made of -- bounded changes to numeric
 * facts, and gates that open once a fact crosses a threshold -- "a small,
 * generic subset to start from, not a general rules language". So:
 *
 *   - a CONDITION is a named set of clauses (`all` or `any`), each comparing
 *     one stored fact to a declared value, or naming another condition;
 *   - a DECLARED MECHANIC applies its `legs` when every condition in `when`
 *     holds, and its `otherwise` legs (or nothing) when one does not;
 *   - a leg is `adjust` (current + sign * amount, clamped) or `set`.
 *
 * Anything else stays a TypeScript `Mechanic` -- that is the escape hatch, and
 * both kinds register side by side on one resolver. A rule that needs an
 * event ("after a search") rather than a fact, or arithmetic across
 * entities, is the escape hatch's, not a reason to grow this.
 *
 * THE ENGINE READS NONE OF IT FOR MEANING (hard rule 4). `id`, `name`,
 * `for`, `then` and `text` are opaque strings, compared for equality or
 * carried through. A clause compares a stored value with a declared one:
 * numerically when both are finite numbers, by equality otherwise -- a
 * structural comparison of the same kind `contradictions()` makes, never an
 * interpretation. `holds` is that comparison's result (hard rule 2): a row
 * saying a stored value meets a declared threshold, never "the game is won".
 *
 * WHY `for`/`then` LIVE HERE. A principal's condition list -- "if these hold,
 * this becomes available to you" -- is what measurably made model-driven
 * principals act on their unlocks. Declared once, the list a caller renders
 * and the gate a mechanic enforces are the SAME data, instead of prose kept
 * in step with code by a test.
 *
 * All of it is plain JSON, so it round-trips through a file unchanged; the
 * application loads one from `DMCP_RULES_FILE` (src/bin/run-dmcp.ts).
 */

export type ComparisonOp = "<" | "<=" | "==" | "!=" | ">=" | ">";
const OPS: readonly ComparisonOp[] = ["<", "<=", "==", "!=", ">=", ">"];

/** A value from the proposal's own parameters, by name. */
export interface ParamRef {
  param: string;
}

/** An entity: its id, a proposal parameter holding its id, or its name --
 *  resolved against the entities that have facts at `t`, and reported as
 *  unresolved when no entity or more than one carries that name. */
export type EntityOperand = string | ParamRef | { named: string };

export type FactClause = {
  entity: EntityOperand;
  key: string;
  op: ComparisonOp;
  value: number | string | ParamRef;
  /** Opaque, carried through for a caller's condition list. */
  text?: string;
};
export type ConditionClause = FactClause | { condition: string };

export interface DeclaredCondition {
  id: string;
  /** Opaque: whose condition this is, for rendering one principal's list. */
  for?: string;
  /** Opaque: what holding it makes available. */
  then?: string;
  all?: readonly ConditionClause[];
  any?: readonly ConditionClause[];
}

export type NumberOperand = number | ParamRef;

export type DeclaredLeg =
  | {
      kind: "adjust";
      entity: EntityOperand;
      key: string;
      amount: NumberOperand;
      /** 1 adds, -1 subtracts. Default 1. */
      sign?: 1 | -1;
      min?: NumberOperand | null;
      max?: NumberOperand | null;
    }
  | {
      kind: "set";
      entity: EntityOperand;
      key: string;
      value: number | string | null | ParamRef;
      min?: NumberOperand | null;
      max?: NumberOperand | null;
    };

export interface DeclaredMechanic {
  name: string;
  /** Condition ids that must ALL hold for `legs` to apply. */
  when?: readonly string[];
  legs: readonly DeclaredLeg[];
  /** Applied instead when a `when` condition does not hold. */
  otherwise?: readonly DeclaredLeg[];
}

export interface DeclaredRules {
  conditions: readonly DeclaredCondition[];
  mechanics: readonly DeclaredMechanic[];
}

export interface ClauseRow {
  /** Present for a fact clause. */
  entityId?: string | null;
  resolution?: "resolved" | "none" | "ambiguous";
  key?: string;
  op?: ComparisonOp;
  value?: number | string;
  observed?: number | string | null;
  /** Present for a clause naming another condition. */
  condition?: string;
  text?: string;
  holds: boolean;
}

export interface ConditionRow {
  id: string;
  for?: string;
  then?: string;
  holds: boolean;
  clauses: ClauseRow[];
}

// ============================================================================
// Validation -- once, before anything runs
// ============================================================================

function fail(message: string): never {
  throw new Error(`declared rules: ${message}`);
}

function isParamRef(v: unknown): v is ParamRef {
  return typeof v === "object" && v !== null && typeof (v as ParamRef).param === "string";
}

function checkEntity(where: string, entity: unknown): void {
  if (typeof entity === "string") return;
  if (isParamRef(entity)) return;
  if (typeof entity === "object" && entity !== null && typeof (entity as { named?: unknown }).named === "string") return;
  fail(`${where}: entity must be an id, {param}, or {named}, got ${JSON.stringify(entity)}`);
}

function checkNumberOperand(where: string, field: string, v: unknown, optional: boolean): void {
  if (v === undefined || v === null) {
    if (optional) return;
    fail(`${where}: '${field}' is required`);
  }
  if (typeof v === "number" && Number.isFinite(v)) return;
  if (isParamRef(v)) return;
  fail(`${where}: '${field}' must be a finite number or {param}, got ${JSON.stringify(v)}`);
}

function clausesOf(condition: DeclaredCondition): readonly ConditionClause[] {
  return condition.all ?? condition.any ?? [];
}

export function validateDeclaredRules(rules: DeclaredRules): void {
  if (!rules || !Array.isArray(rules.conditions) || !Array.isArray(rules.mechanics)) {
    fail("expected { conditions: [], mechanics: [] }");
  }
  const byId = new Map<string, DeclaredCondition>();
  for (const condition of rules.conditions) {
    if (typeof condition?.id !== "string" || condition.id.length === 0) fail(`a condition's 'id' must be a non-empty string`);
    if (byId.has(condition.id)) fail(`duplicate condition id '${condition.id}'`);
    byId.set(condition.id, condition);
    if ((condition.all === undefined) === (condition.any === undefined)) {
      fail(`condition '${condition.id}' must declare exactly one of 'all' or 'any'`);
    }
    const clauses = clausesOf(condition);
    if (!Array.isArray(clauses) || clauses.length === 0) fail(`condition '${condition.id}' needs at least one clause`);
    for (const clause of clauses) {
      if ("condition" in clause) continue;
      const where = `condition '${condition.id}'`;
      checkEntity(where, clause.entity);
      if (typeof clause.key !== "string" || clause.key.length === 0) fail(`${where}: a clause's 'key' must be a non-empty string`);
      if (!OPS.includes(clause.op)) fail(`${where}: unknown operator '${String(clause.op)}' (one of ${OPS.join(" ")})`);
      const v = clause.value;
      if (!(typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) || isParamRef(v))) {
        fail(`${where}: a clause's 'value' must be a number, a string or {param}, got ${JSON.stringify(v)}`);
      }
    }
  }
  // References resolve, and never loop.
  for (const condition of rules.conditions) {
    for (const clause of clausesOf(condition)) {
      if ("condition" in clause && !byId.has(clause.condition)) {
        fail(`condition '${condition.id}' names unknown condition '${clause.condition}'`);
      }
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") fail(`conditions form a cycle: ${[...path, id].join(" -> ")}`);
    state.set(id, "visiting");
    const condition = byId.get(id);
    for (const clause of condition ? clausesOf(condition) : []) {
      if ("condition" in clause) visit(clause.condition, [...path, id]);
    }
    state.set(id, "done");
  };
  for (const condition of rules.conditions) visit(condition.id, []);

  const names = new Set<string>();
  for (const mechanic of rules.mechanics) {
    if (typeof mechanic?.name !== "string" || mechanic.name.length === 0) fail(`a mechanic's 'name' must be a non-empty string`);
    if (names.has(mechanic.name)) fail(`duplicate mechanic name '${mechanic.name}'`);
    names.add(mechanic.name);
    for (const id of mechanic.when ?? []) {
      if (!byId.has(id)) fail(`mechanic '${mechanic.name}' is gated on unknown condition '${id}'`);
    }
    if (!Array.isArray(mechanic.legs)) fail(`mechanic '${mechanic.name}' must declare 'legs'`);
    for (const leg of [...mechanic.legs, ...(mechanic.otherwise ?? [])]) {
      const where = `mechanic '${mechanic.name}'`;
      if (leg?.kind !== "adjust" && leg?.kind !== "set") fail(`${where}: unknown leg kind '${String((leg as { kind?: unknown })?.kind)}'`);
      checkEntity(where, leg.entity);
      if (typeof leg.key !== "string" || leg.key.length === 0) fail(`${where}: a leg's 'key' must be a non-empty string`);
      if (leg.kind === "adjust") {
        checkNumberOperand(where, "amount", leg.amount, false);
        if (leg.sign !== undefined && leg.sign !== 1 && leg.sign !== -1) fail(`${where}: 'sign' must be 1 or -1`);
      }
      checkNumberOperand(where, "min", leg.min, true);
      checkNumberOperand(where, "max", leg.max, true);
    }
  }
}

// ============================================================================
// Evaluation -- over the facts at t, whoever asks
// ============================================================================

type Params = Readonly<Record<string, unknown>>;

function param(params: Params, name: string, type: "number" | "string" | "scalar"): number | string | null {
  const v = params[name];
  const ok =
    type === "number"
      ? typeof v === "number" && Number.isFinite(v)
      : type === "string"
        ? typeof v === "string"
        : typeof v === "string" || v === null || (typeof v === "number" && Number.isFinite(v));
  if (!ok) throw new Error(`declared rules: parameter '${name}' must be a ${type === "scalar" ? "number, string or null" : type}, got ${JSON.stringify(v)}`);
  return v as number | string | null;
}

function numberOf(operand: NumberOperand, params: Params): number {
  return isParamRef(operand) ? (param(params, operand.param, "number") as number) : operand;
}

/** Stored fact values are text; a value that reads as a finite number is compared as one. */
function asNumber(v: string | number | null): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface FactIndex {
  value(entityId: string, key: string): string | null;
  byName(name: string): { entityId: string | null; resolution: "resolved" | "none" | "ambiguous" };
}

function indexFacts(facts: readonly ConstraintFact[]): FactIndex {
  const values = new Map<string, string>();
  const idsByName = new Map<string, Set<string>>();
  for (const fact of facts) {
    values.set(`${fact.entityId}\u0000${fact.key}`, fact.value);
    if (fact.entityName !== null) {
      const ids = idsByName.get(fact.entityName) ?? new Set<string>();
      ids.add(fact.entityId);
      idsByName.set(fact.entityName, ids);
    }
  }
  return {
    value: (entityId, key) => values.get(`${entityId}\u0000${key}`) ?? null,
    byName: (name) => {
      const ids = idsByName.get(name);
      if (!ids || ids.size === 0) return { entityId: null, resolution: "none" };
      if (ids.size > 1) return { entityId: null, resolution: "ambiguous" };
      return { entityId: [...ids][0], resolution: "resolved" };
    },
  };
}

function resolveEntity(entity: EntityOperand, params: Params, facts: FactIndex) {
  if (typeof entity === "string") return { entityId: entity, resolution: "resolved" as const };
  if (isParamRef(entity)) return { entityId: param(params, entity.param, "string") as string, resolution: "resolved" as const };
  return facts.byName(entity.named);
}

function compare(observed: string | null, op: ComparisonOp, declared: number | string): boolean {
  if (observed === null) return false;
  const a = asNumber(observed);
  const b = asNumber(declared);
  if (a !== null && b !== null) {
    switch (op) {
      case "<": return a < b;
      case "<=": return a <= b;
      case "==": return a === b;
      case "!=": return a !== b;
      case ">=": return a >= b;
      case ">": return a > b;
    }
  }
  // Not both numbers: equality only, exact, no normalisation of any kind.
  if (op === "==") return observed === String(declared);
  if (op === "!=") return observed !== String(declared);
  return false;
}

/** Evaluates `roots` (default: every condition) and whatever they reference --
 *  lazily, so a gate never touches an unrelated condition, whose parameters
 *  the proposal has no reason to carry. */
function evaluateAll(rules: DeclaredRules, facts: FactIndex, params: Params, roots?: readonly string[]): Map<string, ConditionRow> {
  const byId = new Map(rules.conditions.map((c) => [c.id, c]));
  const rows = new Map<string, ConditionRow>();
  const evaluate = (id: string): ConditionRow => {
    const done = rows.get(id);
    if (done) return done;
    const condition = byId.get(id);
    if (!condition) throw new Error(`declared rules: unknown condition '${id}'`); // validated away; guarded, not asserted
    const clauses: ClauseRow[] = clausesOf(condition).map((clause) => {
      if ("condition" in clause) return { condition: clause.condition, holds: evaluate(clause.condition).holds };
      const { entityId, resolution } = resolveEntity(clause.entity, params, facts);
      const declared = isParamRef(clause.value) ? (param(params, clause.value.param, "scalar") as number | string) : clause.value;
      const raw = entityId === null ? null : facts.value(entityId, clause.key);
      const observedNumber = raw === null ? null : asNumber(raw);
      return {
        entityId,
        resolution,
        key: clause.key,
        op: clause.op,
        value: declared,
        observed: raw === null ? null : (observedNumber ?? raw),
        ...(clause.text !== undefined ? { text: clause.text } : {}),
        holds: compare(raw, clause.op, declared),
      };
    });
    const holds = condition.all ? clauses.every((c) => c.holds) : clauses.some((c) => c.holds);
    const row: ConditionRow = {
      id,
      ...(condition.for !== undefined ? { for: condition.for } : {}),
      ...(condition.then !== undefined ? { then: condition.then } : {}),
      holds,
      clauses,
    };
    rows.set(id, row);
    return row;
  };
  for (const id of roots ?? rules.conditions.map((c) => c.id)) evaluate(id);
  return rows;
}

/**
 * Every declared condition at `t`, in declared order, with whether it holds
 * and each clause's observed value -- or only the conditions whose `for`
 * equals the one given, which is a principal's condition list. Read-only.
 */
export function evaluateConditions(params: {
  gameId: string;
  t: T;
  rules: DeclaredRules;
  for?: string;
  parameters?: Params;
}): ConditionRow[] {
  validateDeclaredRules(params.rules);
  assertT(params.t);
  const facts = indexFacts(narrationConstraintAt({ gameId: params.gameId, t: params.t }).mustHonor);
  const rows = evaluateAll(params.rules, facts, params.parameters ?? {});
  return params.rules.conditions
    .filter((c) => params.for === undefined || c.for === params.for)
    .flatMap((c) => rows.get(c.id) ?? []);
}

// ============================================================================
// Mechanics -- ordinary `Mechanic`s built from the declaration
// ============================================================================

function legToChange(
  leg: DeclaredLeg,
  params: Params,
  facts: FactIndex
): { change: IntendedChange; record: { entityId: string; key: string; before: number | string | null; after: number | string | null } } {
  const { entityId } = resolveEntity(leg.entity, params, facts);
  if (entityId === null) {
    throw new Error(`declared rules: leg names entity ${JSON.stringify(leg.entity)}, which does not resolve to exactly one entity`);
  }
  const min = leg.min === undefined || leg.min === null ? null : numberOf(leg.min, params);
  const max = leg.max === undefined || leg.max === null ? null : numberOf(leg.max, params);
  const bounds = min !== null || max !== null ? { bounds: { minValue: min, maxValue: max } } : {};
  const beforeRaw = facts.value(entityId, leg.key);

  if (leg.kind === "adjust") {
    const before = beforeRaw === null ? null : asNumber(beforeRaw);
    if (before === null) {
      throw new Error(`declared rules: no numeric fact '${leg.key}' on entity '${entityId}' to adjust`);
    }
    let after = before + (leg.sign ?? 1) * numberOf(leg.amount, params);
    if (min !== null) after = Math.max(min, after);
    if (max !== null) after = Math.min(max, after);
    return {
      change: { kind: "write", entityId, key: leg.key, mode: "set", value: after, ...bounds },
      record: { entityId, key: leg.key, before, after },
    };
  }

  const value = isParamRef(leg.value) ? param(params, leg.value.param, "scalar") : leg.value;
  const before = beforeRaw === null ? null : (asNumber(beforeRaw) ?? beforeRaw);
  if (typeof value === "number") {
    return { change: { kind: "write", entityId, key: leg.key, mode: "set", value, ...bounds }, record: { entityId, key: leg.key, before, after: value } };
  }
  return { change: { kind: "set", entityId, key: leg.key, value }, record: { entityId, key: leg.key, before, after: value } };
}

/**
 * One `Mechanic` per declared mechanic, for `createResolver` beside any
 * hand-written ones. Each reads only the constraint `resolve()` hands it, like
 * every mechanic, and returns ordinary changes that go through the one choke
 * point. `result` records what it did: which gate conditions held, which leg
 * set applied (`legs`, `otherwise`, or `none`), and each leg's before/after.
 */
export function declaredMechanics(rules: DeclaredRules): Mechanic[] {
  validateDeclaredRules(rules);
  return rules.mechanics.map((declared) => ({
    name: declared.name,
    adjudicate(input: AdjudicationInput): Adjudication {
      const params = input.parameters ?? {};
      const facts = indexFacts(input.constraint.mustHonor);
      const evaluated = evaluateAll(rules, facts, params, declared.when ?? []);
      const when = (declared.when ?? []).map((id) => ({ id, holds: evaluated.get(id)?.holds === true }));
      const gateHolds = when.every((w) => w.holds);
      const legs = gateHolds ? declared.legs : (declared.otherwise ?? []);
      const applied = gateHolds ? "legs" : declared.otherwise && declared.otherwise.length > 0 ? "otherwise" : "none";
      const built = legs.map((leg) => legToChange(leg, params, facts));
      return {
        changes: built.map((b) => b.change),
        result: { applied, when, legs: built.map((b) => b.record) },
      };
    },
  }));
}
