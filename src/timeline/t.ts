/**
 * `t` -- story time, client-defined, chosen by one rule (design §14, hard
 * rule 6):
 *
 *   t is the axis that stays invariant when a caller re-segments its own
 *   units.
 *
 * A timestamp qualifies; so does a turn counter. An index into re-cuttable
 * units does NOT -- re-cutting the units shifts what the index points at
 * while the story underneath is unchanged. Choosing wrong raises no error:
 * it silently attaches one unit's content to another's.
 *
 * `t` is an opaque, client-declared ordinal. It is never a datetime -- a
 * `Date` carries a specific re-segmentation temptation (timezone, calendar,
 * "which second did this actually happen") that a plain number does not
 * invite. Callers that want elapsed real time declare an `elapsed` axis
 * (see clock.ts, #6) and hand it a float; they do not hand the engine a
 * `Date`.
 */
export type T = number;

/**
 * The one comparator every place in the timeline that orders `t` goes
 * through. Numeric ascending -- there is no other ordering `t` could have,
 * since it is always a plain number, but centralizing this means a future
 * axis kind can never introduce a second, inconsistent notion of "later."
 */
export function compareT(a: T, b: T): number {
  return a - b;
}

/**
 * Throws unless `value` is a finite number. Rejects everything else --
 * `Date`, string (including a numeric string like `"12"`), `NaN`,
 * `Infinity`, `null`, `undefined` -- naming what was actually supplied so
 * the caller doesn't have to guess which of those it sent.
 */
export function assertT(value: unknown): asserts value is T {
  if (typeof value === "number" && Number.isFinite(value)) {
    return;
  }
  throw new Error(`timeline: t must be a finite number, got ${describeRejectedT(value)}`);
}

/**
 * The declared shape of a game's `t` -- which axis it moves along, chosen
 * once per game and enforced by clock.ts (issue #6, `declareTimeAxis`).
 * Every variant here is here because it satisfies §14's property (hard rule
 * 6): it stays invariant when a caller re-segments its own units. There is a
 * fourth, more obvious-looking kind that is deliberately absent, and the
 * absence is the point -- see below.
 *
 * - `sequence` -- the engine's own append ordinal, one tick per write. The
 *   default for a game that declares nothing. Invariant because nothing
 *   re-cuts it: the engine is the only writer of the next value, so there is
 *   no "the caller's own units" for it to be an index into in the first
 *   place.
 * - `elapsed` -- time since a fixed origin, in a caller-named `unit` (e.g.
 *   "seconds", in-game "minutes" -- whatever the caller's own story runs on).
 *   Invariant because re-segmenting is exactly the act of drawing new unit
 *   boundaries over a timeline that does not itself move; elapsed time from
 *   a fixed origin has nothing to re-cut.
 * - `counter` -- a count of things that happened, in a caller-named `unit`
 *   (turns, ticks). Not a count of things authored. Invariant for the same
 *   reason `sequence` is: re-cutting authored material afterward does not
 *   change how many real events occurred before a given point.
 *
 * There is deliberately **no** variant for an index into units the caller
 * may re-cut. Editing re-cuts those: the index shifts while the story
 * underneath does not, and choosing one raises no error -- it silently
 * attaches one unit's content to another's (§14). Because there is no
 * variant for it, a caller who wants to hand the engine that kind of index
 * anyway has to pick `elapsed` or `counter` and lie about the unit to do it
 * -- there is no honest way to spell "index into units I might re-cut" in
 * this type. That awkwardness is deliberate: it is the API making the wrong
 * choice hard to make by accident, not merely documenting that it is wrong.
 * `clock.ts`'s `declareTimeAxis` backs this up at runtime by refusing to let
 * a game's axis change once declared -- swapping axes mid-timeline is the
 * one runtime action that reproduces this exact failure, so that is where
 * it gets refused.
 */
export type TimeAxis =
  | { kind: "sequence" }
  | { kind: "elapsed"; unit: string }
  | { kind: "counter"; unit: string };

function describeRejectedT(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Date) return `a Date (${value.toISOString()})`;
  if (typeof value === "number") {
    // Only NaN and +-Infinity reach here -- every other number returned
    // above.
    return String(value);
  }
  if (typeof value === "string") return `a string (${JSON.stringify(value)})`;
  return `a ${typeof value}`;
}
