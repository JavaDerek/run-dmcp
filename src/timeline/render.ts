import { replay } from "./replay.js";
import { type T } from "./t.js";
import type { EntityKind } from "./kinds.js";

/**
 * The engine's state-to-text projection (design §7/§8, GitHub issue #16):
 * "say what IS true, never what is absent." *"The grain stores are full and
 * the treasury coffers overflow"* -- never *"the grain stores are no longer
 * empty."*
 *
 * **The rule is enforced AT CONSTRUCTION, not by scanning generated text.**
 * `createStateRenderer` validates a caller-injected `RenderVocabulary` once,
 * up front, and every guard below exists to make negation UNCONSTRUCTABLE
 * rather than detected (root CLAUDE.md hard rule 4, design §7's hazard
 * paragraph): a `VocabularyEntry` has exactly two fields, `noun` and
 * `adjectives`, both positive by construction -- there is no free-text
 * sentence field, no template string with holes, and no field a negation
 * could be written into. This module never scans generated text, never
 * matches a word against a list, and never inspects any string this
 * codebase did not itself define as an object key (hard rule 4's "a token
 * WE defined" exception, applied here to the literal `noun`/`adjectives`
 * check in `resolveEntry` below).
 *
 * **Mechanism is core; the vocabulary is injected by each caller.** This
 * module ships NOT ONE vocabulary entry, example or default -- a vocabulary
 * rich enough to render a real world contains client-specific nouns, and
 * either sitting in this file would fail `engineVocabulary.test.ts` on day
 * one, correctly (design §7's closing paragraph, §10). `RenderVocabulary` is
 * a parameter type, never a value exported from here.
 *
 * **Output is generated ONLY from facts that hold at `t`.** The sole source
 * of state is `replay({gameId, t})` (replay.ts) -- there is no diff, no
 * set-complement against another `t`, no "expected keys minus present
 * keys." A fact that does not hold at `t` produces NOTHING: not a phrase
 * about its absence, not an "unknown," not a placeholder. Silence. A fact
 * that DOES hold but has no vocabulary entry is reported as a row in
 * `unnamed` -- a caller learns its vocabulary is too thin from a row, never
 * from invented or negated text (the vocabulary-richness contract, task
 * brief / design §7).
 *
 * **No transition/differential API.** There is no `renderChange(before,
 * after)` and nothing here takes two `t`s -- that is precisely the shape
 * that produces "no longer." State at one `t`, full stop
 * (`render.test.ts`'s "module export surface" test locks the runtime export
 * list to exactly `createStateRenderer` so a second, differential entry
 * point cannot be added silently).
 */

/**
 * A positive concrete noun naming a thing that is present, with optional
 * positive adjectives qualifying it. This is the ENTIRE vocabulary
 * language: there is no sentence field, no connective, no place for a
 * negation to live. `resolveEntry` below refuses any object carrying a key
 * other than these two -- the guard that stops an `avoid`/`unless`/`negate`
 * field from being bolted on later.
 */
export interface VocabularyEntry {
  /** A positive concrete noun naming a thing that is present. Required, non-empty after trim. */
  noun: string;
  /** Optional positive adjectives qualifying that noun. Each non-empty after trim. */
  adjectives?: readonly string[];
}

/**
 * Keyed by fact `key`, then by fact `value`. Both exact matches -- no
 * pattern matching, no globs, no fallback entry, no wildcard key (hard rule
 * 4: this module never matches meaning, only exact keys it was handed).
 */
export type RenderVocabulary = Readonly<Record<string, Readonly<Record<string, VocabularyEntry>>>>;

/** One fact that held at `t` and was named by the injected vocabulary. */
export interface RenderedNoun {
  entityId: string;
  entityKind: EntityKind;
  entityName: string | null;
  key: string;
  value: string;
  noun: string;
  adjectives: readonly string[];
  /** The noun and its adjectives joined -- the ONLY text this module composes. */
  phrase: string;
}

/**
 * A fact that held at `t` and had no vocabulary entry. A row, never a
 * verdict (root CLAUDE.md hard rule 2) -- there is deliberately no
 * `isComplete`/coverage/severity field anywhere near this shape. Carries no
 * `noun`/`adjectives`/`phrase`: there is nothing to say about it, and this
 * module never invents something to say.
 */
export interface UnnamedFact {
  entityId: string;
  entityKind: EntityKind;
  entityName: string | null;
  key: string;
  value: string;
}

/** Everything the projection could say about a game at `t`, and everything it could not. */
export interface RenderedState {
  gameId: string;
  t: T;
  nouns: RenderedNoun[];
  unnamed: UnnamedFact[];
}

export interface StateRenderer {
  render(params: { gameId: string; t: T }): RenderedState;
}

/** The validated, defensively-copied, frozen form of one vocabulary entry. */
interface ResolvedVocabularyEntry {
  readonly noun: string;
  readonly adjectives: readonly string[];
}

/** The validated, defensively-copied, frozen form of a whole `RenderVocabulary`. */
type ResolvedVocabulary = Readonly<Record<string, Readonly<Record<string, ResolvedVocabularyEntry>>>>;

/**
 * Exactly the fields `VocabularyEntry` declares. This is a literal check
 * against identifiers THIS MODULE defined in a type THIS MODULE specified
 * -- explicitly permitted by hard rule 4 -- and it is the load-bearing
 * guard named in the task brief: it is what stops a caller (or a future
 * editor of a caller's vocabulary file) from bolting an `avoid:`, an
 * `unless:`, or a `negate:` field onto an entry six months from now. Any
 * key outside this set is refused, by name, at construction.
 */
const ALLOWED_ENTRY_FIELDS = new Set(["noun", "adjectives"]);

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "object") return "an object";
  return `a ${type} (${JSON.stringify(value)})`;
}

/**
 * Validates and defensively copies one `(key, value) -> entry` mapping.
 * Never returns a reference into the caller's own object graph -- every
 * field is read once and copied into a fresh, frozen object -- so a caller
 * that holds onto its original vocabulary object and mutates it after
 * construction (adding a forbidden field, blanking a noun) can never affect
 * what a renderer built from it produces. `render.test.ts`'s
 * "frozen/defensive-copy behaviour" test proves this by mutating the
 * original object after `createStateRenderer` returns and asserting the
 * renderer's output is unchanged.
 */
function resolveEntry(entry: unknown, key: string, value: string): ResolvedVocabularyEntry {
  const path = `["${key}"]["${value}"]`;

  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(
      `render vocabulary: entry at ${path} must be an object with a "noun" field, got ${describeValue(entry)}`
    );
  }

  const record = entry as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!ALLOWED_ENTRY_FIELDS.has(field)) {
      throw new Error(
        `render vocabulary: entry at ${path} carries an unrecognized field "${field}". A vocabulary entry may ` +
          `only declare "noun" and "adjectives" -- this refusal is what stops a forbidden field (an "avoid", a ` +
          `"negate", a "mustNotSay") from being bolted onto the vocabulary later (root CLAUDE.md hard rules 4 ` +
          `and 5, design §7).`
      );
    }
  }

  if (typeof record.noun !== "string" || record.noun.trim().length === 0) {
    throw new Error(
      `render vocabulary: entry at ${path}.noun must be a non-empty string, got ${describeValue(record.noun)}`
    );
  }

  let adjectives: string[] = [];
  if (record.adjectives !== undefined) {
    if (!Array.isArray(record.adjectives)) {
      throw new Error(
        `render vocabulary: entry at ${path}.adjectives must be an array of strings, got ` +
          `${describeValue(record.adjectives)}`
      );
    }
    adjectives = record.adjectives.map((adjective: unknown, index: number) => {
      if (typeof adjective !== "string" || adjective.trim().length === 0) {
        throw new Error(
          `render vocabulary: entry at ${path}.adjectives[${index}] must be a non-empty string, got ` +
            `${describeValue(adjective)}`
        );
      }
      return adjective;
    });
  }

  return Object.freeze({ noun: record.noun, adjectives: Object.freeze(adjectives) });
}

/**
 * Validates the WHOLE vocabulary once, at construction (never lazily per
 * render -- see `createStateRenderer`), and returns a frozen, defensively
 * copied internal form. Every reachable value is copied by primitive field,
 * never by object reference, so nothing in the returned structure can be
 * reached and mutated through the caller's original `vocabulary` argument.
 */
function resolveVocabulary(vocabulary: RenderVocabulary): ResolvedVocabulary {
  if (typeof vocabulary !== "object" || vocabulary === null || Array.isArray(vocabulary)) {
    throw new Error(
      `render vocabulary: vocabulary must be an object mapping fact keys to value->entry maps, got ` +
        `${describeValue(vocabulary)}`
    );
  }

  const resolved: Record<string, Readonly<Record<string, ResolvedVocabularyEntry>>> = {};
  let entryCount = 0;

  for (const key of Object.keys(vocabulary)) {
    const valuesForKey = (vocabulary as Record<string, unknown>)[key];
    if (typeof valuesForKey !== "object" || valuesForKey === null || Array.isArray(valuesForKey)) {
      throw new Error(
        `render vocabulary: vocabulary["${key}"] must be an object mapping fact values to vocabulary entries, ` +
          `got ${describeValue(valuesForKey)}`
      );
    }

    const resolvedValues: Record<string, ResolvedVocabularyEntry> = {};
    for (const value of Object.keys(valuesForKey as Record<string, unknown>)) {
      const entry = (valuesForKey as Record<string, unknown>)[value];
      resolvedValues[value] = resolveEntry(entry, key, value);
      entryCount++;
    }
    resolved[key] = Object.freeze(resolvedValues);
  }

  // A renderer that can name nothing is a configuration error, not a
  // silent no-op -- an empty vocabulary would render every real fact into
  // `unnamed` forever, which is a caller mistake worth refusing loudly
  // rather than a legitimate "narrows to nothing" the way an empty
  // `entityIds` list is elsewhere in this codebase (narration.ts).
  if (entryCount === 0) {
    throw new Error(
      "render vocabulary: an empty vocabulary can name nothing at all -- that is a configuration error, not a " +
        "silent no-op. Supply at least one (key, value) -> { noun, adjectives? } entry."
    );
  }

  return Object.freeze(resolved);
}

/** The noun and its adjectives joined -- the ONLY text this module composes. */
function composePhrase(entry: ResolvedVocabularyEntry): string {
  return [...entry.adjectives, entry.noun].join(" ");
}

/**
 * Renders one game's world at `t`. Reads `replay({gameId, t})` -- the sole
 * source of state -- and nothing else.
 *
 * Ordering is deterministic and total, bottoming out at columns SQLite
 * guarantees unique, copying `narration.ts`/`export.ts`'s discipline:
 * `replay()` already orders entities by `(createdAtT, id)`, and `id` is the
 * entities primary key, so that half is already a total order. Within one
 * entity, interval versioning guarantees at most one fact per `key` is
 * valid at a single `t` (replay.ts's own doc comment), so sorting that
 * entity's fact keys ascending is itself a total order over that entity's
 * facts -- no tie a fact `key` could produce. Two renders of the same world
 * therefore produce identical arrays; `render.test.ts`'s determinism test
 * checks this with `JSON.stringify` equality, the same proof `narration.ts`
 * uses.
 */
function renderState(vocabulary: ResolvedVocabulary, params: { gameId: string; t: T }): RenderedState {
  const snapshot = replay({ gameId: params.gameId, t: params.t });

  const nouns: RenderedNoun[] = [];
  const unnamed: UnnamedFact[] = [];

  for (const entity of snapshot.entities) {
    const keys = Object.keys(entity.facts).sort();
    for (const key of keys) {
      const fact = entity.facts[key];
      const entry = vocabulary[key]?.[fact.value];

      if (entry) {
        nouns.push({
          entityId: entity.id,
          entityKind: entity.kind,
          entityName: entity.name,
          key,
          value: fact.value,
          noun: entry.noun,
          adjectives: entry.adjectives,
          phrase: composePhrase(entry),
        });
      } else {
        // A fact with no vocabulary entry is OMITTED as text, but REPORTED
        // as a row -- the vocabulary-richness contract (task brief, design
        // §7): the engine records the gap, never invents a noun, never
        // negates, and passes no judgement on it (root CLAUDE.md hard rule
        // 2 -- no isComplete, no coverage percentage, no severity).
        unnamed.push({
          entityId: entity.id,
          entityKind: entity.kind,
          entityName: entity.name,
          key,
          value: fact.value,
        });
      }
    }
  }

  return { gameId: snapshot.gameId, t: snapshot.t, nouns, unnamed };
}

/**
 * Builds a `StateRenderer` over a caller-injected `vocabulary`. Validation
 * happens ONCE here, over the whole vocabulary, never lazily per `render`
 * call -- a vocabulary that would be invalid for entity #4,000 is refused
 * before entity #1 is ever rendered, and every `render()` call after
 * construction reuses the same validated, frozen internal copy rather than
 * re-checking anything.
 *
 * Throws (see `resolveVocabulary`/`resolveEntry` above) on: an entry whose
 * `noun` is missing, not a string, or empty/whitespace after trim; any
 * `adjectives` element that is not a string or is empty/whitespace after
 * trim; an entry object carrying any key other than `noun`/`adjectives`
 * (named in the error); and an empty vocabulary.
 */
export function createStateRenderer(params: { vocabulary: RenderVocabulary }): StateRenderer {
  const vocabulary = resolveVocabulary(params.vocabulary);
  return {
    render(renderParams: { gameId: string; t: T }): RenderedState {
      return renderState(vocabulary, renderParams);
    },
  };
}
