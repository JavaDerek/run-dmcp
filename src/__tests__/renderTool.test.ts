// The projection reaches MCP only when a caller has supplied the words.
//
// design §7's line is "mechanism in core, vocabulary injected by each
// caller", and this file is where that line becomes observable from outside
// the engine rather than a claim inside a doc comment. `createCoreMcpServer()`
// with no `vocabulary` registers NO `render_state_at` tool at all -- not a
// tool that answers "no vocabulary configured", which would be a default
// vocabulary of one unhelpful string and would still put the engine in the
// business of deciding what a world sounds like. It gets silence, exactly the
// way `mechanics` gets no `resolve` tool when nothing is registered
// (mcp-server.ts's own doc comment).
//
// The second test here is the one that would catch a regression nobody would
// otherwise notice for months: a malformed vocabulary must fail at SERVER
// CONSTRUCTION, not at the first `render_state_at` call. Validation deferred
// to first use is validation that fires in front of a user instead of in
// front of a developer.
import { describe, it, expect } from "vitest";
import { createCoreMcpServer } from "../mcp-server.js";
import type { RenderVocabulary } from "../timeline/render.js";

/** grain, treasury, population -- a throwaway fixture vocabulary for
 *  exercising mechanism, never a starter set (design §10). */
const FIXTURE_VOCABULARY: RenderVocabulary = {
  grain: {
    full: { noun: "stores", adjectives: ["brimming"] },
    spent: { noun: "husks", adjectives: ["swept", "dry"] },
  },
  treasury: {
    full: { noun: "coffers", adjectives: ["stacked"] },
  },
};

/** The registered-tool map the MCP SDK keeps on a built server. */
function toolNames(server: unknown): string[] {
  const registered = (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
  return Object.keys(registered);
}

describe("render_state_at is registered only when a vocabulary is injected", () => {
  it("registers no render tool when createCoreMcpServer is called with nothing at all", () => {
    expect(toolNames(createCoreMcpServer())).not.toContain("render_state_at");
  });

  it("registers no render tool when options are supplied but carry no vocabulary", () => {
    expect(toolNames(createCoreMcpServer({ mechanics: [] }))).not.toContain("render_state_at");
  });

  it("registers the render tool when a vocabulary is injected", () => {
    expect(toolNames(createCoreMcpServer({ vocabulary: FIXTURE_VOCABULARY }))).toContain("render_state_at");
  });

  it("leaves every other tool exactly as it was -- injecting a vocabulary ADDS one tool and changes nothing else", () => {
    const without = new Set(toolNames(createCoreMcpServer()));
    const with_ = toolNames(createCoreMcpServer({ vocabulary: FIXTURE_VOCABULARY }));

    const added = with_.filter((name) => !without.has(name));
    expect(added).toEqual(["render_state_at"]);
    // ...and nothing was dropped on the way in.
    const removed = [...without].filter((name) => !with_.includes(name));
    expect(removed).toEqual([]);
  });
});

describe("a malformed vocabulary is refused when the SERVER is built, not at first render", () => {
  it("throws from createCoreMcpServer on an entry carrying a field other than noun/adjectives", () => {
    expect(() =>
      createCoreMcpServer({
        // The exact regression this guards: a forbidden field bolted onto a
        // vocabulary entry (hard rules 3/4, design §7). It must never reach a
        // running server, and the refusal must name the offending field.
        vocabulary: {
          grain: { full: { noun: "stores", avoid: ["empty granaries"] } },
        } as unknown as RenderVocabulary,
      })
    ).toThrow(/avoid/);
  });

  it("throws from createCoreMcpServer on an empty-string noun", () => {
    expect(() =>
      createCoreMcpServer({ vocabulary: { grain: { full: { noun: "   " } } } })
    ).toThrow(/noun/);
  });
});
