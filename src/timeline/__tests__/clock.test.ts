// timeline_clock tests (GitHub issue #6). Design §14 / root CLAUDE.md hard
// rule 6: `t` is the axis that stays invariant when a caller re-segments its
// own units. That is a property, not a type -- `TimeAxis` (t.ts) makes the
// wrong shape awkward to *declare*; this file is what makes it impossible to
// *misuse* at runtime: declareTimeAxis / setStoryTime / currentStoryTime and
// every refusal that keeps a game's `t` meaning one thing for its whole
// life. Fixtures use grain/treasury/population per root CLAUDE.md; this file
// is scanned by engineVocabulary.test.ts like everything else in the tree.
//
// The end-to-end test below drives the real tool surface (createGame,
// createCharacter, ...) -- never a hand-inserted timeline row -- because
// that is the shape a caller with real story time actually uses, and it is
// the most important test in this file. Every refusal gets its own test
// with a message assertion, per the project's TDD rule (root CLAUDE.md): a
// guard that has never been shown failing is not yet a guard.
//
// Two guards were plant-and-watch-red verified by hand during development
// (mutations not committed -- these are plain JS `if`s, not SQL triggers, so
// there is nothing in the schema to DROP/CREATE the way schema.test.ts and
// projection.test.ts do; the equivalent here is neutering the guard in the
// source, running the suite, and restoring it):
//   - setStoryTime's backwards-t guard (`compareT(t, existing.current_t) < 0`
//     in clock.ts) was replaced with `false && ...`. Result: exactly one test
//     went red -- "setStoryTime refuses to move t backwards" -- everything
//     else, including declareTimeAxis's own separate backwards-t guards,
//     stayed green, confirming the guard is load-bearing for exactly the
//     case it claims and nothing else depends on it accidentally.
//   - declareTimeAxis's axis-swap guard (`existingAxis.kind !== "sequence"`)
//     was replaced with `false && ...`. Result: three tests went red --
//     "refuses a different KIND over an already-declared non-sequence axis",
//     "refuses the same kind with a different UNIT over an already-declared
//     axis", and "refuses sequence over an already-declared non-sequence
//     axis, by the same rule" -- all three cases the rule is supposed to
//     cover, and no others.
// Both restored; the file above passed 22/22 immediately after.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { declareTimeAxis, setStoryTime, currentStoryTime, type StoryTime } from "../clock.js";
import { replay, type Snapshot } from "../replay.js";
import { createGame } from "../../tools/game.js";
import { createCharacter, updateCharacter } from "../../tools/character.js";

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  destroyTestDb();
});

interface ClockRowRaw {
  game_id: string;
  current_t: number;
  axis_kind: string;
  axis_unit: string;
  declared_at: string;
}

function rawClock(gameId: string): ClockRowRaw | undefined {
  return db.prepare(`SELECT * FROM timeline_clock WHERE game_id = ?`).get(gameId) as
    | ClockRowRaw
    | undefined;
}

interface EntityTRow {
  created_at_t: number;
}

function entityCreatedAtT(entityId: string): number {
  return (db.prepare(`SELECT created_at_t FROM entities WHERE id = ?`).get(entityId) as EntityTRow)
    .created_at_t;
}

function makeGame(): string {
  return createGame({ name: "grain depot", setting: "test", style: "test" }).id;
}

/**
 * `currentStoryTime` returns null for a game nothing has declared or written
 * for, which is honest but not what any assertion below is about -- every
 * one of them has already written something. Failing here with a message
 * says "the clock row went missing", where a bare non-null assertion would
 * have thrown an unexplained TypeError several lines later.
 */
function storyTimeOf(gameId: string): StoryTime {
  const storyTime = currentStoryTime(gameId);
  if (!storyTime) throw new Error(`no timeline clock for game '${gameId}'`);
  return storyTime;
}

/** Same reasoning as `storyTimeOf`: a named failure beats a bare `!`. */
function factAt(snapshot: Snapshot, entityId: string, key: string): string {
  const entity = snapshot.entities.find((candidate) => candidate.id === entityId);
  if (!entity) throw new Error(`entity '${entityId}' is not in the snapshot at t=${snapshot.t}`);
  const fact = entity.facts[key];
  if (!fact) throw new Error(`entity '${entityId}' has no '${key}' fact at t=${snapshot.t}`);
  return fact.value;
}

function clockRowOf(gameId: string): ClockRowRaw {
  const row = rawClock(gameId);
  if (!row) throw new Error(`no timeline clock row for game '${gameId}'`);
  return row;
}

describe("end to end: a declared axis governs every write for its game", () => {
  it("entities, facts and events land on the declared t, replay(t) shows the right world at each one, and the engine's append ordinal never appears after declaration", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });

    // createGame() itself is the one write this project's public tool
    // surface cannot route around: it has no parameter for a caller-chosen
    // id, so there is no game.id to declare an axis against before it
    // exists. That single bootstrap write lands on the default sequence
    // axis, same as issue #2 always intended for a game that declares
    // nothing -- see this issue's task report for why "before the game
    // exists" is read as "before creating anything else" here.
    const bootstrapped = storyTimeOf(game.id);
    expect(bootstrapped.axis).toEqual({ kind: "sequence" });
    expect(bootstrapped.t).toBe(1);

    // Declare before creating anything ELSE for this game -- every entity
    // this game will ever have besides the bootstrap write above.
    const declared = declareTimeAxis({
      gameId: game.id,
      axis: { kind: "elapsed", unit: "minute" },
      startAt: bootstrapped.t,
    });
    expect(declared.axis).toEqual({ kind: "elapsed", unit: "minute" });
    expect(declared.t).toBe(bootstrapped.t);

    const alice = createCharacter({ gameId: game.id, name: "Alice", isPlayer: true });
    // A non-sequence axis is never auto-advanced by a write (projection.ts
    // only advances current_t `WHERE axis_kind = 'sequence'`), so Alice
    // lands exactly on the declared t, not on an incremented ordinal.
    expect(entityCreatedAtT(alice.id)).toBe(declared.t);
    expect(storyTimeOf(game.id).t).toBe(declared.t);

    const bob = createCharacter({ gameId: game.id, name: "Bob", isPlayer: false });
    expect(entityCreatedAtT(bob.id)).toBe(declared.t);

    // The caller moves story time forward by hand -- the only way it moves
    // on a declared axis.
    const movedT = declared.t + 30;
    const moved = setStoryTime({ gameId: game.id, t: movedT });
    expect(moved.t).toBe(movedT);

    updateCharacter(alice.id, { name: "Alicia" });

    const nameFacts = db
      .prepare(
        `SELECT value, valid_from_t, valid_to_t FROM facts WHERE entity_id = ? AND key = 'name' ORDER BY valid_from_t`
      )
      .all(alice.id) as { value: string; valid_from_t: number; valid_to_t: number | null }[];
    expect(nameFacts).toEqual([
      { value: "Alice", valid_from_t: declared.t, valid_to_t: movedT },
      { value: "Alicia", valid_from_t: movedT, valid_to_t: null },
    ]);

    // replay(t) at each declared t shows the right world -- the whole point
    // of the timeline being addressable by the caller's own axis rather
    // than by "now".
    const atDeclared = replay({ gameId: game.id, t: declared.t });
    // The game entity itself is alive at t too -- it was the bootstrap write
    // that created this game's clock row in the first place.
    expect(atDeclared.entities.map((e) => e.id).sort()).toEqual(
      [game.id, alice.id, bob.id].sort()
    );
    expect(factAt(atDeclared, alice.id, "name")).toBe("Alice");

    const atMoved = replay({ gameId: game.id, t: movedT });
    expect(factAt(atMoved, alice.id, "name")).toBe("Alicia");

    // Every t ever recorded for this game, across entities/facts/events, is
    // one of exactly the two values a caller actually chose (declared.t via
    // declareTimeAxis, movedT via setStoryTime) -- the engine's own append
    // ordinal (2, 3, 4, ...) never appears once a non-sequence axis governs
    // the game, which is the property this issue exists to enforce.
    const entityTs = (
      db.prepare(`SELECT created_at_t FROM entities WHERE game_id = ?`).all(game.id) as EntityTRow[]
    ).map((r) => r.created_at_t);
    const factTs = (
      db
        .prepare(
          `SELECT valid_from_t, valid_to_t FROM facts f JOIN entities e ON e.id = f.entity_id WHERE e.game_id = ?`
        )
        .all(game.id) as { valid_from_t: number; valid_to_t: number | null }[]
    ).flatMap((r) => [r.valid_from_t, r.valid_to_t].filter((v): v is number => v !== null));
    const eventTs = (
      db.prepare(`SELECT at_t FROM events WHERE game_id = ?`).all(game.id) as { at_t: number }[]
    ).map((r) => r.at_t);

    const allTs = new Set([...entityTs, ...factTs, ...eventTs]);
    expect(allTs).toEqual(new Set([declared.t, movedT]));
  });
});

describe("refusals", () => {
  it("setStoryTime refuses a game with no clock row", () => {
    expect(() => setStoryTime({ gameId: "no-such-game", t: 5 })).toThrow(
      /no timeline clock yet.*declare_time_axis/s
    );
  });

  it("setStoryTime refuses when the axis is still sequence, and says to declare one first", () => {
    const gameId = makeGame(); // bootstraps a default sequence clock
    expect(() => setStoryTime({ gameId, t: 100 })).toThrow(
      /still on the default sequence axis.*declare_time_axis/s
    );
  });

  it("setStoryTime refuses to move t backwards", () => {
    const gameId = makeGame();
    declareTimeAxis({ gameId, axis: { kind: "counter", unit: "turn" }, startAt: 10 });
    expect(() => setStoryTime({ gameId, t: 9 })).toThrow(/t never runs backwards/);
  });

  it("declareTimeAxis refuses a different KIND over an already-declared non-sequence axis", () => {
    const gameId = makeGame();
    declareTimeAxis({ gameId, axis: { kind: "elapsed", unit: "second" } });
    expect(() =>
      declareTimeAxis({ gameId, axis: { kind: "counter", unit: "turn" } })
    ).toThrow(/axis is fixed for the life of a game's timeline/);
  });

  it("declareTimeAxis refuses the same kind with a different UNIT over an already-declared axis", () => {
    const gameId = makeGame();
    declareTimeAxis({ gameId, axis: { kind: "elapsed", unit: "second" } });
    expect(() =>
      declareTimeAxis({ gameId, axis: { kind: "elapsed", unit: "minute" } })
    ).toThrow(/axis is fixed for the life of a game's timeline/);
  });

  it("declareTimeAxis refuses sequence over an already-declared non-sequence axis, by the same rule", () => {
    const gameId = makeGame();
    declareTimeAxis({ gameId, axis: { kind: "counter", unit: "turn" } });
    expect(() => declareTimeAxis({ gameId, axis: { kind: "sequence" } })).toThrow(
      /axis is fixed for the life of a game's timeline/
    );
  });

  it("declareTimeAxis refuses startAt behind current_t when declaring a new axis over sequence", () => {
    const gameId = makeGame();
    createCharacter({ gameId, name: "Alice", isPlayer: true }); // advances sequence past 1
    const before = storyTimeOf(gameId);
    expect(() =>
      declareTimeAxis({ gameId, axis: { kind: "elapsed", unit: "second" }, startAt: before.t - 1 })
    ).toThrow(/t never runs backwards/);
  });

  it("declareTimeAxis refuses startAt behind current_t when re-declaring the identical axis", () => {
    const gameId = makeGame();
    declareTimeAxis({ gameId, axis: { kind: "elapsed", unit: "second" }, startAt: 50 });
    expect(() =>
      declareTimeAxis({ gameId, axis: { kind: "elapsed", unit: "second" }, startAt: 49 })
    ).toThrow(/t never runs backwards/);
  });
});

describe("known limit, pinned: a game's declared-axis floor is above zero (createGame has no caller-supplied id)", () => {
  // This is NOT desired behaviour -- see the doc comment on declareTimeAxis
  // (clock.ts) and the issue #6 task report. createGame() mints its own id,
  // so there is no id to declare an axis against before its creation write
  // lands -- that write claims t=1 on the default sequence axis before any
  // caller can act, which sets this game's floor. Below the floor is refused
  // loudly (the backwards-t rule, from the caller's point of view); it is
  // never silently shifted down to fit, because a silent shift is exactly
  // the failure §14 exists to prevent. This lifts only if createGame (or an
  // equivalent) gains a caller-supplied id -- a separate issue, not this one.
  it("startAt below the floor is refused, with the floor named in the message", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const floor = storyTimeOf(game.id).t; // the game's own creation write already claimed this
    expect(floor).toBe(1);

    expect(() =>
      declareTimeAxis({ gameId: game.id, axis: { kind: "elapsed", unit: "second" }, startAt: 0 })
    ).toThrow(new RegExp(`current t is ${floor}\\b`));
  });

  it("startAt at the floor succeeds, and everything after it records the caller's own numbers unshifted", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const floor = storyTimeOf(game.id).t;

    const declared = declareTimeAxis({
      gameId: game.id,
      axis: { kind: "elapsed", unit: "second" },
      startAt: floor,
    });
    expect(declared.t).toBe(floor);

    // The caller's own number (500) comes back out exactly as floor + 500 --
    // the engine enforces the floor, it does not rebase or renormalize the
    // caller's axis around it.
    const moved = setStoryTime({ gameId: game.id, t: floor + 500 });
    expect(moved.t).toBe(floor + 500);
  });
});

describe("idempotence", () => {
  it("re-declaring the identical axis with no startAt changes nothing, including declared_at", () => {
    const gameId = makeGame();
    const first = declareTimeAxis({ gameId, axis: { kind: "counter", unit: "turn" }, startAt: 3 });
    const rowAfterFirst = clockRowOf(gameId);

    const second = declareTimeAxis({ gameId, axis: { kind: "counter", unit: "turn" } });
    expect(second).toEqual(first);
    expect(rawClock(gameId)).toEqual(rowAfterFirst); // no write happened at all, not even a no-op UPDATE
  });
});

describe("the default: a game that declares nothing runs on sequence (issue #2's behaviour, must not regress)", () => {
  it("t advances by exactly one per write, with no axis ever declared", () => {
    const game = createGame({ name: "treasury office", setting: "test", style: "test" });
    expect(storyTimeOf(game.id).t).toBe(1);
    expect(storyTimeOf(game.id).axis).toEqual({ kind: "sequence" });

    const alice = createCharacter({ gameId: game.id, name: "Alice", isPlayer: true });
    expect(entityCreatedAtT(alice.id)).toBe(2);
    expect(storyTimeOf(game.id).t).toBe(2);

    updateCharacter(alice.id, { name: "Alicia" });
    expect(storyTimeOf(game.id).t).toBe(3);
  });
});

describe("assertT refusals at every entry point (t.ts's assertT, checked before anything else runs)", () => {
  const badValues: Array<[string, unknown]> = [
    ["a Date", new Date()],
    ["a numeric string", "12"],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["null", null],
  ];

  it.each(badValues)("declareTimeAxis's startAt rejects %s", (_label, bad) => {
    const gameId = makeGame();
    expect(() =>
      declareTimeAxis({
        gameId,
        axis: { kind: "elapsed", unit: "second" },
        startAt: bad as unknown as number,
      })
    ).toThrow(/t must be a finite number/);
  });

  it.each(badValues)("setStoryTime's t rejects %s, even with no clock row for the game", (_label, bad) => {
    expect(() => setStoryTime({ gameId: "never-declared", t: bad as unknown as number })).toThrow(
      /t must be a finite number/
    );
  });
});

describe("recorded t is immutable, from this issue's angle", () => {
  // The property under test (§14 / hard rule 6) is that t is invariant --
  // moving the clock forward, or re-declaring the same axis, must never
  // rewrite what already happened. The append-only guard triggers (issue
  // #1) are the mechanism that makes this true; this test asserts the
  // consequence clock.ts's own operations must never violate: nothing this
  // module writes touches entities/facts/events, only timeline_clock.
  it("declareTimeAxis and setStoryTime never change an already-recorded created_at_t / valid_from_t / at_t", () => {
    const gameId = makeGame();
    // No startAt: defaults to the clock's current t (the game's own
    // bootstrap write already put it at 1), which is the only value that
    // satisfies "t never runs backwards" here -- see the report for why
    // this test can't reach back to a literal 0.
    declareTimeAxis({ gameId, axis: { kind: "elapsed", unit: "second" } });
    const alice = createCharacter({ gameId, name: "Alice", isPlayer: true });

    const before = {
      entity: db.prepare(`SELECT * FROM entities WHERE id = ?`).get(alice.id),
      facts: db.prepare(`SELECT * FROM facts WHERE entity_id = ? ORDER BY id`).all(alice.id),
      events: db.prepare(`SELECT * FROM events WHERE game_id = ? ORDER BY id`).all(gameId),
    };

    setStoryTime({ gameId, t: 500 });
    declareTimeAxis({ gameId, axis: { kind: "elapsed", unit: "second" }, startAt: 1000 });

    const after = {
      entity: db.prepare(`SELECT * FROM entities WHERE id = ?`).get(alice.id),
      facts: db.prepare(`SELECT * FROM facts WHERE entity_id = ? ORDER BY id`).all(alice.id),
      events: db.prepare(`SELECT * FROM events WHERE game_id = ? ORDER BY id`).all(gameId),
    };

    expect(after).toEqual(before);
  });
});
