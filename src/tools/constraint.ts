import { v4 as uuidv4 } from "uuid";
import { getDatabase } from "../db/connection.js";
import { validateGameExists } from "./game.js";
import { getResource } from "./resource.js";
import type { ConstraintKind, MonotonicDirection, ResourceConstraint } from "../types/index.js";
import {
  ConstraintViolationError,
  CONSERVED_SUM_EPSILON,
  constraintsFor,
  allConstraintsForEntity,
  type ConstraintRow,
  rowToConstraint,
} from "../timeline/registry.js";

// Re-exported so every existing importer (src/tools/resource.ts,
// src/register/resources.ts) keeps working unchanged -- these two now live
// in src/timeline/registry.js; see the paragraph below on why.
export { ConstraintViolationError, CONSERVED_SUM_EPSILON };

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
 * update_resource_value (see assertConstraintsAllow() in
 * src/timeline/constrained.ts) -- it must go through transferResourceValue()
 * in resource.ts, which moves value between exactly two members of the same
 * set atomically. See the comment on transferResourceValue() for why an
 * explicit transfer, rather than a balanced multi-resource write, was
 * chosen.
 *
 * `irreversible` (design §5.3) is this family's fourth, temporal member --
 * `bounded`/`monotonic` constrain a value's range and direction, 'conserved'
 * constrains a set's total, and `irreversible` constrains what may be
 * asserted about a value after a point in time. It is declared per-FACT
 * (src/timeline/irreversible.ts's declareIrreversible()), not as a row in
 * `resource_constraints` here, and enforced by triggers on the timeline's
 * `facts` table (src/timeline/schema.ts) rather than by
 * assertConstraintsAllow(). The two families still live on different
 * substrates -- this one on `resources`/`resource_constraints`, that one on
 * the timeline's interval-versioned `facts`.
 *
 * Design §5.4's option (C) merge (Phase 3) is complete for `bounded`/
 * `monotonic`/`conserved`: this file declares constraints (insertConstraint
 * and the declare*() functions below) and reads them back for display
 * (listConstraints/getConstraintsForResource); EVALUATING a declared
 * constraint against an intended value change happens in exactly one place,
 * assertConstraintsAllow() (src/timeline/constrained.ts), which every
 * constrained write (writeConstrainedValue/transferConstrainedValue, and
 * through them updateResourceValue/transferResourceValue/updateResource in
 * resource.ts) goes through. Nothing in this file evaluates a constraint
 * against a value any more -- grep for `constraint.kind === "bounded"` or
 * `constraint.direction ===` and constrained.ts is the only hit outside a
 * test.
 */

function insertConstraint(
  gameId: string,
  kind: ConstraintKind,
  resourceIds: string[],
  direction: MonotonicDirection | null,
  total: number | null,
  factKey: string = "value"
): ResourceConstraint {
  const db = getDatabase();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO resource_constraints (id, game_id, kind, direction, total, fact_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, gameId, kind, direction, total, factKey, now);

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
    factKey,
    createdAt: now,
  };
}

/**
 * Declare a 'bounded' constraint: the resource's value must stay within its
 * existing minValue/maxValue (set via create_resource/update_resource).
 * Once declared, out-of-bounds writes through updateResourceValue() are
 * REJECTED instead of silently clamped -- see assertConstraintsAllow()
 * (src/timeline/constrained.ts).
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
  if (constraintsFor(params.resourceId, "value").some((c) => c.kind === "bounded")) {
    throw new Error(`Resource '${params.resourceId}' already has a 'bounded' constraint.`);
  }

  return insertConstraint(params.gameId, "bounded", [params.resourceId], null, null, "value");
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
  if (constraintsFor(params.resourceId, "value").some((c) => c.kind === "monotonic")) {
    throw new Error(`Resource '${params.resourceId}' already has a 'monotonic' constraint.`);
  }

  return insertConstraint(params.gameId, "monotonic", [params.resourceId], params.direction, null, "value");
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
    if (constraintsFor(resourceId, "value").some((c) => c.kind === "conserved")) {
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

  return insertConstraint(params.gameId, "conserved", uniqueIds, null, params.total, "value");
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

/** All constraints (of any kind, any fact key) that govern the given
 * resource. Delegates to the registry's allConstraintsForEntity() rather
 * than writing its own JOIN -- see src/timeline/registry.ts. */
export function getConstraintsForResource(resourceId: string): ResourceConstraint[] {
  return allConstraintsForEntity(resourceId);
}

/** Remove a constraint by id. Returns true if a row was deleted. */
export function removeConstraint(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`DELETE FROM resource_constraints WHERE id = ?`).run(id);
  return result.changes > 0;
}

// `getConservedConstraintFor(resourceId)` used to live here, unscoped by fact
// key. Its callers (deleteResource/updateResource in src/tools/resource.ts)
// now use `conservedConstraintFor(entityId, factKey)` from
// src/timeline/registry.ts instead, and the unscoped version was left with no
// caller at all. Deleted rather than kept: a key-blind lookup surviving beside
// the key-scoped one is exactly the shape a future write reaches for by
// accident, and it would silently find a constraint governing a different
// fact key than the one being written.
