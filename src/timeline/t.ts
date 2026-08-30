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
