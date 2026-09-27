// GitHub issue #35: a citation may name a WORD RANGE of a source instead of
// retyping a quote. The engine owns the source text, so the numbering and the
// rebuild live here, beside the citation rule -- a caller that numbers words
// for its own prompt with `sourceWords()` numbers them exactly as the rebuild
// does, and a second caller never re-derives (or re-breaks) either.
//
// Nothing about what a citation IS changes: a range is rebuilt into
// `{sourceId, quote}` and that quote is held to the same byte-exact rule as a
// typed one. A range can only ever produce a substring of its source, so the
// rebuild makes misquoting unconstructable rather than instructing against it.
//
// The recorded failure this file pins (issue #35, "the overshoot"): a range
// whose start is a real word and whose end runs past the source's last word
// CITES WHAT IS THERE -- its end is clamped. The short sources overshoot most,
// and in the consumer that hit it, dropping them meant one whole class of
// four-word intents was never once ruled.
//
// Fixtures: grain, treasury, population.
import { describe, it, expect } from "vitest";
import {
  createTurnReader,
  sourceWords,
  type ReaderQuestion,
  type ReaderSource,
  type ReaderTransport,
  type TransportAnswer,
} from "../turnReader.js";

const GRAIN: ReaderQuestion = {
  id: "grain-surplus",
  prompt: "Did the grain surplus continue?",
  answerKeys: ["continued", "ended"],
  safeDefault: "ended",
};

// Eight words, with irregular whitespace on purpose: numbering is by maximal
// runs of non-whitespace, and the rebuilt quote keeps the source's own bytes
// between words (the double space and the newline survive).
const LEDGER: ReaderSource = {
  id: "ledger",
  text: "The grain  surplus continued,\ninto the next season.",
};

// Four words: the short-source case the overshoot bit hardest.
const SHORT: ReaderSource = { id: "short", text: "Store the grain now." };

function transportOf(answers: readonly unknown[]): ReaderTransport {
  return (async () => answers) as unknown as ReaderTransport;
}

function ranged(sourceId: string, from: unknown, to: unknown): TransportAnswer {
  return {
    questionId: GRAIN.id,
    answerKey: "continued",
    citation: { sourceId, from, to },
  } as unknown as TransportAnswer;
}

async function readOne(offer: unknown, sources: readonly ReaderSource[] = [LEDGER, SHORT]) {
  const reader = createTurnReader({ questions: [GRAIN], transports: [transportOf([offer])] });
  const result = await reader.read(sources);
  return result.answers[0];
}

describe("sourceWords: the numbering a range cites against", () => {
  it("numbers maximal runs of non-whitespace from 1, with their offsets in the text", () => {
    const words = sourceWords(LEDGER.text);
    expect(words.map((w) => w.word)).toEqual(["The", "grain", "surplus", "continued,", "into", "the", "next", "season."]);
    expect(words.map((w) => w.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const w of words) expect(LEDGER.text.slice(w.start, w.end)).toBe(w.word);
  });

  it("has no words for empty or all-whitespace text", () => {
    expect(sourceWords("")).toEqual([]);
    expect(sourceWords("  \n\t ")).toEqual([]);
  });

  it("is lexical only: punctuation stays attached to its word, nothing is split on meaning", () => {
    expect(sourceWords("grain,treasury -- population").map((w) => w.word)).toEqual(["grain,treasury", "--", "population"]);
  });
});

describe("a ranged citation is rebuilt into a quote and held to the same rule", () => {
  it("accepts a range and reports the rebuilt quote with the source's own bytes between words", async () => {
    const answer = await readOne(ranged("ledger", 2, 5));
    expect(answer.fromSafeDefault).toBe(false);
    expect(answer.citation).toEqual({ sourceId: "ledger", quote: "grain  surplus continued,\ninto", range: { from: 2, to: 5 } });
  });

  it("a single word is from === to", async () => {
    const answer = await readOne(ranged("ledger", 3, 3));
    expect(answer.citation).toEqual({ sourceId: "ledger", quote: "surplus", range: { from: 3, to: 3 } });
  });

  it("the whole source is 1..wordCount", async () => {
    const answer = await readOne(ranged("short", 1, 4));
    expect(answer.citation?.quote).toBe(SHORT.text);
  });

  it("THE OVERSHOOT: a real start with an end past the last word ends at the last word (clamped, not dropped)", async () => {
    const answer = await readOne(ranged("short", 3, 7));
    expect(answer.fromSafeDefault).toBe(false);
    expect(answer.citation).toEqual({ sourceId: "short", quote: "grain now.", range: { from: 3, to: 4 } });
    // The offer exactly as given is kept beside the acceptance, so the clamp is visible, never silent.
    expect(answer.acceptedOffer?.citation).toEqual({ sourceId: "short", from: 3, to: 7 });
  });

  it("a quoted citation still works exactly as before, and carries no range", async () => {
    const answer = await readOne({
      questionId: GRAIN.id,
      answerKey: "continued",
      citation: { sourceId: "short", quote: "the grain" },
    });
    expect(answer.citation).toEqual({ sourceId: "short", quote: "the grain" });
  });

  it("a range, when given, is the citation: a quote beside it is not read", async () => {
    const answer = await readOne({
      questionId: GRAIN.id,
      answerKey: "continued",
      citation: { sourceId: "short", from: 1, to: 1, quote: "words that appear nowhere" },
    });
    expect(answer.fromSafeDefault).toBe(false);
    expect(answer.citation).toEqual({ sourceId: "short", quote: "Store", range: { from: 1, to: 1 } });
  });
});

describe("a range that names no span is rejected with a reason, never silently dropped", () => {
  const cases: Array<[string, unknown, unknown, string]> = [
    ["a start past the source's last word is no citation at all", 5, 6, "range-start-past-end"],
    ["a start past the end even when the end is also past it", 9, 9, "range-start-past-end"],
    ["from > to", 3, 2, "invalid-range"],
    ["from < 1", 0, 2, "invalid-range"],
    ["a non-integer start", 1.5, 2, "invalid-range"],
    ["a non-integer end", 1, 2.5, "invalid-range"],
    ["a string start", "1", 2, "invalid-range"],
    ["only `to` given", undefined, 2, "invalid-range"],
    ["only `from` given", 2, undefined, "invalid-range"],
  ];

  for (const [name, from, to, reason] of cases) {
    it(`${name} -> ${reason}`, async () => {
      const answer = await readOne(ranged("short", from, to));
      expect(answer.fromSafeDefault).toBe(true);
      expect(answer.rejected).toHaveLength(1);
      expect(answer.rejected[0].reason).toBe(reason);
    });
  }

  it("a range into a source not in the request is unknown-source-id, as for a quote", async () => {
    const answer = await readOne(ranged("census", 1, 2));
    expect(answer.rejected[0].reason).toBe("unknown-source-id");
  });

  it("a range into an empty source has no start to name", async () => {
    const answer = await readOne(ranged("blank", 1, 1), [{ id: "blank", text: "   " }]);
    expect(answer.rejected[0].reason).toBe("range-start-past-end");
  });
});

describe("review finding, 2026-09-26: null range fields are absent, not a range", () => {
  it("a quote beside from: null and to: null is read as a quote", async () => {
    const answer = await readOne({ questionId: GRAIN.id, answerKey: "continued", citation: { sourceId: "short", quote: "the grain", from: null, to: null } });
    expect(answer.fromSafeDefault).toBe(false);
    expect(answer.citation).toEqual({ sourceId: "short", quote: "the grain" });
  });
  it("a citation whose only fields are nulls is missing-citation", async () => {
    const answer = await readOne({ questionId: GRAIN.id, answerKey: "continued", citation: { sourceId: "short", quote: null, from: null, to: null } });
    expect(answer.rejected.map((r) => r.reason)).toEqual(["missing-citation"]);
  });
});
