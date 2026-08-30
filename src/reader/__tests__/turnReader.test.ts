// `turnReader.ts` -- design §12 seam 3, GitHub issue #15: one model call per
// unit of progress, answering the questions a server cannot answer with
// code. The engine owns the call, the citation rule, coercion, the safe
// default and the fallback ladder; the CALLER owns the questions and the
// key vocabulary they are answered in.
//
// Every transport here is a scripted fake -- a plain async function built
// from an in-memory script of answers or failures. There is no network call,
// no SDK, and nothing that could reach one; that is the entire point of
// `noVendorTransports.test.ts` beside this file, and this file's own fakes
// are the proof that a real caller never needs anything more than a plain
// function to drive the engine.
//
// No test in this file touches a database, imports `testDb.ts`, or calls
// `createTestDb`/`destroyTestDb` -- the module under test has no database
// call anywhere in it (a pure orchestration layer over injected functions,
// per the task brief's rule 7), and this file's own silence on that front is
// the evidence.
//
// Fixtures: grain, treasury, population -- a throwaway vocabulary for
// exercising mechanism, never a starter set (root CLAUDE.md, engineVocabulary
// test).
import { describe, it, expect } from "vitest";
import {
  createTurnReader,
  type ReaderQuestion,
  type ReaderSource,
  type ReaderTransport,
  type ReadRequest,
  type TransportAnswer,
} from "../turnReader.js";

// ============================================================================
// Fixtures
// ============================================================================

const GRAIN_SURPLUS: ReaderQuestion = {
  id: "grain-surplus",
  prompt: "Did the grain surplus continue through the season?",
  answerKeys: ["continued", "ended"],
  safeDefault: "ended",
};

const TREASURY_TITHE: ReaderQuestion = {
  id: "treasury-tithe",
  prompt: "Was the treasury tithe collected this season?",
  answerKeys: ["collected", "waived"],
  safeDefault: "waived",
};

const POPULATION_GROWTH: ReaderQuestion = {
  id: "population-growth",
  prompt: "Did the population grow this season?",
  answerKeys: ["grew", "shrank", "steady"],
  safeDefault: "steady",
};

const LEDGER: ReaderSource = {
  id: "ledger",
  text: "The grain surplus continued into the next season. The treasury tithe was collected without incident.",
};

const CENSUS: ReaderSource = {
  id: "census",
  text: "The population grew by twelve households this season.",
};

const SOURCES: readonly ReaderSource[] = [LEDGER, CENSUS];

/** Builds a valid, well-cited `TransportAnswer` for a fixture question --
 *  the "everything about this offer is correct" baseline every rejection
 *  test starts from and breaks exactly one property of. */
function goodAnswer(overrides: Partial<TransportAnswer> = {}): TransportAnswer {
  return {
    questionId: GRAIN_SURPLUS.id,
    answerKey: "continued",
    citation: { sourceId: LEDGER.id, quote: "The grain surplus continued into the next season." },
    ...overrides,
  };
}

/** A transport that ignores the request and always returns `answers`,
 *  recording every request it was called with -- the vehicle for the
 *  "already-answered questions are not re-asked" and "sees only the
 *  remaining questions" assertions. */
function scriptedTransport(
  answers: readonly TransportAnswer[]
): { transport: ReaderTransport; requests: ReadRequest[] } {
  const requests: ReadRequest[] = [];
  const transport: ReaderTransport = async (request) => {
    requests.push(request);
    return answers;
  };
  return { transport, requests };
}

/** A transport that throws every time it is called -- exhausted immediately
 *  regardless of `attemptsPerTransport`, and never returns an answer. */
function alwaysThrowingTransport(): { transport: ReaderTransport; callCount: () => number } {
  let calls = 0;
  const transport: ReaderTransport = async () => {
    calls++;
    throw new Error("scripted transport failure");
  };
  return { transport, callCount: () => calls };
}

/** A transport that returns something that is not an array of answers at
 *  all -- the "unusable output" half of the fallback rule, distinct from a
 *  thrown/rejected call. */
function unusableOutputTransport(): ReaderTransport {
  return (async () => ({ notAnArray: true })) as unknown as ReaderTransport;
}

/** Fails `failTimes` calls, then returns `answers` on every call after
 *  that -- the vehicle for the retry-within-a-rung tests. */
function flakyTransport(
  failTimes: number,
  answers: readonly TransportAnswer[]
): { transport: ReaderTransport; callCount: () => number } {
  let calls = 0;
  const transport: ReaderTransport = async () => {
    calls++;
    if (calls <= failTimes) {
      throw new Error("scripted transient failure");
    }
    return answers;
  };
  return { transport, callCount: () => calls };
}

// ============================================================================
// createTurnReader -- construction-time validation (rule 6)
// ============================================================================
describe("createTurnReader construction", () => {
  it("accepts a well-formed question set and an empty transport list", () => {
    expect(() => createTurnReader({ questions: [GRAIN_SURPLUS], transports: [] })).not.toThrow();
  });

  it("rejects a non-string question id", () => {
    const bad = [{ ...GRAIN_SURPLUS, id: 123 as unknown as string }];
    expect(() => createTurnReader({ questions: bad, transports: [] })).toThrow(/id.*non-empty string/i);
  });

  it("rejects an empty/whitespace question id", () => {
    const bad = [{ ...GRAIN_SURPLUS, id: "   " }];
    expect(() => createTurnReader({ questions: bad, transports: [] })).toThrow(/non-empty string/i);
  });

  it("rejects a duplicate question id, naming the offending id", () => {
    const bad = [GRAIN_SURPLUS, { ...TREASURY_TITHE, id: GRAIN_SURPLUS.id }];
    expect(() => createTurnReader({ questions: bad, transports: [] })).toThrow(
      new RegExp(`duplicate question id.*${GRAIN_SURPLUS.id}`, "i")
    );
  });

  it("rejects a question with no answerKeys", () => {
    const bad = [{ ...GRAIN_SURPLUS, answerKeys: [] }];
    expect(() => createTurnReader({ questions: bad, transports: [] })).toThrow(/answerKey/i);
  });

  it("rejects a question with an empty-string answerKey", () => {
    const bad = [{ ...GRAIN_SURPLUS, answerKeys: ["continued", ""] }];
    expect(() => createTurnReader({ questions: bad, transports: [] })).toThrow(/non-empty string/i);
  });

  it("rejects a question with a duplicate answerKey", () => {
    const bad = [{ ...GRAIN_SURPLUS, answerKeys: ["continued", "continued"] }];
    expect(() => createTurnReader({ questions: bad, transports: [] })).toThrow(/duplicate answerKey/i);
  });

  it("rejects a safeDefault that is not a member of the question's own answerKeys", () => {
    const bad = [{ ...GRAIN_SURPLUS, safeDefault: "unclear" }];
    expect(() => createTurnReader({ questions: bad, transports: [] })).toThrow(
      new RegExp(`${GRAIN_SURPLUS.id}.*safeDefault`, "i")
    );
  });

  it("rejects attemptsPerTransport of 0", () => {
    expect(() =>
      createTurnReader({ questions: [GRAIN_SURPLUS], transports: [], attemptsPerTransport: 0 })
    ).toThrow(/attemptsPerTransport/);
  });

  it("rejects a non-integer attemptsPerTransport", () => {
    expect(() =>
      createTurnReader({ questions: [GRAIN_SURPLUS], transports: [], attemptsPerTransport: 1.5 })
    ).toThrow(/attemptsPerTransport/);
  });

  it("rejects a negative attemptsPerTransport", () => {
    expect(() =>
      createTurnReader({ questions: [GRAIN_SURPLUS], transports: [], attemptsPerTransport: -1 })
    ).toThrow(/attemptsPerTransport/);
  });
});

// ============================================================================
// read() -- the happy path and the ladder
// ============================================================================
describe("turn reader: read()", () => {
  it("happy path: one rung answers every question, each accepted with its citation", async () => {
    const { transport } = scriptedTransport([
      goodAnswer(),
      {
        questionId: TREASURY_TITHE.id,
        answerKey: "collected",
        citation: { sourceId: LEDGER.id, quote: "The treasury tithe was collected without incident." },
      },
      {
        questionId: POPULATION_GROWTH.id,
        answerKey: "grew",
        citation: { sourceId: CENSUS.id, quote: "The population grew by twelve households this season." },
      },
    ]);
    const reader = createTurnReader({
      questions: [GRAIN_SURPLUS, TREASURY_TITHE, POPULATION_GROWTH],
      transports: [transport],
    });

    const result = await reader.read(SOURCES);

    expect(result.answers).toHaveLength(3);
    // Deterministic ordering: the caller's declared question order.
    expect(result.answers.map((a) => a.questionId)).toEqual([
      GRAIN_SURPLUS.id,
      TREASURY_TITHE.id,
      POPULATION_GROWTH.id,
    ]);
    expect(result.answers[0]).toMatchObject({
      questionId: GRAIN_SURPLUS.id,
      answerKey: "continued",
      fromSafeDefault: false,
      answeredByRung: 0,
    });
    expect(result.answers[0].citation).toEqual({
      sourceId: LEDGER.id,
      quote: "The grain surplus continued into the next season.",
    });
    expect(result.answers[1]).toMatchObject({ answerKey: "collected", fromSafeDefault: false });
    expect(result.answers[2]).toMatchObject({ answerKey: "grew", fromSafeDefault: false });
    expect(result.unmatched).toEqual([]);
    for (const a of result.answers) {
      expect(a.rejected).toEqual([]);
    }
  });

  it("a rung answers some questions, the next rung answers the rest, and the second rung is asked only the remainder", async () => {
    const firstRungAnswers = [goodAnswer()]; // answers only grain-surplus
    const { transport: firstTransport, requests: firstRequests } = scriptedTransport(firstRungAnswers);
    const { transport: secondTransport, requests: secondRequests } = scriptedTransport([
      {
        questionId: TREASURY_TITHE.id,
        answerKey: "collected",
        citation: { sourceId: LEDGER.id, quote: "The treasury tithe was collected without incident." },
      },
    ]);
    const reader = createTurnReader({
      questions: [GRAIN_SURPLUS, TREASURY_TITHE],
      transports: [firstTransport, secondTransport],
    });

    const result = await reader.read(SOURCES);

    expect(firstRequests).toHaveLength(1);
    expect(firstRequests[0].questions.map((q) => q.id)).toEqual([GRAIN_SURPLUS.id, TREASURY_TITHE.id]);
    // The second rung must see ONLY the still-unanswered question -- the
    // question the first rung already answered validly is not re-asked.
    expect(secondRequests).toHaveLength(1);
    expect(secondRequests[0].questions.map((q) => q.id)).toEqual([TREASURY_TITHE.id]);

    const grain = result.answers.find((a) => a.questionId === GRAIN_SURPLUS.id);
    const treasury = result.answers.find((a) => a.questionId === TREASURY_TITHE.id);
    expect(grain).toMatchObject({ answerKey: "continued", answeredByRung: 0, fromSafeDefault: false });
    expect(treasury).toMatchObject({ answerKey: "collected", answeredByRung: 1, fromSafeDefault: false });
  });

  it("zero transports: every question takes its safe default", async () => {
    const reader = createTurnReader({
      questions: [GRAIN_SURPLUS, TREASURY_TITHE, POPULATION_GROWTH],
      transports: [],
    });

    const result = await reader.read(SOURCES);

    expect(result.answers).toHaveLength(3);
    expect(result.answers).toEqual([
      expect.objectContaining({ questionId: GRAIN_SURPLUS.id, answerKey: "ended", fromSafeDefault: true, answeredByRung: null, citation: null }),
      expect.objectContaining({ questionId: TREASURY_TITHE.id, answerKey: "waived", fromSafeDefault: true, answeredByRung: null, citation: null }),
      expect.objectContaining({ questionId: POPULATION_GROWTH.id, answerKey: "steady", fromSafeDefault: true, answeredByRung: null, citation: null }),
    ]);
  });

  it("every rung failing: all questions fall through to their safe defaults", async () => {
    const { transport: t1 } = alwaysThrowingTransport();
    const { transport: t2 } = alwaysThrowingTransport();
    const reader = createTurnReader({
      questions: [GRAIN_SURPLUS, TREASURY_TITHE],
      transports: [t1, t2],
    });

    const result = await reader.read(SOURCES);

    expect(result.answers.every((a) => a.fromSafeDefault)).toBe(true);
    expect(result.answers.map((a) => a.answerKey)).toEqual(["ended", "waived"]);
  });

  it("a transport that throws advances to the next rung, which then answers", async () => {
    const { transport: throwing } = alwaysThrowingTransport();
    const { transport: succeeding } = scriptedTransport([goodAnswer()]);
    const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [throwing, succeeding] });

    const result = await reader.read(SOURCES);

    expect(result.answers[0]).toMatchObject({ answerKey: "continued", answeredByRung: 1, fromSafeDefault: false });
  });

  it("a transport that returns unusable (non-array) output advances to the next rung", async () => {
    const unusable = unusableOutputTransport();
    const { transport: succeeding } = scriptedTransport([goodAnswer()]);
    const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [unusable, succeeding] });

    const result = await reader.read(SOURCES);

    expect(result.answers[0]).toMatchObject({ answerKey: "continued", answeredByRung: 1, fromSafeDefault: false });
  });

  // ==========================================================================
  // Retry-within-a-rung (attemptsPerTransport)
  // ==========================================================================
  describe("attemptsPerTransport", () => {
    it("attemptsPerTransport=1 (default): a single failure moves to the next rung without retrying", async () => {
      const flaky = flakyTransport(1, [goodAnswer()]);
      const { transport: nextRung } = scriptedTransport([goodAnswer({ answerKey: "ended" })]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [flaky.transport, nextRung] });

      const result = await reader.read(SOURCES);

      expect(flaky.callCount()).toBe(1);
      // The FIRST rung never succeeded, so the second rung's answer is what lands.
      expect(result.answers[0]).toMatchObject({ answerKey: "ended", answeredByRung: 1 });
    });

    it("attemptsPerTransport=2: a transport failing once then succeeding is retried within the same rung", async () => {
      const flaky = flakyTransport(1, [goodAnswer()]);
      const reader = createTurnReader({
        questions: [GRAIN_SURPLUS],
        transports: [flaky.transport],
        attemptsPerTransport: 2,
      });

      const result = await reader.read(SOURCES);

      expect(flaky.callCount()).toBe(2);
      expect(result.answers[0]).toMatchObject({ answerKey: "continued", answeredByRung: 0, fromSafeDefault: false });
    });

    it("attemptsPerTransport=2 does not retry a rung that succeeds on its first attempt", async () => {
      const flaky = flakyTransport(0, [goodAnswer()]);
      const reader = createTurnReader({
        questions: [GRAIN_SURPLUS],
        transports: [flaky.transport],
        attemptsPerTransport: 2,
      });

      await reader.read(SOURCES);

      expect(flaky.callCount()).toBe(1);
    });
  });

  // ==========================================================================
  // Rejection reasons -- each one, in isolation
  // ==========================================================================
  describe("rejection reasons", () => {
    it("unknown-question: an offer naming a questionId this read never declared is recorded under `unmatched`, and its question (if any) still gets its safe default", async () => {
      const { transport } = scriptedTransport([
        { questionId: "no-such-question", answerKey: "continued", citation: { sourceId: LEDGER.id, quote: "The grain surplus continued into the next season." } },
      ]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });

      const result = await reader.read(SOURCES);

      expect(result.unmatched).toHaveLength(1);
      expect(result.unmatched[0].reason).toBe("unknown-question");
      expect(result.unmatched[0].offer).toMatchObject({ questionId: "no-such-question", answerKey: "continued" });
      expect(result.answers[0]).toMatchObject({ questionId: GRAIN_SURPLUS.id, answerKey: "ended", fromSafeDefault: true });
    });

    it("unknown-answer-key: a key outside the question's declared set is rejected, never coerced to the nearest one", async () => {
      const { transport } = scriptedTransport([goodAnswer({ answerKey: "partly-continued" })]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });

      const result = await reader.read(SOURCES);

      expect(result.answers[0]).toMatchObject({ answerKey: "ended", fromSafeDefault: true });
      expect(result.answers[0].rejected).toHaveLength(1);
      expect(result.answers[0].rejected[0].reason).toBe("unknown-answer-key");
      expect(result.answers[0].rejected[0].offer.answerKey).toBe("partly-continued");
    });

    it("unknown-source-id: a citation naming a source that is not in the request is rejected", async () => {
      const { transport } = scriptedTransport([
        goodAnswer({ citation: { sourceId: "no-such-source", quote: "The grain surplus continued into the next season." } }),
      ]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });

      const result = await reader.read(SOURCES);

      expect(result.answers[0].fromSafeDefault).toBe(true);
      expect(result.answers[0].rejected[0].reason).toBe("unknown-source-id");
      expect(result.answers[0].rejected[0].offer.citation.sourceId).toBe("no-such-source");
    });

    it("empty-quote: a citation with an empty quote is rejected", async () => {
      const { transport } = scriptedTransport([goodAnswer({ citation: { sourceId: LEDGER.id, quote: "" } })]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });

      const result = await reader.read(SOURCES);

      expect(result.answers[0].fromSafeDefault).toBe(true);
      expect(result.answers[0].rejected[0].reason).toBe("empty-quote");
    });

    it("quote-not-in-source: a quote that does not occur verbatim in the cited source's text is rejected", async () => {
      const { transport } = scriptedTransport([
        goodAnswer({ citation: { sourceId: LEDGER.id, quote: "The grain surplus vanished entirely." } }),
      ]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });

      const result = await reader.read(SOURCES);

      expect(result.answers[0].fromSafeDefault).toBe(true);
      expect(result.answers[0].rejected[0].reason).toBe("quote-not-in-source");
    });

    it("duplicate-answer: a second offer for an already-accepted question is rejected, and the first offer's answer stands", async () => {
      const { transport } = scriptedTransport([
        goodAnswer({ answerKey: "continued" }),
        goodAnswer({ answerKey: "ended" }), // second offer for the same question in the same batch
      ]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });

      const result = await reader.read(SOURCES);

      expect(result.answers[0]).toMatchObject({ answerKey: "continued", fromSafeDefault: false });
      expect(result.answers[0].rejected).toHaveLength(1);
      expect(result.answers[0].rejected[0].reason).toBe("duplicate-answer");
      expect(result.answers[0].rejected[0].offer.answerKey).toBe("ended");
    });

    it("duplicate-answer across rungs: a later rung re-offering an already-answered question is rejected as duplicate, not treated as fresh", async () => {
      const { transport: first } = scriptedTransport([goodAnswer({ answerKey: "continued" })]);
      const { transport: second } = scriptedTransport([goodAnswer({ answerKey: "ended" })]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [first, second] });

      const result = await reader.read(SOURCES);

      expect(result.answers[0]).toMatchObject({ answerKey: "continued", answeredByRung: 0 });
    });
  });

  // ==========================================================================
  // Case sensitivity -- proves no normalisation snuck in anywhere
  // ==========================================================================
  describe("case sensitivity (no normalisation)", () => {
    it("an answerKey differing only in case is rejected, not coerced", async () => {
      const { transport } = scriptedTransport([goodAnswer({ answerKey: "Continued" })]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });

      const result = await reader.read(SOURCES);

      expect(result.answers[0].fromSafeDefault).toBe(true);
      expect(result.answers[0].rejected[0].reason).toBe("unknown-answer-key");
    });

    it("a quote differing only in case from the source text is rejected as quote-not-in-source, not fuzzy-matched", async () => {
      const { transport } = scriptedTransport([
        goodAnswer({ citation: { sourceId: LEDGER.id, quote: "the grain surplus continued into the next season." } }),
      ]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });

      const result = await reader.read(SOURCES);

      expect(result.answers[0].fromSafeDefault).toBe(true);
      expect(result.answers[0].rejected[0].reason).toBe("quote-not-in-source");
    });

    it("a quote differing only by surrounding whitespace is rejected, not trimmed", async () => {
      const { transport } = scriptedTransport([
        goodAnswer({ citation: { sourceId: LEDGER.id, quote: "  The grain surplus continued into the next season.  " } }),
      ]);
      const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });

      const result = await reader.read(SOURCES);

      expect(result.answers[0].fromSafeDefault).toBe(true);
      expect(result.answers[0].rejected[0].reason).toBe("quote-not-in-source");
    });
  });

  // ==========================================================================
  // The invariant: exactly one answer per question, always drawn from that
  // question's own declared answerKeys.
  // ==========================================================================
  it("invariant: every question always gets exactly one answer, and that answer's key is always a member of its own answerKeys -- across every scenario above", async () => {
    const scenarios: Array<() => Promise<{ answers: readonly { questionId: string; answerKey: string }[] }>> = [
      async () => {
        const reader = createTurnReader({ questions: [GRAIN_SURPLUS, TREASURY_TITHE, POPULATION_GROWTH], transports: [] });
        return reader.read(SOURCES);
      },
      async () => {
        const { transport } = scriptedTransport([goodAnswer({ answerKey: "partly-continued" })]);
        const reader = createTurnReader({ questions: [GRAIN_SURPLUS], transports: [transport] });
        return reader.read(SOURCES);
      },
      async () => {
        const { transport } = scriptedTransport([goodAnswer()]);
        const reader = createTurnReader({
          questions: [GRAIN_SURPLUS, TREASURY_TITHE, POPULATION_GROWTH],
          transports: [transport],
        });
        return reader.read(SOURCES);
      },
    ];

    const byId = new Map<string, ReaderQuestion>([
      [GRAIN_SURPLUS.id, GRAIN_SURPLUS],
      [TREASURY_TITHE.id, TREASURY_TITHE],
      [POPULATION_GROWTH.id, POPULATION_GROWTH],
    ]);

    for (const scenario of scenarios) {
      const result = await scenario();
      const seenIds = new Set<string>();
      for (const answered of result.answers) {
        expect(seenIds.has(answered.questionId)).toBe(false); // exactly one row per question
        seenIds.add(answered.questionId);
        const question = byId.get(answered.questionId);
        expect(question).toBeDefined();
        expect(question?.answerKeys).toContain(answered.answerKey);
      }
    }
  });
});
