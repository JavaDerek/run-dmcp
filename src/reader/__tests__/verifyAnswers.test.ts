// GitHub issue #39: intent in, ruling out -- the turn reader as a verb, with
// the ruling MODEL outside the engine. A caller whose model runs somewhere the
// engine cannot inject a transport into (a client over MCP) builds the
// request, has its own model answer it, and hands the answers back. The engine
// verifies them and returns the ruling -- the citation rule, the ranges, the
// safe defaults and the reasons, with no inference of its own.
//
// `verifyAnswers` is that second step as a library function. It is the same
// tally the ladder runs (turnReader.ts), fed one list of offers instead of a
// list of transports, so the verb and the library cannot disagree about what
// counts: the parity test below holds them to it.
//
// Fixtures: grain, treasury, population.
import { describe, it, expect } from "vitest";
import {
  createTurnReader,
  verifyAnswers,
  type ReaderQuestion,
  type ReaderSource,
  type TransportAnswer,
} from "../turnReader.js";

const GRAIN: ReaderQuestion = {
  id: "grain-surplus",
  prompt: "Did the grain surplus continue?",
  answerKeys: ["continued", "ended"],
  safeDefault: "ended",
};
const POPULATION: ReaderQuestion = {
  id: "population",
  prompt: "Did the population grow?",
  answerKeys: ["grew", "shrank", "steady"],
  safeDefault: "steady",
};
const LEDGER: ReaderSource = { id: "ledger", text: "The grain surplus continued. The population grew by a dozen." };

const OFFERS: readonly unknown[] = [
  { questionId: "grain-surplus", answerKey: "continued", citation: { sourceId: "ledger", from: 2, to: 99 } },
  { questionId: "population", answerKey: "boomed", citation: { sourceId: "ledger", quote: "grew" } },
  { questionId: "nonsense", answerKey: "x", citation: { sourceId: "ledger", quote: "The" } },
  null,
];

describe("verifyAnswers: one list of offers, verified by the reader's own rule", () => {
  it("accepts, clamps, rejects with reasons, and falls to safe defaults exactly as a one-rung read would", async () => {
    const verified = verifyAnswers({ questions: [GRAIN, POPULATION], sources: [LEDGER], offers: OFFERS as TransportAnswer[] });
    const read = await createTurnReader({ questions: [GRAIN, POPULATION], transports: [async () => OFFERS as TransportAnswer[]] }).read([
      LEDGER,
    ]);
    expect(verified).toEqual(read);
  });

  it("reports the offers as rung 0, asked every question, answered with the offers given", () => {
    const verified = verifyAnswers({ questions: [GRAIN, POPULATION], sources: [LEDGER], offers: OFFERS as TransportAnswer[] });
    expect(verified.rungs).toEqual([{ rung: 0, asked: ["grain-surplus", "population"], attempts: [{ outcome: "answered", offers: 4 }] }]);
    expect(verified.answers.map((a) => [a.answerKey, a.fromSafeDefault])).toEqual([
      ["continued", false],
      ["steady", true],
    ]);
    expect(verified.answers[0].citation?.range).toEqual({ from: 2, to: 10 });
    expect(verified.answers[1].rejected.map((r) => r.reason)).toEqual(["unknown-answer-key"]);
    expect(verified.unmatched.map((r) => r.reason)).toEqual(["unknown-question", "malformed-offer"]);
  });

  it("an empty list of offers is every question at its safe default, each asked and offered nothing", () => {
    const verified = verifyAnswers({ questions: [GRAIN], sources: [LEDGER], offers: [] });
    expect(verified.answers[0]).toMatchObject({ answerKey: "ended", fromSafeDefault: true, askedOfRungs: [0], rejected: [] });
  });

  it("validates the question set exactly as createTurnReader does, before looking at any offer", () => {
    expect(() =>
      verifyAnswers({ questions: [{ ...GRAIN, safeDefault: "maybe" }], sources: [LEDGER], offers: [] })
    ).toThrow(/safeDefault 'maybe' which is not one of its own answerKeys/);
    expect(() => verifyAnswers({ questions: [GRAIN, GRAIN], sources: [LEDGER], offers: [] })).toThrow(/duplicate question id/);
  });

  it("a non-list of offers is refused rather than read as none -- the caller is the parser at this boundary", () => {
    expect(() => verifyAnswers({ questions: [GRAIN], sources: [LEDGER], offers: { not: "a list" } as unknown as TransportAnswer[] })).toThrow(
      /offers must be a list/
    );
  });
});
