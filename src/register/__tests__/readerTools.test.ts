// GitHub issue #39 over the wire: `prepare_reading` and `verify_reading`, the
// turn reader's two steps as MCP verbs, with the ruling model on the CLIENT's
// side. A real client over an in-memory transport, as schemaBounds.test.ts
// does -- the bytes a consumer actually receives, not the handler called
// directly. The engine owns the call shape and the verification; nothing here
// runs or names a model.
//
// Fixtures: grain, treasury, population.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCoreMcpServer } from "../../mcp-server.js";
import { verifyAnswers, type TransportAnswer } from "../../reader/turnReader.js";

const QUESTIONS = [
  { id: "grain-surplus", prompt: "Did the grain surplus continue?", answerKeys: ["continued", "ended"], safeDefault: "ended" },
  { id: "treasury", prompt: "Was the tithe collected?", answerKeys: ["collected", "waived"], safeDefault: "waived" },
];
const SOURCES = [{ id: "ledger", text: "The grain  surplus continued. Tithe collected." }];

let client: Client;

beforeAll(async () => {
  const server = createCoreMcpServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "reader-tools-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
});

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

describe("the reader verbs are served by the core server", () => {
  it("tools/list includes prepare_reading and verify_reading, both read-only", async () => {
    const { tools } = await client.listTools();
    for (const name of ["prepare_reading", "verify_reading"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("prepare_reading: the engine hands out the request", () => {
  it("returns the questions as given and every source's words, numbered as a range citation counts them", async () => {
    const { isError, body } = await call("prepare_reading", { questions: QUESTIONS, sources: SOURCES });
    expect(isError).toBe(false);
    expect(body.questions).toEqual(QUESTIONS);
    expect(body.sources).toEqual([
      {
        id: "ledger",
        text: SOURCES[0].text,
        words: [
          { index: 1, word: "The" },
          { index: 2, word: "grain" },
          { index: 3, word: "surplus" },
          { index: 4, word: "continued." },
          { index: 5, word: "Tithe" },
          { index: 6, word: "collected." },
        ],
      },
    ]);
  });

  it("refuses a question set createTurnReader would refuse, before any model is asked", async () => {
    const { isError, body } = await call("prepare_reading", {
      questions: [{ ...QUESTIONS[0], safeDefault: "perhaps" }],
      sources: SOURCES,
    });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/safeDefault 'perhaps'/);
  });

  it("refuses duplicate source ids, which would make a citation's sourceId ambiguous", async () => {
    const { isError, body } = await call("prepare_reading", { questions: QUESTIONS, sources: [SOURCES[0], SOURCES[0]] });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/duplicate source id 'ledger'/);
  });
});

describe("verify_reading: the caller's model answered; the engine verifies and rules", () => {
  const offers = [
    { questionId: "grain-surplus", answerKey: "continued", citation: { sourceId: "ledger", from: 2, to: 40 } },
    { questionId: "treasury", answerKey: "collected", citation: { sourceId: "ledger", quote: "tithe collected" } },
    { questionId: "treasury", answerKey: "collected", citation: {} },
  ];

  it("returns exactly what the library's verifyAnswers returns for the same offers", async () => {
    const { isError, body } = await call("verify_reading", { questions: QUESTIONS, sources: SOURCES, offers });
    expect(isError).toBe(false);
    expect(body).toEqual(JSON.parse(JSON.stringify(verifyAnswers({ questions: QUESTIONS, sources: SOURCES, offers: offers as TransportAnswer[] }))));
  });

  it("clamps an overshooting range, and names each discarded offer's reason", async () => {
    const { body } = await call("verify_reading", { questions: QUESTIONS, sources: SOURCES, offers });
    expect(body.answers[0]).toMatchObject({
      answerKey: "continued",
      fromSafeDefault: false,
      citation: { sourceId: "ledger", quote: "grain  surplus continued. Tithe collected.", range: { from: 2, to: 6 } },
    });
    // Case matters: "tithe" is not "Tithe". Then the empty citation.
    expect(body.answers[1]).toMatchObject({ answerKey: "waived", fromSafeDefault: true });
    expect(body.answers[1].rejected.map((r: { reason: string }) => r.reason)).toEqual(["quote-not-in-source", "missing-citation"]);
  });

  it("an empty offers list rules every question at its safe default", async () => {
    const { body } = await call("verify_reading", { questions: QUESTIONS, sources: SOURCES, offers: [] });
    expect(body.answers.map((a: { answerKey: string }) => a.answerKey)).toEqual(["ended", "waived"]);
  });

  it("an offer missing its answerKey is a rejected row, not a refused call", async () => {
    const { isError, body } = await call("verify_reading", {
      questions: QUESTIONS,
      sources: SOURCES,
      offers: [{ questionId: "grain-surplus", citation: { sourceId: "ledger", quote: "grain" } }],
    });
    expect(isError).toBe(false);
    expect(body.answers[0].rejected.map((r: { reason: string }) => r.reason)).toEqual(["unknown-answer-key"]);
  });

  it("fields of the wrong type -- a range given as strings, a numeric key -- are rejected rows, not a refused call", async () => {
    const { isError, body } = await call("verify_reading", {
      questions: QUESTIONS,
      sources: SOURCES,
      offers: [
        { questionId: "grain-surplus", answerKey: "continued", citation: { sourceId: "ledger", from: "2", to: "3" } },
        { questionId: "treasury", answerKey: 7, citation: { sourceId: "ledger", quote: "Tithe" } },
      ],
    });
    expect(isError).toBe(false);
    expect(body.answers.map((a: { rejected: { reason: string }[] }) => a.rejected.map((r) => r.reason))).toEqual([
      ["invalid-range"],
      ["unknown-answer-key"],
    ]);
  });
});
