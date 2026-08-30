import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import { getDatabase, withTransaction } from "../db/connection.js";
import { assertT, compareT, type T } from "./t.js";
import { currentStoryTime } from "./clock.js";
import { PROJECTED_TABLES, liveColumns } from "./projection.js";
import type { EntityKind } from "./kinds.js";
import { constraintsFor, conservedConstraintFor, ConstraintViolationError, CONSERVED_SUM_EPSILON } from "./registry.js";
import { irreversibleFactFor } from "./irreversible.js";

/**
 * The choke point (design §5.4 option (C), Phase 3 step 2): the ONE place a
 * constrained numeric fact key is written, and the ONE place `resources`'
 * former `resource_history` table is replaced by reading the interval-
 * versioned `facts` the projection triggers (projection.ts) already produce.
 *
 * Before this module existed, "what did this value used to be" had two
 * disconnected answers -- a bespoke `resource_history` table that only
 * `updateResourceValue`/`transferResourceValue` (src/tools/resource.ts) wrote
 * to, and the timeline's own `facts`, which the projection triggers were
 * ALREADY appending to on every write, unread by anyone. Two write paths for
 * the same fact is exactly the failure root CLAUDE.md's "engine records
 * decisions" framing and the project's own history (the predecessor's
 * `resource_history`/`relationship_history`, engineVocabulary.test.ts's
 * epigraph) warn about generalizing badly: something gets added because one
 * caller needed it, nothing generalizes the idea, and the concept of
 * versioning ends up living in exactly as many places as someone happened to
 * ask for it. This module collapses that back to one: `writeConstrainedValue`
 * is the only way a constrained numeric value changes, and `valueHistory` is
 * built entirely from what the timeline already recorded.
 *
 * IMPORT DIRECTION IS LOAD-BEARING. This file imports nothing from
 * `src/tools/` -- registry.ts's doc comment explains why in detail, and the
 * short version is: `src/tools/constraint.ts` already imports
 * `src/tools/resource.ts` (for `getResource`), and `src/tools/resource.ts`
 * needs to import THIS module (to delegate `updateResourceValue`/
 * `transferResourceValue` to it). If this module reached back into
 * `src/tools/` for anything -- `getResource`, a resource-shaped type, a
 * resource-specific constant -- that would close
 * `tools/resource.ts -> timeline/constrained.ts -> tools/*` into a cycle.
 * Every value this module needs about "the entity currently reads a column
 * with this key" comes from the timeline's own vocabulary instead:
 * `entities`, `PROJECTED_TABLES`, `liveColumns` (projection.ts) and
 * `constraintsFor`/`conservedConstraintFor` (registry.ts).
 */

/**
 * One recorded transition of a constrained numeric fact key. A row, never a
 * verdict (hard rule 2) -- there is no `wasClamped`, no `violatedConstraint`,
 * just what changed, when, and (if a constrained write made it) why.
 */
export interface ValueTransition {
  entityId: string;
  key: string;
  previousValue: number;
  newValue: number;
  delta: number;
  reason: string | null;
  /** Where on the timeline this landed. */
  t: T;
  /** The fact this write opened; null when the write changed nothing (no
   *  new interval opens for a value that didn't move -- see
   *  `applyLiveWrite`). */
  factId: string | null;
  /** The annotation event this write logged; null for a transition no
   *  constrained write made (an unannotated fact-only transition -- a
   *  direct column write, a bounds re-clamp, a startup reconciliation). */
  eventId: string | null;
  /** Wall-clock ISO stamp recorded by the choke point; null when
   *  unannotated. */
  at: string | null;
}

interface ResolvedProjection {
  entityId: string;
  gameId: string;
  table: string;
  key: string;
}

/**
 * A1: resolves `entityId` to the live table its `key` column lives in, and
 * confirms that column actually exists -- the generic replacement for
 * hardcoding "this is a resource, its column is `resources.value`" that
 * makes this choke point work for `(entityId, factKey)` in general rather
 * than one hand-picked pair.
 *
 * Reuses `PROJECTED_TABLES`/`liveColumns` (projection.ts) rather than
 * carrying a second table/column registry -- the same "one owner for the
 * column list" rule `checkpoint.ts`'s `timelineDivergences` already follows,
 * for the same reason: a second copy could silently drift from what the
 * projection triggers actually project, and this function would then
 * validate against a set of columns nothing else agrees with.
 *
 * Throws, naming the entity and key, rather than returning undefined --
 * every caller of this function is about to either read or write a live
 * column, and a silent "couldn't resolve" would surface many statements
 * later as a confusing SQL error against a nonexistent column instead of a
 * clear one here.
 */
function resolveProjection(entityId: string, key: string): ResolvedProjection {
  const db = getDatabase();

  const entity = db.prepare(`SELECT game_id, kind FROM entities WHERE id = ?`).get(entityId) as
    | { game_id: string; kind: EntityKind }
    | undefined;
  if (!entity) {
    throw new Error(`timeline: cannot resolve a constrained write -- entity '${entityId}' does not exist`);
  }

  // Cannot happen in practice: PROJECTED_TABLES has exactly one row per
  // ENTITY_KINDS member today, and entities.kind is FK-constrained to
  // entity_kinds (schema.ts). Guarded anyway rather than asserted, because
  // this function has no business trusting that invariant silently forever.
  const projected = PROJECTED_TABLES.find((p) => p.kind === entity.kind);
  if (!projected) {
    throw new Error(
      `timeline: entity '${entityId}' has kind '${entity.kind}', which has no projected table -- ` +
        `there is no live column to write a constrained value through`
    );
  }

  const cols = liveColumns(db, projected.table);
  if (!cols.includes(key)) {
    throw new Error(
      `timeline: '${key}' is not a live column of '${projected.table}' -- entity '${entityId}' ` +
        `(kind '${entity.kind}') has no fact key by that name`
    );
  }

  return { entityId, gameId: entity.game_id, table: projected.table, key };
}

/**
 * Reads the current live value of a resolved (entityId, key). Throws rather
 * than returning a sentinel on either failure: a missing row means the
 * entity was destroyed since `resolveProjection` confirmed it in the
 * timeline (a real race, however narrow); a NULL column means there is no
 * value to move from, and "say what is, never what is absent" (hard rule 3)
 * means this function will not invent a zero to paper over that -- the
 * caller asked for a NUMBER, and an absent one is a caller error to report,
 * not a caller error to guess past.
 */
function readLiveValue(db: Database.Database, resolved: ResolvedProjection): number {
  const row = db
    .prepare(`SELECT ${resolved.key} AS value FROM ${resolved.table} WHERE id = ?`)
    .get(resolved.entityId) as { value: number | null } | undefined;

  if (!row) {
    throw new Error(
      `timeline: no live row in '${resolved.table}' for entity '${resolved.entityId}' -- ` +
        `it may have been destroyed since it was last confirmed to exist`
    );
  }
  if (row.value === null) {
    throw new Error(
      `timeline: '${resolved.key}' is NULL on entity '${resolved.entityId}' -- a constrained numeric ` +
        `write needs an existing numeric value to move from`
    );
  }
  return row.value;
}

function clamp(value: number, minValue: number | null, maxValue: number | null): number {
  let result = value;
  if (minValue !== null) result = Math.max(result, minValue);
  if (maxValue !== null) result = Math.min(result, maxValue);
  return result;
}

/**
 * A2: the single site where the declared constraint family (design §5.3) --
 * `monotonic`, `bounded`, `conserved` -- is evaluated against an intended
 * change. Every one of `checkResourceConstraints()` and
 * `checkBoundedAndMonotonicConstraints()`'s (formerly src/tools/constraint.ts)
 * rules lives here now and ONLY here -- grep the tree for
 * `constraint.direction ===` or `constraint.kind === "bounded"` and this file
 * is the only hit outside a test.
 *
 * Reads via `constraintsFor(entityId, key)` (registry.ts), not
 * `allConstraintsForEntity` -- this is the behavioral point of Phase 3 step
 * 1's key-scoping: a `monotonic` constraint declared on one fact key must
 * never reach a write to a different key on the same entity, even though
 * every constraint declared through today's declare*() functions happens to
 * govern `'value'`.
 *
 * `bounds` is optional. When a caller has no bounds to check against (e.g.
 * `updateResource`'s own guard below, which is not itself moving a value
 * against declared min/max -- it is refusing a conserved reclamp), the
 * `bounded` branch is simply skipped rather than crashing on a missing
 * object. `monotonic` and `conserved` need no bounds and are always
 * evaluated when applicable.
 *
 * MESSAGE PRESERVATION: every string thrown below is copied verbatim from
 * `checkResourceConstraints`/`checkBoundedAndMonotonicConstraints` as they
 * stood before this module existed -- `conserved.test.ts` asserts against
 * the conserved-rejection text by regex, and nothing here is worth rewording
 * away from wording a real caller may already be matching on.
 */
export function assertConstraintsAllow(params: {
  entityId: string;
  key: string;
  previousValue: number;
  intendedValue: number;
  bounds?: { minValue: number | null; maxValue: number | null };
  /** "reject" -- a direct single-entity write to a conserved member is
   *  refused (the ambiguity has no answer). "allow" -- the caller is the
   *  counterpart-carrying transfer, the one write that CAN preserve the
   *  total. */
  conservedMemberWrite: "reject" | "allow";
  /** Appended to a conserved rejection in place of the default sentence
   *  about `update_resource_value`, so the message names the operation the
   *  caller actually performed. */
  context?: string;
}): void {
  const { entityId, key, previousValue, intendedValue, bounds, conservedMemberWrite, context } = params;
  const constraints = constraintsFor(entityId, key);

  for (const constraint of constraints) {
    if (constraint.kind === "monotonic") {
      if (constraint.direction === "increasing" && intendedValue < previousValue) {
        throw new ConstraintViolationError(
          "monotonic",
          entityId,
          `Resource '${entityId}' is constrained to never decrease; rejected change from ${previousValue} to ${intendedValue}.`
        );
      }
      if (constraint.direction === "decreasing" && intendedValue > previousValue) {
        throw new ConstraintViolationError(
          "monotonic",
          entityId,
          `Resource '${entityId}' is constrained to never increase; rejected change from ${previousValue} to ${intendedValue}.`
        );
      }
    }

    if (constraint.kind === "bounded" && bounds) {
      if (bounds.minValue !== null && intendedValue < bounds.minValue) {
        throw new ConstraintViolationError(
          "bounded",
          entityId,
          `Resource '${entityId}' is bounded-constrained (min ${bounds.minValue}); rejected value ${intendedValue} instead of clamping.`
        );
      }
      if (bounds.maxValue !== null && intendedValue > bounds.maxValue) {
        throw new ConstraintViolationError(
          "bounded",
          entityId,
          `Resource '${entityId}' is bounded-constrained (max ${bounds.maxValue}); rejected value ${intendedValue} instead of clamping.`
        );
      }
    }
  }

  if (conservedMemberWrite === "reject") {
    const conserved = constraints.find((c) => c.kind === "conserved");
    if (conserved) {
      const suffix =
        context ??
        `and cannot be written directly via update_resource_value -- a single-resource write is ambiguous about where ` +
          `the counterpart delta should come from, and could silently break the set's total. Use transfer_resource_value ` +
          `to move value between two members of this set atomically instead.`;
      throw new ConstraintViolationError(
        "conserved",
        entityId,
        `Resource '${entityId}' is a member of a 'conserved' constraint (id '${conserved.id}', total ${conserved.total}) ${suffix}`
      );
    }
  }
}

/**
 * Rejects (never clamps) a transfer leg that would push an entity's key
 * outside `bounds`. Ported from `assertWithinBoundsForTransfer`
 * (src/tools/resource.ts) with the same reasoning: clamping one side of a
 * transfer would apply an uneven delta and silently create or destroy value,
 * so any bound violation on either side rejects the whole transfer instead
 * -- regardless of whether a `bounded` constraint is separately declared.
 * `bounds` here is the resource's own plain minValue/maxValue, which this
 * check always enforces once supplied; declared `bounded` constraints are a
 * SEPARATE, opt-in check (`assertConstraintsAllow` above).
 */
function assertWithinBoundsForTransfer(
  entityId: string,
  label: string,
  bounds: { minValue: number | null; maxValue: number | null } | undefined,
  intendedValue: number,
  role: "source" | "destination"
): void {
  if (!bounds) return;
  if (bounds.minValue !== null && intendedValue < bounds.minValue) {
    throw new ConstraintViolationError(
      "conserved",
      entityId,
      `Transfer rejected: '${label}' (${entityId}) would go below its minimum value ` +
        `(${bounds.minValue}) as the ${role} of this transfer. transfer_resource_value never clamps -- ` +
        `clamping one side of a transfer would apply an uneven delta and silently create or destroy value. ` +
        `Choose a smaller amount.`
    );
  }
  if (bounds.maxValue !== null && intendedValue > bounds.maxValue) {
    throw new ConstraintViolationError(
      "conserved",
      entityId,
      `Transfer rejected: '${label}' (${entityId}) would exceed its maximum value ` +
        `(${bounds.maxValue}) as the ${role} of this transfer. transfer_resource_value never clamps -- ` +
        `clamping one side of a transfer would apply an uneven delta and silently create or destroy value. ` +
        `Choose a smaller amount.`
    );
  }
}

/**
 * Performs one live column write plus its one annotation event, and returns
 * the resulting `ValueTransition`. Shared by `writeConstrainedValue` (one
 * leg) and `transferConstrainedValue` (two legs, same transaction) so the
 * "how do we find what fact this opened, and what do we tell `events`"
 * logic is written exactly once.
 *
 * MUST be called from inside a `withTransaction()` -- it performs the
 * `UPDATE` (which fires the generated `_au` projection trigger,
 * projection.ts, closing the old fact and opening the new one INSIDE that
 * same statement) and the annotation-event `INSERT` as two separate
 * statements that need to land together or not at all.
 *
 * Column and table names are interpolated, never bound -- `resolved.table`
 * and `resolved.key` were validated by `resolveProjection` against
 * `pragma_table_info`/`PROJECTED_TABLES`, this codebase's own vocabulary,
 * never a caller-supplied string. See projection.ts's doc comments for the
 * fuller statement of the same rule.
 */
function applyLiveWrite(params: {
  entityId: string;
  gameId: string;
  table: string;
  key: string;
  previousValue: number;
  newValue: number;
  reason: string | null;
}): ValueTransition {
  const db = getDatabase();
  const { entityId, gameId, table, key, previousValue, newValue, reason } = params;

  db.prepare(`UPDATE ${table} SET ${key} = ? WHERE id = ?`).run(newValue, entityId);

  let factId: string | null = null;
  let t: T;

  if (newValue === previousValue) {
    // The projection trigger's INSERT is guarded `WHERE NEW.<col> IS NOT
    // (SELECT value FROM facts ...)` (projection.ts) -- an unchanged value
    // opens no new fact. Detected here from the value comparison, not by
    // inspecting rows, because inspecting rows can't tell "nothing opened"
    // apart from "something opened and was immediately superseded" without
    // extra bookkeeping this choke point has no reason to carry.
    const story = currentStoryTime(gameId);
    if (!story) {
      throw new Error(
        `timeline: game '${gameId}' has no timeline clock -- cannot record a no-op constrained write with no t to attach it to`
      );
    }
    t = story.t;
  } else {
    // The fact the trigger just opened: the currently-open interval for
    // this (entityId, key). In a correctly functioning system this row's
    // valid_from_t already equals "the game's clock now" -- it was opened
    // by the UPDATE just above -- so there is no separate clock read to
    // reconcile it against.
    const openFact = db
      .prepare(
        `SELECT id, valid_from_t FROM facts WHERE entity_id = ? AND key = ? AND valid_to_t IS NULL
         ORDER BY valid_from_t DESC, id DESC LIMIT 1`
      )
      .get(entityId, key) as { id: string; valid_from_t: number } | undefined;

    if (openFact) {
      factId = openFact.id;
      t = openFact.valid_from_t;
    } else {
      // Only reachable if newValue is NULL (the trigger's INSERT is also
      // guarded `WHERE NEW.<col> IS NOT NULL`) -- not a case a numeric
      // constrained write produces, but this function is not itself the
      // place to assume that; fall back to the clock rather than throw.
      const story = currentStoryTime(gameId);
      if (!story) {
        throw new Error(`timeline: game '${gameId}' has no timeline clock to attach this write to`);
      }
      t = story.t;
    }
  }
  assertT(t);

  const at = new Date().toISOString();
  const delta = newValue - previousValue;
  const eventId = uuidv4();

  // `causes` deliberately does NOT carry a `row_id` key. irreversible.ts's
  // `findOpenedByEventId` matches `json_extract(causes, '$.row_id')` to
  // attach design §5.2c's one hop of provenance, picking the first event at
  // a given `t` by a random hex id when more than one matches. `row_id` is
  // the PROJECTION triggers' own token for "the live row this projection
  // event was generated from" (projection.ts) -- an annotation event this
  // choke point writes is not a projection event, and if it carried
  // `row_id` too, a projection event and an annotation event sharing one
  // `t` (which a constrained write's own UPDATE produces: the `_au`
  // trigger's `<kind>.updated` event and this `value.changed` event both
  // land at the same `t`) would make `findOpenedByEventId`'s pick
  // non-deterministic. `entity_id` is the accurate key for what this event
  // is about anyway, so using it instead of `row_id` is both the honest
  // name and the one that can never collide with that lookup.
  const causes = JSON.stringify({
    source: "constrained_write",
    entity_id: entityId,
    key,
    fact_id: factId,
    previous_value: previousValue,
    new_value: newValue,
    delta,
    at,
  });

  db.prepare(
    `INSERT INTO events (id, game_id, at_t, kind, description, causes) VALUES (?, ?, ?, 'value.changed', ?, ?)`
  ).run(eventId, gameId, t, reason, causes);

  return { entityId, key, previousValue, newValue, delta, reason, t, factId, eventId, at };
}

/**
 * One leg's worth of "what were we trying to write" -- the input to
 * `translateIrreversibleFailure` below. `table` travels alongside
 * `entityId`/`key` because the TEXT-form cast (`castedTextForm`) needs to
 * know which column's declared type to cast through, and by the time a
 * write has failed and rolled back there is no live row left to read it
 * from.
 */
interface IrreversibleWriteAttempt {
  entityId: string;
  key: string;
  table: string;
  attemptedValue: number;
}

/**
 * The TEXT form SQLite's projection triggers would have produced for
 * `attemptedValue` had this write actually landed in `table.key` --
 * reproduced by asking SQLite itself, not by formatting the number in JS.
 *
 * This exists because of a measured trap (checkpoint.ts's doc comment,
 * timeline-architecture.md): a bound JS number carries no column affinity of
 * its own, so `String(100)` is `"100"`, but SQLite's own
 * `CAST(100 AS REAL)` -- what actually happens when 100 is stored into a
 * REAL-affinity column like `resources.value` -- renders as TEXT
 * `"100.0"`. Comparing the JS-formatted string against an irreversible
 * fact's stored value would then silently never match a REAL column, which
 * is every constrained numeric column this choke point writes today.
 *
 * `CAST(x AS <type-name>)` uses the same 5-rule algorithm SQLite uses to
 * derive column affinity from a declared type name (SQLite's own
 * documentation for CAST expressions says so explicitly), so casting
 * through the column's OWN declared type -- read from `pragma_table_info`,
 * exactly where `resolveProjection`/`liveColumns` already get their column
 * vocabulary from, never a caller-supplied string -- reproduces the
 * identical conversion `CAST(NEW.<col> AS TEXT)` (projection.ts) applies to
 * a value that actually lands in that column. `NUMERIC` is the fallback for
 * a column with no declared type; SQLite treats undeclared/empty type names
 * as BLOB affinity for real columns, but every live column this function is
 * ever called for is numeric by construction (`readLiveValue` already
 * required one to get this far), so NUMERIC -- not BLOB -- is the honest
 * default here.
 */
function castedTextForm(db: Database.Database, table: string, key: string, attemptedValue: number): string {
  const info = db.prepare(`SELECT type FROM pragma_table_info(?) WHERE name = ?`).get(table, key) as
    | { type: string }
    | undefined;
  const declaredType = info?.type && info.type.length > 0 ? info.type : "NUMERIC";
  const row = db.prepare(`SELECT CAST(CAST(? AS ${declaredType}) AS TEXT) AS text_form`).get(attemptedValue) as {
    text_form: string;
  };
  return row.text_form;
}

/**
 * Design decision #7 / §5.2c: translates a write that failed inside
 * `withTransaction` into a typed `ConstraintViolationError` carrying one hop
 * of causality -- but ONLY when it can show, structurally, that an
 * irreversible fact is why. `timeline_facts_irreversible` (the BEFORE
 * INSERT trigger on `facts`, schema.ts) remains the only thing that decided
 * to refuse the write; by the time this function runs, `withTransaction`
 * has already rolled the whole attempt back, and nothing here can change
 * that outcome -- it can only name it.
 *
 * Called with one attempt for `writeConstrainedValue`'s single leg, two for
 * `transferConstrainedValue`'s two legs. A transfer's legs write different
 * entities under the same key, and after rollback neither leg's UPDATE is
 * visible any more -- there is no way to ask "which leg's row changed" from
 * the live tables, only "does either leg's entity carry an irreversible
 * fact that disagrees with what that leg tried to assert," which is exactly
 * what `irreversibleFactFor` (irreversible.ts) can answer without touching
 * the failed error at all.
 *
 * Deliberately does NOT inspect `err`'s message or SQLite error code --
 * hard rule 4 (never pattern-match meaning) applies to this codebase's own
 * generated text too, and a check against rows this module itself wrote
 * keeps working even if the trigger's wording ever changes. If no attempt's
 * entity/key carries an irreversible fact that disagrees with what was
 * written, `err` is rethrown completely untouched -- losing an unrelated
 * failure (the conserved-sum invariant check, a fault in some other
 * trigger, anything that isn't this rejection) inside a translation layer
 * would be far worse than leaving it untranslated.
 */
function translateIrreversibleFailure(db: Database.Database, attempts: IrreversibleWriteAttempt[], err: unknown): never {
  for (const attempt of attempts) {
    const fact = irreversibleFactFor(attempt.entityId, attempt.key);
    if (!fact) continue;

    const attemptedText = castedTextForm(db, attempt.table, attempt.key, attempt.attemptedValue);
    if (fact.value !== attemptedText) {
      throw new ConstraintViolationError(
        "irreversible",
        attempt.entityId,
        `Resource '${attempt.entityId}' has an irreversible fact for key '${attempt.key}': value '${fact.value}' ` +
          `holds as of t=${fact.validFromT}` +
          (fact.openedByEventId !== null
            ? ` (opened by event '${fact.openedByEventId}')`
            : ` (no event is recorded for when this was opened)`) +
          `. The attempted value '${attemptedText}' contradicts it and is refused.`,
        fact
      );
    }
  }
  throw err;
}

/**
 * A3: the only way a constrained numeric value changes. Resolve, check,
 * clamp, write -- in that order, and the order is load-bearing: clamping
 * BEFORE the constraint check would let a declared `bounded` constraint's
 * rejection be silently satisfied by the very clamp it exists to prevent
 * (an intended value of 150 against a [0, 100] bound would arrive at the
 * check already clamped to 100, and a `bounded` constraint's whole point is
 * to refuse 150, not to see 100). Clamping AFTER means the constraint check
 * always sees the caller's actual, unclamped intent.
 */
export function writeConstrainedValue(params: {
  entityId: string;
  key: string;
  mode: "delta" | "set";
  value: number;
  reason?: string | null;
  bounds?: { minValue: number | null; maxValue: number | null };
  context?: string;
}): ValueTransition {
  const resolved = resolveProjection(params.entityId, params.key);
  const db = getDatabase();
  const previousValue = readLiveValue(db, resolved);

  const intendedValue = params.mode === "delta" ? previousValue + params.value : params.value;

  assertConstraintsAllow({
    entityId: params.entityId,
    key: params.key,
    previousValue,
    intendedValue,
    bounds: params.bounds,
    conservedMemberWrite: "reject",
    context: params.context,
  });

  const newValue = params.bounds ? clamp(intendedValue, params.bounds.minValue, params.bounds.maxValue) : intendedValue;
  const reason = params.reason ?? null;

  try {
    return withTransaction(() =>
      applyLiveWrite({
        entityId: params.entityId,
        gameId: resolved.gameId,
        table: resolved.table,
        key: params.key,
        previousValue,
        newValue,
        reason,
      })
    );
  } catch (err) {
    translateIrreversibleFailure(
      db,
      [{ entityId: params.entityId, key: params.key, table: resolved.table, attemptedValue: newValue }],
      err
    );
  }
}

/**
 * A4: the counterpart-carrying two-leg write for conserved sets. Ported from
 * `transferResourceValue` (src/tools/resource.ts) minus its argument
 * validation (self-transfer, non-finite, negative, not-found), which stays
 * in resource.ts because it is about resource IDENTITY, not about the
 * constraint family this module owns -- see the doc comment there.
 *
 * Checks run BEFORE the transaction (membership, then bounded/monotonic on
 * both legs, then the never-clamp bounds rejection), exactly as
 * `transferResourceValue` ordered them -- a transfer that is going to be
 * rejected should never touch either live row. Both legs' writes, plus the
 * defense-in-depth sum re-verification, land in ONE `withTransaction()`.
 */
export function transferConstrainedValue(params: {
  fromEntityId: string;
  toEntityId: string;
  key: string;
  amount: number;
  reason?: string | null;
  fromBounds?: { minValue: number | null; maxValue: number | null };
  toBounds?: { minValue: number | null; maxValue: number | null };
  fromLabel?: string;
  toLabel?: string;
}): { from: ValueTransition; to: ValueTransition } {
  const { fromEntityId, toEntityId, key, amount } = params;
  const fromLabel = params.fromLabel ?? fromEntityId;
  const toLabel = params.toLabel ?? toEntityId;
  const reason = params.reason ?? null;

  const fromResolved = resolveProjection(fromEntityId, key);
  const toResolved = resolveProjection(toEntityId, key);
  const db = getDatabase();

  const fromConstraint = conservedConstraintFor(fromEntityId, key);
  const toConstraint = conservedConstraintFor(toEntityId, key);
  if (!fromConstraint || !toConstraint || fromConstraint.id !== toConstraint.id) {
    const details: string[] = [];
    if (!fromConstraint) details.push(`'${fromLabel}' (${fromEntityId}) is not a member of any 'conserved' constraint.`);
    if (!toConstraint) details.push(`'${toLabel}' (${toEntityId}) is not a member of any 'conserved' constraint.`);
    if (fromConstraint && toConstraint && fromConstraint.id !== toConstraint.id) {
      details.push(
        `They belong to different 'conserved' constraints ('${fromConstraint.id}' and '${toConstraint.id}').`
      );
    }
    throw new ConstraintViolationError(
      "conserved",
      fromEntityId,
      `transfer_resource_value requires fromResourceId and toResourceId to both be members of the same declared ` +
        `'conserved' constraint -- moving value between resources outside a shared conserved set would change ` +
        `each side's total independently, which is what update_resource_value is for. ${details.join(" ")}`
    );
  }

  const fromPrev = readLiveValue(db, fromResolved);
  const toPrev = readLiveValue(db, toResolved);
  const fromIntended = fromPrev - amount;
  const toIntended = toPrev + amount;

  // Bounded/monotonic constraints, if separately declared, apply during a
  // transfer exactly as they do during a direct write -- "allow" here means
  // only "the conserved-member ambiguity does not apply to this write",
  // never "skip the rest of the family".
  assertConstraintsAllow({
    entityId: fromEntityId,
    key,
    previousValue: fromPrev,
    intendedValue: fromIntended,
    bounds: params.fromBounds,
    conservedMemberWrite: "allow",
  });
  assertConstraintsAllow({
    entityId: toEntityId,
    key,
    previousValue: toPrev,
    intendedValue: toIntended,
    bounds: params.toBounds,
    conservedMemberWrite: "allow",
  });

  assertWithinBoundsForTransfer(fromEntityId, fromLabel, params.fromBounds, fromIntended, "source");
  assertWithinBoundsForTransfer(toEntityId, toLabel, params.toBounds, toIntended, "destination");

  const constraintId = fromConstraint.id;
  const declaredTotal = fromConstraint.total ?? 0;
  const memberIds = fromConstraint.resourceIds;

  try {
    return withTransaction(() => {
      const from = applyLiveWrite({
        entityId: fromEntityId,
        gameId: fromResolved.gameId,
        table: fromResolved.table,
        key,
        previousValue: fromPrev,
        newValue: fromIntended,
        reason,
      });
      const to = applyLiveWrite({
        entityId: toEntityId,
        gameId: toResolved.gameId,
        table: toResolved.table,
        key,
        previousValue: toPrev,
        newValue: toIntended,
        reason,
      });

      // Defense in depth: re-read every member of the set (inside this same
      // transaction, so this sees the writes above) generically -- through
      // resolveProjection's table resolution, never through a src/tools/
      // resource accessor -- and assert it still sums to the declared total.
      // The primary guarantee is structural (an equal and opposite delta,
      // above); this turns any future bug in this function, or a schema
      // change that opens another write path around it, into a loud rollback
      // instead of a silently wrong total.
      const currentSum = memberIds.reduce((sum, id) => {
        const memberResolved = resolveProjection(id, key);
        const row = db.prepare(`SELECT ${key} AS value FROM ${memberResolved.table} WHERE id = ?`).get(id) as
          | { value: number | null }
          | undefined;
        return sum + (row?.value ?? 0);
      }, 0);
      if (Math.abs(currentSum - declaredTotal) > CONSERVED_SUM_EPSILON) {
        throw new Error(
          `Invariant check failed after transfer: conserved constraint '${constraintId}' members now sum to ` +
            `${currentSum}, expected ${declaredTotal}. Rolling back.`
        );
      }

      return { from, to };
    });
  } catch (err) {
    translateIrreversibleFailure(
      db,
      [
        { entityId: fromEntityId, key, table: fromResolved.table, attemptedValue: fromIntended },
        { entityId: toEntityId, key, table: toResolved.table, attemptedValue: toIntended },
      ],
      err
    );
  }
}

interface FactPairRow {
  factId: string;
  value: string;
  t: number;
  rid: number;
  eventId: string | null;
  reason: string | null;
  at: string | null;
}

interface NoOpEventRow {
  eventId: string;
  reason: string | null;
  t: number;
  previousValue: number;
  newValue: number;
  delta: number;
  at: string | null;
  rid: number;
}

interface RankedTransition {
  transition: ValueTransition;
  t: number;
  rid: number;
}

/**
 * A5: the payoff -- `valueHistory` is built ENTIRELY from the timeline
 * (`facts` and `events`), with no `resource_history` in sight, because by
 * this point in the merge there is no `resource_history` writer left to
 * read from.
 *
 * Two sources, both scoped to `(entityId, key)`:
 *
 *   1. every FACT TRANSITION: consecutive facts, ordered `(valid_from_t,
 *      rowid)`, paired so each fact after the first supplies a
 *      previousValue/newValue/delta. The first fact is the value's
 *      CREATION, not a change -- `createResource` writes no history row
 *      today, and this function must not invent one, so the pairing loop
 *      starts at index 1, never 0.
 *   2. every `"value.changed"` annotation event whose `causes.$.fact_id` is
 *      JSON null -- a constrained write that changed nothing. A no-op write
 *      opens no fact (see `applyLiveWrite`), so its annotation event is the
 *      ONLY record of it; without this second source, a zero-amount
 *      transfer or a zero-delta update would silently vanish from history,
 *      which is exactly what conserved.test.ts's "logged even though
 *      nothing moved" assertions were written against.
 *
 * Fact transitions are joined to their annotation (if any) by
 * `json_extract(causes, '$.fact_id') = facts.id` -- an EXACT, unique link,
 * because `applyLiveWrite` recorded the fact id at write time. This is
 * deliberately stronger than irreversible.ts's `findOpenedByEventId`, which
 * has to approximate the same relationship via `(at_t, row_id)` because the
 * projection triggers that write `row_id` have no fact id to record at the
 * point they fire (issue #2 predates this module). Here, recording the real
 * id costs nothing extra and removes the approximation entirely.
 *
 * `json_valid(causes)` guards every extraction, matching irreversible.ts's
 * `CASE WHEN json_valid(causes) THEN causes END` idiom for the same reason
 * given there: `events.causes` has no CHECK constraint, timeline import
 * (export.ts) carries it through verbatim by design, and SQLite's
 * `json_extract` raises for the WHOLE query -- not just the offending row --
 * when it meets a value that isn't JSON. A provenance hop must never be able
 * to fail the query it annotates.
 *
 * Rows with no matching annotation (a direct column write, a bounds
 * re-clamp, a startup reconciliation) come back with `reason: null`,
 * `eventId: null`, `at: null` -- MORE history than `resource_history` ever
 * held, because that table only ever got a row when
 * `updateResourceValue`/`transferResourceValue` themselves wrote one.
 *
 * Ordered newest-first by `(t, rowid)` descending, matching
 * `resource_history`'s old `ORDER BY timestamp DESC` in spirit -- but by the
 * timeline's own axis, `t`, not by wall-clock time, because an unannotated
 * transition has no wall-clock stamp to sort by and `t` is the one ordering
 * this whole codebase agrees on (t.ts). `rowid` is the tiebreak for the rare
 * case two rows share a `t`, mirroring `changes.ts`'s own tiebreak
 * discipline. `limit` applies after ordering, never before.
 */
export function valueHistory(entityId: string, key: string, limit?: number): ValueTransition[] {
  const db = getDatabase();

  const factRows = db
    .prepare(
      `SELECT
         f.id AS factId,
         f.value AS value,
         f.valid_from_t AS t,
         f.rowid AS rid,
         e.id AS eventId,
         e.description AS reason,
         json_extract(CASE WHEN json_valid(e.causes) THEN e.causes END, '$.at') AS at
       FROM facts f
       LEFT JOIN events e
         ON e.kind = 'value.changed'
         AND json_extract(CASE WHEN json_valid(e.causes) THEN e.causes END, '$.fact_id') = f.id
       WHERE f.entity_id = ? AND f.key = ?
       ORDER BY f.valid_from_t ASC, f.rowid ASC`
    )
    .all(entityId, key) as FactPairRow[];

  const ranked: RankedTransition[] = [];

  for (let i = 1; i < factRows.length; i++) {
    const prev = factRows[i - 1];
    const cur = factRows[i];
    assertT(cur.t);
    const previousValue = Number(prev.value);
    const newValue = Number(cur.value);
    ranked.push({
      t: cur.t,
      rid: cur.rid,
      transition: {
        entityId,
        key,
        previousValue,
        newValue,
        delta: newValue - previousValue,
        reason: cur.reason,
        t: cur.t,
        factId: cur.factId,
        eventId: cur.eventId,
        at: cur.at,
      },
    });
  }

  const noOpRows = db
    .prepare(
      `SELECT
         id AS eventId,
         description AS reason,
         at_t AS t,
         json_extract(CASE WHEN json_valid(causes) THEN causes END, '$.previous_value') AS previousValue,
         json_extract(CASE WHEN json_valid(causes) THEN causes END, '$.new_value') AS newValue,
         json_extract(CASE WHEN json_valid(causes) THEN causes END, '$.delta') AS delta,
         json_extract(CASE WHEN json_valid(causes) THEN causes END, '$.at') AS at,
         rowid AS rid
       FROM events
       WHERE kind = 'value.changed'
         AND json_extract(CASE WHEN json_valid(causes) THEN causes END, '$.entity_id') = ?
         AND json_extract(CASE WHEN json_valid(causes) THEN causes END, '$.key') = ?
         AND json_extract(CASE WHEN json_valid(causes) THEN causes END, '$.fact_id') IS NULL`
    )
    .all(entityId, key) as NoOpEventRow[];

  for (const row of noOpRows) {
    assertT(row.t);
    ranked.push({
      t: row.t,
      rid: row.rid,
      transition: {
        entityId,
        key,
        previousValue: row.previousValue,
        newValue: row.newValue,
        delta: row.delta,
        reason: row.reason,
        t: row.t,
        factId: null,
        eventId: row.eventId,
        at: row.at,
      },
    });
  }

  ranked.sort((a, b) => {
    const byT = -compareT(a.t, b.t);
    if (byT !== 0) return byT;
    return b.rid - a.rid;
  });

  const limited = limit !== undefined ? ranked.slice(0, limit) : ranked;
  return limited.map((r) => r.transition);
}
