import { getDatabase } from "../db/connection.js";
import type {
  ConstraintKind,
  DeclaredConstraintKind,
  MonotonicDirection,
  ResourceConstraint,
} from "../types/index.js";
// Type-only: erased at compile time, so this carries no runtime coupling
// even though the two modules are conceptually paired (irreversible is the
// fourth member of the family this file is the read side of). No cycle
// exists to worry about either way -- irreversible.ts is a leaf here, it
// imports nothing from registry.ts or constrained.ts -- but `import type`
// means the answer would be the same regardless: it never produces a JS
// import, so it can't be the edge that closes a cycle.
import type { IrreversibleFact } from "./irreversible.js";

/**
 * The read side of the resource-constraint registry (design §5.3 / §5.4
 * option (C)): declarative, opt-in, server-enforced invariants on numeric
 * fact keys, keyed on `(entityId, factKey)` rather than on an entity id
 * alone.
 *
 * This lives in src/timeline/ -- not src/tools/constraint.ts, where the code
 * below used to live -- so that the generic write choke point Phase 3
 * introduces next (also under src/timeline/) can consult it WITHOUT
 * importing anything from src/tools/. That import direction is what would
 * otherwise close a cycle: src/tools/constraint.ts already imports
 * src/tools/resource.ts (for getResource()), and the future choke point
 * will need to check what's declared here before it writes a fact -- if the
 * read side still lived in tools/constraint.ts, that edge would run
 * tools/resource.ts -> timeline/<choke point> -> tools/constraint.ts, and
 * tools/constraint.ts already sits downstream of tools/resource.ts. Moving
 * the read side here breaks that cycle before the choke point exists to hit
 * it.
 *
 * Everything that WRITES `resource_constraints` -- insertConstraint() and
 * the declare*() functions, and all the validation that goes with them --
 * stays in src/tools/constraint.ts, which imports the accessors below
 * rather than duplicating the query against resource_constraint_members.
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
    public readonly constraintKind: DeclaredConstraintKind,
    public readonly resourceId: string,
    message: string,
    /** Design decision #7 / §5.2c's one hop of causality, attached as typed
     *  data and not only baked into `message` -- a reviewer at a fired check
     *  has to decide "is the fact wrong or is the claim wrong," and parsing
     *  that back out of a sentence is exactly the shape §5.2c exists to
     *  prevent. Only ever set when `constraintKind === "irreversible"`;
     *  every other family in this union has no contradicted fact to attach,
     *  so `undefined` is the correct default rather than a fourth sentinel
     *  value. */
    public readonly contradictedFact?: IrreversibleFact
  ) {
    super(message);
    this.name = "ConstraintViolationError";
  }
}

/** Shape of a raw `resource_constraints` row. Exported so
 * src/tools/constraint.ts's own by-game query (listConstraints(), which has
 * no JOIN to share with queryConstraintsForEntity() below) can build
 * ResourceConstraint values through rowToConstraint() below instead of
 * duplicating the row-shape/mapping logic this module already owns. */
export interface ConstraintRow {
  id: string;
  game_id: string;
  kind: ConstraintKind;
  direction: MonotonicDirection | null;
  total: number | null;
  fact_key: string;
  created_at: string;
}

/** The resource ids belonging to a constraint, in insertion order. Exported
 * alongside ConstraintRow/rowToConstraint for the same reason. */
export function memberIdsFor(constraintId: string): string[] {
  const db = getDatabase();
  const rows = db
    .prepare(`SELECT resource_id FROM resource_constraint_members WHERE constraint_id = ? ORDER BY rowid`)
    .all(constraintId) as { resource_id: string }[];
  return rows.map((r) => r.resource_id);
}

export function rowToConstraint(row: ConstraintRow): ResourceConstraint {
  return {
    id: row.id,
    gameId: row.game_id,
    kind: row.kind,
    resourceIds: memberIdsFor(row.id),
    direction: row.direction,
    total: row.total,
    factKey: row.fact_key,
    createdAt: row.created_at,
  };
}

/**
 * Shared query underlying every constraint lookup by entity id, so the JOIN
 * against resource_constraint_members is written exactly once. `factKey`
 * omitted means "any key" -- today's getConstraintsForResource() behaviour
 * (src/tools/constraint.ts), preserved for the one caller that still needs
 * it. Every OTHER caller must pass a factKey; see constraintsFor() below.
 */
function queryConstraintsForEntity(entityId: string, factKey?: string): ResourceConstraint[] {
  const db = getDatabase();
  const conditions = ["rcm.resource_id = ?"];
  const args: string[] = [entityId];
  if (factKey !== undefined) {
    conditions.push("rc.fact_key = ?");
    args.push(factKey);
  }

  const rows = db
    .prepare(
      `SELECT rc.* FROM resource_constraints rc
       JOIN resource_constraint_members rcm ON rcm.constraint_id = rc.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY rc.created_at`
    )
    .all(...args) as ConstraintRow[];

  return rows.map(rowToConstraint);
}

/**
 * Every constraint governing `(entityId, factKey)`, ordered by
 * `created_at`. This is the whole point of Phase 3 step 1: a constraint
 * declared on one fact key of an entity must never be visible when a
 * different fact key of that SAME entity is asked about, even though today
 * every constraint happens to govern the same key ('value').
 */
export function constraintsFor(entityId: string, factKey: string): ResourceConstraint[] {
  return queryConstraintsForEntity(entityId, factKey);
}

/**
 * Every constraint governing `entityId`, regardless of fact key. Exists
 * only so getConstraintsForResource() (src/tools/constraint.ts) can keep
 * its pre-Phase-3 "all keys" behaviour without a second copy of the JOIN
 * above -- new callers should prefer constraintsFor(), which cannot
 * accidentally forget to scope by key.
 */
export function allConstraintsForEntity(entityId: string): ResourceConstraint[] {
  return queryConstraintsForEntity(entityId);
}

/** The 'conserved' constraint governing `(entityId, factKey)`, or `null` if
 * none is declared. At most one can exist for a given key: declareConservedConstraint()
 * (src/tools/constraint.ts) rejects overlapping conserved membership on the
 * same key. */
export function conservedConstraintFor(entityId: string, factKey: string): ResourceConstraint | null {
  return constraintsFor(entityId, factKey).find((c) => c.kind === "conserved") ?? null;
}
