import { v4 as uuidv4 } from "uuid";
import { getDatabase } from "../db/connection.js";
import { validateGameExists } from "./game.js";
import { ConstraintViolationError, conservedConstraintFor } from "../timeline/registry.js";
import {
  assertConstraintsAllow,
  writeConstrainedValue,
  transferConstrainedValue,
  valueHistory,
  type ValueTransition,
} from "../timeline/constrained.js";
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
 * Maps a timeline `ValueTransition` (src/timeline/constrained.ts) onto the
 * public `ResourceChange` shape every existing caller of
 * updateResourceValue()/transferResourceValue()/getResourceHistory() already
 * expects. `id` prefers the annotation event's id, falling back to the fact
 * id for a transition no constrained write annotated (a direct column
 * write, a bounds re-clamp, a startup reconciliation) -- either is a real,
 * unique identifier for the row, and a transition can never lack both.
 * `timestamp` prefers the wall-clock `at` the choke point stamped; an
 * unannotated transition has no wall-clock moment to report, so its
 * timeline coordinate `t` is the honest answer instead of inventing one.
 */
function transitionToResourceChange(transition: ValueTransition): ResourceChange {
  return {
    id: transition.eventId ?? transition.factId ?? "",
    resourceId: transition.entityId,
    previousValue: transition.previousValue,
    newValue: transition.newValue,
    delta: transition.delta,
    reason: transition.reason,
    timestamp: transition.at ?? String(transition.t),
  };
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
  //
  // Routed through assertConstraintsAllow() (src/timeline/constrained.ts) --
  // the single site the whole constraint family (monotonic/bounded/conserved)
  // is evaluated -- rather than throwing directly, so this is not a second
  // place the 'conserved' rule is written down. `context` carries this
  // guard's own explanation so the thrown message still names update_resource
  // (what this caller actually did), not a generic mention of
  // update_resource_value. No `bounds` is passed: this call is not itself
  // testing this resource's own min/max against a declared 'bounded'
  // constraint (updateResourceValue does that); it exists only to refuse an
  // isolated conserved-member value change.
  if (newValue !== current.value) {
    assertConstraintsAllow({
      entityId: id,
      key: "value",
      previousValue: current.value,
      intendedValue: newValue,
      conservedMemberWrite: "reject",
      context:
        `and its value cannot be changed by update_resource, including indirectly by narrowing minValue/maxValue ` +
        `so the current value would be reclamped. Rejected instead of silently changing the value -- use ` +
        `transfer_resource_value if the value itself needs to move, or choose bounds that don't affect the current value.`,
    });
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
  //
  // This is not a value-change check -- deleting a resource doesn't move
  // any number -- so it reads the registry directly (conservedConstraintFor,
  // key-scoped to 'value') rather than going through assertConstraintsAllow,
  // which exists to evaluate an INTENDED value change.
  const conserved = conservedConstraintFor(id, "value");
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

/**
 * Update a resource's value - either by delta or absolute set.
 * Use mode: "delta" to add/subtract, mode: "set" to set an absolute value.
 *
 * Delegates entirely to writeConstrainedValue() (src/timeline/constrained.ts)
 * -- the resolve/check/clamp/write/annotate sequence, and the atomicity of
 * the write and its audit trail, all live there now. This function's own job
 * is narrower than it used to be: translate the resource-shaped call into
 * the generic (entityId, factKey) one, and translate the generic
 * ValueTransition result back into the Resource/ResourceChange shapes every
 * existing caller already expects.
 */
export function updateResourceValue(params: {
  resourceId: string;
  mode: "delta" | "set";
  value: number;
  reason?: string;
}): { resource: Resource; change: ResourceChange } | null {
  const resource = getResource(params.resourceId);
  if (!resource) return null;

  const transition = writeConstrainedValue({
    entityId: params.resourceId,
    key: "value",
    mode: params.mode,
    value: params.value,
    reason: params.reason ?? null,
    bounds: { minValue: resource.minValue, maxValue: resource.maxValue },
  });

  return {
    resource: { ...resource, value: transition.newValue },
    change: transitionToResourceChange(transition),
  };
}

/**
 * Move `amount` from one resource to another, atomically. This is the ONLY
 * write path for a resource that is a member of a declared 'conserved'
 * constraint -- assertConstraintsAllow() (src/timeline/constrained.ts)
 * rejects update_resource_value against such a resource specifically because
 * a single-resource write can't express where the counterpart delta comes
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
 * tool (see assertConstraintsAllow() in src/timeline/constrained.ts). Keeping
 * the two write paths mutually exclusive per resource means which one to use
 * is never ambiguous.
 *
 * Never clamps. Clamping one side of a transfer would apply an uneven delta
 * -- the source would lose less (or the destination gain less) than the
 * other side moved by, silently creating or destroying value -- so any
 * bound violation on either side rejects the whole transfer instead,
 * regardless of whether a 'bounded' constraint is separately declared.
 *
 * Keeps its own argument validation (self-transfer, non-finite, negative,
 * not-found) -- that is about resource IDENTITY, not about the declared
 * constraint family, so it stays here rather than moving into
 * transferConstrainedValue() (src/timeline/constrained.ts), which delegates
 * the actual membership check, the bounded/monotonic checks, the never-clamp
 * bounds rejection, and both atomic writes.
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

  const { from: fromTransition, to: toTransition } = transferConstrainedValue({
    fromEntityId: from.id,
    toEntityId: to.id,
    key: "value",
    amount: params.amount,
    reason: params.reason ?? null,
    fromBounds: { minValue: from.minValue, maxValue: from.maxValue },
    toBounds: { minValue: to.minValue, maxValue: to.maxValue },
    fromLabel: from.name,
    toLabel: to.name,
  });

  return {
    from: { ...from, value: fromTransition.newValue },
    to: { ...to, value: toTransition.newValue },
    fromChange: transitionToResourceChange(fromTransition),
    toChange: transitionToResourceChange(toTransition),
  };
}

/**
 * Every recorded change to a resource's value, newest first. Built entirely
 * from the timeline (valueHistory() in src/timeline/constrained.ts) -- there
 * is no `resource_history` table backing this any more (design §5.4 option
 * (C); see the freeze trigger in src/db/schema.ts). This is a strict
 * superset of what `resource_history` ever held: it also surfaces
 * transitions no constrained write annotated (a direct column write, a
 * bounds re-clamp, a startup reconciliation), which the old table simply
 * never recorded.
 */
export function getResourceHistory(
  resourceId: string,
  limit?: number
): ResourceChange[] {
  return valueHistory(resourceId, "value", limit).map(transitionToResourceChange);
}
