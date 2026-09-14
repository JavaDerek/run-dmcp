import { v4 as uuidv4 } from "uuid";
import { getDatabase, withTransaction } from "../db/connection.js";
import { type T } from "./t.js";
import { currentStoryTime } from "./clock.js";
import { narrationConstraintAt, contradictions, type NarrationConstraint, type Claim, type Contradiction } from "./narration.js";
import { withAdjudicationOpen } from "./adjudication.js";
import type { EntityKind } from "./kinds.js";
import {
  writeConstrainedValue,
  transferConstrainedValue,
  setProjectedValue,
  createProjectedEntity,
  destroyProjectedEntity,
  type ValueTransition,
  type SetTransition,
  type CreatedEntity,
  type DestroyedEntity,
} from "./constrained.js";

/**
 * The inbound half of authority (design §5.2a, GitHub issue #10): propose ->
 * adjudicate -> outcome. The engine enforces the PROTOCOL -- resolution
 * happens before narration, writes go through the audited path, declared
 * constraints are checked -- WITHOUT knowing what any particular mechanic
 * *means*. A caller registers its mechanics; the engine dispatches them by
 * name and never learns what the name is for.
 *
 * REGISTRATION IS INJECTION AT CONSTRUCTION, never a global registry --
 * modeled directly on `initializeSchema({ migrations })`
 * (src/db/schema.ts's `SchemaMigration`), and for the identical reason that
 * module states for itself: a registry would make behaviour depend on
 * module import order and on import-time side effects, which is exactly the
 * disease the library/application entry-point split (src/index.ts vs
 * src/bin/run-dmcp.ts) cured. A parameter passed to `createResolver` cannot
 * be "registered too late" -- it is either in the array a caller handed to
 * the one call that matters, or it does not exist yet as far as this module
 * is concerned.
 *
 * ONE CONSUMER, AND THAT IS FINE (design §5.2a, root CLAUDE.md hard rule
 * 1). Core membership here is "generic, with at least one real caller," not
 * "needed by every consumer" -- this protocol has exactly one caller today,
 * and belongs in the core anyway because it is entirely generic: nothing
 * below this line has any opinion about what a "mechanic" does, only about
 * the shape every mechanic's dispatch and every mechanic's write must take.
 *
 * THE UNIFICATION THIS FILE DEPENDS ON: `narrationConstraintAt` (the
 * OUTBOUND half of authority, design §5.2b) and this module's own inbound
 * precondition check are the SAME STRUCTURE read in two directions. Every
 * `resolve()` call builds exactly one `NarrationConstraint` at the game's
 * current `t` and uses it for BOTH purposes -- as the input to
 * `contradictions()` when checking a caller's declared `expects`, and as
 * the mechanic's own read surface (`AdjudicationInput.constraint`). This is
 * not merely convenient reuse: it is what makes it structurally impossible
 * for the outbound contract and the inbound precondition to disagree about
 * what contradicts what, because they are never two comparisons, only one.
 *
 * THE ENGINE RECORDS DECISIONS; IT DOES NOT MAKE THEM (root CLAUDE.md hard
 * rule 2, design §5.5). This is the subtlest thing in this file, worth
 * saying plainly: the decision to depend on an `Expectation` was the
 * CALLER's, made when it built the `Proposal` -- not the engine's, and not
 * a policy the engine holds an opinion about. When an expectation does not
 * hold, `resolve()` is not passing judgement on the caller's mechanic or on
 * the world; it is reporting, structurally, that a precondition the caller
 * itself declared does not hold at the game's current `t`. `reason` on
 * `ResolveProtocolError` names which rule of the ENGINE'S OWN PROTOCOL
 * refused -- never a verdict about the proposal's merits, the mechanic's
 * correctness, or which side (fact or claim) is "wrong." Design §5.2c's one
 * hop of causality (the contradicted fact, its `validFromT`, the event that
 * opened it -- already carried on every `ConstraintFact`) is what lets a
 * caller answer that question for itself; the engine only hands over the
 * evidence.
 *
 * WHAT `resolve()` ENFORCES, IN ORDER -- each numbered comment inline below
 * names which of these it is:
 *   1. Unknown mechanic -> refuse before anything happens. No window opens,
 *      nothing is written, no query beyond the map lookup itself runs.
 *   2. The game must have a clock (`currentStoryTime`) -- a resolution with
 *      no `t` to attach itself to is refused, naming what is missing.
 *   3. Declared expectations, checked BEFORE dispatch, by reusing
 *      `narrationConstraintAt`/`contradictions` from narration.ts rather
 *      than writing a second comparison (see the unification note above).
 *      Any contradiction refuses without ever calling the mechanic's
 *      `adjudicate`.
 *   4. Dispatch. The mechanic returns intents; it receives no database
 *      handle anywhere in `AdjudicationInput` and therefore cannot write.
 *   5. Apply. ONE `withTransaction`, with `withAdjudicationOpen` nested
 *      INSIDE it (adjudication.ts's own doc comment asks for exactly this
 *      nesting, so the window row rolls back with the writes it
 *      authorized). Every change goes through `writeConstrainedValue` /
 *      `transferConstrainedValue` / `setProjectedValue` (issue #32, a
 *      non-numeric column) / `createProjectedEntity` /
 *      `destroyProjectedEntity` (issue #34, an entity beginning or ending)
 *      -- the one choke point (root CLAUDE.md hard rule 7) -- never a
 *      direct write. A `create` is labelled with a caller-chosen `ref`,
 *      and a later leg of the same resolution may say `{ ref }` wherever
 *      it would say an entity id, because a mechanic has no database
 *      handle and cannot know the id the engine will allocate; every ref
 *      is checked against the legs before it, BEFORE the transaction
 *      opens, so a ref naming nothing refuses with no write attempted.
 *      A constraint violation
 *      anywhere in the list propagates out of the transaction untouched
 *      (never caught and re-labelled here) and rolls back EVERY change the
 *      transaction made, including ones that individually would have
 *      succeeded.
 *   6. Record one `resolution.recorded` event, inside that SAME
 *      transaction, with `causes` carrying the resolution id, the
 *      mechanic's name, and the change count -- following
 *      `applyLiveWrite`'s (constrained.ts) `causes` discipline of never
 *      including a `row_id` key, which belongs to the projection triggers'
 *      own vocabulary (see that function's comment on why colliding with it
 *      would make `findOpenedByEventId`'s pick non-deterministic).
 *   7. Build the outcome's constraint AFTER the writes have landed --
 *      re-reading `currentStoryTime` inside the same transaction, after
 *      every change has been applied, so a `sequence`-axis game (whose `t`
 *      advances once per write) is queried at the `t` its own writes
 *      actually produced, not the `t` the resolution merely started at.
 *      This is what makes "resolution precedes narration" a PROTOCOL
 *      property rather than a convention design §5.2c already names as a
 *      real asymmetry: a caller reading `outcome.constraint` is reading
 *      state that could only exist once every write in this resolution had
 *      already committed.
 */

/** One fact a `Proposal` declares it depends on -- the caller's own
 *  precondition, verified before the mechanic it names is ever dispatched.
 *  No `t` field: the claim is always evaluated at the game's current story
 *  time, the same `t` the mechanic itself is dispatched at (see the module
 *  doc comment's unification note). */
export interface Expectation {
  entityId: string;
  key: string;
  value: string | number;
}

/** What a caller asks the engine to resolve. `parameters` is opaque to the
 *  engine -- handed to the named mechanic verbatim, never inspected here,
 *  the same way `Claim` (narration.ts) carries no `text` field: this module
 *  compares declared facts against declared expectations, never the shape
 *  or meaning of a mechanic's own arguments. */
export interface Proposal {
  gameId: string;
  mechanic: string;
  parameters?: Record<string, unknown>;
  expects?: readonly Expectation[];
}

/**
 * What a `Mechanic`'s `adjudicate` receives -- and ALL it receives. There is
 * no database handle anywhere in this shape, which is the entire mechanism
 * by which "every write goes through the audited path" is enforced: a
 * mechanic that never sees a connection cannot open one of its own, so the
 * only way its intent reaches storage at all is by returning `changes` for
 * `resolve()` itself to apply (step 5 above) through the one choke point.
 * `constraint` is the mechanic's read surface -- the world at `t`, exactly
 * as `narrationConstraintAt` (narration.ts) would serialize it for the
 * outbound half of authority; a mechanic that needs to know what currently
 * holds reads it from here, never from a query of its own.
 */
export interface AdjudicationInput {
  gameId: string;
  mechanic: string;
  t: T;
  parameters: Record<string, unknown>;
  constraint: NarrationConstraint;
}

/**
 * An entity id, or the label of an entity created by an earlier `create`
 * leg of the same resolution (issue #34). A mechanic cannot know the id the
 * engine allocates -- it has no database handle, which is the whole
 * mechanism of "every write goes through the audited path" -- so it names
 * the new entity by the `ref` it chose, and `resolve()` substitutes the
 * real id when it applies the leg.
 */
export type EntityRef = string | { ref: string };

/** One intended write to a single fact key -- the generic shape
 *  `writeConstrainedValue` (constrained.ts) already takes, carried here so a
 *  mechanic can express "change this value" without ever calling that
 *  function itself. */
export interface IntendedWrite {
  kind: "write";
  entityId: EntityRef;
  key: string;
  mode: "delta" | "set";
  value: number;
  reason?: string | null;
  bounds?: { minValue: number | null; maxValue: number | null };
}

/** One intended two-leg transfer between conserved members -- the generic
 *  shape `transferConstrainedValue` (constrained.ts) already takes. */
export interface IntendedTransfer {
  kind: "transfer";
  fromEntityId: EntityRef;
  toEntityId: EntityRef;
  key: string;
  amount: number;
  reason?: string | null;
  fromBounds?: { minValue: number | null; maxValue: number | null };
  toBounds?: { minValue: number | null; maxValue: number | null };
}

/** One intended set of a non-numeric column on an entity's projected row
 *  (issue #32) -- a thing changing owner, a character changing place. The
 *  engine stores `value` and never learns what `key` means; see
 *  `setProjectedValue` (constrained.ts) for what it refuses. */
export interface IntendedSet {
  kind: "set";
  entityId: EntityRef;
  key: string;
  /** `{ ref }` names an entity created earlier in this resolution -- the
   *  new thing becoming this entity's owner, say. */
  value: string | number | null | { ref: string };
}

/** One intended entity coming into existence (issue #34): a row in the
 *  projected table for `entityKind`, with `columns` restricted to that
 *  table's live columns and the game column filled by the engine from the
 *  proposal. `ref` is the label later legs of this same resolution use for
 *  it; the engine allocates the id and reports it in `Outcome.created`.
 *  The engine never learns what the entity is for or what it was made
 *  from -- "derived from" is the caller's to record. */
export interface IntendedCreate {
  kind: "create";
  ref: string;
  entityKind: EntityKind;
  columns: Readonly<Record<string, string | number | null | { ref: string }>>;
}

/** One intended entity ending (issue #34): its live row deleted, its facts
 *  closed by the projection trigger. See `destroyProjectedEntity`
 *  (constrained.ts) for what it refuses. */
export interface IntendedDestroy {
  kind: "destroy";
  entityId: EntityRef;
}

export type IntendedChange = IntendedWrite | IntendedTransfer | IntendedSet | IntendedCreate | IntendedDestroy;

/**
 * What a mechanic returns. `changes` are intents, not writes -- `resolve()`
 * applies every one of them through the one choke point (step 5); the
 * mechanic itself performs none of them. `result` is opaque to the engine,
 * carried to the `Outcome` verbatim and never inspected -- the same
 * discipline `Proposal.parameters` observes for the inbound side. There is
 * no severity field, no `ok`/`valid`/`success` anywhere in this shape (root
 * CLAUDE.md hard rule 2): a mechanic reports what happened, and whether
 * that counts as a win, a loss, or nothing at all is a question this engine
 * has no opinion about and no field to hold one in.
 */
export interface Adjudication {
  changes?: readonly IntendedChange[];
  result?: Record<string, unknown>;
  description?: string;
}

/**
 * The recorded result of a completed resolution. `constraint` is reachable
 * ONLY by way of a completed `resolve()` call -- there is no function that
 * hands back "the constraint a resolution would produce" without actually
 * running one -- which is what makes "resolution precedes narration" true
 * of the API's shape, not merely of how this module happens to be
 * implemented today.
 */
export interface Outcome {
  resolutionId: string;
  gameId: string;
  mechanic: string;
  t: T;
  result: Record<string, unknown>;
  transitions: ValueTransition[];
  /** Every `set` this resolution applied, in order (issue #32). Kept apart
   *  from `transitions`, whose values are numbers. */
  sets: SetTransition[];
  /** Every entity this resolution created, in order, each with the `ref`
   *  the mechanic labelled it with and the id the engine allocated (issue
   *  #34). Kept apart from `transitions` and `sets`, so existing callers are
   *  unchanged. */
  created: (CreatedEntity & { ref: string })[];
  /** Every entity this resolution destroyed, in order (issue #34). */
  destroyed: DestroyedEntity[];
  constraint: NarrationConstraint;
  eventId: string;
}

/** A mechanic a caller registers at construction (`createResolver`). `name`
 *  is a token the engine dispatches on and stores in exactly one place
 *  (the internal name -> mechanic map) -- it is never parsed, matched
 *  against a pattern, or read for meaning anywhere in this module (root
 *  CLAUDE.md hard rule 4). */
export interface Mechanic {
  /** A name the engine dispatches on and never interprets. */
  name: string;
  adjudicate(input: AdjudicationInput): Adjudication;
}

/** Which rule of the engine's OWN PROTOCOL a `resolve()` call refused
 *  under -- never a judgement about the proposal, the mechanic, or the
 *  world (see the module doc comment's "records decisions, does not make
 *  them" paragraph). */
export type ResolveRefusalReason =
  | "unknown-mechanic"
  | "no-clock"
  | "expectation-contradicted"
  /** A leg said `{ ref }` and no earlier `create` leg of the same
   *  resolution defined that ref (issue #34). Refused before any write. */
  | "unresolved-ref"
  /** Two `create` legs of one resolution chose the same `ref` (issue #34).
   *  Refused before any write. */
  | "duplicate-ref";

/**
 * Refused before dispatch, before any write, or (never, by construction --
 * see step 5 above) mid-apply. `reason` is the discriminant a caller
 * switches on; `contradictions` is populated ONLY for
 * `"expectation-contradicted"`, mirroring `ConstraintViolationError`'s own
 * `contradictedFact` (registry.ts), which is likewise set only for its one
 * relevant `constraintKind` rather than carrying a fourth sentinel value for
 * every other reason.
 *
 * Deliberately NOT what a constraint violation during apply (step 5) throws
 * -- that is a `ConstraintViolationError` (registry.ts), propagated
 * completely untouched (see the module doc comment). Wrapping it here would
 * blur the one distinction a caller actually needs: a `ResolveProtocolError`
 * means the PROTOCOL refused before anything was attempted; a
 * `ConstraintViolationError` out of `resolve()` means the protocol was
 * followed and the WORLD refused, mid-attempt, and everything already
 * rolled back.
 */
export class ResolveProtocolError extends Error {
  constructor(
    public readonly reason: ResolveRefusalReason,
    message: string,
    public readonly contradictions?: readonly Contradiction[]
  ) {
    super(message);
    this.name = "ResolveProtocolError";
  }
}

export interface Resolver {
  resolve(proposal: Proposal): Outcome;
  /** The registered names. The engine holds them; it never reads meaning
   *  into them. */
  mechanics(): string[];
}

/**
 * Validates a mechanic list the exact way `validateMigrations`
 * (src/db/schema.ts) validates a migration list -- same three checks, same
 * error voice: a non-empty string name, no duplicate name, a real
 * `adjudicate` function. Run once, at construction, so a bad registration
 * fails loudly before a single `resolve()` call rather than surfacing as a
 * confusing "undefined is not a function" three calls later.
 */
function validateMechanics(mechanics: readonly Mechanic[]): void {
  const seen = new Set<string>();

  for (const mechanic of mechanics) {
    const name = mechanic?.name;

    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error(`Invalid mechanic: 'name' must be a non-empty string, got ${JSON.stringify(name)}`);
    }

    if (seen.has(name)) {
      throw new Error(`Duplicate mechanic name: '${name}'`);
    }
    seen.add(name);

    if (typeof mechanic.adjudicate !== "function") {
      throw new Error(`Mechanic '${name}' has no 'adjudicate' function`);
    }
  }
}

/**
 * Builds the resolver a caller uses for the lifetime of its process.
 * `mechanics` is a parameter, not a global -- see the module doc comment on
 * why that is load-bearing rather than a style choice. An engine
 * constructed with an empty (or omitted) mechanics list is legal: every
 * `resolve()` call against it refuses with `"unknown-mechanic"`, which is
 * the correct behaviour for a caller that has not registered anything, not
 * a special case this function needs to guard against.
 */
export function createResolver(params: { mechanics: readonly Mechanic[] }): Resolver {
  validateMechanics(params.mechanics);

  const byName = new Map<string, Mechanic>();
  for (const mechanic of params.mechanics) {
    byName.set(mechanic.name, mechanic);
  }

  return {
    resolve(proposal: Proposal): Outcome {
      return resolveProposal(byName, proposal);
    },
    mechanics(): string[] {
      return [...byName.keys()];
    },
  };
}

/** The shape one `resolution.recorded` event's `causes` JSON carries.
 *  Deliberately no `row_id` key -- see applyLiveWrite's (constrained.ts)
 *  doc comment on why that token belongs to the projection triggers' own
 *  vocabulary and would collide with `findOpenedByEventId`'s pick if reused
 *  here for something else entirely. */
interface ResolutionCauses {
  source: "resolve";
  resolution_id: string;
  mechanic: string;
  change_count: number;
}

/** Every `{ ref }` a change carries, in the order it is read (issue #34) --
 *  the one place the shape of each intent kind's ref-bearing fields is
 *  known, shared by the pre-transaction check and the apply step. */
function refsUsedBy(change: IntendedChange): string[] {
  const refOf = (value: unknown): string[] => (typeof value === "object" && value !== null && "ref" in value ? [String((value as { ref: unknown }).ref)] : []);
  switch (change.kind) {
    case "write":
      return refOf(change.entityId);
    case "transfer":
      return [...refOf(change.fromEntityId), ...refOf(change.toEntityId)];
    case "set":
      return [...refOf(change.entityId), ...refOf(change.value)];
    case "create":
      return Object.values(change.columns).flatMap(refOf);
    case "destroy":
      return refOf(change.entityId);
    default:
      return [];
  }
}

/**
 * Step 5's precondition (issue #34): every `{ ref }` names a `create` leg
 * EARLIER in the list, and no two creates share a ref. Checked over the
 * intent list alone -- a structural property of what the mechanic returned,
 * decidable with no database at all -- so a bad ref refuses with no
 * transaction opened and no write attempted, in the same voice as every
 * other protocol refusal.
 */
function assertRefsResolvable(mechanicName: string, changes: readonly IntendedChange[]): void {
  const defined = new Set<string>();
  changes.forEach((change, index) => {
    for (const ref of refsUsedBy(change)) {
      if (!defined.has(ref)) {
        throw new ResolveProtocolError(
          "unresolved-ref",
          `resolve: leg ${index + 1} of mechanic '${mechanicName}' names ref '${ref}', and no earlier 'create' leg of this ` +
            `resolution defines it; refused before any write. A ref may only name an entity created by a leg before the one that uses it.`
        );
      }
    }
    if (change.kind === "create") {
      if (defined.has(change.ref)) {
        throw new ResolveProtocolError(
          "duplicate-ref",
          `resolve: mechanic '${mechanicName}' creates two entities under the ref '${change.ref}'; refused before any write. ` +
            `A ref is unique within one resolution.`
        );
      }
      defined.add(change.ref);
    }
  });
}

function deref(value: EntityRef, refs: ReadonlyMap<string, string>): string {
  if (typeof value === "string") return value;
  const id = refs.get(value.ref);
  if (id === undefined) {
    // Unreachable after assertRefsResolvable; guarded so a future caller of
    // this function alone still fails loudly.
    throw new ResolveProtocolError("unresolved-ref", `resolve: ref '${value.ref}' names no entity created in this resolution`);
  }
  return id;
}

function derefValue(value: string | number | null | { ref: string }, refs: ReadonlyMap<string, string>): string | number | null {
  return typeof value === "object" && value !== null ? deref(value, refs) : value;
}

type AppliedChange =
  | { transitions: ValueTransition[] }
  | { set: SetTransition }
  | { created: CreatedEntity & { ref: string } }
  | { destroyed: DestroyedEntity };

function applyChange(change: IntendedChange, gameId: string, refs: Map<string, string>): AppliedChange {
  if (change.kind === "set") {
    return { set: setProjectedValue({ entityId: deref(change.entityId, refs), key: change.key, value: derefValue(change.value, refs) }) };
  }

  if (change.kind === "write") {
    return {
      transitions: [
        writeConstrainedValue({
          entityId: deref(change.entityId, refs),
          key: change.key,
          mode: change.mode,
          value: change.value,
          reason: change.reason,
          bounds: change.bounds,
        }),
      ],
    };
  }

  if (change.kind === "transfer") {
    const { from, to } = transferConstrainedValue({
      fromEntityId: deref(change.fromEntityId, refs),
      toEntityId: deref(change.toEntityId, refs),
      key: change.key,
      amount: change.amount,
      reason: change.reason,
      fromBounds: change.fromBounds,
      toBounds: change.toBounds,
    });
    return { transitions: [from, to] };
  }

  if (change.kind === "create") {
    const columns: Record<string, string | number | null> = {};
    for (const [key, value] of Object.entries(change.columns)) columns[key] = derefValue(value, refs);
    const created = createProjectedEntity({ gameId, entityKind: change.entityKind, columns });
    refs.set(change.ref, created.entityId);
    return { created: { ...created, ref: change.ref } };
  }

  if (change.kind === "destroy") {
    return { destroyed: destroyProjectedEntity({ entityId: deref(change.entityId, refs) }) };
  }

  // Unreachable through the exported types (`IntendedChange` is an
  // exhaustive discriminated union), but a mechanic is caller-supplied code
  // this module does not control at runtime -- a malformed `kind` from
  // outside the type system must still fail loudly rather than silently
  // apply nothing.
  throw new Error(`resolve: an intended change carried an unrecognized kind '${(change as { kind: string }).kind}'`);
}

function resolveProposal(mechanicsByName: Map<string, Mechanic>, proposal: Proposal): Outcome {
  const { gameId, mechanic: mechanicName } = proposal;

  // 1. Unknown mechanic -- refuse before anything happens. No window opens,
  // nothing is written, and the only work done so far is a map lookup.
  const mechanic = mechanicsByName.get(mechanicName);
  if (!mechanic) {
    const registered = [...mechanicsByName.keys()];
    throw new ResolveProtocolError(
      "unknown-mechanic",
      `resolve: '${mechanicName}' is not a mechanic registered with this resolver. ` +
        (registered.length > 0
          ? `Registered: ${registered.join(", ")}.`
          : `This resolver has no mechanics registered at all.`) +
        ` The engine dispatches a mechanic by name and never learns what the name means -- register ` +
        `'${mechanicName}' at construction (createResolver) before proposing it.`
    );
  }

  // 2. The game must have a clock -- a resolution with no t to attach
  // itself to is refused, naming what is missing rather than guessing at a
  // default.
  const preStory = currentStoryTime(gameId);
  if (!preStory) {
    throw new ResolveProtocolError(
      "no-clock",
      `resolve: game '${gameId}' has no timeline clock yet -- nothing has been declared or written for ` +
        `it, so this resolution has no t to attach to. Declare a time axis (declare_time_axis) or write ` +
        `something through the normal tools first, then propose again.`
    );
  }
  const t = preStory.t;

  // 3. ONE query builds both the mechanic's read surface AND the inbound
  // precondition check -- see the module doc comment's unification note on
  // why this is the same structure read in two directions, not two
  // independently-maintained comparisons that could drift apart.
  const constraint = narrationConstraintAt({ gameId, t });

  const expectations = proposal.expects ?? [];
  if (expectations.length > 0) {
    const claims: Claim[] = expectations.map((expectation) => ({
      entityId: expectation.entityId,
      key: expectation.key,
      value: expectation.value,
      t,
    }));
    const found = contradictions(constraint, claims);
    if (found.length > 0) {
      throw new ResolveProtocolError(
        "expectation-contradicted",
        `resolve: ${found.length} declared expectation(s) for mechanic '${mechanicName}' do not hold at ` +
          `t=${t}; refused before dispatch. The caller declared these preconditions when it built the ` +
          `proposal -- the engine only reports that they do not hold, carrying one hop of causality per ` +
          `contradiction (design §5.2c) so a caller can tell whether the fact is wrong or the claim is.`,
        found
      );
    }
  }

  // 4. Dispatch. The mechanic sees gameId/mechanic/t/parameters/constraint
  // and NOTHING else -- no database handle exists anywhere in
  // AdjudicationInput, so the only way its intent can reach storage is by
  // returning `changes` for step 5 to apply.
  const adjudication = mechanic.adjudicate({
    gameId,
    mechanic: mechanicName,
    t,
    parameters: proposal.parameters ?? {},
    constraint,
  });

  const resolutionId = uuidv4();
  const changes = adjudication.changes ?? [];

  // 5's precondition: every ref resolves, before the transaction opens.
  assertRefsResolvable(mechanicName, changes);

  // 5 & 6. Apply every intended change through the one choke point, and
  // record one event -- both inside ONE transaction with the adjudication
  // window nested inside it (adjudication.ts's own doc comment asks for
  // exactly this order), so a violation anywhere rolls back every write,
  // the window row, AND the event together. Nothing here catches a
  // constraint violation -- it propagates out of withTransaction untouched,
  // by design (see the module doc comment on why a ConstraintViolationError
  // is never relabelled as a ResolveProtocolError).
  const applied = withTransaction(() =>
    withAdjudicationOpen(gameId, () => {
      const transitions: ValueTransition[] = [];
      const sets: SetTransition[] = [];
      const created: (CreatedEntity & { ref: string })[] = [];
      const destroyed: DestroyedEntity[] = [];
      const refs = new Map<string, string>();
      for (const change of changes) {
        const applied = applyChange(change, gameId, refs);
        if ("transitions" in applied) transitions.push(...applied.transitions);
        else if ("set" in applied) sets.push(applied.set);
        else if ("created" in applied) created.push(applied.created);
        else destroyed.push(applied.destroyed);
      }

      // Re-read the clock AFTER every write has landed, inside this same
      // transaction -- a sequence-axis game advances its own t once per
      // write (projection.ts), so the t this resolution's writes actually
      // produced can be later than the t it started at. The event this
      // resolution records, and the constraint the caller receives back,
      // both belong at THAT t, not at the one captured before dispatch.
      const postStory = currentStoryTime(gameId);
      if (!postStory) {
        // Cannot happen in practice -- entities/facts/events are
        // append-only and nothing deletes a timeline_clock row -- but this
        // function has no business assuming that silently forever.
        throw new Error(
          `resolve: game '${gameId}' lost its timeline clock mid-resolution -- cannot record the outcome event`
        );
      }

      const eventId = uuidv4();
      const causes: ResolutionCauses = {
        source: "resolve",
        resolution_id: resolutionId,
        mechanic: mechanicName,
        change_count: changes.length,
      };
      getDatabase()
        .prepare(
          `INSERT INTO events (id, game_id, at_t, kind, description, causes) VALUES (?, ?, ?, 'resolution.recorded', ?, ?)`
        )
        .run(eventId, gameId, postStory.t, adjudication.description ?? null, JSON.stringify(causes));

      return { transitions, sets, created, destroyed, eventId, postT: postStory.t };
    })
  );

  // 7. The outcome's constraint, built AFTER the writes landed and the
  // transaction holding them has already committed -- reachable only from a
  // completed resolution, which is what makes "resolution precedes
  // narration" a protocol property rather than a convention (§5.2c).
  const postConstraint = narrationConstraintAt({ gameId, t: applied.postT });

  return {
    resolutionId,
    gameId,
    mechanic: mechanicName,
    t,
    result: adjudication.result ?? {},
    transitions: applied.transitions,
    sets: applied.sets,
    created: applied.created,
    destroyed: applied.destroyed,
    constraint: postConstraint,
    eventId: applied.eventId,
  };
}
