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
 */

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
 * SCOPE: this only registers the constraint. It is deliberately NOT
 * enforced in this branch -- see checkResourceConstraints() and
 * enforceConservedConstraint() below for why and where the seam is.
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
  for (const resourceId of uniqueIds) {
    if (!getResource(resourceId)) {
      throw new Error(`Resource '${resourceId}' not found.`);
    }
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
 * ConstraintViolationError on violation; returns void otherwise. Called
 * from updateResourceValue() in resource.ts before the row is written.
 *
 * 'conserved' constraints are deliberately NOT checked here -- see the seam
 * note on enforceConservedConstraint() below.
 */
export function checkResourceConstraints(
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

    // constraint.kind === "conserved": intentionally not checked here.
  }
}

/**
 * SEAM -- NOT IMPLEMENTED IN THIS BRANCH.
 *
 * Enforcing a 'conserved' constraint means: when any one resource in the set
 * changes, every other member must be re-read and, if needed, adjusted (or
 * the write rejected) so the set still sums to `total`. That requires an
 * atomic multi-row read-modify-write -- otherwise two concurrent updates (or
 * even a single-threaded read-then-write with no transaction) can observe or
 * leave the set out of sync.
 *
 * `withTransaction()` (src/db/connection.ts:78-81) exists for exactly this
 * but is currently dead code: nothing in DMCP performs atomic multi-row
 * writes yet, and real transaction wiring is being added on a separate
 * branch. Faking enforcement here with sequential single-row writes would
 * produce a race-prone approximation, not the guarantee 'conserved' promises
 * -- so this function exists only to make the gap explicit rather than
 * silently doing nothing.
 *
 * To implement: once atomic multi-row writes are available, wrap a read of
 * every member's current value + the write(s) that keep them summing to
 * `total` in withTransaction(), and call this from wherever conserved-set
 * updates are meant to happen (updateResourceValue() only ever touches one
 * resource at a time, so conserved-set writes likely need their own entry
 * point rather than reusing it as-is).
 */
export function enforceConservedConstraint(_constraintId: string): never {
  throw new Error(
    "'conserved' constraint enforcement is not implemented in this branch. " +
      "Declaring the constraint (declareConservedConstraint) and listing/removing it work today; " +
      "it requires atomic multi-row writes (see withTransaction() in src/db/connection.ts) " +
      "which are being added on a separate branch. See the comment on this function for details."
  );
}
