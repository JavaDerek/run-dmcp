import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ANNOTATIONS } from "../utils/tool-annotations.js";
import { LIMITS } from "../utils/validation.js";
import { createLogger } from "../utils/logger.js";
import {
  sourceWords,
  validateQuestions,
  validateSourceIds,
  verifyAnswers,
  type TransportAnswer,
} from "../reader/turnReader.js";

const log = createLogger("reader");

/**
 * The turn reader as two MCP verbs (GitHub issue #39: intent in, ruling out),
 * for a caller whose ruling MODEL runs on its own side of the wire -- a
 * client-side principal, a person typing, anything that cannot hand the engine a
 * transport function. The engine owns the call shape and the verification;
 * it never runs, names or configures a model (src/reader/turnReader.ts's
 * header, and noVendorTransports.test.ts beside it):
 *
 *   1. `prepare_reading` -- the caller's own request (closed-key questions and
 *      the sources an answer may cite), validated exactly as
 *      `createTurnReader` validates it, handed back with every source's words
 *      numbered as a range citation counts them. A bad question set is
 *      refused here, before a model call is spent on it.
 *   2. `verify_reading` -- the caller's model's answers, verified by the same
 *      tally the library's ladder runs (`verifyAnswers`): the citation rule,
 *      ranges and their clamp, the safe defaults, and a reason for every
 *      discarded offer.
 *
 * Stateless: neither verb reads or writes a game. The request travels with
 * each call rather than being stored between them, so nothing here is a
 * second copy of a caller's question set that could drift from the first.
 * Everything the caller sends is opaque to the engine except the literal
 * checks the reader already makes (hard rule 4).
 */
const questionSchema = () =>
  z.object({
    id: z.string().max(100).describe("The question's id; answers name it as questionId."),
    prompt: z.string().max(LIMITS.CONTENT_MAX).describe("The caller's question text. Opaque to the engine."),
    answerKeys: z
      .array(z.string().max(LIMITS.NAME_MAX))
      .max(200)
      .describe("The CLOSED set of keys an answer may take."),
    safeDefault: z
      .string()
      .max(LIMITS.NAME_MAX)
      .describe("The key a question falls to when no answer is accepted. Must be one of answerKeys."),
  });

const sourceSchema = () =>
  z.object({
    id: z.string().max(100).describe("The source's id; a citation names it as sourceId."),
    text: z.string().max(LIMITS.CONTENT_MAX).describe("The text a citation must come from, byte for byte."),
  });

const requestShape = () => ({
  questions: z.array(questionSchema()).max(100).describe("The caller's closed-key questions."),
  sources: z.array(sourceSchema()).max(100).describe("Every source an answer may cite."),
});

/** A scalar of any JSON type, bounded where it is a string. */
const looseLeaf = () => z.union([z.string().max(LIMITS.NAME_MAX), z.number(), z.boolean(), z.null()]);

function fail(tool: string, error: unknown) {
  log.error(`${tool} refused`, { error: (error as Error).message });
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: (error as Error).message }) }],
    isError: true,
  };
}

export function registerReaderTools(server: McpServer) {
  server.registerTool(
    "prepare_reading",
    {
      description:
        "Step 1 of ruling free text against closed keys with your own model. Validates your request -- " +
        "closed-key questions and the sources an answer may cite -- exactly as the engine's turn reader does, " +
        "and returns it with every source's words numbered from 1. Show your model the numbered words and let " +
        "it cite {sourceId, from, to} instead of retyping a quote: a range cannot misquote. Then send its " +
        "answers to verify_reading. The engine never runs or chooses a model.",
      inputSchema: requestShape(),
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ questions, sources }) => {
      try {
        validateQuestions(questions);
        validateSourceIds(sources);
        const numbered = sources.map((s) => ({
          id: s.id,
          text: s.text,
          words: sourceWords(s.text).map((w) => ({ index: w.index, word: w.word })),
        }));
        return { content: [{ type: "text", text: JSON.stringify({ questions, sources: numbered }, null, 2) }] };
      } catch (error) {
        return fail("prepare_reading", error);
      }
    }
  );

  server.registerTool(
    "verify_reading",
    {
      description:
        "Step 2: your model's answers in, a ruling out. Each answer is {questionId, answerKey, citation}, where " +
        "citation is {sourceId, from, to} (a word range from prepare_reading's numbering) or {sourceId, quote} " +
        "(byte-exact). An answer counts only if its key is one of that question's answerKeys and its citation " +
        "names text really in that source; a range ending past a source's last word ends at it. Every question " +
        "gets exactly one answer: the accepted one, or its safeDefault. Every discarded answer is returned with " +
        "the reason it was discarded. Send the same questions and sources you prepared.",
      inputSchema: {
        ...requestShape(),
        offers: z
          .array(
            // Every leaf admits the wrong type on purpose: a model that writes
            // "from": "3" or a numeric key has made an answer the reader
            // rejects as a row with a reason, and refusing the whole call on
            // schema validation would lose every other answer beside it --
            // the same failure a `[null]` in a transport's list once caused.
            z.object({
              questionId: looseLeaf().optional(),
              answerKey: looseLeaf().optional(),
              citation: z
                .object({
                  sourceId: looseLeaf().optional(),
                  quote: z.union([z.string().max(LIMITS.CONTENT_MAX), z.number(), z.null()]).optional(),
                  from: looseLeaf().optional(),
                  to: looseLeaf().optional(),
                })
                .optional(),
            })
          )
          .max(1000)
          .describe(
            "Your model's answers, as parsed from its reply. An answer with a wrong or missing field is a rejected " +
              "row with a reason, not a refused call."
          ),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ questions, sources, offers }) => {
      try {
        const ruling = verifyAnswers({ questions, sources, offers: offers as TransportAnswer[] });
        return { content: [{ type: "text", text: JSON.stringify(ruling, null, 2) }] };
      } catch (error) {
        return fail("verify_reading", error);
      }
    }
  );
}
