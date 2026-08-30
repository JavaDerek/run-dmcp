import { v4 as uuidv4 } from "uuid";
import { getDatabase } from "../db/connection.js";
import { validateGameExists } from "./game.js";
import { getResource } from "./resource.js";
import type { ConstraintKind, MonotonicDirection, ResourceConstraint } from "../types/index.js";

/**
 * Declarative, opt-in, server-enforced invariants on `resources` rows.
 *
 * A resource with no declared constraint behaves exactly as it always has --
 * out-of-bounds writes are silently clamped by clampValue() in resource.ts.
 * Declaring a constraint here changes that contract for that one resource
 * (or set of resources, for 'conserved') only.
 *
 * SCOPE NOTE: this layer covers the `resources` table only. Three other
 * numeric write paths bypass it entirely and are NOT covered:
 *   - factions.resources (JSON blob; see modifyFactionResource/setFactionResource
 *     in src/tools/faction.ts -- no bounds, no history, silently deletes an
 *     entry when it hits <= 0)
 *   - characters.attributes (arbitrary numeric JSON, unvalidated)
 *   - relationships.value (its own separate system)
 * A game author who needs a server-enforced invariant on a quantity must
 * model that quantity as a `resources` row, not one of the above.
 *
 * 'conserved' is fully enforced: a resource that is a member of a declared
 * 'conserved' constraint can no longer be written directly through
 * update_resource_value (see checkResourceConstraints() below) -- it must go
 * through transferResourceValue() in resource.ts, which moves value between
 * exactly two members of the same set atomically. See the comment on
 * transferResourceValue() for why an explicit transfer, rather than a
 * balanced multi-resource write, was chosen.
 *
 * `irreversible` (design §5.3) is this family's fourth, temporal member --
 * `bounded`/`monotonic` constrain a value's range and direction, 'conserved'
 * constrains a set's total, and `irreversible` constrains what may be
 * asserted about a value after a point in time. It is declared per-FACT
 * (src/timeline/irreversible.ts's declareIrreversible()), not as a row in
 * `resource_constraints` here, and enforced by triggers on the timeline's
 * `facts` table (src/timeline/schema.ts) rather than by
 * checkResourceConstraints() below. The two families live on different
 * substrates -- this one on `resources`/`resource_constraints`, that one on
 * the timeline's interval-versioned `facts` -- until design §5.4's option
 * (C) merges them at Phase 3 (`resources` becomes a constrained kind of
 * fact). Forcing an `irreversible` row into `resource_constraints` now would
 * build that merge early, against the wrong table, before the substrate
 * decision it depends on has actually landed.
 */

/** Absolute tolerance for floating-point sum comparisons on 'conserved'
 * constraints. IEEE 754 doubles cannot represent values like 0.1 exactly,
 * so repeated addition/subtraction across many transfers can drift by a
 * few ULPs. This is large enough to absorb that drift over realistic
 * transfer volumes while still catching an actual logic bug (which would
 * typically desync the sum by a whole `amount`, not a fraction of one). */
export const CONSERVED_SUM_EPSILON = 1e-6;

export class ConstraintViolationError extends Error {
  constructor(
    public readonly constraintKind: ConstraintKind,
    public readonly resourceId: string,
    message: string
  ) {
    super(message);
    this.name = "ConstraintViolationError";
  }
}

interface ConstraintRow {
  id: string;
  game_id: string;
  kind: ConstraintKind;
  direction: MonotonicDirection | null;
  total: number | null;
  created_at: string;
}

function memberIdsFor(constraintId: string): string[] {
  const db = getDatabase();
  const rows = db
    .prepare(`SELECT resource_id FROM resource_constraint_members WHERE constraint_id = ? ORDER BY rowid`)
    .all(constraintId) as { resource_id: string }[];
  return rows.map((r) => r.resource_id);
}

function rowToConstraint(row: ConstraintRow): ResourceConstraint {
  return {
    id: row.id,
    gameId: row.game_id,
    kind: row.kind,
    resourceIds: memberIdsFor(row.id),
    direction: row.direction,
    total: row.total,
    createdAt: row.created_at,
  };
}

function insertConstraint(
  gameId: string,
  kind: ConstraintKind,
  resourceIds: string[],
  direction: MonotonicDirection | null,
  total: number | null
): ResourceConstraint {
  const db = getDatabase();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO resource_constraints (id, game_id, kind, direction, total, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, gameId, kind, direction, total, now);

  const memberStmt = db.prepare(
    `INSERT INTO resource_constraint_members (constraint_id, resource_id) VALUES (?, ?)`
  );
  for (const resourceId of resourceIds) {
    memberStmt.run(id, resourceId);
  }

  return {
    id,
    gameId,
    kind,
    resourceIds,
    direction,
    total,
    createdAt: now,
  };
}

/**
 * Declare a 'bounded' constraint: the resource's value must stay within its
 * existing minValue/maxValue (set via create_resource/update_resource).
 * Once declared, out-of-bounds writes through updateResourceValue() are
 * REJECTED instead of silently clamped -- see checkResourceConstraints().
 */
export function declareBoundedConstraint(params: {
  gameId: string;
  resourceId: string;
}): ResourceConstraint {
  validateGameExists(params.gameId);

  const resource = getResource(params.resourceId);
  if (!resource) {
    throw new Error(`Resource '${params.resourceId}' not found.`);
  }
  if (resource.minValue === null && resource.maxValue === null) {
    throw new Error(
      `Resource '${params.resourceId}' has neither minValue nor maxValue set. ` +
        `A 'bounded' constraint enforces those bounds by rejecting instead of clamping -- ` +
        `set at least one bound with update_resource before declaring this constraint.`
    );
  }
  if (getConstraintsForResource(params.resourceId).some((c) => c.kind === "bounded")) {
    throw new Error(`Resource '${params.resourceId}' already has a 'bounded' constraint.`);
  }

  return insertConstraint(params.gameId, "bounded", [params.resourceId], null, null);
}

/**
 * Declare a 'monotonic' constraint: the resource's value may only move in
 * the given direction. 'increasing' means it may never decrease;
 * 'decreasing' means it may never increase. Holding steady is always
 * allowed.
 */
export function declareMonotonicConstraint(params: {
  gameId: string;
  resourceId: string;
  direction: MonotonicDirection;
}): ResourceConstraint {
  validateGameExists(params.gameId);

  const resource = getResource(params.resourceId);
  if (!resource) {
    throw new Error(`Resource '${params.resourceId}' not found.`);
  }
  if (getConstraintsForResource(params.resourceId).some((c) => c.kind === "monotonic")) {
    throw new Error(`Resource '${params.resourceId}' already has a 'monotonic' constraint.`);
  }

  return insertConstraint(params.gameId, "monotonic", [params.resourceId], params.direction, null);
}

/**
 * Register a 'conserved' constraint: a set of resources that must always
 * sum to a fixed total.
 *
 * Validation performed here, all rejecting rather than silently coercing:
 *   - at least two distinct resources
 *   - every resourceId must exist
 *   - `total` must be a finite number
 *   - no resource may already belong to another 'conserved' constraint --
 *     a resource can be a member of at most one conserved set at a time, so
 *     that transferResourceValue() (resource.ts) never has to guess which
 *     set a transfer touching that resource is supposed to preserve
 *   - the members' CURRENT values must already sum to `total`. This
 *     constraint records an existing invariant, it does not establish one --
 *     if the values don't already sum to `total`, that's almost always a
 *     caller mistake (wrong total, forgot a member), and silently rewriting
 *     resource values to make it true would hide that mistake.
 *
 * A resource may still separately hold a 'bounded' and/or 'monotonic'
 * constraint alongside 'conserved' -- those are orthogonal and both remain
 * enforced during transfers (see transferResourceValue()).
 */
export function declareConservedConstraint(params: {
  gameId: string;
  resourceIds: string[];
  total: number;
}): ResourceConstraint {
  validateGameExists(params.gameId);

  const uniqueIds = Array.from(new Set(params.resourceIds));
  if (uniqueIds.length < 2) {
    throw new Error("A 'conserved' constraint requires at least two distinct resources.");
  }
  if (!Number.isFinite(params.total)) {
    throw new Error(`'total' must be a finite number for a 'conserved' constraint; got ${params.total}.`);
  }

  let sum = 0;
  for (const resourceId of uniqueIds) {
    const resource = getResource(resourceId);
    if (!resource) {
      throw new Error(`Resource '${resourceId}' not found.`);
    }
    if (getConstraintsForResource(resourceId).some((c) => c.kind === "conserved")) {
      throw new Error(
        `Resource '${resourceId}' already belongs to a 'conserved' constraint. A resource may only be a ` +
          `member of one 'conserved' set at a time -- remove the existing constraint first (remove_resource_constraint) ` +
          `if you need to redefine the set it belongs to.`
      );
    }
    sum += resource.value;
  }

  if (Math.abs(sum - params.total) > CONSERVED_SUM_EPSILON) {
    throw new Error(
      `Cannot declare a 'conserved' constraint with total ${params.total}: the current values of ` +
        `[${uniqueIds.join(", ")}] sum to ${sum}, not ${params.total}. Adjust the resources' values (via ` +
        `update_resource_value, before declaring the constraint) or the declared total so they already match -- ` +
        `declaring this constraint does not rewrite resource values to make a mismatched total true.`
    );
  }

  return insertConstraint(params.gameId, "conserved", uniqueIds, null, params.total);
}

/** List constraints for a game, optionally filtered to ones governing a given resource. */
export function listConstraints(gameId: string, resourceId?: string): ResourceConstraint[] {
  const db = getDatabase();
  const rows = db
    .prepare(`SELECT * FROM resource_constraints WHERE game_id = ? ORDER BY created_at`)
    .all(gameId) as ConstraintRow[];

  const constraints = rows.map(rowToConstraint);
  if (resourceId === undefined) return constraints;
  return constraints.filter((c) => c.resourceIds.includes(resourceId));
}

/** All constraints (of any kind) that govern the given resource. */
export function getConstraintsForResource(resourceId: string): ResourceConstraint[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT rc.* FROM resource_constraints rc
       JOIN resource_constraint_members rcm ON rcm.constraint_id = rc.id
       WHERE rcm.resource_id = ?
       ORDER BY rc.created_at`
    )
    .all(resourceId) as ConstraintRow[];

  return rows.map(rowToConstraint);
}

/** Remove a constraint by id. Returns true if a row was deleted. */
export function removeConstraint(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`DELETE FROM resource_constraints WHERE id = ?`).run(id);
  return result.changes > 0;
}

/**
 * Check whether an intended value change for a single resource would
 * violate any 'bounded' or 'monotonic' constraint declared on it. Throws
 * ConstraintViolationError on violation; returns void otherwise. Shared by
 * checkResourceConstraints() (the single-resource write path) and
 * transferResourceValue() (resource.ts; the two-resource conserved-transfer
 * path) -- both paths must respect 'bounded'/'monotonic' the same way.
 * Deliberately does not look at 'conserved' constraints; callers decide
 * separately what to do about those (see checkResourceConstraints() below
 * and transferResourceValue()).
 */
export function checkBoundedAndMonotonicConstraints(
  resourceId: string,
  previousValue: number,
  intendedValue: number,
  bounds: { minValue: number | null; maxValue: number | null }
): void {
  const constraints = getConstraintsForResource(resourceId);

  for (const constraint of constraints) {
    if (constraint.kind === "monotonic") {
      if (constraint.direction === "increasing" && intendedValue < previousValue) {
        throw new ConstraintViolationError(
          "monotonic",
          resourceId,
          `Resource '${resourceId}' is constrained to never decrease; rejected change from ${previousValue} to ${intendedValue}.`
        );
      }
      if (constraint.direction === "decreasing" && intendedValue > previousValue) {
        throw new ConstraintViolationError(
          "monotonic",
          resourceId,
          `Resource '${resourceId}' is constrained to never increase; rejected change from ${previousValue} to ${intendedValue}.`
        );
      }
    }

    if (constraint.kind === "bounded") {
      if (bounds.minValue !== null && intendedValue < bounds.minValue) {
        throw new ConstraintViolationError(
          "bounded",
          resourceId,
          `Resource '${resourceId}' is bounded-constrained (min ${bounds.minValue}); rejected value ${intendedValue} instead of clamping.`
        );
      }
      if (bounds.maxValue !== null && intendedValue > bounds.maxValue) {
        throw new ConstraintViolationError(
          "bounded",
          resourceId,
          `Resource '${resourceId}' is bounded-constrained (max ${bounds.maxValue}); rejected value ${intendedValue} instead of clamping.`
        );
      }
    }

    // constraint.kind === "conserved": handled by callers, not here.
  }
}

/**
 * Check whether an intended value change for a single resource would
 * violate any constraint declared on it. Throws ConstraintViolationError on
 * violation; returns void otherwise. Called from updateResourceValue() in
 * resource.ts before the row is written.
 *
 * 'conserved' is handled specially here: ANY direct single-resource write to
 * a conserved member is rejected, unconditionally, regardless of whether the
 * particular delta would happen to preserve the total. The server cannot
 * know where update_resource_value's counterpart delta should come from --
 * writing one member without atomically adjusting another would silently
 * break the set's invariant, which is exactly the failure this constraint
 * exists to prevent. Use transfer_resource_value (transferResourceValue() in
 * resource.ts) instead, which moves value between two members of the same
 * set atomically.
 */
export function checkResourceConstraints(
  resourceId: string,
  previousValue: number,
  intendedValue: number,
  bounds: { minValue: number | null; maxValue: number | null }
): void {
  const constraints = getConstraintsForResource(resourceId);
  checkBoundedAndMonotonicConstraints(resourceId, previousValue, intendedValue, bounds);

  const conserved = constraints.find((c) => c.kind === "conserved");
  if (conserved) {
    throw new ConstraintViolationError(
      "conserved",
      resourceId,
      `Resource '${resourceId}' is a member of a 'conserved' constraint (id '${conserved.id}', total ${conserved.total}) ` +
        `and cannot be written directly via update_resource_value -- a single-resource write is ambiguous about where ` +
        `the counterpart delta should come from, and could silently break the set's total. Use transfer_resource_value ` +
        `to move value between two members of this set atomically instead.`
    );
  }
}

/** All conserved constraints (of kind 'conserved') governing a resource,
 * i.e. zero or one (declareConservedConstraint() rejects overlapping
 * conserved membership, so a resource can belong to at most one). */
export function getConservedConstraintFor(resourceId: string): ResourceConstraint | null {
  return getConstraintsForResource(resourceId).find((c) => c.kind === "conserved") ?? null;
}
