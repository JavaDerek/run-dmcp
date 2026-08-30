/**
 * The turn reader (design §12 seam 3, GitHub issue #15): one model call per
 * unit of progress, answering the questions a server cannot answer with
 * code -- "did the surplus hold", "was the tithe paid" -- structured facts a
 * caller needs to keep its own world consistent, not narration.
 *
 * THE SPLIT, AND IT IS THE WHOLE POINT. The ENGINE owns the call, the
 * citation rule, coercion, the safe default, and the fallback ladder. The
 * CALLER owns the questions and the key vocabulary they are answered in.
 * The engine never reads a question (`ReaderQuestion.prompt` is opaque, the
 * same discipline `Proposal.parameters` observes in resolve.ts and `Claim`
 * observes in narration.ts -- see those modules' own doc comments), never
 * interprets an answer beyond "is this key a member of the set the caller
 * declared", and never learns what any key MEANS. `"continued"` and
 * `"TITHE"` are the same kind of token to this module: an opaque string
 * dispatched or compared, never parsed for content.
 *
 * THE HARD CONSTRAINT THIS MODULE IS BUILT AROUND: `ReaderTransport` is an
 * INJECTED INTERFACE, exactly like `Mechanic.adjudicate` (resolve.ts) is an
 * injected interface rather than a call this module makes itself. There is
 * no vendor SDK import here, no API key, no configured request URL, no
 * `fetch`, no read of ambient environment configuration for any
 * credential, and no network code of any kind --
 * a transport is a plain async function the CALLER wrote and handed to
 * `createTurnReader`, closing over whatever local model, hosted API, or
 * scripted fixture it likes. This module is provably ignorant of what is on
 * the other end of a transport; `noVendorTransports.test.ts` (this
 * directory) enforces that mechanically by scanning every file here for
 * vendor/network tokens, the same device `engineVocabulary.test.ts` uses for
 * client vocabulary.
 *
 * RULE 4'S NARROW DOOR, AND WHY THE CITATION CHECK WALKS THROUGH IT WITHOUT
 * VIOLATING IT. Root CLAUDE.md hard rule 4 forbids deriving state by
 * pattern-matching meaning out of natural language -- and the citation check
 * below (`quote occurs verbatim in that source's text`) is a
 * `String.prototype.includes` call over text a CALLER supplied, checking for
 * a span the CALLER'S OWN transport claims it read there. That is a literal
 * presence test, structurally identical to the "a check for a token WE
 * defined in output WE generated is fine" carve-out root CLAUDE.md states
 * for itself -- except here the token is not one this codebase generated,
 * it is one the caller's source text already contained, and the check is
 * "does this exact byte sequence occur in that exact byte sequence", never
 * "does this mean the same thing as that". No case folding, no whitespace
 * trimming, no normalisation of any kind: the moment this check learned to
 * ignore a difference between two strings, it would have taken one step
 * toward understanding English rather than comparing text, which is exactly
 * the slope hard rule 4 exists to keep this module off of. It is legal
 * because it never asks what the quote or the source MEAN; it asks only
 * whether one is a substring of the other.
 *
 * THE ENGINE RECORDS DECISIONS; IT DOES NOT MAKE THEM (hard rule 2). A
 * rejected offer is a row -- `RejectedOffer.reason`, one of a fixed,
 * literal, engine-defined vocabulary, never a severity or a verdict about
 * whether the transport that offered it is "good" or "bad". There is no
 * `confidence`, no `score`, no `valid`/`ok` field anywhere in this module.
 * The caller's own `safeDefault` is likewise not this module's opinion about
 * which direction is safe -- the caller declared it, per question, at
 * construction; the engine has none of its own.
 *
 * THE FALLBACK LADDER is `transports`, tried in the caller's own order. The
 * engine never learns which rung is "the local model" and which is "the
 * hosted one" -- it is an ordered list of opaque functions, and a rung that
 * throws, rejects, or returns something that is not an array of answers is
 * treated identically: exhausted, advance to the next rung with only the
 * still-unanswered questions. `attemptsPerTransport` gives one rung its own
 * retry budget before the ladder gives up on it and moves on.
 */

/** A question the caller wants answered. `prompt` is the caller's text and
 *  is never read, parsed, or matched against anything by this module --
 *  carried opaquely from `ReadRequest` through to a transport, the same way
 *  `Proposal.parameters` (resolve.ts) is handed to a mechanic verbatim. */
export interface ReaderQuestion {
  id: string;
  /** The caller's text. Opaque to the engine. */
  prompt: string;
  /** The CLOSED set of keys an answer may take. Answers are keys, never
   *  prose -- a transport that wants to say "mostly, with an exception"
   *  cannot; it must pick one of these, or the offer is discarded. */
  answerKeys: readonly string[];
  /** The key to fall to when the read fails. The CALLER declares which
   *  direction is safe; the engine has no opinion of its own. Must be a
   *  member of `answerKeys` -- enforced at construction. */
  safeDefault: string;
}

/** One source a claim may be cited against. Caller-supplied text; the
 *  engine never interprets it beyond a literal substring test (see the
 *  module doc comment's rule-4 discussion). */
export interface ReaderSource {
  id: string;
  text: string;
}

/** What a transport is handed for one call: the questions still needing an
 *  answer (already-validly-answered questions are never re-asked -- see
 *  the module doc comment), and every source available to cite against. */
export interface ReadRequest {
  questions: readonly ReaderQuestion[];
  sources: readonly ReaderSource[];
}

/** What a transport returns: KEYS and citations, never prose. */
export interface TransportAnswer {
  questionId: string;
  answerKey: string;
  citation: { sourceId: string; quote: string };
}

/** An injected capability, not a call this module makes itself -- see the
 *  module doc comment's "hard constraint" section. A transport may throw,
 *  reject, or return `TransportAnswer[]`; anything else (including a
 *  non-array return value) is treated as an unusable rung, identically to a
 *  throw. */
export type ReaderTransport = (request: ReadRequest) => Promise<readonly TransportAnswer[]>;

/** The literal, engine-defined reasons an offered answer is discarded.
 *  Never a severity, never a score -- a row names exactly which mechanical
 *  check failed (hard rule 2). */
export type RejectionReason =
  | "unknown-question"
  | "unknown-answer-key"
  | "unknown-source-id"
  | "quote-not-in-source"
  | "empty-quote"
  | "duplicate-answer";

/** One discarded offer, carried verbatim so a reviewer can see exactly what
 *  was offered and why it did not count -- never summarised, never
 *  scored. `rung` is the index into the caller's own `transports` array
 *  that produced this offer; the engine reports the position, it does not
 *  interpret what that position means. */
export interface RejectedOffer {
  reason: RejectionReason;
  rung: number;
  /** The offer exactly as the transport returned it. */
  offer: TransportAnswer;
}

/** One row of the result: a question's final answer, whether it came from
 *  a transport or from the caller's own safe default, and every offer for
 *  that question this read discarded along the way. */
export interface AnsweredQuestion {
  questionId: string;
  /** Always a member of the question's own `answerKeys` -- true whether
   *  this came from a transport or from `safeDefault` itself. */
  answerKey: string;
  fromSafeDefault: boolean;
  /** The index into `transports` that produced this answer; `null` when
   *  every rung was exhausted and the question took its safe default. */
  answeredByRung: number | null;
  /** `null` when `fromSafeDefault` is true -- a default was never cited
   *  against anything, because nothing was accepted for it to cite. */
  citation: { sourceId: string; quote: string } | null;
  rejected: readonly RejectedOffer[];
}

export interface ReaderResult {
  /** One row per question this read declared, in the caller's own declared
   *  order -- deterministic regardless of which rung answered what or in
   *  what order a transport's own response array happened to list them. */
  answers: readonly AnsweredQuestion[];
  /** Offers naming a `questionId` that is not any question this read
   *  declared -- cannot be attached to a row in `answers` because there is
   *  no question for it to belong to. Always `reason: "unknown-question"`. */
  unmatched: readonly RejectedOffer[];
}

export interface TurnReader {
  /** Runs the ladder for this reader's declared questions against `sources`
   *  -- one call per unit of progress, per the module's own framing.
   *  `sources` varies per call; `questions`/`transports` are fixed at
   *  construction, because the questions and the vocabulary they are
   *  answered in are the caller's declared capability, not something that
   *  changes turn to turn. */
  read(sources: readonly ReaderSource[]): Promise<ReaderResult>;
}

/**
 * Construction-time validation, in the same voice as `validateMechanics`
 * (resolve.ts) and `validateMigrations` (src/db/schema.ts): every check
 * that could make an invalid reader constructable runs ONCE, here, so a bad
 * declaration fails loudly before a single `read()` call rather than
 * surfacing as an answer silently outside the declared set three calls
 * later. In particular: a reader that could ever return a key outside its
 * own declared `answerKeys` must be unconstructable, which is why
 * `safeDefault` membership is checked here rather than trusted.
 */
function validateQuestions(questions: readonly ReaderQuestion[]): void {
  const seenIds = new Set<string>();

  for (const question of questions) {
    const id = question?.id;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(
        `createTurnReader: a question's 'id' must be a non-empty string, got ${JSON.stringify(id)}`
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`createTurnReader: duplicate question id '${id}'`);
    }
    seenIds.add(id);

    const answerKeys = question.answerKeys;
    if (!Array.isArray(answerKeys) || answerKeys.length === 0) {
      throw new Error(`createTurnReader: question '${id}' must declare at least one answerKey`);
    }

    const seenKeys = new Set<string>();
    for (const key of answerKeys) {
      if (typeof key !== "string" || key.length === 0) {
        throw new Error(
          `createTurnReader: question '${id}' has an answerKey that is not a non-empty string: ${JSON.stringify(key)}`
        );
      }
      if (seenKeys.has(key)) {
        throw new Error(`createTurnReader: question '${id}' declares duplicate answerKey '${key}'`);
      }
      seenKeys.add(key);
    }

    if (!answerKeys.includes(question.safeDefault)) {
      throw new Error(
        `createTurnReader: question '${id}' declares safeDefault '${question.safeDefault}' which is not ` +
          `one of its own answerKeys (${answerKeys.join(", ")})`
      );
    }
  }
}

function validateAttemptsPerTransport(attemptsPerTransport: number): void {
  if (!Number.isInteger(attemptsPerTransport) || attemptsPerTransport < 1) {
    throw new Error(
      `createTurnReader: 'attemptsPerTransport' must be an integer >= 1, got ${JSON.stringify(attemptsPerTransport)}`
    );
  }
}

/**
 * Builds the reader a caller uses for the lifetime of a session -- the
 * `createResolver({ mechanics })` idiom (resolve.ts) copied directly:
 * capability injected at construction, engine owns the protocol and never
 * learns what the injected things mean. `questions` and `transports` are
 * parameters, not globals, for the identical reason resolve.ts's own doc
 * comment gives: a registry would make behaviour depend on import order.
 *
 * An empty `transports` list is legal -- every `read()` call against it
 * returns every question's safe default, which is the correct behaviour
 * for a caller that has not registered any capability to answer with, not
 * a special case this function needs to guard against.
 */
export function createTurnReader(params: {
  questions: readonly ReaderQuestion[];
  transports: readonly ReaderTransport[];
  attemptsPerTransport?: number;
}): TurnReader {
  const attemptsPerTransport = params.attemptsPerTransport ?? 1;
  validateQuestions(params.questions);
  validateAttemptsPerTransport(attemptsPerTransport);

  const questions = params.questions;
  const transports = params.transports;

  return {
    read(sources: readonly ReaderSource[]): Promise<ReaderResult> {
      return runLadder(questions, transports, attemptsPerTransport, sources);
    },
  };
}

/**
 * Whether `citation` cites a real source, non-empty, verbatim -- the
 * citation rule's three conjuncts. All three must hold; the order below is
 * only the order a REASON is reported in when more than one fails, and it
 * runs cheapest-first: the quote must be a non-empty string, the source must
 * be one that is actually in the request, and the quote must occur EXACTLY
 * (`String.prototype.includes`, no case folding, no trimming, no fuzzy
 * matching) inside that source's text. An offer that fails two conjuncts is
 * rejected either way -- which reason it carries is a reporting detail, not
 * a difference in whether it counts. Returns the first failing reason, or
 * `null` when the citation is accepted -- see the module doc comment's
 * rule-4 discussion for why this literal presence test does not become the
 * pattern-matching-meaning it is built beside.
 *
 * Defensive against a citation that is missing entirely or missing a field
 * -- a transport is caller-supplied code this module does not control at
 * runtime, and a malformed citation must still be rejected mechanically
 * rather than throwing out of this function and aborting the whole read.
 */
function checkCitation(
  citation: TransportAnswer["citation"] | null | undefined,
  sourcesById: ReadonlyMap<string, ReaderSource>
): "unknown-source-id" | "empty-quote" | "quote-not-in-source" | null {
  const sourceId = citation?.sourceId;
  const quote = citation?.quote;

  if (typeof quote !== "string" || quote.length === 0) {
    return "empty-quote";
  }
  if (typeof sourceId !== "string") {
    return "unknown-source-id";
  }
  const source = sourcesById.get(sourceId);
  if (!source) {
    return "unknown-source-id";
  }
  if (!source.text.includes(quote)) {
    return "quote-not-in-source";
  }
  return null;
}

interface AcceptedAnswer {
  answerKey: string;
  rung: number;
  citation: { sourceId: string; quote: string };
}

/**
 * Runs the fallback ladder for one `read()` call. `accepted` accumulates
 * across rungs, keyed by `questionId` -- once a question is in this map its
 * answer is FINAL for this read: the next rung's request omits it (rule 4,
 * "questions already answered validly are NOT re-asked"), and any further
 * offer for it from any rung -- including a non-compliant transport that
 * answers a question it was not asked -- is rejected as `duplicate-answer`
 * rather than silently overwriting the first accepted answer. That is what
 * makes duplicate detection uniform across "two offers in one rung's
 * response" and "a later rung re-offers an already-answered question":
 * both are the same check, `accepted.has(questionId)`, evaluated at the
 * moment each offer is processed.
 */
async function runLadder(
  questions: readonly ReaderQuestion[],
  transports: readonly ReaderTransport[],
  attemptsPerTransport: number,
  sources: readonly ReaderSource[]
): Promise<ReaderResult> {
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const sourcesById = new Map(sources.map((s) => [s.id, s]));

  const accepted = new Map<string, AcceptedAnswer>();
  const rejectedByQuestion = new Map<string, RejectedOffer[]>();
  const unmatched: RejectedOffer[] = [];

  function reject(reason: RejectionReason, rung: number, offer: TransportAnswer): void {
    const row: RejectedOffer = { reason, rung, offer };
    const question = questionsById.get(offer.questionId);
    if (!question) {
      unmatched.push(row);
      return;
    }
    const existing = rejectedByQuestion.get(offer.questionId);
    if (existing) {
      existing.push(row);
    } else {
      rejectedByQuestion.set(offer.questionId, [row]);
    }
  }

  for (let rung = 0; rung < transports.length; rung++) {
    const remaining = questions.filter((q) => !accepted.has(q.id));
    if (remaining.length === 0) break; // every question already answered -- nothing left for any further rung

    const transport = transports[rung];
    let answers: readonly TransportAnswer[] | null = null;

    for (let attempt = 0; attempt < attemptsPerTransport; attempt++) {
      try {
        const result = await transport({ questions: remaining, sources });
        if (Array.isArray(result)) {
          answers = result;
          break;
        }
        // Unusable output -- treated identically to a throw: retry within
        // this rung's budget, then fall through to the next rung.
      } catch {
        // Threw or rejected -- retry within this rung's budget, then fall
        // through to the next rung. The engine does not distinguish WHY a
        // rung failed; it only advances.
      }
    }

    if (answers === null) continue; // rung exhausted; the next rung sees the same `remaining` set

    for (const offer of answers) {
      const question = questionsById.get(offer.questionId);
      if (!question) {
        reject("unknown-question", rung, offer);
        continue;
      }
      if (accepted.has(offer.questionId)) {
        reject("duplicate-answer", rung, offer);
        continue;
      }
      if (!question.answerKeys.includes(offer.answerKey)) {
        // Coercion to keys that ACTUALLY exist -- exact membership or
        // nothing (rule 2). No fuzzy match, no case fold, no "nearest key".
        reject("unknown-answer-key", rung, offer);
        continue;
      }
      const citationProblem = checkCitation(offer.citation, sourcesById);
      if (citationProblem) {
        reject(citationProblem, rung, offer);
        continue;
      }

      accepted.set(offer.questionId, {
        answerKey: offer.answerKey,
        rung,
        citation: { sourceId: offer.citation.sourceId, quote: offer.citation.quote },
      });
    }
  }

  const answersOut: AnsweredQuestion[] = questions.map((question) => {
    const rejected = rejectedByQuestion.get(question.id) ?? [];
    const win = accepted.get(question.id);
    if (win) {
      return {
        questionId: question.id,
        answerKey: win.answerKey,
        fromSafeDefault: false,
        answeredByRung: win.rung,
        citation: win.citation,
        rejected,
      };
    }
    // Every rung that could answer this question was exhausted (or none
    // were ever registered) -- the caller's own declared safe direction,
    // never the engine's guess (rule 3).
    return {
      questionId: question.id,
      answerKey: question.safeDefault,
      fromSafeDefault: true,
      answeredByRung: null,
      citation: null,
      rejected,
    };
  });

  return { answers: answersOut, unmatched };
}
