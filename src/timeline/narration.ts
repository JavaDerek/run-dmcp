import { getDatabase } from "../db/connection.js";
import { assertT, compareT, type T } from "./t.js";
import type { EntityKind } from "./kinds.js";
import { openingEventId, type FactProvenance } from "./provenance.js";

/**
 * The outbound half of authority (design §5.2b/§5.2c, GitHub issues #11 and
 * #12): "Here is what is true; depict it, do not argue with it." One
 * consumer enforces this live, inside one session, resolution preceding
 * narration in one conversation -- its world advances a turn at a time,
 * with a player making uncertain decisions right up until resolution says
 * what actually happened. The other cannot: its units have duration and
 * everything in them is already known in advance, and its narrator output
 * is generated once, reviewed by a human, committed as a file, and
 * rendered hours later by a process that must never call a model. There is
 * no live moment inside that pipeline for a constraint to be checked at --
 * enforcement there is a lint over a finished artifact, at a different
 * point in time from generation entirely.
 *
 * **This is why the whole module is built around ONE serialized structure
 * and TWO enforcement points, not a live handshake.** `narrationConstraintAt`
 * is the only function here that touches the database; everything below it
 * -- `Claim`, `Contradiction`, `contradictions()` -- operates purely on the
 * plain-data shape `narrationConstraintAt` returns, with no database call
 * anywhere in that path. That is not an implementation detail worth noting
 * in passing: it is the entire reason the second consumer above can use
 * this at all (§5.2b's "the condition that decides whether it can use it").
 * See `narration.test.ts`'s "works on a JSON-rehydrated object with the
 * database closed" test, which proves the property by actually closing the
 * database mid-test and running `contradictions` on a
 * `JSON.parse(JSON.stringify(...))` round trip.
 *
 * **Prohibitions are derived and structural, never authored and lexical**
 * (hard rule 5, §5.2b, and the four recorded instances of this exact
 * mistake across two codebases catalogued in root CLAUDE.md). This module
 * has no `mustNotSay`, no `avoid`, no `forbidden`, no `negativePrompt`, no
 * phrase list, and no severity or `isValid`/`ok`/`passed` field anywhere.
 * `Claim` deliberately has no `text` field and never will: turning prose
 * into a structured claim is the CALLER's job, downstream of this object
 * (hard rule 4 -- the engine compares a claim against facts, never text
 * against a word list). Negation is unconstructable here because the type
 * that would carry it -- a negative fact, a forbidden-value list -- was
 * simply never given a field to live in, not because something scans for
 * one and rejects it.
 *
 * §5.2c's one hop of causality travels on every fact via `FactProvenance`
 * (provenance.ts), the same shape `IrreversibleFact` (irreversible.ts) now
 * extends -- there is exactly one owner of "the fact plus the event that
 * opened it" in this codebase, not a second copy grown for this module.
 */
export const NARRATION_CONSTRAINT_FORMAT_VERSION = 1;

/**
 * One fact that holds, carried in positive form -- design §7's "say what
 * is, never what is absent" applied to a whole serialized object rather
 * than to a single rendered sentence. `validToT` is carried, unlike
 * `replay.ts`'s `ReplayedFact` (which deliberately omits it: at a replayed
 * instant a fact is simply open), because `contradictions()` below needs
 * the fact's FULL half-open interval to decide whether a claim at some
 * OTHER `t` would contradict it -- the prohibition is derived over
 * `[validFromT, validToT)`, not only evaluated at the instant this object
 * was built. `null` means still open at serialization time.
 */
export interface ConstraintFact extends FactProvenance {
  entityKind: EntityKind;
  entityName: string | null;
  /** null while still open at serialization time. Carried because the
   *  prohibition is derived over a half-open interval; see `contradictions`. */
  validToT: T | null;
  irreversible: boolean;
}

/** The frozen artifact itself -- one caller's declared `t`, and every fact
 *  that constrains what may be truthfully asserted at it. */
export interface NarrationConstraint {
  formatVersion: number;
  gameId: string;
  t: T;
  mustHonor: ConstraintFact[];
}

interface ConstraintFactRow {
  id: string;
  entity_id: string;
  key: string;
  value: string;
  valid_from_t: number;
  valid_to_t: number | null;
  irreversible: number;
  entity_kind: EntityKind;
  entity_name: string | null;
}

function toConstraintFact(row: ConstraintFactRow, gameId: string): ConstraintFact {
  assertT(row.valid_from_t);
  if (row.valid_to_t !== null) assertT(row.valid_to_t);
  return {
    factId: row.id,
    entityId: row.entity_id,
    key: row.key,
    value: row.value,
    validFromT: row.valid_from_t,
    validToT: row.valid_to_t,
    irreversible: Boolean(row.irreversible),
    entityKind: row.entity_kind,
    entityName: row.entity_name,
    openedByEventId: openingEventId(gameId, row.entity_id, row.valid_from_t),
  };
}

/**
 * The constraint that holds for `gameId` at `t`, optionally narrowed to
 * `entityIds`. The only function in this module that touches the database
 * -- see the module doc comment for why that boundary is load-bearing.
 *
 * Includes, for the game (§5.2b, §5.2c):
 *
 *   1. every fact valid at `t` on an entity alive at `t` -- the EXACT
 *      half-open predicates `replay.ts` uses (`replay()`'s own doc comment
 *      spells out why both must be half-open and identical everywhere):
 *        alive:  created_at_t <= t AND (destroyed_at_t IS NULL OR destroyed_at_t > t)
 *        valid:  valid_from_t <= t AND (valid_to_t   IS NULL OR valid_to_t   > t)
 *      `replay.ts`'s own `ALIVE_AT_T` constant is module-private and out of
 *      scope for this module to import (it would mean editing replay.ts,
 *      which this change does not touch) -- so the predicate text is
 *      reproduced here character-for-character rather than paraphrased,
 *      which is what "EXACT" in the task brief means in practice.
 *
 *   2. every fact with `irreversible = 1` and `valid_from_t <= t`, EVEN IF
 *      CLOSED, and EVEN IF its entity was destroyed. This is not a hedge --
 *      it is the entire motivating failure of design §5.2b and root
 *      CLAUDE.md's hard rule 3: an irreversible fact is prohibited for
 *      every `t' >= its valid_from_t` regardless of what has happened to
 *      the entity or the fact's own interval since, so a destroyed island
 *      cannot quietly exist again just because the fact that destroyed it
 *      closed, or the entity itself was later deleted. Entities are
 *      append-only (`timeline_entities_no_delete`, schema.ts) and facts are
 *      append-only (`timeline_facts_no_delete`), so both rows are always
 *      still there to join against -- name and kind survive destruction.
 *
 * The two sets are combined with a single SQL `OR` inside one query rather
 * than two queries merged in JS, because that makes de-duplication free: a
 * physical fact row satisfies the combined WHERE clause at most once, so a
 * fact that is BOTH currently valid AND irreversible (the common case --
 * most irreversible facts are also the currently-open truth) can never
 * appear twice in `mustHonor` the way a naive UNION of two result sets
 * would risk.
 *
 * Deterministic, total ordering ending in the primary key
 * (`valid_from_t`, `entity_id`, `key`, `id`) -- `export.ts`'s own
 * discipline, copied for the same reason: two calls over the same world
 * must `JSON.stringify` byte-identically, and an ORDER BY that does not
 * bottom out at a column SQLite guarantees is unique leaves the tie broken
 * by unspecified query-plan order instead.
 */
export function narrationConstraintAt(params: {
  gameId: string;
  t: T;
  entityIds?: readonly string[];
}): NarrationConstraint {
  const { gameId, t } = params;
  assertT(t);

  // An explicitly empty entityIds list narrows to nothing, not to
  // "unnarrowed" -- and short-circuiting here also sidesteps an invalid
  // `IN ()` in the SQL below, which SQLite (correctly) does not accept as
  // "matches nothing".
  if (params.entityIds !== undefined && params.entityIds.length === 0) {
    return { formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION, gameId, t, mustHonor: [] };
  }

  const db = getDatabase();
  const entityIds = params.entityIds;
  const entityFilter = entityIds !== undefined ? ` AND f.entity_id IN (${entityIds.map(() => "?").join(",")})` : "";

  const rows = db
    .prepare(
      `SELECT f.id AS id, f.entity_id AS entity_id, f.key AS key, f.value AS value,
              f.valid_from_t AS valid_from_t, f.valid_to_t AS valid_to_t, f.irreversible AS irreversible,
              e.kind AS entity_kind, e.name AS entity_name
         FROM facts f
         JOIN entities e ON e.id = f.entity_id
        WHERE e.game_id = ?
          AND (
            (e.created_at_t <= ? AND (e.destroyed_at_t IS NULL OR e.destroyed_at_t > ?)
              AND f.valid_from_t <= ? AND (f.valid_to_t IS NULL OR f.valid_to_t > ?))
            OR
            (f.irreversible = 1 AND f.valid_from_t <= ?)
          )
          ${entityFilter}
        ORDER BY f.valid_from_t, f.entity_id, f.key, f.id`
    )
    .all(gameId, t, t, t, t, t, ...(entityIds ?? [])) as ConstraintFactRow[];

  const mustHonor = rows.map((row) => toConstraintFact(row, gameId));

  return { formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION, gameId, t, mustHonor };
}

/**
 * A structured assertion a caller wishes to check. Deliberately has NO
 * `text` field and never will: the engine compares a claim against facts,
 * never text against a word list (hard rule 4). Turning prose into claims
 * is the caller's half of the contract, downstream of this object.
 */
export interface Claim {
  entityId: string;
  key: string;
  value: string | number;
  /** Where on the axis this claim asserts its value. */
  t: T;
}

/** One derived contradiction: the claim, and the fact it contradicts, with
 *  that fact's one hop of causality attached. A row, never a verdict. */
export interface Contradiction {
  claim: Claim;
  fact: ConstraintFact;
}

/**
 * Whether `claimValue` and `factValue` name the same value -- the highest-
 * risk detail in this whole module, per the task brief. `resources.value`
 * is a REAL column, and the projection triggers CAST every projected value
 * to TEXT (`CAST(NEW.value AS TEXT)`, projection.ts), so a fact for a
 * numeric resource does NOT read the JS-formatted "20" -- it reads
 * whatever SQLite's own REAL-to-TEXT cast produces, typically "20.0" (see
 * `castedTextForm`'s doc comment in constrained.ts, and
 * `narration.test.ts`'s test that reads this string from a real database
 * rather than guessing it). A caller naturally holds a plain JS number.
 * Comparing "20" against "20.0" as bare strings would raise a false
 * contradiction -- exactly the "checker gets satisfied instead of
 * understood" failure design §5.2c/issue #12 exists to prevent, one layer
 * up from causality: getting the CHECK itself wrong is worse than getting
 * the reviewer's context for it wrong.
 *
 * So: if BOTH sides parse as finite numbers (trimmed, non-empty), compare
 * numerically with `===` and no epsilon -- the engine picks no tolerance,
 * the same policy `compareT` and every other axis comparison in this
 * codebase takes (no fuzzing what "equal" means). Otherwise compare as
 * exact strings, which is correct for every non-numeric fact key ("status"
 * = "destroyed" vs "rebuilt" has no numeric reading to fall back to).
 */
function valuesMatch(claimValue: string | number, factValue: string): boolean {
  const claimText = String(claimValue);
  const claimNumber = parseFiniteNumber(claimText);
  const factNumber = parseFiniteNumber(factValue);
  if (claimNumber !== null && factNumber !== null) {
    return claimNumber === factNumber;
  }
  return claimText === factValue;
}

function parseFiniteNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Derives every contradiction between `claims` and the facts `constraint`
 * says must be honored. Pure -- no database call anywhere in this
 * function, which is the whole point (module doc comment above): the
 * artifact-lint consumer runs this hours later on a JSON file, offline,
 * with no engine and no model in the loop.
 *
 * For each `(claim, fact)` pair matching on `entityId` AND `key`, where the
 * values differ (`valuesMatch` above):
 *
 *   - fact `irreversible`: a contradiction iff
 *     `compareT(claim.t, fact.validFromT) >= 0` -- mirroring
 *     `timeline_facts_irreversible` (schema.ts) EXACTLY, `>=` included. The
 *     trigger's own comment explains why: `valid_from_t` IS the instant the
 *     new value takes effect, so "prohibited for all t' > t" (§5.2b's prose)
 *     is stated at the row level as `>=` against the OLD fact's
 *     `valid_from_t`. Getting this boundary wrong in either direction is
 *     exactly the failure §12 exists to prevent -- a checker one increment
 *     looser or stricter than the trigger it is supposed to mirror would
 *     silently diverge from what the engine itself actually enforces.
 *   - fact NOT irreversible: a contradiction iff `validFromT <= claim.t`
 *     AND (`validToT === null` OR `claim.t < validToT`) -- the identical
 *     half-open reading `replay()` uses for "valid at t".
 *
 * A claim naming an entity/key with no fact in `mustHonor` yields NOTHING:
 * the engine is silent about what it does not know, and silence is not a
 * verdict (hard rule 2, §5.5's "the engine records the decision, it does
 * not make it" -- applied here to what it has never recorded at all).
 */
export function contradictions(
  constraint: NarrationConstraint,
  claims: readonly Claim[]
): Contradiction[] {
  // REFUSE A FORMAT THIS BUILD DOES NOT KNOW, rather than lint it anyway.
  // This function's whole purpose is to run far from the engine that produced
  // its input -- a different process, a different machine, hours or days
  // later (module doc comment above) -- which means it is exactly the kind of
  // code that meets a file written by a NEWER engine than itself. If a later
  // format version ever adds something that bears on whether a claim
  // contradicts a fact, an older checker reading it as v1 would not error; it
  // would silently return FEWER contradictions and report a clean artifact.
  // A checker that fails loudly can be fixed; a checker that quietly passes
  // everything gets trusted, and design §5.2c/issue #12's whole finding is
  // that a check nobody can argue with gets satisfied instead of understood.
  // Refusing an unknown version keeps "this artifact was checked" from ever
  // meaning "this artifact was checked by something that understood it."
  //
  // Deliberately `!==`, not `>`: a version this build has never heard of is
  // unreadable whether it is newer or older, and guessing which direction is
  // safe is how a compatibility window becomes a silent one.
  if (constraint.formatVersion !== NARRATION_CONSTRAINT_FORMAT_VERSION) {
    throw new Error(
      `narration constraint: format version ${constraint.formatVersion} is not the version this build ` +
        `understands (${NARRATION_CONSTRAINT_FORMAT_VERSION}); refusing to check claims against it rather ` +
        `than reporting a clean result it cannot justify`
    );
  }

  const found: Contradiction[] = [];

  for (const claim of claims) {
    for (const fact of constraint.mustHonor) {
      if (fact.entityId !== claim.entityId || fact.key !== claim.key) continue;
      if (valuesMatch(claim.value, fact.value)) continue;

      // Every comparison on the axis goes through `compareT` (t.ts), never a
      // bare `<=` -- not because the two differ today (`compareT` is `a - b`,
      // so they are identical for the finite numbers `assertT` admits) but
      // because `t` is a declared axis with one owner of what ordering means
      // on it, and a module that hand-rolls the comparison in one branch and
      // delegates it in the other is one axis change away from the two
      // branches disagreeing.
      const disagrees = fact.irreversible
        ? compareT(claim.t, fact.validFromT) >= 0
        : compareT(fact.validFromT, claim.t) <= 0 &&
          (fact.validToT === null || compareT(claim.t, fact.validToT) < 0);

      if (disagrees) {
        found.push({ claim, fact });
      }
    }
  }

  return found;
}
