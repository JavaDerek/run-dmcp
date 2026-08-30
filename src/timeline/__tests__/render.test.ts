// `render.ts` -- design §7/§8, GitHub issue #16: the engine's state-to-text
// projection. "Say what IS true, never what is absent" (root CLAUDE.md hard
// rule 3), enforced AT CONSTRUCTION -- the vocabulary's atomic unit is a
// positive noun phrase with no field a negation could live in, so there is
// nothing to scan for and nothing to detect (hard rule 4). Mechanism is
// core; the vocabulary below is a throwaway fixture for exercising that
// mechanism, never a starter set (root CLAUDE.md, design §10).
//
// Fixture idiom copied from narration.test.ts: raw SQL `insertEntity`/
// `insertFact` helpers over the same in-memory database, so tests control
// `created_at_t`/`destroyed_at_t`/`valid_from_t`/`valid_to_t` directly.
//
// Every guard here is planted-and-watched-red per the project's testing
// rule (root CLAUDE.md) -- see the task report for the actual failing-first
// runs and the mutation-testing notes for the four load-bearing guards.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { replay } from "../replay.js";
import * as renderModule from "../render.js";
import { createStateRenderer, type RenderVocabulary } from "../render.js";

/** Inserts a legal `entities` row via raw SQL and returns its id. */
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
    overrides.key ?? "status",
    overrides.value ?? "stored",
    overrides.validFromT ?? 0,
    overrides.validToT ?? null,
    overrides.irreversible ?? 0
  );
  return id;
}

/** Throwaway grain/treasury/population vocabulary -- exercises the
 *  mechanism only, never a starter set (root CLAUDE.md, design §10). */
function baseVocabulary(): RenderVocabulary {
  return {
    status: {
      stored: { noun: "grain stores", adjectives: ["full"] },
    },
    condition: {
      overflowing: { noun: "treasury coffers", adjectives: ["overflowing"] },
    },
    trend: {
      growing: { noun: "population count", adjectives: ["growing"] },
    },
  };
}

describe("state-to-text projection (design §7/§8, issue #16)", () => {
  let db: Database.Database;
  let gameId: string;

  beforeEach(() => {
    db = createTestDb();
    gameId = uuidv4();
  });

  afterEach(() => {
    destroyTestDb();
  });

  describe("module export surface", () => {
    it("exports exactly createStateRenderer -- no differential/transition render API (no renderChange, no two-t signature)", () => {
      expect(Object.keys(renderModule)).toEqual(["createStateRenderer"]);
    });
  });

  describe("createStateRenderer -- construction-time validation", () => {
    it("throws on an entry missing noun", () => {
      const vocabulary = { status: { stored: {} } } as unknown as RenderVocabulary;
      expect(() => createStateRenderer({ vocabulary })).toThrow(/noun/);
    });

    it("throws on a noun that is not a string", () => {
      const vocabulary = { status: { stored: { noun: 42 } } } as unknown as RenderVocabulary;
      expect(() => createStateRenderer({ vocabulary })).toThrow(/noun/);
    });

    it("throws on an empty-string noun", () => {
      const vocabulary: RenderVocabulary = { status: { stored: { noun: "" } } };
      expect(() => createStateRenderer({ vocabulary })).toThrow(/noun/);
    });

    it("throws on a whitespace-only noun", () => {
      const vocabulary: RenderVocabulary = { status: { stored: { noun: "   " } } };
      expect(() => createStateRenderer({ vocabulary })).toThrow(/noun/);
    });

    it("throws when adjectives is not an array", () => {
      const vocabulary = {
        status: { stored: { noun: "grain stores", adjectives: "full" } },
      } as unknown as RenderVocabulary;
      expect(() => createStateRenderer({ vocabulary })).toThrow(/adjectives/);
    });

    it("throws on a non-string adjectives element", () => {
      const vocabulary = {
        status: { stored: { noun: "grain stores", adjectives: [7] } },
      } as unknown as RenderVocabulary;
      expect(() => createStateRenderer({ vocabulary })).toThrow(/adjectives/);
    });

    it("throws on an empty-string adjectives element", () => {
      const vocabulary: RenderVocabulary = {
        status: { stored: { noun: "grain stores", adjectives: [""] } },
      };
      expect(() => createStateRenderer({ vocabulary })).toThrow(/adjectives/);
    });

    it("throws on a whitespace-only adjectives element", () => {
      const vocabulary: RenderVocabulary = {
        status: { stored: { noun: "grain stores", adjectives: ["   "] } },
      };
      expect(() => createStateRenderer({ vocabulary })).toThrow(/adjectives/);
    });

    /**
     * THE load-bearing guard (task brief): a literal check for identifiers
     * WE defined in an object WE specified. This is what stops someone
     * bolting an `avoid:`/`unless:`/`negate:` field onto the vocabulary in
     * six months -- see the "mutation: unknown-entry-key refusal" note in
     * the task report for the planted-and-watched-red run against this
     * exact test.
     */
    it("throws on an entry carrying any key other than noun/adjectives, and names the refused key", () => {
      const vocabulary = {
        status: { stored: { noun: "grain stores", avoid: ["empty stores"] } },
      } as unknown as RenderVocabulary;
      expect(() => createStateRenderer({ vocabulary })).toThrow(/avoid/);
    });

    it("throws on an entry carrying a different forbidden key (negativePrompt)", () => {
      const vocabulary = {
        status: { stored: { noun: "grain stores", negativePrompt: "empty" } },
      } as unknown as RenderVocabulary;
      expect(() => createStateRenderer({ vocabulary })).toThrow(/negativePrompt/);
    });

    it("throws on a completely empty vocabulary -- a renderer that can name nothing is a configuration error", () => {
      expect(() => createStateRenderer({ vocabulary: {} })).toThrow(/empty/i);
    });

    it("throws on a vocabulary whose only key maps to zero entries -- still zero total entries", () => {
      const vocabulary: RenderVocabulary = { status: {} };
      expect(() => createStateRenderer({ vocabulary })).toThrow(/empty/i);
    });

    it("accepts a valid vocabulary with no adjectives at all (adjectives is optional)", () => {
      const vocabulary: RenderVocabulary = { status: { stored: { noun: "grain stores" } } };
      expect(() => createStateRenderer({ vocabulary })).not.toThrow();
    });
  });

  describe("createStateRenderer -- frozen/defensive-copy behaviour", () => {
    /**
     * Proves the vocabulary is defensively copied at construction, not
     * merely referenced: mutating the caller's ORIGINAL object after
     * construction must never change what the renderer produces. See the
     * "mutation: frozen-vocabulary rule" note in the task report for the
     * planted-and-watched-red run against this exact test.
     */
    it("is unaffected by mutating the original vocabulary object after construction", () => {
      const vocabulary = baseVocabulary();
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 0 });
      insertFact(db, entityId, { key: "status", value: "stored", validFromT: 0, validToT: null });

      const renderer = createStateRenderer({ vocabulary });

      // Mutate the caller's own object post-construction: change the noun,
      // and bolt on a field that would have been refused at construction.
      const mutableEntry = vocabulary.status.stored as unknown as Record<string, unknown>;
      mutableEntry.noun = "corrupted";
      mutableEntry.avoid = ["empty stores"];

      const result = renderer.render({ gameId, t: 5 });
      expect(result.nouns).toHaveLength(1);
      expect(result.nouns[0].noun).toBe("grain stores");
      expect(result.nouns[0].adjectives).toEqual(["full"]);
      expect(Object.keys(result.nouns[0])).not.toContain("avoid");
    });
  });

  describe("render -- happy path and structural shape", () => {
    it("renders a single fact as a positive noun phrase composed only of noun + adjectives", () => {
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 0 });
      insertFact(db, entityId, { key: "status", value: "stored", validFromT: 0, validToT: null });

      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      const result = renderer.render({ gameId, t: 5 });

      expect(result.gameId).toBe(gameId);
      expect(result.t).toBe(5);
      expect(result.nouns).toHaveLength(1);
      expect(result.unnamed).toEqual([]);

      const row = result.nouns[0];
      expect(row.entityId).toBe(entityId);
      expect(row.entityKind).toBe("resource");
      expect(row.entityName).toBe("grain");
      expect(row.key).toBe("status");
      expect(row.value).toBe("stored");
      expect(row.noun).toBe("grain stores");
      expect(row.adjectives).toEqual(["full"]);
      expect(row.phrase).toBe("full grain stores");
      // Exactly the documented fields -- nothing extra, nothing negative.
      expect(Object.keys(row).sort()).toEqual(
        ["adjectives", "entityId", "entityKind", "entityName", "key", "noun", "phrase", "value"].sort()
      );
    });

    it("reports a fact with no vocabulary entry in `unnamed`, not `nouns`, and produces no text for it -- silence, not description", () => {
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "treasury", createdAtT: 0 });
      insertFact(db, entityId, { key: "status", value: "rotten", validFromT: 0, validToT: null });

      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      const result = renderer.render({ gameId, t: 5 });

      expect(result.nouns).toEqual([]);
      expect(result.unnamed).toHaveLength(1);
      const row = result.unnamed[0];
      expect(row.entityId).toBe(entityId);
      expect(row.entityKind).toBe("resource");
      expect(row.entityName).toBe("treasury");
      expect(row.key).toBe("status");
      expect(row.value).toBe("rotten");
      // No noun/adjectives/phrase field anywhere on an unnamed row -- there
      // is nowhere for invented or negated text to live.
      expect(Object.keys(row).sort()).toEqual(["entityId", "entityKind", "entityName", "key", "value"].sort());
      // Precise substrings, not "noun" -- the top-level `nouns` array name
      // legitimately contains that substring even when empty.
      expect(JSON.stringify(row)).not.toContain('"noun"');
      expect(JSON.stringify(row)).not.toContain('"phrase"');
      expect(JSON.stringify(row)).not.toContain('"adjectives"');
    });

    it("renders multiple entities in deterministic order: entity by (createdAtT, id), then facts by key ascending within an entity", () => {
      const eGrain = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 2 });
      const eTreasury = insertEntity(db, { gameId, kind: "resource", name: "treasury", createdAtT: 0 });
      const ePopulation = insertEntity(db, { gameId, kind: "resource", name: "population", createdAtT: 1 });

      // Inserted deliberately out of key order within an entity.
      insertFact(db, eGrain, { key: "status", value: "stored", validFromT: 0, validToT: null });
      insertFact(db, eTreasury, { key: "condition", value: "overflowing", validFromT: 0, validToT: null });
      insertFact(db, ePopulation, { key: "trend", value: "growing", validFromT: 0, validToT: null });

      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      const result = renderer.render({ gameId, t: 5 });

      // Expected entity order comes from replay() itself (createdAtT, id) --
      // not re-derived here, so this test cannot silently agree with a bug
      // shared between replay and render.
      const snapshot = replay({ gameId, t: 5 });
      const expectedEntityOrder = snapshot.entities.map((e) => e.id);

      expect(result.nouns.map((n) => n.entityId)).toEqual(expectedEntityOrder);
      expect(expectedEntityOrder).toEqual([eTreasury, ePopulation, eGrain]);
    });

    it("is deterministic: two renders of the same world deep-equal each other", () => {
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 0 });
      insertFact(db, entityId, { key: "status", value: "stored", validFromT: 0, validToT: null });
      insertFact(db, entityId, { key: "condition", value: "unknown-value", validFromT: 0, validToT: null });

      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      const first = renderer.render({ gameId, t: 5 });
      const second = renderer.render({ gameId, t: 5 });

      expect(first).toEqual(second);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
  });

  describe("render -- only facts that HOLD at t", () => {
    it("excludes a fact that has not opened yet at t", () => {
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 0 });
      insertFact(db, entityId, { key: "status", value: "stored", validFromT: 20, validToT: null });

      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      const result = renderer.render({ gameId, t: 5 });

      expect(result.nouns).toEqual([]);
      expect(result.unnamed).toEqual([]);
    });

    it("excludes a fact that has already closed by t", () => {
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 0 });
      insertFact(db, entityId, { key: "status", value: "stored", validFromT: 0, validToT: 10 });

      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      const result = renderer.render({ gameId, t: 10 });

      expect(result.nouns).toEqual([]);
      expect(result.unnamed).toEqual([]);
    });

    it("excludes every fact on an entity destroyed before t", () => {
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 0, destroyedAtT: 5 });
      insertFact(db, entityId, { key: "status", value: "stored", validFromT: 0, validToT: null });

      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      const result = renderer.render({ gameId, t: 10 });

      expect(result.nouns).toEqual([]);
      expect(result.unnamed).toEqual([]);
    });

    it("excludes every fact on an entity not yet created at t", () => {
      const entityId = insertEntity(db, { gameId, kind: "resource", name: "grain", createdAtT: 20 });
      insertFact(db, entityId, { key: "status", value: "stored", validFromT: 20, validToT: null });

      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      const result = renderer.render({ gameId, t: 10 });

      expect(result.nouns).toEqual([]);
      expect(result.unnamed).toEqual([]);
    });

    it("renders nothing for an empty world (a gameId with no recorded history at all)", () => {
      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      const result = renderer.render({ gameId: uuidv4(), t: 0 });

      expect(result.nouns).toEqual([]);
      expect(result.unnamed).toEqual([]);
    });
  });

  describe("render -- t validation", () => {
    it("rejects a non-finite t (NaN), the same way replay()/assertT do", () => {
      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      expect(() => renderer.render({ gameId, t: NaN })).toThrow(/t must be a finite number/);
    });

    it("rejects Infinity", () => {
      const renderer = createStateRenderer({ vocabulary: baseVocabulary() });
      expect(() => renderer.render({ gameId, t: Infinity })).toThrow(/t must be a finite number/);
    });
  });
});
