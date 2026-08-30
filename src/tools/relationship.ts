import { v4 as uuidv4 } from "uuid";
import { getDatabase, withTransaction } from "../db/connection.js";
import { validateGameExists } from "./game.js";
import { writeConstrainedValue, valueHistory, type ValueTransition } from "../timeline/constrained.js";
import type { Relationship, RelationshipChange } from "../types/index.js";

/**
 * Maps a timeline `ValueTransition` (src/timeline/constrained.ts) onto the
 * public `RelationshipChange` shape every existing caller of
 * modifyRelationship()/updateRelationshipValue()/getRelationshipHistory()
 * already expects. Mirrors transitionToResourceChange() in
 * src/tools/resource.ts exactly, minus `delta` -- RelationshipChange has no
 * `delta` field (src/types/index.ts) and never has, so none is invented
 * here. `id` prefers the annotation event's id, falling back to the fact id
 * for a transition no constrained write annotated; `timestamp` prefers the
 * wall-clock `at` the choke point stamped, falling back to the timeline
 * coordinate `t` for a transition with no wall-clock moment to report.
 */
function transitionToRelationshipChange(transition: ValueTransition): RelationshipChange {
  return {
    id: transition.eventId ?? transition.factId ?? "",
    relationshipId: transition.entityId,
    previousValue: transition.previousValue,
    newValue: transition.newValue,
    reason: transition.reason,
    timestamp: transition.at ?? String(transition.t),
  };
}

export function createRelationship(params: {
  gameId: string;
  sourceId: string;
  sourceType: string;
  targetId: string;
  targetType: string;
  relationshipType: string;
  value?: number;
  label?: string;
  notes?: string;
}): Relationship {
  // Validate game exists to prevent orphaned records
  validateGameExists(params.gameId);

  const db = getDatabase();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO relationships (id, game_id, source_id, source_type, target_id, target_type, relationship_type, value, label, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.gameId,
    params.sourceId,
    params.sourceType,
    params.targetId,
    params.targetType,
    params.relationshipType,
    params.value ?? 0,
    params.label || null,
    params.notes || "",
    now,
    now
  );

  return {
    id,
    gameId: params.gameId,
    sourceId: params.sourceId,
    sourceType: params.sourceType,
    targetId: params.targetId,
    targetType: params.targetType,
    relationshipType: params.relationshipType,
    value: params.value ?? 0,
    label: params.label || null,
    notes: params.notes || "",
    createdAt: now,
    updatedAt: now,
  };
}

export function getRelationship(id: string): Relationship | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM relationships WHERE id = ?`).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    gameId: row.game_id as string,
    sourceId: row.source_id as string,
    sourceType: row.source_type as string,
    targetId: row.target_id as string,
    targetType: row.target_type as string,
    relationshipType: row.relationship_type as string,
    value: row.value as number,
    label: row.label as string | null,
    notes: row.notes as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getRelationshipBetween(
  gameId: string,
  sourceId: string,
  targetId: string,
  relationshipType?: string
): Relationship | null {
  const db = getDatabase();

  let query = `SELECT * FROM relationships WHERE game_id = ? AND source_id = ? AND target_id = ?`;
  const params: string[] = [gameId, sourceId, targetId];

  if (relationshipType) {
    query += ` AND relationship_type = ?`;
    params.push(relationshipType);
  }

  query += ` LIMIT 1`;

  const row = db.prepare(query).get(...params) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    id: row.id as string,
    gameId: row.game_id as string,
    sourceId: row.source_id as string,
    sourceType: row.source_type as string,
    targetId: row.target_id as string,
    targetType: row.target_type as string,
    relationshipType: row.relationship_type as string,
    value: row.value as number,
    label: row.label as string | null,
    notes: row.notes as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Metadata updater that also accepts a new value, written by a single
 * direct UPDATE -- deliberately NOT routed through writeConstrainedValue()
 * (src/timeline/constrained.ts). Its value write therefore lands as an
 * UNANNOTATED transition in valueHistory()/getRelationshipHistory() below
 * (reason: null, eventId: null) rather than one a constrained write
 * stamped -- which is still strictly MORE history than the old
 * relationship_history table ever held for this path, since nothing wrote
 * there for a plain updateRelationship() call either. Mirrors
 * updateResource() in src/tools/resource.ts, whose own value-adjacent write
 * (re-clamping on a bounds change) is likewise a direct column write, not a
 * choke-point one.
 */
export function updateRelationship(
  id: string,
  updates: {
    relationshipType?: string;
    value?: number;
    label?: string | null;
    notes?: string;
  }
): Relationship | null {
  const db = getDatabase();
  const current = getRelationship(id);
  if (!current) return null;

  const now = new Date().toISOString();
  const newType = updates.relationshipType ?? current.relationshipType;
  const newValue = updates.value ?? current.value;
  const newLabel = updates.label !== undefined ? updates.label : current.label;
  const newNotes = updates.notes ?? current.notes;

  db.prepare(`
    UPDATE relationships
    SET relationship_type = ?, value = ?, label = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(newType, newValue, newLabel, newNotes, now, id);

  return {
    ...current,
    relationshipType: newType,
    value: newValue,
    label: newLabel,
    notes: newNotes,
    updatedAt: now,
  };
}

/**
 * Modify a relationship's value by a delta, with optional bounds. Delegates
 * the value write entirely to writeConstrainedValue() (src/timeline/
 * constrained.ts) -- the one choke point every constrained numeric fact key
 * writes through, mirroring updateResourceValue() in src/tools/resource.ts.
 * The resolve/check/clamp/write/annotate sequence, and the atomicity of the
 * write and its audit trail, all live there now.
 *
 * Logs unconditionally, including for a zero delta -- exactly as this
 * function always has. The choke point itself already handles a no-op
 * write: it opens no new fact (there is nothing to version when the value
 * doesn't move), but it still writes the annotation event, and
 * valueHistory()/getRelationshipHistory() below surface that event as a
 * history row regardless. So a zero-delta call still produces a row with no
 * extra code here -- see conserved.test.ts's "logged even though nothing
 * moved" assertions on the resource side of the same mechanism.
 *
 * `updated_at` gets its own UPDATE, in the same withTransaction() as the
 * value write, for the same reason updateRelationshipValue() below writes
 * its metadata separately: the choke point writes ONE column -- the
 * constrained fact key -- and nothing else, because a writer that also
 * touched neighbouring columns would be making policy about them. This
 * function's `updated_at` bump is that policy, so it stays here, where it
 * always was. Dropping it would be a silent regression: listRelationships()
 * orders by `updated_at DESC`, so a relationship modified through this path
 * would stop sorting as recently touched.
 */
export function modifyRelationship(params: {
  relationshipId: string;
  delta: number;
  reason?: string;
  minValue?: number;
  maxValue?: number;
}): { relationship: Relationship; change: RelationshipChange } | null {
  const relationship = getRelationship(params.relationshipId);
  if (!relationship) return null;

  // Validate bounds if both are provided
  if (params.minValue !== undefined && params.maxValue !== undefined && params.minValue > params.maxValue) {
    throw new Error(`Invalid bounds: minValue (${params.minValue}) cannot be greater than maxValue (${params.maxValue})`);
  }

  const now = new Date().toISOString();

  const transition = withTransaction(() => {
    getDatabase()
      .prepare(`UPDATE relationships SET updated_at = ? WHERE id = ?`)
      .run(now, params.relationshipId);

    return writeConstrainedValue({
      entityId: params.relationshipId,
      key: "value",
      mode: "delta",
      value: params.delta,
      reason: params.reason || null,
      bounds: { minValue: params.minValue ?? null, maxValue: params.maxValue ?? null },
    });
  });

  return {
    relationship: { ...relationship, value: transition.newValue, updatedAt: now },
    change: transitionToRelationshipChange(transition),
  };
}

export function deleteRelationship(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`DELETE FROM relationships WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function listRelationships(
  gameId: string,
  filter?: {
    entityId?: string;  // Either source or target
    sourceId?: string;
    targetId?: string;
    relationshipType?: string;
    entityType?: string;  // Filter by source_type or target_type
  }
): Relationship[] {
  const db = getDatabase();

  let query = `SELECT * FROM relationships WHERE game_id = ?`;
  const params: string[] = [gameId];

  if (filter?.entityId) {
    query += ` AND (source_id = ? OR target_id = ?)`;
    params.push(filter.entityId, filter.entityId);
  }

  if (filter?.sourceId) {
    query += ` AND source_id = ?`;
    params.push(filter.sourceId);
  }

  if (filter?.targetId) {
    query += ` AND target_id = ?`;
    params.push(filter.targetId);
  }

  if (filter?.relationshipType) {
    query += ` AND relationship_type = ?`;
    params.push(filter.relationshipType);
  }

  if (filter?.entityType) {
    query += ` AND (source_type = ? OR target_type = ?)`;
    params.push(filter.entityType, filter.entityType);
  }

  query += ` ORDER BY updated_at DESC`;

  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

  return rows.map(row => ({
    id: row.id as string,
    gameId: row.game_id as string,
    sourceId: row.source_id as string,
    sourceType: row.source_type as string,
    targetId: row.target_id as string,
    targetType: row.target_type as string,
    relationshipType: row.relationship_type as string,
    value: row.value as number,
    label: row.label as string | null,
    notes: row.notes as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

/**
 * Every recorded change to a relationship's value, newest first. Built
 * entirely from the timeline (valueHistory() in src/timeline/
 * constrained.ts) -- there is no `relationship_history` table backing this
 * any more (design §5.4 option (C); see the freeze trigger in
 * src/db/schema.ts). Mirrors getResourceHistory() in src/tools/resource.ts
 * exactly, and is a strict superset of what `relationship_history` ever
 * held for the same reason: it also surfaces transitions no constrained
 * write annotated (e.g. updateRelationship()'s direct column write above),
 * which the old table simply never recorded.
 */
export function getRelationshipHistory(relationshipId: string, limit?: number): RelationshipChange[] {
  return valueHistory(relationshipId, "value", limit).map(transitionToRelationshipChange);
}

/**
 * Update a relationship value with optional metadata changes. Supports both
 * direct set and delta modes. Logs to history when the value changes; no
 * history row (and `change: null`) when it doesn't -- that "no-op means no
 * row" contract is this function's own, distinct from modifyRelationship()
 * above, which always logs (see its doc comment). The choke point itself
 * ALWAYS leaves a trace of a write, including a no-op one (an annotation
 * event with no fact behind it -- see applyLiveWrite() in
 * src/timeline/constrained.ts), so writeConstrainedValue() below is called
 * ONLY when newValue !== previousValue -- routing a genuine no-op through it
 * would put a row in getRelationshipHistory() that this contract says must
 * not appear.
 *
 * `newValue` is computed and clamped here, BEFORE the choke-point call, for
 * two reasons: first, to make that changed/unchanged decision at all;
 * second, so the value handed to writeConstrainedValue() (mode: "set") is
 * already the caller's real intent -- the choke point's own clamp against
 * the same `bounds` is then a no-op on an already-clamped number, and its
 * constraint check (assertConstraintsAllow(), src/timeline/constrained.ts)
 * still sees a real, meaningful intended value rather than a raw delta.
 *
 * The metadata columns (relationship_type, label, notes, updated_at) are
 * written by their own UPDATE, separate from the value write below, but
 * both run inside one withTransaction() so the whole call is still one
 * atomic unit -- exactly as before, just as two statements against
 * `relationships` instead of one. That is a real, visible consequence of
 * routing the value column through the one choke point every constrained
 * write goes through: each statement fires the table's own projection
 * trigger (projection.ts) independently, so a value-changing call now
 * advances the timeline's `t` twice and logs two `relationship.updated`
 * events instead of one. One write path for "what did this value used to
 * be" is worth that -- see constrained.ts's own header comment on why a
 * second write path is the failure this project keeps rediscovering.
 */
export function updateRelationshipValue(params: {
  relationshipId: string;
  mode: "delta" | "set";
  value: number;
  reason?: string;
  minValue?: number;
  maxValue?: number;
  relationshipType?: string;
  label?: string | null;
  notes?: string;
}): { relationship: Relationship; change: RelationshipChange | null; previousValue: number } | null {
  const db = getDatabase();
  const relationship = getRelationship(params.relationshipId);
  if (!relationship) return null;

  // Validate bounds if both are provided
  if (params.minValue !== undefined && params.maxValue !== undefined && params.minValue > params.maxValue) {
    throw new Error(`Invalid bounds: minValue (${params.minValue}) cannot be greater than maxValue (${params.maxValue})`);
  }

  const previousValue = relationship.value;
  let newValue: number;

  if (params.mode === "delta") {
    newValue = previousValue + params.value;
  } else {
    newValue = params.value;
  }

  // Apply bounds (clamp to min first, then max to ensure max takes precedence)
  if (params.minValue !== undefined) {
    newValue = Math.max(newValue, params.minValue);
  }
  if (params.maxValue !== undefined) {
    newValue = Math.min(newValue, params.maxValue);
  }

  const now = new Date().toISOString();
  const newType = params.relationshipType ?? relationship.relationshipType;
  const newLabel = params.label !== undefined ? params.label : relationship.label;
  const newNotes = params.notes ?? relationship.notes;
  const bounds = { minValue: params.minValue ?? null, maxValue: params.maxValue ?? null };

  // The metadata update and the (conditional) value write must land
  // together, for the same reason as modifyRelationship() above -- a
  // failure between the two must never leave a changed value with no
  // metadata update applied, or vice versa.
  const change = withTransaction((): RelationshipChange | null => {
    db.prepare(`
      UPDATE relationships
      SET relationship_type = ?, label = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(newType, newLabel, newNotes, now, params.relationshipId);

    if (newValue === previousValue) {
      return null;
    }

    const transition = writeConstrainedValue({
      entityId: params.relationshipId,
      key: "value",
      mode: "set",
      value: newValue,
      reason: params.reason || null,
      bounds,
    });
    return transitionToRelationshipChange(transition);
  });

  return {
    relationship: {
      ...relationship,
      relationshipType: newType,
      value: newValue,
      label: newLabel,
      notes: newNotes,
      updatedAt: now,
    },
    change,
    previousValue,
  };
}

// Helper to get a value label based on thresholds
export function getRelationshipLabel(value: number): string {
  if (value >= 80) return "devoted";
  if (value >= 60) return "friendly";
  if (value >= 40) return "warm";
  if (value >= 20) return "cordial";
  if (value >= 0) return "neutral";
  if (value >= -20) return "cool";
  if (value >= -40) return "unfriendly";
  if (value >= -60) return "hostile";
  if (value >= -80) return "hateful";
  return "nemesis";
}

// Create a bidirectional relationship (both directions with same initial value)
export function createBidirectionalRelationship(params: {
  gameId: string;
  entityA: { id: string; type: string };
  entityB: { id: string; type: string };
  relationshipType: string;
  value?: number;
  label?: string;
  notes?: string;
}): [Relationship, Relationship] {
  // A "bidirectional" relationship is really two rows. If the second insert
  // fails, we must not be left with a lopsided relationship where A knows
  // about B but not vice versa -- so both inserts happen in one transaction.
  return withTransaction(() => {
    const relA = createRelationship({
      gameId: params.gameId,
      sourceId: params.entityA.id,
      sourceType: params.entityA.type,
      targetId: params.entityB.id,
      targetType: params.entityB.type,
      relationshipType: params.relationshipType,
      value: params.value,
      label: params.label,
      notes: params.notes,
    });

    const relB = createRelationship({
      gameId: params.gameId,
      sourceId: params.entityB.id,
      sourceType: params.entityB.type,
      targetId: params.entityA.id,
      targetType: params.entityA.type,
      relationshipType: params.relationshipType,
      value: params.value,
      label: params.label,
      notes: params.notes,
    });

    return [relA, relB];
  });
}
