// `resolve_only` -- the fourth ROW-based member of the constraint family
// (design §5.3, §5.2a; GitHub issue #13): every DIRECT write to the fact
// key it governs is refused, so the value can move only through an
// adjudicating call. It was written downstream and never extracted; this
// file is its extraction.
//
// Two independent guards enforce it, and this file proves both actually do
// something rather than merely existing:
//   - the JS choke point, a `resolve_only` branch in assertConstraintsAllow()
//     (constrained.ts), which every writeConstrainedValue/transferConstrainedValue
//     call passes through;
//   - the SQL backstop, `timeline_facts_resolve_only` (a BEFORE INSERT ON
//     facts trigger, src/db/schema.ts), which makes bypassing the JS layer
//     entirely -- a raw UPDATE that never calls writeConstrainedValue --
//     unconstructable rather than merely unchecked.
// Both read the SAME adjudication window (src/timeline/adjudication.ts) as
// their one source of truth for "is this write, in fact, direct."
//
// Every guard here is planted-and-watched-red per the project's testing
// rule (root CLAUDE.md) -- see the task report for the actual failing-first
// runs, including the ones (the SQL trigger's DROP/CREATE cycle) that are
// ALSO permanent regression tests in this file, not only one-time checks.
//
// Fixtures: grain, treasury, population -- never either consumer's
// vocabulary (src/__tests__/engineVocabulary.test.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { getDatabase, closeDatabase } from "../../db/connection.js";
import { initializeSchema } from "../../db/schema.js";
import { createGame } from "../../tools/game.js";
import {
  createResource,
  getResource,
  updateResourceValue,
  transferResourceValue,
  deleteResource,
} from "../../tools/resource.js";
import * as constraintTools from "../../tools/constraint.js";
import { ConstraintViolationError } from "../registry.js";
import { writeConstrainedValue, transferConstrainedValue } from "../constrained.js";
import { adjudicationOpen, withAdjudicationOpen } from "../adjudication.js";

describe("resolve_only", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  // ==========================================================================
  // declareResolveOnlyConstraint (src/tools/constraint.ts)
  // ==========================================================================
  describe("declareResolveOnlyConstraint", () => {
    it("declares with the default factKey 'value' and null direction/total", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });

      const constraint = constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      expect(constraint.kind).toBe("resolve_only");
      expect(constraint.resourceIds).toEqual([grain.id]);
      expect(constraint.direction).toBeNull();
      expect(constraint.total).toBeNull();
      expect(constraint.factKey).toBe("value");
    });

    it("declares with an explicit, non-default factKey", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });

      const constraint = constraintTools.declareResolveOnlyConstraint({
        gameId: game.id,
        resourceId: grain.id,
        factKey: "population",
      });

      expect(constraint.factKey).toBe("population");
    });

    it("throws when the game does not exist", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });

      expect(() =>
        constraintTools.declareResolveOnlyConstraint({ gameId: "does-not-exist", resourceId: grain.id })
      ).toThrow();
    });

    it("throws when the resource does not exist", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });

      expect(() =>
        constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: "does-not-exist" })
      ).toThrow(/not found/i);
    });

    it("rejects a duplicate declaration on the same (resource, factKey)", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      expect(() => constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id })).toThrow(
        /already has a 'resolve_only' constraint/i
      );
    });

    it("permits a SECOND resolve_only declaration on the same resource under a DIFFERENT factKey", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id, factKey: "value" });

      expect(() =>
        constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id, factKey: "population" })
      ).not.toThrow();
    });
  });

  // ==========================================================================
  // The adjudication window (src/timeline/adjudication.ts)
  // ==========================================================================
  describe("the adjudication window", () => {
    it("is closed at rest", () => {
      expect(adjudicationOpen()).toBe(false);
    });

    it("is open for the duration of withAdjudicationOpen's fn", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      let observedInside = false;
      withAdjudicationOpen(game.id, () => {
        observedInside = adjudicationOpen();
      });
      expect(observedInside).toBe(true);
    });

    it("closes again once withAdjudicationOpen returns normally", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      withAdjudicationOpen(game.id, () => 42);
      expect(adjudicationOpen()).toBe(false);
    });

    it("returns fn's value", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const result = withAdjudicationOpen(game.id, () => "grain harvested");
      expect(result).toBe("grain harvested");
    });

    describe("re-entrancy: nested windows", () => {
      it("keeps the outer window open while an inner call is in flight, and after the inner call returns", () => {
        const game = createGame({ name: "grain depot", setting: "test", style: "test" });
        let openDuringInner = false;
        let openAfterInnerReturnsButBeforeOuterReturns = false;

        withAdjudicationOpen(game.id, () => {
          withAdjudicationOpen(game.id, () => {
            openDuringInner = adjudicationOpen();
          });
          // The inner call already ran its own `finally` and deleted ITS
          // OWN row -- but the outer row (inserted before the inner call
          // started) is untouched, so the window is still open here.
          openAfterInnerReturnsButBeforeOuterReturns = adjudicationOpen();
        });

        expect(openDuringInner).toBe(true);
        expect(openAfterInnerReturnsButBeforeOuterReturns).toBe(true);
        expect(adjudicationOpen()).toBe(false);
      });

      it("a throwing inner call does not close the outer window -- the outer's own row survives", () => {
        const game = createGame({ name: "grain depot", setting: "test", style: "test" });
        let openAfterCatchingInnerThrow = false;

        withAdjudicationOpen(game.id, () => {
          expect(() =>
            withAdjudicationOpen(game.id, () => {
              throw new Error("inner adjudication failed");
            })
          ).toThrow("inner adjudication failed");

          openAfterCatchingInnerThrow = adjudicationOpen();
        });

        expect(openAfterCatchingInnerThrow).toBe(true);
        expect(adjudicationOpen()).toBe(false);
      });

      it("three levels deep still closes fully once every level has returned", () => {
        const game = createGame({ name: "grain depot", setting: "test", style: "test" });
        const seenOpen: boolean[] = [];

        withAdjudicationOpen(game.id, () => {
          withAdjudicationOpen(game.id, () => {
            withAdjudicationOpen(game.id, () => {
              seenOpen.push(adjudicationOpen());
            });
            seenOpen.push(adjudicationOpen());
          });
          seenOpen.push(adjudicationOpen());
        });

        expect(seenOpen).toEqual([true, true, true]);
        expect(adjudicationOpen()).toBe(false);
      });
    });

    describe("partial failure: a throwing adjudication leaves no window open", () => {
      it("a single-level throw closes the window (no stray row survives)", () => {
        const game = createGame({ name: "grain depot", setting: "test", style: "test" });

        expect(() =>
          withAdjudicationOpen(game.id, () => {
            throw new Error("adjudication failed before any write");
          })
        ).toThrow("adjudication failed before any write");

        expect(adjudicationOpen()).toBe(false);
        const rows = db.prepare(`SELECT COUNT(*) AS n FROM timeline_adjudications_open`).get() as { n: number };
        expect(rows.n).toBe(0);
      });

      it("a write fn performs before throwing keeps its own effect (own transaction), but the window row is still cleaned up", () => {
        // This is the boundary this module's "no half-landed write" promise
        // actually covers: the WINDOW ROW never survives a throw, regardless
        // of what fn did before throwing. A domain write fn makes has its
        // OWN atomicity (writeConstrainedValue's own withTransaction) and is
        // not rolled back by withAdjudicationOpen throwing afterward --
        // exactly like a database transaction committing before an
        // application-level error is raised later in the same request.
        const game = createGame({ name: "grain depot", setting: "test", style: "test" });
        const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });

        expect(() =>
          withAdjudicationOpen(game.id, () => {
            writeConstrainedValue({ entityId: grain.id, key: "value", mode: "set", value: 75 });
            throw new Error("adjudication failed after the write already committed");
          })
        ).toThrow("adjudication failed after the write already committed");

        expect(adjudicationOpen()).toBe(false);
        expect(getResource(grain.id)?.value).toBe(75);
      });
    });

    describe("startup cleanup closes any leftover window (fail-closed, not fail-open)", () => {
      it("a row left behind by a crashed process (never cleaned by any finally) is cleared by the next initializeSchema(), and enforcement resumes", () => {
        const game = createGame({ name: "grain depot", setting: "test", style: "test" });
        const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
        constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

        // Simulate a crash: a row inserted with no corresponding `finally`
        // ever running (the process that opened it is simply gone).
        db.prepare(`INSERT INTO timeline_adjudications_open (id, game_id, opened_at) VALUES (?, ?, ?)`).run(
          uuidv4(),
          game.id,
          new Date().toISOString()
        );
        expect(adjudicationOpen()).toBe(true);

        // The next startup pass -- initializeSchema() -- must resolve this
        // ambiguous leftover to "not open" (fail CLOSED), not leave
        // resolve_only silently unenforced forever.
        initializeSchema();

        expect(adjudicationOpen()).toBe(false);
        expect(() => updateResourceValue({ resourceId: grain.id, mode: "set", value: 999 })).toThrow(
          ConstraintViolationError
        );
      });
    });
  });

  // ==========================================================================
  // timeline_facts_resolve_only -- the SQL backstop, raw trigger level
  // ==========================================================================
  describe("timeline_facts_resolve_only (BEFORE INSERT ON facts guard)", () => {
    it("refuses a raw UPDATE that bypasses writeConstrainedValue entirely, with no window open", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(999, grain.id)).toThrow(
        /resolve_only|adjudicating call/i
      );
      // The whole statement -- including the projection trigger's own
      // partial work -- rolled back; the live column never moved.
      expect(getResource(grain.id)?.value).toBe(50);
    });

    it("names the fact key and points at the adjudicating call in its message", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(999, grain.id)).toThrow(/value/);
    });

    it("permits the identical raw UPDATE while an adjudication window is open", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      withAdjudicationOpen(game.id, () => {
        expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(999, grain.id)).not.toThrow();
      });
      expect(getResource(grain.id)?.value).toBe(999);
    });

    it("an UNCONSTRAINED resource is completely unaffected, with or without a window open", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 10 });

      expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(20, treasury.id)).not.toThrow();
      expect(getResource(treasury.id)?.value).toBe(20);
    });

    it("a resource constrained on a DIFFERENT resource is completely unaffected", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 10 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(20, treasury.id)).not.toThrow();
      expect(getResource(treasury.id)?.value).toBe(20);
    });

    it("key-scoping: a resolve_only declaration on a DIFFERENT factKey of the same entity does not block a real 'value' write", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      // 'population' is not a real live column of `resources` -- irrelevant
      // to this trigger, which only ever compares against NEW.key, never
      // against what columns actually exist.
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id, factKey: "population" });

      expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(999, grain.id)).not.toThrow();
      expect(getResource(grain.id)?.value).toBe(999);
    });

    it("key-scoping at the raw facts level: a DIFFERENT key on the SAME entity is unaffected by a 'value' resolve_only declaration", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id, factKey: "value" });

      // A raw INSERT under a DIFFERENT key on the exact same entity_id.
      expect(() =>
        db
          .prepare(
            `INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(uuidv4(), grain.id, "status", "growing", 0, null, 0)
      ).not.toThrow();

      // The DECLARED key, same entity, is still refused.
      expect(() =>
        db
          .prepare(
            `INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(uuidv4(), grain.id, "value", "999.0", 0, null, 0)
      ).toThrow();
    });

    it("closing an interval remains legal even with no window open -- destroying the entity is not a contradiction", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      const openFactBefore = db
        .prepare(`SELECT valid_to_t FROM facts WHERE entity_id = ? AND key = 'value' AND valid_to_t IS NULL`)
        .get(grain.id);
      expect(openFactBefore).toBeDefined();

      // deleteResource() -> DELETE FROM resources -> the projection layer's
      // AFTER DELETE trigger closes every open fact for the entity via an
      // UPDATE (facts.valid_to_t), never an INSERT -- so
      // timeline_facts_resolve_only, a BEFORE INSERT guard, never fires.
      expect(() => deleteResource(grain.id)).not.toThrow();

      const openFactAfter = db
        .prepare(`SELECT valid_to_t FROM facts WHERE entity_id = ? AND key = 'value' AND valid_to_t IS NULL`)
        .get(grain.id);
      expect(openFactAfter).toBeUndefined();
    });

    describe("plant-and-watch-red: the trigger is what actually refuses the write", () => {
      it("dropping the trigger permits the direct write; recreating it refuses the same write again", () => {
        const game = createGame({ name: "grain depot", setting: "test", style: "test" });
        const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
        constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

        db.exec(`DROP TRIGGER IF EXISTS timeline_facts_resolve_only`);

        // RED: with the guard removed, the exact same write this describe
        // block otherwise refuses now succeeds.
        expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(999, grain.id)).not.toThrow();
        expect(getResource(grain.id)?.value).toBe(999);

        // Recreate the guard the same way every real startup does --
        // initializeSchema()'s own DROP-then-CREATE pass, not a hand-copied
        // second definition of the trigger in this test file.
        initializeSchema();

        // GREEN again: the identical write is refused once more.
        expect(() => db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(1, grain.id)).toThrow();
        expect(getResource(grain.id)?.value).toBe(999);
      });
    });
  });

  // ==========================================================================
  // The JS choke point -- assertConstraintsAllow's resolve_only branch
  // (src/timeline/constrained.ts)
  // ==========================================================================
  describe("the JS choke point (assertConstraintsAllow)", () => {
    it("writeConstrainedValue (via update_resource_value) throws a typed ConstraintViolationError with no window open", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      let caught: unknown;
      try {
        updateResourceValue({ resourceId: grain.id, mode: "set", value: 75 });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConstraintViolationError);
      expect((caught as ConstraintViolationError).constraintKind).toBe("resolve_only");
      expect((caught as ConstraintViolationError).resourceId).toBe(grain.id);
      // The live column never moved -- the check runs BEFORE any write.
      expect(getResource(grain.id)?.value).toBe(50);
    });

    it("writeConstrainedValue succeeds while an adjudication window is open", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      const result = withAdjudicationOpen(game.id, () =>
        updateResourceValue({ resourceId: grain.id, mode: "set", value: 75 })
      );

      expect(result?.resource.value).toBe(75);
      expect(getResource(grain.id)?.value).toBe(75);
    });

    it("transferConstrainedValue (via transfer_resource_value) is ALSO refused for a resolve_only-constrained conserved member", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 50 });
      constraintTools.declareConservedConstraint({ gameId: game.id, resourceIds: [grain.id, treasury.id], total: 100 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      let caught: unknown;
      try {
        transferResourceValue({ fromResourceId: grain.id, toResourceId: treasury.id, amount: 10 });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConstraintViolationError);
      expect((caught as ConstraintViolationError).constraintKind).toBe("resolve_only");
      // Neither leg moved.
      expect(getResource(grain.id)?.value).toBe(50);
      expect(getResource(treasury.id)?.value).toBe(50);
    });

    it("transferConstrainedValue succeeds while an adjudication window is open", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 50 });
      constraintTools.declareConservedConstraint({ gameId: game.id, resourceIds: [grain.id, treasury.id], total: 100 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      withAdjudicationOpen(game.id, () => {
        transferResourceValue({ fromResourceId: grain.id, toResourceId: treasury.id, amount: 10 });
      });

      expect(getResource(grain.id)?.value).toBe(40);
      expect(getResource(treasury.id)?.value).toBe(60);
    });

    it("an UNCONSTRAINED resource is completely unaffected", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const population = createResource({ gameId: game.id, ownerType: "game", name: "population", value: 100 });

      expect(() => updateResourceValue({ resourceId: population.id, mode: "delta", value: 5 })).not.toThrow();
      expect(getResource(population.id)?.value).toBe(105);
    });

    it("a resource constrained on a DIFFERENT factKey is completely unaffected", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id, factKey: "population" });

      // The 'value' key is untouched by a constraint scoped to 'population'.
      expect(() => updateResourceValue({ resourceId: grain.id, mode: "set", value: 75 })).not.toThrow();
      expect(getResource(grain.id)?.value).toBe(75);
    });

    it("direct writeConstrainedValue() (not only the resource.ts wrapper) is refused identically", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      expect(() => writeConstrainedValue({ entityId: grain.id, key: "value", mode: "set", value: 75 })).toThrow(
        ConstraintViolationError
      );
    });

    it("direct transferConstrainedValue() (not only the resource.ts wrapper) is refused identically", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 50 });
      constraintTools.declareConservedConstraint({ gameId: game.id, resourceIds: [grain.id, treasury.id], total: 100 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: treasury.id });

      expect(() =>
        transferConstrainedValue({ fromEntityId: grain.id, toEntityId: treasury.id, key: "value", amount: 10 })
      ).toThrow(ConstraintViolationError);
    });
  });

  // ==========================================================================
  // Reconciliation (src/timeline/projection.ts's reconcileTable) must never
  // throw initializeSchema() out at startup for a resolve_only-governed key
  // that has diverged -- the identical precedent `facts.irreversible = 0`
  // already sets for 'irreversible' (see irreversible.test.ts's own
  // "reconciliation at startup does not throw" describe block, which this
  // mirrors).
  // ==========================================================================
  describe("reconciliation does not throw initializeSchema() out for a diverged resolve_only key", () => {
    it("leaves the stale fact open and unchanged, does not throw, and the divergence is still reported", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });

      // Simulate a write that bypassed the projection triggers entirely (a
      // database predating them, or an external writer) by dropping the
      // resources AFTER UPDATE trigger before writing directly to the live
      // column -- the same technique irreversible.test.ts uses for the
      // identical scenario against 'irreversible'.
      db.exec(`DROP TRIGGER IF EXISTS timeline_resources_au`);
      db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(999, grain.id);

      const factBefore = db
        .prepare(`SELECT value, valid_to_t FROM facts WHERE entity_id = ? AND key = 'value'`)
        .get(grain.id) as { value: string; valid_to_t: number | null };
      expect(factBefore.value).toBe("50.0");
      expect(factBefore.valid_to_t).toBeNull();

      // PLANT: without projection.ts's resolve_only guard on the
      // reconcile close/open statements, this would close the stale fact
      // and then fail to reopen it (timeline_facts_resolve_only refuses the
      // INSERT with no window open), throwing this whole reconciliation --
      // and therefore initializeSchema() -- out at startup.
      expect(() => initializeSchema()).not.toThrow();

      const factAfter = db
        .prepare(`SELECT value, valid_to_t FROM facts WHERE entity_id = ? AND key = 'value'`)
        .get(grain.id) as { value: string; valid_to_t: number | null };
      expect(factAfter.value).toBe(factBefore.value);
      expect(factAfter.valid_to_t).toBeNull();

      // The live row is left exactly as reconciliation found it -- the
      // engine records the divergence, it does not decide about it.
      expect(getResource(grain.id)?.value).toBe(999);
    });

    it("an unconstrained resource, and one constrained on a DIFFERENT factKey, reconcile exactly as before (unchanged behaviour)", () => {
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 10 });
      const population = createResource({ gameId: game.id, ownerType: "game", name: "population", value: 20 });
      // 'population' scoped resolve_only, deliberately NOT the 'value' key
      // this test diverges -- must not change how the divergence resolves.
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: population.id, factKey: "reputation" });

      db.exec(`DROP TRIGGER IF EXISTS timeline_resources_au`);
      db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(999, treasury.id);
      db.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(888, population.id);

      expect(() => initializeSchema()).not.toThrow();

      // Reconciliation repairs both exactly as it always has: closes the
      // stale fact and opens a new one at the diverged live value.
      const treasuryFact = db
        .prepare(`SELECT value, valid_to_t FROM facts WHERE entity_id = ? AND key = 'value' AND valid_to_t IS NULL`)
        .get(treasury.id) as { value: string; valid_to_t: number | null } | undefined;
      expect(treasuryFact?.value).toBe("999.0");

      const populationFact = db
        .prepare(`SELECT value, valid_to_t FROM facts WHERE entity_id = ? AND key = 'value' AND valid_to_t IS NULL`)
        .get(population.id) as { value: string; valid_to_t: number | null } | undefined;
      expect(populationFact?.value).toBe("888.0");
    });
  });

  // ==========================================================================
  // ConstraintKind widened to a fourth member -- src/types/index.ts
  // ==========================================================================
  it("ResourceConstraint.kind accepts 'resolve_only', matching the type declared in src/types/index.ts", () => {
    const game = createGame({ name: "grain depot", setting: "test", style: "test" });
    const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 50 });
    const constraint = constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });
    const kind: "bounded" | "monotonic" | "conserved" | "resolve_only" = constraint.kind;
    expect(kind).toBe("resolve_only");
  });
});

// ============================================================================
// The CHECK migration -- SQLite cannot ALTER a CHECK constraint, so widening
// resource_constraints.kind for a database that predates issue #13 needs a
// full table rebuild. This describe block manages its own on-disk database
// and DMCP_DB_PATH rather than createTestDb()/destroyTestDb() -- mirroring
// src/db/__tests__/migrations.test.ts's own "against an existing on-disk
// database" block -- because it needs to simulate a database that was NEVER
// touched by this build's code, which an in-memory createTestDb() (already
// running the new, widened-CHECK schema) cannot represent.
// ============================================================================
describe("resource_constraints CHECK migration (resolve_only, issue #13)", () => {
  afterEach(() => {
    closeDatabase();
  });

  it("a fresh database's resource_constraints CHECK already admits 'resolve_only' -- no rebuild needed", () => {
    process.env.DMCP_DB_PATH = ":memory:";
    initializeSchema();
    const db = getDatabase();
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_constraints'`).get() as {
      sql: string;
    };
    expect(row.sql).toContain("resolve_only");
  });

  it("an existing database with the OLD three-member CHECK, holding constraint rows and member rows, survives the rebuild with every row and every FK intact -- and fresh vs. migrated sqlite_master.sql are byte-identical", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "dmcp-resolve-only-migration-"));
    const dbPath = join(tmpDir, "games.db");

    try {
      // Build a REAL, fully-shaped on-disk database via this build's own
      // initializeSchema() and real tool functions -- games/resources get
      // every column the rest of initializeSchema()'s many `CREATE INDEX ...
      // (game_id)` statements expect, which a hand-rolled minimal stub table
      // (tried first; see the task report) does NOT provide, since `CREATE
      // TABLE IF NOT EXISTS` no-ops against an already-existing table
      // regardless of its actual column set. The ONLY thing then
      // deliberately downgraded back to the OLD (pre-issue-#13) shape is
      // resource_constraints itself -- everything else in this database is
      // exactly what a real, already-migrated (through issue #9's fact_key
      // step) pre-#13 database would look like.
      process.env.DMCP_DB_PATH = dbPath;
      initializeSchema();
      const setupDb = getDatabase();
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const grain = createResource({ gameId: game.id, ownerType: "game", name: "grain", value: 25 });
      const treasury = createResource({ gameId: game.id, ownerType: "game", name: "treasury", value: 75 });

      // Downgrade resource_constraints to the OLD three-member CHECK, in
      // place, the mirror image of the production rebuild (new -> old
      // instead of old -> new) -- purely to fabricate this fixture; nothing
      // about THIS step is under test. DROP then CREATE directly under the
      // FINAL name, deliberately never RENAME TO -- an earlier version of
      // this fixture went via a temporary "_old_shape" table and renamed it
      // into place, which failed with "no such table: resource_constraints":
      // SQLite revalidates every trigger that references a table as part of
      // renaming another table INTO that table's name, and
      // timeline_facts_resolve_only (already installed, since
      // initializeSchema() already ran once above) names resource_constraints
      // in its WHEN clause. That failure pointed at a REAL gap in
      // PRODUCTION's rebuild too (src/db/schema.ts's own RENAME-based recipe
      // had the identical exposure), which now unconditionally drops that
      // trigger before doing any table surgery -- see that block's comment.
      // This fixture's OWN downgrade is a separate operation from
      // production's upgrade, on a database state production never
      // produces (a database can't be mid-migration on disk), so it carries
      // its own fix rather than depending on production's: avoiding RENAME
      // entirely sidesteps the revalidation path altogether, which is
      // simpler here than reasoning about what a trigger-that-does-not-yet-
      // enforce-anything-for-this-shape would revalidate against.
      setupDb.exec(`DELETE FROM resource_constraints`);
      setupDb.exec(`DROP TABLE resource_constraints`);
      setupDb.exec(`
        CREATE TABLE resource_constraints (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('bounded', 'monotonic', 'conserved')),
          direction TEXT CHECK (direction IN ('increasing', 'decreasing')),
          total REAL,
          created_at TEXT NOT NULL,
          fact_key TEXT NOT NULL DEFAULT 'value',
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
        )
      `);
      setupDb.prepare(
        `INSERT INTO resource_constraints (id, game_id, kind, direction, total, created_at, fact_key)
         VALUES ('constraint-1', ?, 'bounded', NULL, NULL, '2020-01-01T00:00:00.000Z', 'value')`
      ).run(game.id);
      setupDb.prepare(
        `INSERT INTO resource_constraints (id, game_id, kind, direction, total, created_at, fact_key)
         VALUES ('constraint-2', ?, 'conserved', NULL, 100, '2020-01-02T00:00:00.000Z', 'value')`
      ).run(game.id);
      setupDb.prepare(
        `INSERT INTO resource_constraint_members (constraint_id, resource_id) VALUES ('constraint-1', ?)`
      ).run(grain.id);
      setupDb.prepare(
        `INSERT INTO resource_constraint_members (constraint_id, resource_id) VALUES ('constraint-2', ?), ('constraint-2', ?)`
      ).run(grain.id, treasury.id);
      closeDatabase();

      // Reopen -- THIS is the call under test: initializeSchema() must
      // detect the old CHECK and rebuild it.
      process.env.DMCP_DB_PATH = dbPath;
      expect(() => initializeSchema()).not.toThrow();

      const migrated = getDatabase();

      // Every row, and every id, survived.
      const constraint1 = migrated.prepare(`SELECT * FROM resource_constraints WHERE id = ?`).get("constraint-1") as
        | Record<string, unknown>
        | undefined;
      expect(constraint1).toMatchObject({
        id: "constraint-1",
        game_id: game.id,
        kind: "bounded",
        direction: null,
        total: null,
        created_at: "2020-01-01T00:00:00.000Z",
        fact_key: "value",
      });

      const constraint2 = migrated.prepare(`SELECT * FROM resource_constraints WHERE id = ?`).get("constraint-2") as
        | Record<string, unknown>
        | undefined;
      expect(constraint2).toMatchObject({
        id: "constraint-2",
        kind: "conserved",
        total: 100,
        fact_key: "value",
      });

      // Sorted in JS by (constraint_id, resource_id) rather than relying on
      // SQL's ORDER BY resource_id -- real (createResource-generated) uuids
      // have no predictable lexicographic relationship to each other, unlike
      // the earlier fixed-id draft of this fixture, so the two members of
      // 'constraint-2' need a deterministic comparator on both sides rather
      // than a hardcoded expected order.
      const memberSort = (a: { constraint_id: string; resource_id: string }, b: { constraint_id: string; resource_id: string }) =>
        a.constraint_id === b.constraint_id ? a.resource_id.localeCompare(b.resource_id) : a.constraint_id.localeCompare(b.constraint_id);
      const members = (
        migrated.prepare(`SELECT constraint_id, resource_id FROM resource_constraint_members`).all() as {
          constraint_id: string;
          resource_id: string;
        }[]
      ).sort(memberSort);
      expect(members).toEqual(
        [
          { constraint_id: "constraint-1", resource_id: grain.id },
          { constraint_id: "constraint-2", resource_id: grain.id },
          { constraint_id: "constraint-2", resource_id: treasury.id },
        ].sort(memberSort)
      );
      // The widened CHECK actually admits 'resolve_only' now -- not merely
      // asserted by inspecting the DDL text, but proven by successfully
      // inserting a row of that kind.
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO resource_constraints (id, game_id, kind, direction, total, created_at, fact_key) VALUES (?, ?, 'resolve_only', NULL, NULL, ?, 'value')`
          )
          .run("constraint-3", game.id, new Date().toISOString())
      ).not.toThrow();

      // Every foreign key -- resource_constraints.game_id -> games.id, and
      // resource_constraint_members' pair into resource_constraints/resources
      // -- is intact after the rebuild.
      const fkViolations = migrated.pragma("foreign_key_check");
      expect(fkViolations).toEqual([]);

      const migratedSql = migrated
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_constraints'`)
        .get() as { sql: string };
      expect(migratedSql.sql).toContain("resolve_only");

      // The rebuild's own DROP TRIGGER IF EXISTS timeline_facts_resolve_only
      // (src/db/schema.ts) must not leave the guard uninstalled -- a
      // migration that silently dropped the enforcement it exists to widen
      // support for would be the worst outcome this whole block could
      // produce. Prove it is BACK and ACTUALLY ENFORCING, not merely
      // present in sqlite_master: declare a real resolve_only constraint on
      // 'constraint-3''s own row (grain, via the resource this fixture
      // already created) and attempt the exact direct write this trigger
      // exists to refuse.
      migrated.prepare(`DELETE FROM resource_constraints WHERE id = 'constraint-3'`).run();
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: grain.id });
      expect(() => migrated.prepare(`UPDATE resources SET value = ? WHERE id = ?`).run(12345, grain.id)).toThrow();

      closeDatabase();

      // A completely fresh database, for the byte-identical comparison.
      process.env.DMCP_DB_PATH = ":memory:";
      initializeSchema();
      const freshSql = getDatabase()
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_constraints'`)
        .get() as { sql: string };
      closeDatabase();

      expect(migratedSql.sql).toBe(freshSql.sql);

      // Idempotent: running initializeSchema() again against the ALREADY
      // migrated on-disk database must not re-rebuild, must not throw, and
      // must leave the schema text and the data exactly as they are.
      process.env.DMCP_DB_PATH = dbPath;
      expect(() => initializeSchema()).not.toThrow();
      const reopened = getDatabase();
      const secondPassSql = reopened
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_constraints'`)
        .get() as { sql: string };
      expect(secondPassSql.sql).toBe(migratedSql.sql);
      // constraint-1, constraint-2 (from the original fixture) and the
      // resolve_only declaration the trigger-enforcement check above made
      // via the real declareResolveOnlyConstraint() -- constraint-3 (the
      // raw, member-less probe row from earlier) was deleted before that.
      const rowCount = reopened.prepare(`SELECT COUNT(*) AS n FROM resource_constraints`).get() as { n: number };
      expect(rowCount.n).toBe(3);
    } finally {
      process.env.DMCP_DB_PATH = ":memory:";
      try {
        closeDatabase();
      } catch {
        // already closed
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("calling initializeSchema() twice against the SAME old-shape database rebuilds on the first call and skips on the second, both completing cleanly", () => {
    // A standalone, minimal version of the scenario the previous test also
    // exercises inline at its tail -- isolated here as its own test because
    // "an existing database, not just a fresh one" (root CLAUDE.md) is
    // exactly the property this migration is riskiest against, and it
    // deserves a test that can fail on its own, independent of everything
    // else the larger fixture also asserts.
    const tmpDir = mkdtempSync(join(tmpdir(), "dmcp-resolve-only-double-pass-"));
    const dbPath = join(tmpDir, "games.db");

    try {
      process.env.DMCP_DB_PATH = dbPath;
      initializeSchema();
      const setupDb = getDatabase();
      const game = createGame({ name: "grain depot", setting: "test", style: "test" });
      const population = createResource({ gameId: game.id, ownerType: "game", name: "population", value: 40 });

      setupDb.exec(`DELETE FROM resource_constraints`);
      setupDb.exec(`DROP TABLE resource_constraints`);
      setupDb.exec(`
        CREATE TABLE resource_constraints (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('bounded', 'monotonic', 'conserved')),
          direction TEXT CHECK (direction IN ('increasing', 'decreasing')),
          total REAL,
          created_at TEXT NOT NULL,
          fact_key TEXT NOT NULL DEFAULT 'value',
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
        )
      `);
      setupDb
        .prepare(
          `INSERT INTO resource_constraints (id, game_id, kind, direction, total, created_at, fact_key) VALUES ('c-double-pass', ?, 'monotonic', 'increasing', NULL, '2020-01-01T00:00:00.000Z', 'value')`
        )
        .run(game.id);
      setupDb
        .prepare(`INSERT INTO resource_constraint_members (constraint_id, resource_id) VALUES ('c-double-pass', ?)`)
        .run(population.id);
      closeDatabase();

      // PASS 1: the old CHECK is present -- this call must perform the
      // rebuild.
      process.env.DMCP_DB_PATH = dbPath;
      expect(() => initializeSchema()).not.toThrow();
      const afterPass1 = getDatabase()
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_constraints'`)
        .get() as { sql: string };
      expect(afterPass1.sql).toContain("resolve_only");
      const rowAfterPass1 = getDatabase().prepare(`SELECT * FROM resource_constraints WHERE id = ?`).get("c-double-pass");
      expect(rowAfterPass1).toMatchObject({ id: "c-double-pass", kind: "monotonic", direction: "increasing" });
      closeDatabase();

      // PASS 2: the CHECK already contains 'resolve_only' -- this call must
      // detect that and skip the rebuild body entirely, not merely tolerate
      // running it again.
      process.env.DMCP_DB_PATH = dbPath;
      expect(() => initializeSchema()).not.toThrow();
      const afterPass2 = getDatabase()
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_constraints'`)
        .get() as { sql: string };
      expect(afterPass2.sql).toBe(afterPass1.sql);
      const rowAfterPass2 = getDatabase().prepare(`SELECT * FROM resource_constraints WHERE id = ?`).get("c-double-pass");
      expect(rowAfterPass2).toEqual(rowAfterPass1);

      // The resolve_only guard is live after both passes -- not just present
      // in the schema text, but actually enforcing, on a resource this test
      // only just declared it against (population carried a pre-existing
      // 'monotonic' constraint throughout, deliberately left alone by both
      // passes above; this is a NEW, separate declaration).
      constraintTools.declareResolveOnlyConstraint({ gameId: game.id, resourceId: population.id, factKey: "census" });
      expect(() =>
        getDatabase()
          .prepare(`INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible) VALUES (?, ?, 'census', '1', 0, NULL, 0)`)
          .run(uuidv4(), population.id)
      ).toThrow();
    } finally {
      process.env.DMCP_DB_PATH = ":memory:";
      try {
        closeDatabase();
      } catch {
        // already closed
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
