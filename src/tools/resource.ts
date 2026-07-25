import { v4 as uuidv4 } from "uuid";
import { getDatabase, withTransaction } from "../db/connection.js";
import { validateGameExists } from "./game.js";
import {
  checkResourceConstraints,
  checkBoundedAndMonotonicConstraints,
  getConservedConstraintFor,
  ConstraintViolationError,
  CONSERVED_SUM_EPSILON,
} from "./constraint.js";
import type { Resource, ResourceChange } from "../types/index.js";

function clampValue(
  value: number,
  minValue: number | null,
  maxValue: number | null
): number {
  let result = value;
  if (minValue !== null) result = Math.max(result, minValue);
  if (maxValue !== null) result = Math.min(result, maxValue);
  return result;
}

/**
 * Reject (never clamp) a transfer leg that would push `resource` outside
 * its own minValue/maxValue. Used only by transferResourceValue() -- see
 * the doc comment there for why a transfer never clamps, even when the
 * resource has no separately-declared 'bounded' constraint.
 */
function assertWithinBoundsForTransfer(
  resource: Resource,
  intendedValue: number,
  role: "source" | "destination"
): void {
  if (resource.minValue !== null && intendedValue < resource.minValue) {
    throw new ConstraintViolationError(
      "conserved",
      resource.id,
      `Transfer rejected: '${resource.name}' (${resource.id}) would go below its minimum value ` +
        `(${resource.minValue}) as the ${role} of this transfer. transfer_resource_value never clamps -- ` +
        `clamping one side of a transfer would apply an uneven delta and silently create or destroy value. ` +
        `Choose a smaller amount.`
    );
  }
  if (resource.maxValue !== null && intendedValue > resource.maxValue) {
    throw new ConstraintViolationError(
      "conserved",
      resource.id,
      `Transfer rejected: '${resource.name}' (${resource.id}) would exceed its maximum value ` +
        `(${resource.maxValue}) as the ${role} of this transfer. transfer_resource_value never clamps -- ` +
        `clamping one side of a transfer would apply an uneven delta and silently create or destroy value. ` +
        `Choose a smaller amount.`
    );
  }
}

export function createResource(params: {
  gameId: string;
  ownerType: "game" | "character";
  ownerId?: string;
  name: string;
  description?: string;
  category?: string;
  value?: number;
  minValue?: number;
  maxValue?: number;
}): Resource {
  // Validate game exists to prevent orphaned records
  validateGameExists(params.gameId);

  const db = getDatabase();
  const id = uuidv4();
  const now = new Date().toISOString();

  const ownerId = params.ownerType === "game" ? null : (params.ownerId || null);
  const initialValue = params.value ?? 0;
  const minValue = params.minValue ?? null;
  const maxValue = params.maxValue ?? null;
  const value = clampValue(initialValue, minValue, maxValue);

  const stmt = db.prepare(`
    INSERT INTO resources (id, game_id, owner_id, owner_type, name, description, category, value, min_value, max_value, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.gameId,
    ownerId,
    params.ownerType,
    params.name,
    params.description || "",
    params.category || null,
    value,
    minValue,
    maxValue,
    now
  );

  return {
    id,
    gameId: params.gameId,
    ownerId,
    ownerType: params.ownerType,
    name: params.name,
    description: params.description || "",
    category: params.category || null,
    value,
    minValue,
    maxValue,
    createdAt: now,
  };
}

export function getResource(id: string): Resource | null {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT * FROM resources WHERE id = ?`);
  const row = stmt.get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    gameId: row.game_id as string,
    ownerId: row.owner_id as string | null,
    ownerType: row.owner_type as "game" | "character",
    name: row.name as string,
    description: row.description as string,
    category: row.category as string | null,
    value: row.value as number,
    minValue: row.min_value as number | null,
    maxValue: row.max_value as number | null,
    createdAt: row.created_at as string,
  };
}

export function updateResource(
  id: string,
  updates: {
    name?: string;
    description?: string;
    category?: string | null;
    minValue?: number | null;
    maxValue?: number | null;
  }
): Resource | null {
  const db = getDatabase();
  const current = getResource(id);
  if (!current) return null;

  const newName = updates.name ?? current.name;
  const newDescription = updates.description ?? current.description;
  const newCategory = updates.category !== undefined ? updates.category : current.category;
  const newMinValue = updates.minValue !== undefined ? updates.minValue : current.minValue;
  const newMaxValue = updates.maxValue !== undefined ? updates.maxValue : current.maxValue;

  // Re-clamp value if bounds changed
  const newValue = clampValue(current.value, newMinValue, newMaxValue);

  // A conserved member's value may ONLY change via transferResourceValue(),
  // which applies an equal-and-opposite delta to another member in the same
  // atomic write. Re-clamping here would change this resource's value on
  // its own -- silently, with no counterpart adjustment -- which is exactly
  // the kind of isolated write that breaks the set's total. Reject instead;
  // the caller can still change bounds that don't affect the current value.
  if (newValue !== current.value) {
    const conserved = getConservedConstraintFor(id);
    if (conserved) {
      throw new ConstraintViolationError(
        "conserved",
        id,
        `Resource '${id}' is a member of a 'conserved' constraint (id '${conserved.id}', total ${conserved.total}) ` +
          `and its value cannot be changed by update_resource, including indirectly by narrowing minValue/maxValue ` +
          `so the current value would be reclamped. Rejected instead of silently changing the value -- use ` +
          `transfer_resource_value if the value itself needs to move, or choose bounds that don't affect the current value.`
      );
    }
  }

  const stmt = db.prepare(`
    UPDATE resources
    SET name = ?, description = ?, category = ?, min_value = ?, max_value = ?, value = ?
    WHERE id = ?
  `);

  stmt.run(newName, newDescription, newCategory, newMinValue, newMaxValue, newValue, id);

  return {
    ...current,
    name: newName,
    description: newDescription,
    category: newCategory,
    minValue: newMinValue,
    maxValue: newMaxValue,
    value: newValue,
  };
}

export function deleteResource(id: string): boolean {
  // Deleting a conserved member would shrink the set out from under its
  // declared total with no counterpart adjustment (and, via ON DELETE
  // CASCADE on resource_constraint_members, would silently remove it from
  // the set rather than raise any error). Reject instead: the caller must
  // remove_resource_constraint first if the set itself is being redefined.
  const conserved = getConservedConstraintFor(id);
  if (conserved) {
    throw new ConstraintViolationError(
      "conserved",
      id,
      `Resource '${id}' is a member of a 'conserved' constraint (id '${conserved.id}', total ${conserved.total}) ` +
        `and cannot be deleted while that constraint exists -- deleting it would shrink the set below its declared ` +
        `total with no way to keep the invariant true. Remove the constraint first with remove_resource_constraint ` +
        `if the set is being redefined.`
    );
  }

  const db = getDatabase();
  const stmt = db.prepare(`DELETE FROM resources WHERE id = ?`);
  const result = stmt.run(id);
  return result.changes > 0;
}

export function listResources(
  gameId: string,
  filter?: {
    ownerType?: "game" | "character";
    ownerId?: string;
    category?: string;
  }
): Resource[] {
  const db = getDatabase();
  let query = `SELECT * FROM resources WHERE game_id = ?`;
  const params: (string | number)[] = [gameId];

  if (filter?.ownerType !== undefined) {
    query += ` AND owner_type = ?`;
    params.push(filter.ownerType);
  }

  if (filter?.ownerId !== undefined) {
    query += ` AND owner_id = ?`;
    params.push(filter.ownerId);
  }

  if (filter?.category !== undefined) {
    query += ` AND category = ?`;
    params.push(filter.category);
  }

  query += ` ORDER BY name`;

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    gameId: row.game_id as string,
    ownerId: row.owner_id as string | null,
    ownerType: row.owner_type as "game" | "character",
    name: row.name as string,
    description: row.description as string,
    category: row.category as string | null,
    value: row.value as number,
    minValue: row.min_value as number | null,
    maxValue: row.max_value as number | null,
    createdAt: row.created_at as string,
  }));
}

function logChange(
  resourceId: string,
  previousValue: number,
  newValue: number,
  reason: string | null
): ResourceChange {
  const db = getDatabase();
  const id = uuidv4();
  const now = new Date().toISOString();
  const delta = newValue - previousValue;

  const stmt = db.prepare(`
    INSERT INTO resource_history (id, resource_id, previous_value, new_value, delta, reason, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, resourceId, previousValue, newValue, delta, reason, now);

  return {
    id,
    resourceId,
    previousValue,
    newValue,
    delta,
    reason,
    timestamp: now,
  };
}

/**
 * Update a resource's value - either by delta or absolute set.
 * Use mode: "delta" to add/subtract, mode: "set" to set an absolute value.
 */
export function updateResourceValue(params: {
  resourceId: string;
  mode: "delta" | "set";
  value: number;
  reason?: string;
}): { resource: Resource; change: ResourceChange } | null {
  const resource = getResource(params.resourceId);
  if (!resource) return null;

  const previousValue = resource.value;
  const intendedValue =
    params.mode === "delta" ? previousValue + params.value : params.value;

  // Opt-in constraint enforcement: throws ConstraintViolationError and
  // leaves the row untouched if this resource has a declared 'bounded' or
  // 'monotonic' constraint that `intendedValue` would violate. Resources
  // with no declared constraint are unaffected by this call and fall
  // through to the existing clamp behavior below, unchanged.
  checkResourceConstraints(params.resourceId, previousValue, intendedValue, {
    minValue: resource.minValue,
    maxValue: resource.maxValue,
  });

  const newValue = clampValue(intendedValue, resource.minValue, resource.maxValue);

  // The value update and its resource_history row must land together --
  // otherwise a failure between the two leaves a changed value with no
  // audit trail explaining why it changed.
  const change = withTransaction(() => {
    const db = getDatabase();
    const stmt = db.prepare(`UPDATE resources SET value = ? WHERE id = ?`);
    stmt.run(newValue, params.resourceId);

    return logChange(
      params.resourceId,
      previousValue,
      newValue,
      params.reason || null
    );
  });

  return {
    resource: { ...resource, value: newValue },
    change,
  };
}

/**
 * Move `amount` from one resource to another, atomically. This is the ONLY
 * write path for a resource that is a member of a declared 'conserved'
 * constraint -- checkResourceConstraints() (constraint.ts) rejects
 * update_resource_value against such a resource specifically because a
 * single-resource write can't express where the counterpart delta comes
 * from. This function is that counterpart-carrying write.
 *
 * WHY AN EXPLICIT TRANSFER TOOL, NOT A BALANCED MULTI-RESOURCE WRITE:
 * A single-resource write against a conserved member is ambiguous -- the
 * server has no way to infer where the offsetting delta should come from.
 * Two designs resolve that ambiguity:
 *   (a) an explicit transfer(from, to, amount) tool, or
 *   (b) a "balanced write" tool taking an arbitrary { resourceId: delta }
 *       map, rejecting the whole call unless every conserved set's deltas
 *       sum to zero.
 * (b) is more general -- it can reshuffle N members in one call -- but
 * offloads real bookkeeping onto the caller: an LLM has to enumerate every
 * affected resourceId, get every delta's sign right, and get the
 * grouping-by-constraint-set right, all in one shot with no partial-progress
 * checkpoint if it gets any of that wrong. (a) covers the overwhelming
 * majority of real game actions directly ("trade 10 grain for gold", "the
 * treasury pays the population") and composes: an N-member reshuffle is just
 * several transfers, which the caller can still wrap in one withTransaction()
 * if it needs to be all-or-nothing (see the "chains two transfers" tests in
 * conserved.test.ts). That composability, plus the much smaller surface for
 * a caller to get wrong, is why the narrower primitive was chosen.
 *
 * Scope is deliberately narrow: fromResourceId and toResourceId must already
 * be members of the SAME declared 'conserved' constraint. This is not a
 * general "move value between any two resources" tool -- for anything not
 * under a 'conserved' constraint, update_resource_value remains the right
 * tool (see checkResourceConstraints()). Keeping the two write paths
 * mutually exclusive per resource means which one to use is never
 * ambiguous.
 *
 * Never clamps. Clamping one side of a transfer would apply an uneven delta
 * -- the source would lose less (or the destination gain less) than the
 * other side moved by, silently creating or destroying value -- so any
 * bound violation on either side rejects the whole transfer instead,
 * regardless of whether a 'bounded' constraint is separately declared.
 */
export function transferResourceValue(params: {
  fromResourceId: string;
  toResourceId: string;
  amount: number;
  reason?: string;
}): { from: Resource; to: Resource; fromChange: ResourceChange; toChange: ResourceChange } {
  if (params.fromResourceId === params.toResourceId) {
    throw new Error(
      `Cannot transfer a resource to itself (fromResourceId and toResourceId are both '${params.fromResourceId}').`
    );
  }
  if (!Number.isFinite(params.amount)) {
    throw new Error(`Transfer amount must be a finite number; got ${params.amount}.`);
  }
  if (params.amount < 0) {
    throw new Error(
      `Transfer amount must be >= 0 (got ${params.amount}); swap fromResourceId and toResourceId to reverse ` +
        `direction instead of using a negative amount.`
    );
  }

  const from = getResource(params.fromResourceId);
  if (!from) {
    throw new Error(`Resource '${params.fromResourceId}' not found.`);
  }
  const to = getResource(params.toResourceId);
  if (!to) {
    throw new Error(`Resource '${params.toResourceId}' not found.`);
  }

  const fromConstraint = getConservedConstraintFor(from.id);
  const toConstraint = getConservedConstraintFor(to.id);
  if (!fromConstraint || !toConstraint || fromConstraint.id !== toConstraint.id) {
    const details: string[] = [];
    if (!fromConstraint) details.push(`'${from.name}' (${from.id}) is not a member of any 'conserved' constraint.`);
    if (!toConstraint) details.push(`'${to.name}' (${to.id}) is not a member of any 'conserved' constraint.`);
    if (fromConstraint && toConstraint && fromConstraint.id !== toConstraint.id) {
      details.push(
        `They belong to different 'conserved' constraints ('${fromConstraint.id}' and '${toConstraint.id}').`
      );
    }
    throw new ConstraintViolationError(
      "conserved",
      from.id,
      `transfer_resource_value requires fromResourceId and toResourceId to both be members of the same declared ` +
        `'conserved' constraint -- moving value between resources outside a shared conserved set would change ` +
        `each side's total independently, which is what update_resource_value is for. ${details.join(" ")}`
    );
  }

  const fromPrev = from.value;
  const toPrev = to.value;
  const fromIntended = fromPrev - params.amount;
  const toIntended = toPrev + params.amount;

  // Bounded/monotonic constraints, if separately declared, apply during a
  // transfer exactly as they do during a direct write.
  checkBoundedAndMonotonicConstraints(from.id, fromPrev, fromIntended, {
    minValue: from.minValue,
    maxValue: from.maxValue,
  });
  checkBoundedAndMonotonicConstraints(to.id, toPrev, toIntended, {
    minValue: to.minValue,
    maxValue: to.maxValue,
  });
  // Never clamp (see doc comment above): reject outright if either side's
  // own minValue/maxValue would be violated, even without a declared
  // 'bounded' constraint.
  assertWithinBoundsForTransfer(from, fromIntended, "source");
  assertWithinBoundsForTransfer(to, toIntended, "destination");

  const reason = params.reason || null;
  const constraintId = fromConstraint.id;
  const declaredTotal = fromConstraint.total ?? 0;
  const memberIds = fromConstraint.resourceIds;

  return withTransaction(() => {
    const db = getDatabase();
    db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(fromIntended, from.id);
    db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(toIntended, to.id);

    const fromChange = logChange(from.id, fromPrev, fromIntended, reason);
    const toChange = logChange(to.id, toPrev, toIntended, reason);

    // Defense in depth: re-read every member of the set (inside this same
    // transaction, so this sees the writes above) and assert it still sums
    // to the declared total. The primary guarantee is structural (an equal
    // and opposite delta, above) -- this turns any future bug in this
    // function, or a schema change that opens another write path around it,
    // into a loud rollback instead of a silently wrong total.
    const currentSum = memberIds.reduce((sum, id) => sum + (getResource(id)?.value ?? 0), 0);
    if (Math.abs(currentSum - declaredTotal) > CONSERVED_SUM_EPSILON) {
      throw new Error(
        `Invariant check failed after transfer: conserved constraint '${constraintId}' members now sum to ` +
          `${currentSum}, expected ${declaredTotal}. Rolling back.`
      );
    }

    return {
      from: { ...from, value: fromIntended },
      to: { ...to, value: toIntended },
      fromChange,
      toChange,
    };
  });
}

export function getResourceHistory(
  resourceId: string,
  limit?: number
): ResourceChange[] {
  const db = getDatabase();
  let query = `SELECT * FROM resource_history WHERE resource_id = ? ORDER BY timestamp DESC`;
  const params: (string | number)[] = [resourceId];

  if (limit !== undefined) {
    query += ` LIMIT ?`;
    params.push(limit);
  }

  const stmt = db.prepare(query);
  const rows = stmt.all(...params) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: row.id as string,
    resourceId: row.resource_id as string,
    previousValue: row.previous_value as number,
    newValue: row.new_value as number,
    delta: row.delta as number,
    reason: row.reason as string | null,
    timestamp: row.timestamp as string,
  }));
}
