import { getDatabase } from "../db/connection.js";
import { assertT, compareT, type T, type TimeAxis } from "./t.js";

/**
 * One game's declared position on its own timeline: where `t` currently
 * sits, and the axis it is measured on. What `currentStoryTime` /
 * `declareTimeAxis` / `setStoryTime` all read and write, one row per game in
 * `timeline_clock` (schema.ts).
 */
export interface StoryTime {
  gameId: string;
  t: T;
  axis: TimeAxis;
}

interface ClockRow {
  game_id: string;
  current_t: number;
  axis_kind: "sequence" | "elapsed" | "counter";
  axis_unit: string;
  declared_at: string;
}

/**
 * `timeline_clock.axis_unit` always holds a string, including for
 * `sequence` -- the generated projection triggers (projection.ts) write
 * `'write'` there when they lazily bootstrap a clock row for a game that
 * never called `declareTimeAxis`. The `TimeAxis` type has no `unit` field on
 * `sequence` because a caller never chooses or reads it; this function
 * exists so that fact is expressed once, not re-derived at every call site.
 */
function axisToRow(axis: TimeAxis): { kind: TimeAxis["kind"]; unit: string } {
  return axis.kind === "sequence" ? { kind: "sequence", unit: "write" } : axis;
}

function rowToAxis(row: ClockRow): TimeAxis {
  return row.axis_kind === "sequence"
    ? { kind: "sequence" }
    : { kind: row.axis_kind, unit: row.axis_unit };
}

/** Human-readable axis, for error messages only -- never parsed back. */
function describeAxis(axis: TimeAxis): string {
  return axis.kind === "sequence" ? "sequence (the engine's append ordinal)" : `${axis.kind}(${axis.unit})`;
}

/** `null` for `sequence` (no unit exists to compare), else the declared unit. */
function axisUnitOrNull(axis: TimeAxis): string | null {
  return axis.kind === "sequence" ? null : axis.unit;
}

function sameAxis(a: TimeAxis, b: TimeAxis): boolean {
  return a.kind === b.kind && axisUnitOrNull(a) === axisUnitOrNull(b);
}

function readClock(gameId: string): ClockRow | undefined {
  return getDatabase()
    .prepare(`SELECT game_id, current_t, axis_kind, axis_unit, declared_at FROM timeline_clock WHERE game_id = ?`)
    .get(gameId) as ClockRow | undefined;
}

/** Current position on a game's timeline, or null if nothing has ever been declared or written for it. */
export function currentStoryTime(gameId: string): StoryTime | null {
  const row = readClock(gameId);
  if (!row) return null;
  return { gameId, t: row.current_t, axis: rowToAxis(row) };
}

/**
 * Declares (or re-declares) the axis a game's `t` moves along. This is the
 * one place §14's property (hard rule 6) is enforced at runtime rather than
 * merely documented by `TimeAxis`'s missing fourth variant (t.ts):
 *
 *   - No clock row yet: create one at `startAt ?? 0` on the requested axis.
 *     This is the path a caller uses BEFORE creating anything for this game,
 *     so its world starts at its own origin -- 0.0 seconds, turn 0, whatever
 *     the caller's own axis calls zero -- rather than partway up the
 *     engine's append ordinal, which is what every game gets by default the
 *     moment its first entity is written with no axis declared (see
 *     projection.ts).
 *   - Re-declaring the IDENTICAL axis (same `kind`, and for `elapsed` /
 *     `counter` the same `unit`) is a no-op unless `startAt` is supplied, in
 *     which case it must be `>= current_t` -- `t` never runs backwards, full
 *     stop, even when the axis itself is not changing.
 *   - Declaring a DIFFERENT axis over a clock still on the default
 *     `sequence` axis is allowed -- nothing has committed to `sequence`
 *     meaning anything yet, it is just what every game gets before its
 *     owner says otherwise -- but `startAt` (defaulting to the current `t`)
 *     must still be `>= current_t`, so `t` never runs backwards across the
 *     change either.
 *   - Declaring a DIFFERENT axis over a clock already on a non-`sequence`
 *     axis is refused outright. An axis is fixed for the life of a game's
 *     timeline once it has been chosen for real: swapping it mid-timeline is
 *     precisely what re-segmenting a caller's own units does to the meaning
 *     of every `t` already recorded (§14) -- the one runtime action that
 *     reproduces that failure, and this is where it is refused rather than
 *     silently reinterpreting history. Declaring `sequence` back over a
 *     declared axis is refused by this exact same rule: `sequence` is a
 *     `kind` like any other here, not a neutral "no axis" state to fall back
 *     to.
 *
 * Known limit, pinned by a test in clock.test.ts (not desired behaviour): a
 * game created through `createGame` already has its own creation write
 * recorded on the default `sequence` axis before any caller can act --
 * `createGame` has no parameter for a caller-supplied id, so there is no id
 * to declare an axis against before that write lands. The practical effect
 * is that such a game's declared axis has a floor above zero (`startAt`
 * below the game's current `t` at declaration time is refused, by the
 * backwards-`t` rule above, with that floor named in the message). The fix
 * is to move the origin UP to the floor, never to shift the caller's own
 * numbers down to fit -- silently offsetting an axis to fit is exactly the
 * failure §14 exists to prevent, so this limit is enforced the same loud way
 * every other one here is. This lifts only if `createGame` (or an
 * equivalent) gains a caller-supplied id, which is a separate issue.
 */
export function declareTimeAxis(params: { gameId: string; axis: TimeAxis; startAt?: T }): StoryTime {
  const { gameId, axis } = params;
  if (params.startAt !== undefined) assertT(params.startAt);

  const db = getDatabase();
  const existing = readClock(gameId);

  if (!existing) {
    const t = params.startAt ?? 0;
    const row = axisToRow(axis);
    db.prepare(
      `INSERT INTO timeline_clock (game_id, current_t, axis_kind, axis_unit, declared_at) VALUES (?, ?, ?, ?, ?)`
    ).run(gameId, t, row.kind, row.unit, new Date().toISOString());
    return { gameId, t, axis };
  }

  const existingAxis = rowToAxis(existing);

  if (sameAxis(existingAxis, axis)) {
    if (params.startAt === undefined) {
      // No-op: the identical axis, no requested move.
      return { gameId, t: existing.current_t, axis: existingAxis };
    }
    if (compareT(params.startAt, existing.current_t) < 0) {
      throw new Error(
        `timeline: cannot declare startAt ${params.startAt} for game '${gameId}' -- ` +
          `t never runs backwards, and its current t is ${existing.current_t}. ` +
          `Pass startAt >= ${existing.current_t}, or omit startAt to leave t where it is.`
      );
    }
    db.prepare(`UPDATE timeline_clock SET current_t = ? WHERE game_id = ?`).run(params.startAt, gameId);
    return { gameId, t: params.startAt, axis: existingAxis };
  }

  if (existingAxis.kind !== "sequence") {
    throw new Error(
      `timeline: game '${gameId}' already declared axis ${describeAxis(existingAxis)}; ` +
        `an axis is fixed for the life of a game's timeline once declared, and cannot become ` +
        `${describeAxis(axis)} now. Swapping axes mid-timeline would silently reattach every ` +
        `already-recorded t to a different meaning (design §14) -- start a new game if this one ` +
        `truly needs a different axis, or re-declare ${describeAxis(existingAxis)} if that is what was meant.`
    );
  }

  const startAt = params.startAt ?? existing.current_t;
  if (compareT(startAt, existing.current_t) < 0) {
    throw new Error(
      `timeline: cannot declare axis ${describeAxis(axis)} starting at ${startAt} for game '${gameId}' -- ` +
        `t never runs backwards, even across an axis change, and its current t is ${existing.current_t}. ` +
        `Pass startAt >= ${existing.current_t}.`
    );
  }
  const newRow = axisToRow(axis);
  db.prepare(
    `UPDATE timeline_clock SET current_t = ?, axis_kind = ?, axis_unit = ?, declared_at = ? WHERE game_id = ?`
  ).run(startAt, newRow.kind, newRow.unit, new Date().toISOString(), gameId);
  return { gameId, t: startAt, axis };
}

/**
 * Moves a game's `t` forward. This is the caller's own hand on the clock --
 * it exists only for a declared, non-`sequence` axis, because those are the
 * only axes whose writes do not already advance `t` for themselves
 * (projection.ts advances `current_t` on every write, but only `WHERE
 * axis_kind = 'sequence'`; a declared `elapsed` or `counter` axis sits still
 * between calls here by construction).
 *
 * Three refusals, none of them advisory:
 *   - no clock row for `gameId`: nothing has declared or written anything
 *     for this game yet, so there is no `t` to move.
 *   - the axis is still `sequence`: the append ordinal belongs to the
 *     engine, not to a caller positioning `t` by hand. This is the sharpest
 *     form of "make the wrong axis awkward to supply" the API has -- a
 *     caller who reaches for this on a default game is told to say what its
 *     axis actually is first, not handed a silent success that means
 *     nothing.
 *   - `t` would move backwards under `compareT`.
 */
export function setStoryTime(params: { gameId: string; t: T }): StoryTime {
  assertT(params.t);
  const { gameId, t } = params;

  const existing = readClock(gameId);
  if (!existing) {
    throw new Error(
      `timeline: game '${gameId}' has no timeline clock yet -- nothing has been declared or written ` +
        `for it. Call declare_time_axis first (or write something through the normal tools, which ` +
        `bootstraps the default sequence axis), then set_story_time.`
    );
  }

  const axis = rowToAxis(existing);
  if (axis.kind === "sequence") {
    throw new Error(
      `timeline: game '${gameId}' is still on the default sequence axis -- the engine's own append ` +
        `ordinal, which advances one tick per write and does not take a caller-supplied position. ` +
        `Call declare_time_axis first with the axis this game's t actually is (elapsed or counter); ` +
        `set_story_time will work once a non-sequence axis is declared.`
    );
  }

  if (compareT(t, existing.current_t) < 0) {
    throw new Error(
      `timeline: cannot set story time to ${t} for game '${gameId}' -- t never runs backwards, and its ` +
        `current t is ${existing.current_t}. Pass a t >= ${existing.current_t}.`
    );
  }

  getDatabase().prepare(`UPDATE timeline_clock SET current_t = ? WHERE game_id = ?`).run(t, gameId);
  return { gameId, t, axis };
}
