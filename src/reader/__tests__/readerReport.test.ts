// GitHub issue #36: tell the caller which answers were discarded, and why.
//
// A question that falls to its safe default looked the same from outside
// whatever the cause -- the rung offered nothing for it, the rung threw, the
// rung returned something that was not a list of answers, or an offer was
// discarded on a named conjunct of the citation rule. A consumer read "no
// offer" in its transcripts for four games while its model had named the
// right object every time. The reader knows each of these at the moment it
// decides; this file pins that it SAYS so.
//
// Reporting only (hard rule 2): nothing here changes what is accepted or which
// key a question falls to. Every field is a record of what the reader did --
// which rungs were asked which questions, what each attempt came back as, and
// the offer exactly as given beside what was accepted -- never a verdict on
// the transport's quality.
//
// Fixtures: grain, treasury, population.
import { describe, it, expect } from "vitest";
import {
  createTurnReader,
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

const TREASURY: ReaderQuestion = {
  id: "treasury-tithe",
  prompt: "Was the tithe collected?",
  answerKeys: ["collected", "waived"],
  safeDefault: "waived",
};

const LEDGER: ReaderSource = { id: "ledger", text: "The grain surplus continued. The tithe was collected." };

const GOOD_GRAIN: TransportAnswer = {
  questionId: GRAIN.id,
  answerKey: "continued",
  citation: { sourceId: "ledger", quote: "grain surplus continued" },
};

const GOOD_TREASURY: TransportAnswer = {
  questionId: TREASURY.id,
  answerKey: "collected",
  citation: { sourceId: "ledger", quote: "tithe was collected" },
};

const returning = (answers: unknown): ReaderTransport => (async () => answers) as unknown as ReaderTransport;
const throwing = (message: string): ReaderTransport => async () => {
  throw new Error(message);
};

describe("rungs: what each attempt on each rung came back as", () => {
  it("records an answering attempt with the number of offers it made", async () => {
    const reader = createTurnReader({ questions: [GRAIN], transports: [returning([GOOD_GRAIN])] });
    const result = await reader.read([LEDGER]);
    expect(result.rungs).toEqual([{ rung: 0, asked: ["grain-surplus"], attempts: [{ outcome: "answered", offers: 1 }] }]);
  });

  it("distinguishes a rung that threw (with its message) from one that returned a non-list", async () => {
    const reader = createTurnReader({
      questions: [GRAIN],
      transports: [throwing("socket closed"), returning({ notAList: true }), returning([GOOD_GRAIN])],
    });
    const result = await reader.read([LEDGER]);
    expect(result.rungs).toEqual([
      { rung: 0, asked: ["grain-surplus"], attempts: [{ outcome: "threw", error: "Error: socket closed" }] },
      { rung: 1, asked: ["grain-surplus"], attempts: [{ outcome: "not-a-list" }] },
      { rung: 2, asked: ["grain-surplus"], attempts: [{ outcome: "answered", offers: 1 }] },
    ]);
  });

  it("records every retry within a rung's budget", async () => {
    let calls = 0;
    const flaky: ReaderTransport = async () => {
      calls++;
      if (calls === 1) throw new Error("once");
      return [GOOD_GRAIN];
    };
    const reader = createTurnReader({ questions: [GRAIN], transports: [flaky], attemptsPerTransport: 3 });
    const result = await reader.read([LEDGER]);
    expect(result.rungs[0].attempts).toEqual([
      { outcome: "threw", error: "Error: once" },
      { outcome: "answered", offers: 1 },
    ]);
  });

  it("a rung never called, because every question was already answered, is not listed", async () => {
    const reader = createTurnReader({ questions: [GRAIN], transports: [returning([GOOD_GRAIN]), returning([GOOD_GRAIN])] });
    const result = await reader.read([LEDGER]);
    expect(result.rungs.map((r) => r.rung)).toEqual([0]);
  });

  it("asked lists only the questions still open when that rung was called", async () => {
    const reader = createTurnReader({
      questions: [GRAIN, TREASURY],
      transports: [returning([GOOD_GRAIN]), returning([GOOD_TREASURY])],
    });
    const result = await reader.read([LEDGER]);
    expect(result.rungs.map((r) => r.asked)).toEqual([["grain-surplus", "treasury-tithe"], ["treasury-tithe"]]);
  });
});

describe("per question: asked, offered, accepted -- the four causes are now distinguishable", () => {
  it("OFFERED NOTHING: asked of a rung that answered, no offer for it, nothing rejected", async () => {
    const reader = createTurnReader({ questions: [GRAIN, TREASURY], transports: [returning([GOOD_TREASURY])] });
    const [grain] = (await reader.read([LEDGER])).answers;
    expect(grain).toMatchObject({ fromSafeDefault: true, askedOfRungs: [0], rejected: [], acceptedOffer: null });
  });

  it("RUNG FAILED: asked of a rung that threw -- visible in rungs, not confused with an empty offer", async () => {
    const reader = createTurnReader({ questions: [GRAIN], transports: [throwing("down")] });
    const result = await reader.read([LEDGER]);
    expect(result.answers[0]).toMatchObject({ fromSafeDefault: true, askedOfRungs: [0], rejected: [] });
    expect(result.rungs[0].attempts[0].outcome).toBe("threw");
  });

  it("NEVER ASKED: zero transports -- askedOfRungs is empty", async () => {
    const reader = createTurnReader({ questions: [GRAIN], transports: [] });
    const result = await reader.read([LEDGER]);
    expect(result.answers[0].askedOfRungs).toEqual([]);
    expect(result.rungs).toEqual([]);
  });

  it("DISCARDED: the rejected offer carries its conjunct -- a named source not in the request", async () => {
    const reader = createTurnReader({
      questions: [GRAIN],
      transports: [returning([{ ...GOOD_GRAIN, citation: { sourceId: "census", quote: "grain" } }])],
    });
    const [grain] = (await reader.read([LEDGER])).answers;
    expect(grain.rejected.map((r) => r.reason)).toEqual(["unknown-source-id"]);
  });

  it("ACCEPTED: the offer exactly as the transport gave it is kept beside the acceptance", async () => {
    const reader = createTurnReader({ questions: [GRAIN], transports: [returning([GOOD_GRAIN])] });
    const [grain] = (await reader.read([LEDGER])).answers;
    expect(grain.acceptedOffer).toEqual(GOOD_GRAIN);
  });
});

describe("a malformed offer is a rejected row, never a crash that loses the whole read", () => {
  it("null, a number and a string in the list are rejected as malformed-offer under unmatched; good offers still count", async () => {
    const reader = createTurnReader({ questions: [GRAIN], transports: [returning([null, 7, "grain", GOOD_GRAIN])] });
    const result = await reader.read([LEDGER]);
    expect(result.answers[0]).toMatchObject({ fromSafeDefault: false, answerKey: "continued" });
    expect(result.unmatched.map((r) => r.reason)).toEqual(["malformed-offer", "malformed-offer", "malformed-offer"]);
    expect(result.unmatched.map((r) => r.offer)).toEqual([null, 7, "grain"]);
  });

  it("an offer whose questionId is not a string is malformed-offer", async () => {
    const reader = createTurnReader({ questions: [GRAIN], transports: [returning([{ ...GOOD_GRAIN, questionId: 3 }])] });
    const result = await reader.read([LEDGER]);
    expect(result.unmatched.map((r) => r.reason)).toEqual(["malformed-offer"]);
  });

  it("an offer for a real question with no citation at all is rejected under that question, not thrown", async () => {
    const reader = createTurnReader({
      questions: [GRAIN],
      transports: [returning([{ questionId: GRAIN.id, answerKey: "continued" }])],
    });
    const [grain] = (await reader.read([LEDGER])).answers;
    expect(grain.fromSafeDefault).toBe(true);
    expect(grain.rejected.map((r) => r.reason)).toEqual(["empty-quote"]);
  });
});

describe("reporting changes nothing about what counts", () => {
  it("the same offers produce the same answer keys and citations with or without the new fields being read", async () => {
    const offers = [{ ...GOOD_GRAIN, answerKey: "mostly" }, GOOD_TREASURY];
    const reader = createTurnReader({ questions: [GRAIN, TREASURY], transports: [returning(offers)] });
    const result = await reader.read([LEDGER]);
    expect(result.answers.map((a) => [a.answerKey, a.fromSafeDefault])).toEqual([
      ["ended", true],
      ["collected", false],
    ]);
  });
});
