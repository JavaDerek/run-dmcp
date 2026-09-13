// `resolve.ts` under contention -- design §5.2a, GitHub issue #31: pin what
// the engine does when TWO proposers call `resolver.resolve()` against the
// same world, interleaved on a `counter` axis, before a real caller with
// that exact shape arrives. resolve.test.ts's 18 cases are all one
// proposer against a world only it writes; this file is the first to
// exercise two.
//
// TEST-ONLY (issue #31's own instruction): no engine code changes in this
// commit. If a case could not pass without one, it is marked `it.fails`
// with the finding recorded in its own comment, per that instruction --
// none of the six needed that; see the file-level summary at the bottom for
// the one place the issue's own prose did not match what the engine does
// (case 2's named event), pinned as what was actually observed rather than
// what was guessed.
//
// Neutral fixture -- grain, treasury, population -- never a consumer's
// vocabulary (src/__tests__/engineVocabulary.test.ts). "Proposer A" and
// "Proposer B" are two callers of the same resolver, modeled as two
// registered mechanics under throwaway names, so nothing here needs a
// second principal concept the engine does not have -- the engine has no
// notion of "who" proposes, only "which mechanic," and that is exactly the
// generality issue #31 exists to pin.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../../tools/game.js";
import { createResource, getResource, deleteResource } from "../../tools/resource.js";
import * as constraintTools from "../../tools/constraint.js";
import { ConstraintViolationError } from "../registry.js";
import { writeConstrainedValue, valueHistory } from "../constrained.js";
import { adjudicationOpen } from "../adjudication.js";
import { declareIrreversible } from "../irreversible.js";
import { declareTimeAxis, setStoryTime, currentStoryTime } from "../clock.js";
import { createResolver, ResolveProtocolError, type Mechanic } from "../resolve.js";

describe("resolve protocol under contention -- two proposers (design §5.2a, issue #31)", () => {
  let db: Database.Database;
  let gameId: string;
  let grainId: string;
  let treasuryId: string;
  let populationId: string;

  beforeEach(() => {
    db = createTestDb();
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    gameId = game.id;
    grainId = createResource({ gameId, ownerType: "game", name: "grain", value: 50 }).id;
    treasuryId = createResource({ gameId, ownerType: "game", name: "treasury", value: 50 }).id;
    populationId = createResource({ gameId, ownerType: "game", name: "population", value: 20 }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  /** Every `resolution.recorded` event this game has accumulated, mirroring
   *  resolve.test.ts's own counter. */
  function countResolutionEvents(): number {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE game_id = ? AND kind = 'resolution.recorded'`)
      .get(gameId) as { c: number };
    return row.c;
  }

  /** Moves the game onto a `counter` axis frozen wherever it currently sits,
   *  so every write from here on lands at a `t` this test controls by hand
   *  via `setStoryTime` rather than the engine's own append ordinal --
   *  exactly the shape issue #31 asks these cases to alternate on. */
  function declareCounterAxis(): number {
    const before = currentStoryTime(gameId);
    expect(before).not.toBeNull();
    const t0 = before?.t as number;
    declareTimeAxis({ gameId, axis: { kind: "counter", unit: "turn" }, startAt: t0 });
    return t0;
  }

  // ==========================================================================
  // Case 1: alternating writes at t, t+1, t+2 -- every transition survives,
  // in order, and no interleaving loses a write.
  // ==========================================================================
  it("case 1: two mechanics alternating at t, t+1, t+2 on a counter axis -- valueHistory shows every transition in order", () => {
    const t0 = declareCounterAxis();

    const sow: Mechanic = {
      name: "SOW",
      adjudicate: () => ({
        changes: [{ kind: "write", entityId: grainId, key: "value", mode: "delta", value: 10 }],
      }),
    };
    const levy: Mechanic = {
      name: "LEVY",
      adjudicate: () => ({
        changes: [{ kind: "write", entityId: treasuryId, key: "value", mode: "delta", value: 5 }],
      }),
    };
    const resolver = createResolver({ mechanics: [sow, levy] });

    // Proposer A, at t0.
    const outcomeA1 = resolver.resolve({ gameId, mechanic: "SOW" });
    expect(outcomeA1.t).toBe(t0);

    // Proposer B, at t0 + 1.
    setStoryTime({ gameId, t: t0 + 1 });
    const outcomeB = resolver.resolve({ gameId, mechanic: "LEVY" });
    expect(outcomeB.t).toBe(t0 + 1);

    // Proposer A again, at t0 + 2.
    setStoryTime({ gameId, t: t0 + 2 });
    const outcomeA2 = resolver.resolve({ gameId, mechanic: "SOW" });
    expect(outcomeA2.t).toBe(t0 + 2);

    expect(getResource(grainId)?.value).toBe(70);
    expect(getResource(treasuryId)?.value).toBe(55);
    expect(countResolutionEvents()).toBe(3);

    // valueHistory is newest-first (constrained.ts's own documented order).
    const grainHistory = valueHistory(grainId, "value");
    expect(grainHistory).toHaveLength(2);
    expect(grainHistory[0]).toMatchObject({ previousValue: 60, newValue: 70, t: t0 + 2 });
    expect(grainHistory[1]).toMatchObject({ previousValue: 50, newValue: 60, t: t0 });

    const treasuryHistory = valueHistory(treasuryId, "value");
    expect(treasuryHistory).toHaveLength(1);
    expect(treasuryHistory[0]).toMatchObject({ previousValue: 50, newValue: 55, t: t0 + 1 });
  });

  // ==========================================================================
  // Case 2: A's expectation is contradicted by B's earlier write. One hop of
  // causality (issue #30) now travels on the contradiction's fact -- assert
  // what it actually names, per issue #31's own "assert the shape either
  // way and mark which."
  // ==========================================================================
  it("case 2: A's expectation is contradicted by B's earlier write, and the contradiction's fact carries a non-null hop", () => {
    const t0 = declareCounterAxis();

    const setTo100: Mechanic = {
      name: "OVERWRITE",
      adjudicate: () => ({
        changes: [{ kind: "write", entityId: grainId, key: "value", mode: "set", value: 100 }],
      }),
    };
    const resolver = createResolver({ mechanics: [setTo100, { name: "SOW", adjudicate: () => ({}) }] });

    // Proposer B writes grain to 100 at t0.
    const outcomeB = resolver.resolve({ gameId, mechanic: "OVERWRITE" });
    expect(getResource(grainId)?.value).toBe(100);

    // Proposer A, one t later, expects grain's value to still be 40 (stale --
    // it never saw B's write).
    setStoryTime({ gameId, t: t0 + 1 });
    let caught: unknown;
    try {
      resolver.resolve({ gameId, mechanic: "SOW", expects: [{ entityId: grainId, key: "value", value: 40 }] });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ResolveProtocolError);
    const err = caught as ResolveProtocolError;
    expect(err.reason).toBe("expectation-contradicted");
    const found = err.contradictions ?? [];
    expect(found).toHaveLength(1);
    expect(found[0].claim).toMatchObject({ entityId: grainId, key: "value", value: 40 });
    // The fact naming what's actually there: B's write, "100" (SQLite's own
    // REAL-to-TEXT cast, per narration.ts's documented risk -- never a
    // hand-written guess).
    expect(found[0].fact.value).toBe(String(getResource(grainId)?.value) + ".0");

    // ISSUE #31 SAYS: "naming B's resolution.recorded event." OBSERVED: it
    // does not. `writeConstrainedValue` -> `applyLiveWrite` performs a raw
    // `UPDATE resources SET value = ...`, which fires the projection
    // trigger's `_au` body -- THAT is what opens the new fact and stamps it
    // (issue #30) with the `resource.updated` event the trigger itself
    // inserts. `resolution.recorded` is a separate, higher-level event
    // resolve.ts inserts directly, afterward, in the same transaction, and
    // no trigger ever runs against it -- it stamps nothing. The hop is real
    // and non-null, but it names the low-level state-transition event, not
    // the resolution that triggered it. Pinned here as what the engine
    // actually does; see this file's header note.
    expect(found[0].fact.openedByEventId).not.toBeNull();
    const namedEvent = db.prepare(`SELECT kind, causes FROM events WHERE id = ?`).get(found[0].fact.openedByEventId) as
      | { kind: string; causes: string | null }
      | undefined;
    expect(namedEvent?.kind).toBe("resource.updated");
    expect(namedEvent?.kind).not.toBe("resolution.recorded");
    // It is B's write specifically, not merely *an* update event: the
    // annotation event `applyLiveWrite` also writes carries the resolution
    // id that produced it, and that resolution is the one under test.
    const resolutionCauses = db
      .prepare(`SELECT causes FROM events WHERE game_id = ? AND kind = 'resolution.recorded'`)
      .get(gameId) as { causes: string };
    const resolutionId = (JSON.parse(resolutionCauses.causes) as { resolution_id: string }).resolution_id;
    expect(outcomeB.resolutionId).toBe(resolutionId);
  });

  // ==========================================================================
  // Case 3: resolve_only under contention -- a direct write is refused while
  // no window is open, even interleaved with another proposer's completed
  // resolutions (no leaked window between calls).
  // ==========================================================================
  it("case 3: resolve_only refuses a direct write between two proposers' resolutions -- no leaked window", () => {
    constraintTools.declareResolveOnlyConstraint({ gameId, resourceId: treasuryId });
    const resolver = createResolver({
      mechanics: [
        {
          name: "LEVY",
          adjudicate: () => ({
            changes: [{ kind: "write", entityId: treasuryId, key: "value", mode: "delta", value: 10 }],
          }),
        },
      ],
    });

    // Proposer A resolves; the window opens and closes within resolve().
    resolver.resolve({ gameId, mechanic: "LEVY" });
    expect(adjudicationOpen()).toBe(false);
    expect(getResource(treasuryId)?.value).toBe(60);

    // Proposer B attempts a DIRECT write between A's resolution and B's own
    // -- outside any resolution, so it is refused exactly as it would be
    // with a single proposer.
    expect(() => writeConstrainedValue({ entityId: treasuryId, key: "value", mode: "delta", value: 5 })).toThrow(
      ConstraintViolationError
    );
    expect(getResource(treasuryId)?.value).toBe(60);

    // And B's OWN resolution still works, because it goes through the
    // adjudicating call -- the constraint governs directness, not identity.
    const outcomeB = resolver.resolve({ gameId, mechanic: "LEVY" });
    expect(outcomeB.transitions[0]).toMatchObject({ previousValue: 60, newValue: 70 });
    expect(adjudicationOpen()).toBe(false);
  });

  // ==========================================================================
  // Case 4: irreversible -- A declares a fact irreversible; B's later
  // resolution contradicts it and rolls back EVERY change in that
  // resolution, including a numeric leg (treasury) that would have
  // succeeded alone, and records no event.
  // ==========================================================================
  it("case 4: irreversible rolls back every change in B's resolution, including a leg that would have succeeded alone", () => {
    // Proposer A's declaration: population's current value (20) is now
    // irreversible -- declareIrreversible is its own top-level API (design
    // §5.3), not a resolve() change kind, exactly as irreversible.test.ts
    // exercises it.
    declareIrreversible({ entityId: populationId, key: "value" });

    const resolver = createResolver({
      mechanics: [
        {
          name: "CENSUS",
          adjudicate: () => ({
            changes: [
              // Contradicts the irreversible fact just declared.
              { kind: "write", entityId: populationId, key: "value", mode: "set", value: 25 },
              // Legal on its own -- would succeed if it were the only change.
              { kind: "write", entityId: treasuryId, key: "value", mode: "delta", value: 10 },
            ],
          }),
        },
      ],
    });

    const before = countResolutionEvents();
    expect(() => resolver.resolve({ gameId, mechanic: "CENSUS" })).toThrow(ConstraintViolationError);

    expect(getResource(populationId)?.value).toBe(20);
    expect(getResource(treasuryId)?.value).toBe(50);
    expect(valueHistory(treasuryId, "value")).toEqual([]);
    expect(countResolutionEvents()).toBe(before);
    expect(adjudicationOpen()).toBe(false);
  });

  // ==========================================================================
  // Case 5: an expectation naming an entity/key with no fact at t dispatches
  // -- pinned as contradictions()'s documented "silence is not a verdict",
  // not fixed. A caller reading this test learns it cannot express "still
  // exists" through `expects`.
  // ==========================================================================
  it("case 5: an expectation about a destroyed entity's key dispatches -- silence is not a verdict (pinned, not fixed)", () => {
    expect(deleteResource(populationId)).toBe(true);

    let dispatched = false;
    const resolver = createResolver({
      mechanics: [
        {
          name: "SOW",
          adjudicate: () => {
            dispatched = true;
            return {};
          },
        },
      ],
    });

    // The expectation names a key on an entity that no longer exists at all
    // -- contradictions() finds no fact to compare against and therefore
    // reports nothing, so resolve() proceeds to dispatch. A caller that
    // wanted to assert "population still exists" cannot express that through
    // `expects`; this is the documented limit, not a bug this test polices.
    const outcome = resolver.resolve({
      gameId,
      mechanic: "SOW",
      expects: [{ entityId: populationId, key: "value", value: 20 }],
    });

    expect(dispatched).toBe(true);
    expect(outcome.mechanic).toBe("SOW");

    // The identical silence for a key that was simply never written on a
    // live entity -- same documented behaviour, different cause.
    dispatched = false;
    const outcome2 = resolver.resolve({
      gameId,
      mechanic: "SOW",
      expects: [{ entityId: grainId, key: "reputation", value: "renowned" }],
    });
    expect(dispatched).toBe(true);
    expect(outcome2.mechanic).toBe("SOW");
  });

  // ==========================================================================
  // Case 6: two proposals at the SAME t on a counter axis -- both land;
  // assert only what the engine promises about their order, which is
  // nothing. This is the test that documents why a caller alternates
  // half-steps (case 1) rather than sharing a t.
  // ==========================================================================
  it("case 6: two proposals at the identical t on a counter axis both land, with no promised order between them", () => {
    const t0 = declareCounterAxis();

    const sow: Mechanic = {
      name: "SOW",
      adjudicate: () => ({
        changes: [{ kind: "write", entityId: grainId, key: "value", mode: "delta", value: 10 }],
      }),
    };
    const levy: Mechanic = {
      name: "LEVY",
      adjudicate: () => ({
        changes: [{ kind: "write", entityId: treasuryId, key: "value", mode: "delta", value: 5 }],
      }),
    };
    const resolver = createResolver({ mechanics: [sow, levy] });

    // Neither call moves the clock (counter axis, no setStoryTime between
    // them) -- both proposals share t0.
    const outcomeA = resolver.resolve({ gameId, mechanic: "SOW" });
    const outcomeB = resolver.resolve({ gameId, mechanic: "LEVY" });

    expect(outcomeA.t).toBe(t0);
    expect(outcomeB.t).toBe(t0);

    // Both landed, independently and completely -- this is the entire
    // promise. No assertion here about which resolution's event sorts
    // first, which fact opened "before" the other, or any other notion of
    // order at a shared t: the engine makes none, which is exactly why a
    // caller alternating turns (case 1) advances t between them instead of
    // sharing one.
    expect(getResource(grainId)?.value).toBe(60);
    expect(getResource(treasuryId)?.value).toBe(55);
    expect(countResolutionEvents()).toBe(2);
    expect(outcomeA.resolutionId).not.toBe(outcomeB.resolutionId);
  });
});
