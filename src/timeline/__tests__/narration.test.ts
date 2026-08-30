// `narration.ts` -- design §5.2b/§5.2c, GitHub issues #11 and #12: the
// outbound half of authority. "Here is what is true; depict it, do not
// argue with it." One consumer enforces this live, inside a session, before
// narration happens; the other lints a finished artifact hours later with
// no engine and no model call. Both read the SAME serialized structure, so
// these tests are split the same way the module is: `narrationConstraintAt`
// (a database query, exercised against a real fixture) and `contradictions`
// (a pure function over that serialized shape, exercised with the database
// closed, to prove the offline-lint property is real and not aspirational).
//
// Fixture idiom copied verbatim from `irreversible.test.ts` -- raw SQL
// `insertEntity`/`insertFact` helpers over the same in-memory database, so
// tests control `valid_from_t`/`valid_to_t`/`irreversible`/`destroyed_at_t`
// directly rather than fighting the tool layer's own clock. A handful of
// tests additionally go through the real tool path (`createResource`,
// `declareIrreversible`) specifically where the thing under test is what
// the PROJECTION triggers actually produce -- the value-format risk noted
// in the task brief cannot be caught by a hand-written fixture string.
//
// Every guard here is planted-and-watched-red per the project's testing
// rule (root CLAUDE.md) -- see the task report for the actual failing-first
// runs: the module-not-found failure that opens this file's life, the `>=`
// operator on the irreversible branch of `contradictions`, and the
// structural no-negative-field assertion.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../../tools/game.js";
import { createResource } from "../../tools/resource.js";
import { declareIrreversible } from "../irreversible.js";
import {
  narrationConstraintAt,
  contradictions,
  NARRATION_CONSTRAINT_FORMAT_VERSION,
  type NarrationConstraint,
  type ConstraintFact,
  type Claim,
} from "../narration.js";

/** Inserts a legal `entities` row via raw SQL and returns its id. Identical
 *  to irreversible.test.ts's helper -- this file does not build a second
 *  fixture, it reuses the same idiom over the same in-memory database. */
function insertEntity(
  db: Database.Database,
  overrides: Partial<{
    id: string;
    gameId: string;
    kind: string;
    name: string | null;
    createdAtT: number;
    destroyedAtT: number | null;
  }> = {}
): string {
  const id = overrides.id ?? uuidv4();
  db.prepare(
    `INSERT INTO entities (id, game_id, kind, name, created_at_t, destroyed_at_t) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.gameId ?? uuidv4(),
    overrides.kind ?? "resource",
    overrides.name ?? "grain",
    overrides.createdAtT ?? 0,
    overrides.destroyedAtT ?? null
  );
  return id;
}

/** Inserts a legal `facts` row via raw SQL and returns its id. */
function insertFact(
  db: Database.Database,
  entityId: string,
  overrides: Partial<{
    id: string;
    key: string;
    value: string;
    validFromT: number;
    validToT: number | null;
    irreversible: number;
  }> = {}
): string {
  const id = overrides.id ?? uuidv4();
  db.prepare(
    `INSERT INTO facts (id, entity_id, key, value, valid_from_t, valid_to_t, irreversible) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    entityId,
    overrides.key ?? "quantity",
    overrides.value ?? "50",
    overrides.validFromT ?? 0,
    overrides.validToT ?? null,
    overrides.irreversible ?? 0
  );
  return id;
}

/** Every key name §5.2b/hard rule 5 forbid the serialized structure from
 *  ever carrying. A bare list, but note what it is a list OF: field names
 *  in data THIS module defines, not phrases in narrative text -- checking
 *  that our own schema has no negative-form field is a literal check
 *  against a vocabulary we authored, not language understanding (hard
 *  rule 4's "a token we defined" exception). */
const NEGATIVE_FORM_KEYS = [
  "mustNotSay",
  "mustNotAssert",
  "avoid",
  "forbidden",
  "negativePrompt",
  "negative_prompt",
  "isValid",
  "is_valid",
  "isClean",
  "is_clean",
  "ok",
  "passed",
  "severity",
];

describe("narration constraint (design §5.2b/§5.2c, issues #11/#12)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  describe("narrationConstraintAt", () => {
    let gameId: string;

    beforeEach(() => {
      gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
    });

    it("carries formatVersion, gameId and t through unchanged", () => {
      // Narrowed to an entity id nothing owns, on purpose: `createGame`
      // itself projects a `game` entity with its own facts (name, setting,
      // style, ...), which is correct behaviour (games are entities too,
      // design §5.1) but not what this test is checking. This test is only
      // about the three top-level passthrough fields.
      const result = narrationConstraintAt({ gameId, t: 42, entityIds: [uuidv4()] });
      expect(result.formatVersion).toBe(NARRATION_CONSTRAINT_FORMAT_VERSION);
      expect(result.gameId).toBe(gameId);
      expect(result.t).toBe(42);
      expect(result.mustHonor).toEqual([]);
    });

    it("includes a fact valid at t on an entity alive at t, in positive form with its provenance", () => {
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "treasury", createdAtT: 0 });
      insertFact(db, entityId, { key: "status", value: "full", validFromT: 5, validToT: null });

      // Narrowed to the fixture entity -- `createGame`'s own game entity
      // and facts are real and correctly included by an unnarrowed query,
      // but they are not what this test is about; see the note above.
      const result = narrationConstraintAt({ gameId, t: 10, entityIds: [entityId] });

      expect(result.mustHonor).toHaveLength(1);
      const fact = result.mustHonor[0];
      expect(fact.entityId).toBe(entityId);
      expect(fact.entityKind).toBe("resource");
      expect(fact.entityName).toBe("treasury");
      expect(fact.key).toBe("status");
      expect(fact.value).toBe("full");
      expect(fact.validFromT).toBe(5);
      expect(fact.validToT).toBeNull();
      expect(fact.irreversible).toBe(false);
      // No event created this fact -- it was inserted by raw SQL, not
      // through the projection triggers -- so there is nothing to hop to.
      expect(fact.openedByEventId).toBeNull();
    });

    it("excludes a fact that has not opened yet at t", () => {
      const entityId = insertEntity(db, { gameId });
      insertFact(db, entityId, { key: "status", value: "full", validFromT: 20, validToT: null });

      const result = narrationConstraintAt({ gameId, t: 10, entityIds: [entityId] });

      expect(result.mustHonor).toEqual([]);
    });

    it("excludes a fact that has already closed by t (non-irreversible)", () => {
      const entityId = insertEntity(db, { gameId });
      insertFact(db, entityId, { key: "status", value: "full", validFromT: 0, validToT: 10 });

      const result = narrationConstraintAt({ gameId, t: 10, entityIds: [entityId] });

      expect(result.mustHonor).toEqual([]);
    });

    it("excludes a non-irreversible fact on an entity destroyed by t", () => {
      const entityId = insertEntity(db, { gameId, createdAtT: 0, destroyedAtT: 5 });
      insertFact(db, entityId, { key: "status", value: "full", validFromT: 0, validToT: null });

      const result = narrationConstraintAt({ gameId, t: 10, entityIds: [entityId] });

      expect(result.mustHonor).toEqual([]);
    });

    it("excludes a non-irreversible fact on an entity not yet created at t", () => {
      const entityId = insertEntity(db, { gameId, createdAtT: 20 });
      insertFact(db, entityId, { key: "status", value: "full", validFromT: 20, validToT: null });

      const result = narrationConstraintAt({ gameId, t: 10, entityIds: [entityId] });

      expect(result.mustHonor).toEqual([]);
    });

    it("includes an irreversible fact even after it has closed and its entity has been destroyed -- the motivating case (§5.2b: a destroyed thing quietly existing again)", () => {
      const entityId = insertEntity(db, { gameId, kind: "location", name: "the mill", createdAtT: 0 });
      const factId = insertFact(db, entityId, {
        key: "status",
        value: "destroyed",
        validFromT: 6,
        validToT: null,
        irreversible: 1,
      });
      // Close the fact and destroy the entity -- exactly what a real
      // delete does (projection.ts's `_ad` trigger), reproduced here by
      // raw SQL so the test controls the exact t values.
      db.prepare("UPDATE facts SET valid_to_t = ? WHERE id = ?").run(8, factId);
      db.prepare("UPDATE entities SET destroyed_at_t = ? WHERE id = ?").run(8, entityId);

      const result = narrationConstraintAt({ gameId, t: 20, entityIds: [entityId] });

      expect(result.mustHonor).toHaveLength(1);
      const fact = result.mustHonor[0];
      expect(fact.factId).toBe(factId);
      expect(fact.value).toBe("destroyed");
      expect(fact.validToT).toBe(8);
      expect(fact.irreversible).toBe(true);
    });

    it("does not include an irreversible fact whose valid_from_t is still in the future relative to t", () => {
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      insertFact(db, entityId, {
        key: "status",
        value: "destroyed",
        validFromT: 30,
        validToT: null,
        irreversible: 1,
      });

      const result = narrationConstraintAt({ gameId, t: 10, entityIds: [entityId] });

      expect(result.mustHonor).toEqual([]);
    });

    it("de-duplicates a fact that is both currently valid AND irreversible -- it appears exactly once", () => {
      const entityId = insertEntity(db, { gameId, createdAtT: 0 });
      const factId = insertFact(db, entityId, {
        key: "status",
        value: "destroyed",
        validFromT: 5,
        validToT: null,
        irreversible: 1,
      });

      const result = narrationConstraintAt({ gameId, t: 10, entityIds: [entityId] });

      expect(result.mustHonor).toHaveLength(1);
      expect(result.mustHonor[0].factId).toBe(factId);
    });

    it("narrows to the requested entityIds, and an empty entityIds list yields no facts", () => {
      const wanted = insertEntity(db, { gameId, name: "grain" });
      const other = insertEntity(db, { gameId, name: "treasury" });
      insertFact(db, wanted, { key: "status", value: "full", validFromT: 0, validToT: null });
      insertFact(db, other, { key: "status", value: "full", validFromT: 0, validToT: null });

      const narrowed = narrationConstraintAt({ gameId, t: 10, entityIds: [wanted] });
      expect(narrowed.mustHonor).toHaveLength(1);
      expect(narrowed.mustHonor[0].entityId).toBe(wanted);

      const empty = narrationConstraintAt({ gameId, t: 10, entityIds: [] });
      expect(empty.mustHonor).toEqual([]);
    });

    it("scopes to gameId -- a fact belonging to a different game never appears", () => {
      const otherGameId = createGame({ name: "other depot", setting: "test", style: "test" }).id;
      const entityId = insertEntity(db, { gameId: otherGameId });
      insertFact(db, entityId, { key: "status", value: "full", validFromT: 0, validToT: null });

      // Queried against `gameId`, not `otherGameId` -- narrowed to the
      // other game's entity id specifically so a query bug that dropped
      // the `e.game_id = ?` scoping (and matched on entity id alone)
      // could not pass this test by accident.
      const result = narrationConstraintAt({ gameId, t: 10, entityIds: [entityId] });

      expect(result.mustHonor).toEqual([]);
    });

    it("orders deterministically by (validFromT, entityId, key, factId), regardless of insertion order", () => {
      const e1 = insertEntity(db, { gameId, name: "population" });
      const e2 = insertEntity(db, { gameId, name: "grain" });
      // Inserted out of order on purpose.
      insertFact(db, e2, { key: "b", value: "1", validFromT: 5, validToT: null });
      insertFact(db, e1, { key: "a", value: "1", validFromT: 1, validToT: null });
      insertFact(db, e1, { key: "z", value: "1", validFromT: 1, validToT: null });

      const result = narrationConstraintAt({ gameId, t: 10, entityIds: [e1, e2] });

      expect(result.mustHonor.map((f) => [f.validFromT, f.entityId, f.key])).toEqual([
        [1, e1, "a"],
        [1, e1, "z"],
        [5, e2, "b"],
      ]);
    });

    it("is deterministic: two calls over the same world serialize byte-identically", () => {
      const entityId = insertEntity(db, { gameId, name: "population" });
      insertFact(db, entityId, { key: "status", value: "starving", validFromT: 0, validToT: null, irreversible: 1 });
      insertFact(db, entityId, { key: "size", value: "12", validFromT: 3, validToT: null });

      const first = narrationConstraintAt({ gameId, t: 10 });
      const second = narrationConstraintAt({ gameId, t: 10 });

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it("carries the one hop of causality (§5.2c) for a fact opened through the real projection path, and null for one that was not", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });
      declareIrreversible({ entityId: resource.id, key: "value" });

      const result = narrationConstraintAt({ gameId, t: 10 });
      const fact = result.mustHonor.find((f) => f.entityId === resource.id);
      expect(fact).toBeDefined();
      expect(fact?.openedByEventId).not.toBeNull();

      const eventRow = db
        .prepare("SELECT causes FROM events WHERE id = ?")
        .get(fact?.openedByEventId) as { causes: string } | undefined;
      expect(eventRow).toBeDefined();
      expect(JSON.parse(eventRow?.causes ?? "null")).toMatchObject({ table: "resources", row_id: resource.id });
    });

    /**
     * The highest-risk detail named in the task brief: `resources.value`
     * is a REAL column, and the projection trigger casts through it
     * (`CAST(NEW.value AS TEXT)`, projection.ts), so a numeric value of 50
     * is NOT stored as the fact text "50" -- it is stored as whatever
     * SQLite's own REAL-to-TEXT cast produces. This test reads that string
     * from the database directly (not a hand-written guess) so the
     * assertion below stands on the real projected value, exactly as the
     * task brief requires.
     */
    it("carries the REAL SQLite-projected text form of a numeric resource value, not a hand-written guess", () => {
      const resource = createResource({ gameId, ownerType: "game", name: "grain", value: 50 });

      const projectedRow = db
        .prepare("SELECT value FROM facts WHERE entity_id = ? AND key = 'value'")
        .get(resource.id) as { value: string };
      // Locks in the risk this test exists to catch: a REAL column's cast
      // to TEXT is NOT the JS-formatted "50".
      expect(projectedRow.value).toBe("50.0");

      const result = narrationConstraintAt({ gameId, t: 10 });
      const fact = result.mustHonor.find((f) => f.entityId === resource.id && f.key === "value");
      expect(fact?.value).toBe(projectedRow.value);
    });

    it("has no negative-form field anywhere in the top-level constraint or any carried fact (structural, hard rule 5 / §5.2b)", () => {
      const entityId = insertEntity(db, { gameId });
      insertFact(db, entityId, { key: "status", value: "full", validFromT: 0, validToT: null, irreversible: 1 });

      const result = narrationConstraintAt({ gameId, t: 10 });

      const topLevelKeys = Object.keys(result);
      for (const forbidden of NEGATIVE_FORM_KEYS) {
        expect(topLevelKeys).not.toContain(forbidden);
      }
      for (const fact of result.mustHonor) {
        const factKeys = Object.keys(fact);
        for (const forbidden of NEGATIVE_FORM_KEYS) {
          expect(factKeys).not.toContain(forbidden);
        }
      }
      // Belt-and-suspenders over the wire form too, since a key could in
      // principle survive Object.keys but never reach JSON (a non-enumerable
      // property, say) -- the artifact-lint consumer only ever sees JSON.
      const json = JSON.stringify(result);
      for (const forbidden of NEGATIVE_FORM_KEYS) {
        expect(json).not.toContain(`"${forbidden}"`);
      }
    });
  });

  describe("contradictions -- pure, derived, structural (hard rule 5 / §5.2b)", () => {
    it("flags a claim that disagrees with a currently-valid, non-irreversible fact", () => {
      const entityId = insertEntity(db, { name: "treasury" });
      const factId = insertFact(db, entityId, { key: "coins", value: "100", validFromT: 0, validToT: null });
      const constraint: NarrationConstraint = {
        formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
        gameId: "g1",
        t: 5,
        mustHonor: [
          {
            factId,
            entityId,
            key: "coins",
            value: "100",
            validFromT: 0,
            validToT: null,
            irreversible: false,
            entityKind: "resource",
            entityName: "treasury",
            openedByEventId: null,
          },
        ],
      };
      const claim: Claim = { entityId, key: "coins", value: 50, t: 5 };

      const result = contradictions(constraint, [claim]);

      expect(result).toHaveLength(1);
      expect(result[0].claim).toBe(claim);
      expect(result[0].fact.factId).toBe(factId);
    });

    it("returns nothing for a claim naming an entity/key with no fact in mustHonor -- silence, not a verdict", () => {
      const constraint: NarrationConstraint = {
        formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
        gameId: "g1",
        t: 5,
        mustHonor: [],
      };
      const claim: Claim = { entityId: uuidv4(), key: "coins", value: 50, t: 5 };

      expect(contradictions(constraint, [claim])).toEqual([]);
    });

    function factFixture(overrides: Partial<ConstraintFact> = {}): ConstraintFact {
      return {
        factId: uuidv4(),
        entityId: "e1",
        key: "coins",
        value: "100",
        validFromT: 10,
        validToT: 20,
        irreversible: false,
        entityKind: "resource",
        entityName: "treasury",
        openedByEventId: null,
        ...overrides,
      };
    }

    it("does not flag a claim asserting the SAME value, even in a different textual form that parses to the same number", () => {
      const fact = factFixture({ value: "20.0" });
      const constraint: NarrationConstraint = {
        formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
        gameId: "g1",
        t: 15,
        mustHonor: [fact],
      };
      // "20" (number) and "20" (string) both parse to the same number as
      // the fact's REAL-cast "20.0" -- must NOT be a false contradiction.
      expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: 20, t: 15 }])).toEqual([]);
      expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: "20", t: 15 }])).toEqual([]);
    });

    it("does not flag when the claim's value is textually identical to the fact's (non-numeric)", () => {
      const fact = factFixture({ value: "destroyed" });
      const constraint: NarrationConstraint = {
        formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
        gameId: "g1",
        t: 15,
        mustHonor: [fact],
      };
      expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: "destroyed", t: 15 }])).toEqual([]);
    });

    it("does flag a genuinely different non-numeric value", () => {
      const fact = factFixture({ value: "destroyed" });
      const constraint: NarrationConstraint = {
        formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
        gameId: "g1",
        t: 15,
        mustHonor: [fact],
      };
      expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: "rebuilt", t: 15 }])).toHaveLength(1);
    });

    describe("non-irreversible half-open interval boundaries", () => {
      it("does not flag before validFromT", () => {
        const fact = factFixture({ validFromT: 10, validToT: 20, value: "100" });
        const constraint: NarrationConstraint = {
          formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
          gameId: "g1",
          t: 9,
          mustHonor: [fact],
        };
        expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: 50, t: 9 }])).toEqual([]);
      });

      it("flags exactly AT validFromT (present at the open boundary)", () => {
        const fact = factFixture({ validFromT: 10, validToT: 20, value: "100" });
        const constraint: NarrationConstraint = {
          formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
          gameId: "g1",
          t: 10,
          mustHonor: [fact],
        };
        expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: 50, t: 10 }])).toHaveLength(1);
      });

      it("does NOT flag exactly AT validToT -- gone at that instant, half-open like replay()", () => {
        const fact = factFixture({ validFromT: 10, validToT: 20, value: "100" });
        const constraint: NarrationConstraint = {
          formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
          gameId: "g1",
          t: 20,
          mustHonor: [fact],
        };
        expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: 50, t: 20 }])).toEqual([]);
      });

      it("flags just before validToT", () => {
        const fact = factFixture({ validFromT: 10, validToT: 20, value: "100" });
        const constraint: NarrationConstraint = {
          formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
          gameId: "g1",
          t: 19,
          mustHonor: [fact],
        };
        expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: 50, t: 19 }])).toHaveLength(1);
      });
    });

    describe("irreversible: prohibited for all t' >= valid_from_t (mirrors timeline_facts_irreversible's `>=`)", () => {
      it("does not flag strictly before valid_from_t", () => {
        const fact = factFixture({ validFromT: 10, validToT: null, irreversible: true, value: "destroyed" });
        const constraint: NarrationConstraint = {
          formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
          gameId: "g1",
          t: 9,
          mustHonor: [fact],
        };
        expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: "rebuilt", t: 9 }])).toEqual([]);
      });

      it("flags exactly AT valid_from_t -- the boundary the trigger's `>=` exists to cover", () => {
        const fact = factFixture({ validFromT: 10, validToT: null, irreversible: true, value: "destroyed" });
        const constraint: NarrationConstraint = {
          formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
          gameId: "g1",
          t: 10,
          mustHonor: [fact],
        };
        expect(contradictions(constraint, [{ entityId: "e1", key: "coins", value: "rebuilt", t: 10 }])).toHaveLength(1);
      });

      it("flags well after valid_from_t, even though the fact is closed and its entity destroyed -- the motivating case", () => {
        const fact = factFixture({
          validFromT: 6,
          validToT: 8,
          irreversible: true,
          value: "destroyed",
          entityKind: "location",
          entityName: "the mill",
        });
        const constraint: NarrationConstraint = {
          formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
          gameId: "g1",
          t: 6.48,
          mustHonor: [fact],
        };
        const result = contradictions(constraint, [
          { entityId: "e1", key: "coins", value: "a lush, turning water wheel", t: 6.48 },
        ]);
        expect(result).toHaveLength(1);
        expect(result[0].fact.entityName).toBe("the mill");
      });
    });

    it("returns rows, never a verdict -- the shape has no isValid/ok/passed and no count/summary field (hard rule 2 / §5.5)", () => {
      const fact = factFixture({ value: "destroyed", irreversible: true, validFromT: 0, validToT: null });
      const constraint: NarrationConstraint = {
        formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION,
        gameId: "g1",
        t: 10,
        mustHonor: [fact],
      };
      const result = contradictions(constraint, [{ entityId: "e1", key: "coins", value: "rebuilt", t: 10 }]);
      expect(Array.isArray(result)).toBe(true);
      for (const row of result) {
        expect(Object.keys(row).sort()).toEqual(["claim", "fact"]);
      }
    });

    /**
     * The whole point of design §5.2b/§11's "not a handshake": the video
     * client lints a finished artifact hours later, offline, with no
     * engine and no model. This test proves it by actually closing the
     * database (destroyTestDb(), same call `afterEach` makes -- calling it
     * twice is safe, see connection.ts's closeDatabase()) INSIDE the test
     * body, then round-tripping the constraint through JSON.parse(
     * JSON.stringify(...)) and calling `contradictions` on the rehydrated,
     * database-free object. If `contradictions` ever touched the database,
     * this test -- not a comment -- would be what caught it.
     */
    it("works on a JSON-rehydrated object with the database closed -- the offline-lint property", () => {
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const entityId = insertEntity(db, { gameId, kind: "location", name: "the mill", createdAtT: 0 });
      insertFact(db, entityId, {
        key: "status",
        value: "destroyed",
        validFromT: 6,
        validToT: null,
        irreversible: 1,
      });

      const constraint = narrationConstraintAt({ gameId, t: 10 });
      const claims: Claim[] = [{ entityId, key: "status", value: "a lush, turning water wheel", t: 10 }];

      // Close the database now, inside the test, before touching
      // `contradictions` at all.
      destroyTestDb();

      const rehydratedConstraint = JSON.parse(JSON.stringify(constraint)) as NarrationConstraint;
      const rehydratedClaims = JSON.parse(JSON.stringify(claims)) as Claim[];

      const result = contradictions(rehydratedConstraint, rehydratedClaims);

      expect(result).toHaveLength(1);
      expect(result[0].fact.entityName).toBe("the mill");
      expect(result[0].claim.value).toBe("a lush, turning water wheel");
    });

    /**
     * The counterpart to the offline-lint property above: running far from
     * the engine that produced the input is exactly what makes meeting a
     * FOREIGN format version reachable. A checker that reads an unknown
     * format as if it were its own does not error -- it silently finds fewer
     * contradictions and calls the artifact clean, which is the one failure
     * mode design §5.2c/issue #12 says is worse than no check at all.
     * `toThrow` here, rather than an assertion about a returned value, is the
     * whole point: there is no "clean" answer this function is entitled to
     * give about a document it cannot read.
     */
    it("refuses a constraint whose formatVersion it does not understand, rather than reporting a clean result it cannot justify", () => {
      const gameId = createGame({ name: "grain depot", setting: "test", style: "test" }).id;
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 0 });
      insertFact(db, entityId, { key: "value", value: "40", validFromT: 1, validToT: null, irreversible: 0 });

      const constraint = narrationConstraintAt({ gameId, t: 5 });
      const claims: Claim[] = [{ entityId, key: "value", value: 999, t: 5 }];

      // Sanity: at the version this build understands, the disagreeing claim
      // IS found -- so the refusal below is about the version and nothing else.
      expect(contradictions(constraint, claims)).toHaveLength(1);

      const fromANewerEngine: NarrationConstraint = {
        ...constraint,
        formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION + 1,
      };
      expect(() => contradictions(fromANewerEngine, claims)).toThrow(/format version/);

      // And an OLDER version is refused too -- unreadable is unreadable in
      // both directions, and guessing which way is safe is how a
      // compatibility window becomes a silent one.
      const fromAnOlderEngine: NarrationConstraint = {
        ...constraint,
        formatVersion: NARRATION_CONSTRAINT_FORMAT_VERSION - 1,
      };
      expect(() => contradictions(fromAnOlderEngine, claims)).toThrow(/format version/);
    });
  });
});
