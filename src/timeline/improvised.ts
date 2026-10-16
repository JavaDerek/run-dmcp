import type { AdjudicationInput, Adjudication, IntendedChange, Mechanic } from "./resolve.js";

/**
 * The improvised ruling (design §5.2a, §5.3): an act no listed mechanic fits
 * still HAPPENS, and when it plausibly touches something, it receives a
 * small, bounded ruling on a value the game declared `improvisable`. This
 * module is the engine-provided mechanic that carries one.
 *
 * A MECHANIC KIND, NOT AN OUTCOME KIND. `resolve()` still returns an
 * `Outcome` or refuses, and `Outcome` still has no kind field. An improvised
 * ruling is an ordinary resolve whose caller picks the values, the tier and
 * the amounts; every leg goes through the one choke point (hard rule 7)
 * tagged `improvised`, so the target's declared caps, bounds, conservation,
 * `resolve_only`, the transaction and its rollback, and the
 * `resolution.recorded` event all apply unchanged. There is no second write
 * path here and no second set of refusals: a target that is not
 * improvisable, a tier it does not declare, an amount past the tier's cap,
 * or a missing confirmation where the tier requires one are refused by
 * `assertConstraintsAllow` (constrained.ts) as a `ConstraintViolationError`
 * of kind `improvisable`, and the whole ruling rolls back.
 *
 * WHAT THIS MODULE REFUSES ITSELF is only the SHAPE of its parameters --
 * missing rationale, a non-numeric amount, a value named twice -- before any
 * change is returned, the way `declaredMechanics` (declared.ts) refuses a
 * malformed proposal. Naming one value twice is refused because two legs
 * under one cap would add up past it.
 *
 * THE ENGINE RECORDS DECISIONS; IT DOES NOT MAKE THEM (hard rule 2). Which
 * value an act touches, which tier it deserves and how much it moves are the
 * caller's ruling, typically a model's at the boundary; the engine only
 * holds that ruling to what the game declared. In particular the
 * `confirmation` reference is RECORDED, never judged: where a tier requires
 * one, the engine checks that a reference is present and keeps it on the
 * event. Whether the confirmation behind it was independent of the ruling --
 * a second call, a second reader, a person -- is the caller's guarantee to
 * make; the engine cannot tell, and does not pretend to.
 *
 * NOTHING HERE IS READ FOR MEANING (hard rule 4). `rationale`, `citedAct` and
 * `precedentKey` are carried verbatim onto the outcome's `result` and from
 * there onto the `resolution.recorded` event's `causes.result`, so every
 * improvised ruling is auditable on the timeline: the act, the values, the
 * tier, the amounts, the reason, the precedent key and the confirmation.
 * `precedentKey` is stored only. Finding an earlier ruling with the same key,
 * and reusing it, is a later step and not built here.
 *
 * A CONSERVED TARGET MOVES BY TRANSFER. A target with `counterpartId` becomes
 * a transfer between the two -- a positive amount moves value from the
 * counterpart to the target, a negative one from the target to the
 * counterpart -- through the existing conserved transfer, which holds the
 * total and refuses a counterpart outside the target's set. A conserved
 * target without one is a direct write, refused as `conserved` exactly as
 * any other direct write to a conserved member is. The counterpart is a
 * value this ruling moves too, so it must be improvisable under the same
 * tier; the choke point holds both legs to their own declaration.
 */

/** The name the mechanic registers under unless the caller chooses another. */
export const IMPROVISED_RULING = "improvised_ruling";

/** One value an improvised ruling moves. `key` defaults to `"value"`.
 *  `amount` is signed. `counterpartId` makes the leg a transfer between two
 *  members of one conserved set (see the module doc comment). */
export interface ImprovisedTarget {
  entityId: string;
  key?: string;
  tier: string;
  amount: number;
  counterpartId?: string;
}

/** The parameters a proposal hands this mechanic. */
export interface ImprovisedRulingParameters {
  targets: ImprovisedTarget[];
  /** Why the ruling lands where it does. Recorded verbatim; also each leg's
   *  `reason` and the resolution event's description. */
  rationale: string;
  /** The verbatim words of the act being ruled on. Recorded, never read. */
  citedAct: string;
  /** A caller-chosen key for "the same kind of act", stored only. */
  precedentKey?: string;
  /** A reference to the confirmation a tier requiring one was given. The
   *  engine records it; it does not judge it. */
  confirmation?: string;
}

/** What the mechanic reports on `Outcome.result` and records on the event. */
export interface ImprovisedRulingResult {
  rationale: string;
  citedAct: string;
  precedentKey: string | null;
  confirmation: string | null;
  targets: { entityId: string; key: string; tier: string; amount: number; counterpartId: string | null }[];
}

function fail(message: string): never {
  throw new Error(`improvised ruling: ${message}`);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`'${field}' must be a non-empty string, got ${JSON.stringify(value)}`);
  return value;
}

function optionalNonEmptyString(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : nonEmptyString(value, field);
}

/** Validates the opaque parameters into their typed shape, or throws naming
 *  what is wrong. No database is touched: the mechanic has none. */
function readParameters(parameters: Record<string, unknown>): ImprovisedRulingResult {
  const rationale = nonEmptyString(parameters.rationale, "rationale");
  const citedAct = nonEmptyString(parameters.citedAct, "citedAct");
  const precedentKey = optionalNonEmptyString(parameters.precedentKey, "precedentKey");
  const confirmation = optionalNonEmptyString(parameters.confirmation, "confirmation");

  const raw = parameters.targets;
  if (!Array.isArray(raw) || raw.length === 0) fail(`'targets' must be a non-empty list of { entityId, key?, tier, amount, counterpartId? }`);

  const named = new Set<string>();
  const name = (entityId: string, key: string) => {
    const id = `${entityId}\u0000${key}`;
    if (named.has(id)) fail(`names '${key}' on '${entityId}' more than once; one ruling moves each value at most once`);
    named.add(id);
  };

  const targets = raw.map((target: unknown, index) => {
    if (typeof target !== "object" || target === null) fail(`target ${index + 1} must be an object`);
    const t = target as Record<string, unknown>;
    const entityId = nonEmptyString(t.entityId, `targets[${index}].entityId`);
    const key = t.key === undefined ? "value" : nonEmptyString(t.key, `targets[${index}].key`);
    const tier = nonEmptyString(t.tier, `targets[${index}].tier`);
    if (typeof t.amount !== "number" || !Number.isFinite(t.amount)) fail(`targets[${index}].amount must be a finite number, got ${JSON.stringify(t.amount)}`);
    const counterpartId = optionalNonEmptyString(t.counterpartId, `targets[${index}].counterpartId`);
    if (counterpartId === entityId) fail(`targets[${index}] names '${entityId}' as its own counterpart`);
    name(entityId, key);
    if (counterpartId !== null) name(counterpartId, key);
    return { entityId, key, tier, amount: t.amount, counterpartId };
  });

  return { rationale, citedAct, precedentKey, confirmation, targets };
}

/**
 * The improvised-ruling mechanic, for `createResolver` (or
 * `createCoreMcpServer({ mechanics })`, which puts it behind the `resolve`
 * tool) beside a game's own mechanics. `name` defaults to
 * `IMPROVISED_RULING`.
 */
export function improvisedRulingMechanic(options?: { name?: string }): Mechanic {
  return {
    name: options?.name ?? IMPROVISED_RULING,
    adjudicate(input: AdjudicationInput): Adjudication {
      const ruling = readParameters(input.parameters ?? {});
      const improvised = { tier: "", confirmation: ruling.confirmation };
      const changes: IntendedChange[] = ruling.targets.map((target) => {
        const tag = { ...improvised, tier: target.tier };
        if (target.counterpartId === null) {
          return { kind: "write", entityId: target.entityId, key: target.key, mode: "delta", value: target.amount, reason: ruling.rationale, improvised: tag };
        }
        const towardTarget = target.amount >= 0;
        return {
          kind: "transfer",
          fromEntityId: towardTarget ? target.counterpartId : target.entityId,
          toEntityId: towardTarget ? target.entityId : target.counterpartId,
          key: target.key,
          amount: Math.abs(target.amount),
          reason: ruling.rationale,
          improvised: tag,
        };
      });
      return { changes, result: { ...ruling }, description: ruling.rationale };
    },
  };
}
