// The state-to-text projection (design §7/§8, GitHub issue #16), proven over
// the real MCP wire against a consumer-shaped assembly. "Say what IS true,
// never what is absent," enforced AT CONSTRUCTION: this file's job is to
// prove that guarantee from OUTSIDE the engine -- a real child process,
// injected with a real (if small) vocabulary, driven entirely through the
// ordinary MCP tool surface a consumer would actually use
// (create_resource/update_resource, never a raw fact write).
//
// grain/treasury/population flavoured throughout (root CLAUDE.md,
// engineVocabulary.test.ts) -- a throwaway fixture, never a starter set.
//
// This file writes NO assertion that scans rendered text for negation, an
// absence, or a forbidden word -- root CLAUDE.md hard rule 4 forbids
// exactly that shape of check, whether inside the engine or a test of it.
// Every assertion below is either (a) a direct equality against a token
// FIXTURE_VOCABULARY below itself defines -- explicitly permitted, the same
// exception src/timeline/render.ts's own `resolveEntry` relies on -- or (b)
// a shape/absence check (does this row exist at all, is this array empty),
// never a scan of generated prose.
import { test, expect } from "@playwright/test";
import { connectConsumer, spawnConsumerServerProcess, type ConsumerHarness } from "../support/consumerClient.js";
import type { RenderedState, RenderVocabulary } from "../../dist/timeline/render.js";
import type { Resource } from "../../dist/types/index.js";
import type { StoryTime } from "../../dist/timeline/clock.js";

/**
 * MUST mirror `e2e/support/consumerServer.ts`'s own `FIXTURE_VOCABULARY`
 * exactly. The two files run in separate processes (this spec never imports
 * the server script's module scope -- it only spawns it), so there is no
 * shared object to import; this is the harness's own copy, used ONLY to
 * assert that render_state_at's output uses the exact nouns/adjectives THIS
 * vocabulary declares, never anything invented. Checking our own defined
 * tokens in our own output is explicitly permitted (root CLAUDE.md hard rule
 * 4's "a literal check for a token we defined is fine"); this is that check,
 * not a disguised regex over prose.
 */
const FIXTURE_VOCABULARY: RenderVocabulary = {
  category: {
    full: { noun: "grain stores", adjectives: ["brimming", "full"] },
    spent: { noun: "grain husks", adjectives: ["swept", "dry"] },
    stacked: { noun: "treasury coffers", adjectives: ["stacked", "gleaming"] },
    growing: { noun: "population count", adjectives: ["growing"] },
  },
};

async function currentT(harness: ConsumerHarness, gameId: string): Promise<number> {
  const story = await harness.call<StoryTime>("get_story_time", { gameId });
  return story.t;
}

test.describe("state-to-text projection over the real MCP wire (consumer-shaped assembly)", () => {
  let harness: ConsumerHarness;

  test.beforeEach(async () => {
    harness = await connectConsumer({ label: "consumer-render" });
  });

  test.afterEach(async () => {
    await harness.close();
  });

  test("render_state_at is registered when a vocabulary is injected", async () => {
    const names = await harness.listToolNames();
    expect(names).toContain("render_state_at");
  });

  test("renders a fact that holds using ONLY the noun/adjectives this harness's own vocabulary declares", async () => {
    const game = await harness.call<{ id: string }>("create_game", { name: "grain depot", setting: "test", style: "test" });
    const gameId = game.id;

    const grain = await harness.call<Resource>("create_resource", {
      gameId,
      ownerType: "game",
      name: "grain",
      category: "full",
      value: 50,
    });
    const t = await currentT(harness, gameId);

    const rendered = await harness.call<RenderedState>("render_state_at", { gameId, t });

    const noun = rendered.nouns.find((n) => n.entityId === grain.id && n.key === "category");
    expect(noun).toBeDefined();
    // Equality against OUR OWN vocabulary object, not a hardcoded string
    // duplicated a second time and not a scan for a word -- if
    // FIXTURE_VOCABULARY.category.full ever changes, this assertion moves
    // with it automatically.
    const expected = FIXTURE_VOCABULARY.category!.full;
    expect(noun?.noun).toBe(expected.noun);
    expect(noun?.adjectives).toEqual(expected.adjectives);
    expect(noun?.phrase).toBe([...expected.adjectives!, expected.noun].join(" "));
    expect(noun?.value).toBe("full");
  });

  test("a fact that holds but has no vocabulary entry is reported as a row in unnamed, never invented or described", async () => {
    const game = await harness.call<{ id: string }>("create_game", { name: "grain depot", setting: "test", style: "test" });
    const gameId = game.id;

    const treasury = await harness.call<Resource>("create_resource", {
      gameId,
      ownerType: "game",
      name: "treasury",
      // "uncatalogued" is deliberately absent from FIXTURE_VOCABULARY.
      category: "uncatalogued",
      value: 50,
    });
    const t = await currentT(harness, gameId);

    const rendered = await harness.call<RenderedState>("render_state_at", { gameId, t });

    // Never named as a noun...
    expect(rendered.nouns.find((n) => n.entityId === treasury.id && n.key === "category")).toBeUndefined();
    // ...but present, as a plain row, in unnamed -- the caller learns its
    // vocabulary is too thin from a row, never from invented text.
    const row = rendered.unnamed.find((u) => u.entityId === treasury.id && u.key === "category");
    expect(row).toBeDefined();
    expect(row?.value).toBe("uncatalogued");
  });

  test("a fact that does not hold at t produces nothing at all -- no phrase, no placeholder, no unnamed row", async () => {
    const game = await harness.call<{ id: string }>("create_game", { name: "grain depot", setting: "test", style: "test" });
    const gameId = game.id;

    const population = await harness.call<Resource>("create_resource", {
      gameId,
      ownerType: "game",
      name: "population",
      category: "growing",
      value: 20,
    });
    const tGrowing = await currentT(harness, gameId);

    // Confirm it DOES hold first, so the later absence is meaningful rather
    // than "it never rendered in the first place."
    const renderedWhileGrowing = await harness.call<RenderedState>("render_state_at", { gameId, t: tGrowing });
    expect(renderedWhileGrowing.nouns.some((n) => n.entityId === population.id && n.key === "category")).toBe(true);

    // Clearing category to null closes the "growing" fact interval and
    // opens NOTHING new (the projection trigger only opens a fact for a
    // non-NULL column -- src/timeline/projection.ts's buildUpdateTrigger).
    await harness.call("update_resource", { resourceId: population.id, category: null });
    const tCleared = await currentT(harness, gameId);

    const renderedAfterClear = await harness.call<RenderedState>("render_state_at", { gameId, t: tCleared });

    // Not renamed, not renamed to something else, not present as an unnamed
    // row either -- the fact simply does not exist at this t, and the
    // projection says nothing about it at all.
    expect(renderedAfterClear.nouns.find((n) => n.entityId === population.id && n.key === "category")).toBeUndefined();
    expect(renderedAfterClear.unnamed.find((u) => u.entityId === population.id && u.key === "category")).toBeUndefined();
  });

  test("rendering at an earlier t shows the earlier state; rendering at a later t shows the later state", async () => {
    const game = await harness.call<{ id: string }>("create_game", { name: "grain depot", setting: "test", style: "test" });
    const gameId = game.id;

    const grain = await harness.call<Resource>("create_resource", {
      gameId,
      ownerType: "game",
      name: "grain",
      category: "full",
      value: 50,
    });
    const tFull = await currentT(harness, gameId);

    await harness.call("update_resource", { resourceId: grain.id, category: "spent" });
    const tSpent = await currentT(harness, gameId);

    expect(tSpent).toBeGreaterThan(tFull);

    const earlier = await harness.call<RenderedState>("render_state_at", { gameId, t: tFull });
    const later = await harness.call<RenderedState>("render_state_at", { gameId, t: tSpent });

    const earlierNoun = earlier.nouns.find((n) => n.entityId === grain.id && n.key === "category");
    const laterNoun = later.nouns.find((n) => n.entityId === grain.id && n.key === "category");

    expect(earlierNoun?.value).toBe("full");
    expect(earlierNoun?.noun).toBe(FIXTURE_VOCABULARY.category!.full.noun);

    expect(laterNoun?.value).toBe("spent");
    expect(laterNoun?.noun).toBe(FIXTURE_VOCABULARY.category!.spent.noun);

    // The earlier render is unaffected by the later write -- re-querying
    // the SAME earlier t after the update still reports "full", never
    // "spent" and never both at once (interval versioning guarantees at
    // most one fact per key is valid at a single t).
    const earlierAgain = await harness.call<RenderedState>("render_state_at", { gameId, t: tFull });
    const earlierAgainNoun = earlierAgain.nouns.find((n) => n.entityId === grain.id && n.key === "category");
    expect(earlierAgainNoun?.value).toBe("full");
  });

  test("negation is unconstructable: a vocabulary entry carrying an extra field is refused at SERVER CONSTRUCTION, not at first render", async () => {
    // A consumer server variant that injects a vocabulary entry with an
    // extra `avoid` field -- src/timeline/render.ts's own resolveEntry
    // refuses this before createMcpServer ever returns, which means before
    // this process ever connects a transport. Spawned as a bare child
    // process (not through connectConsumer/StdioClientTransport) precisely
    // because there is no MCP handshake to complete here at all -- see
    // consumerClient.ts's own doc comment on why this needs a different tool
    // than the rest of this file uses.
    const spawned = spawnConsumerServerProcess({
      label: "consumer-render-bad-vocab",
      extraEnv: { E2E_BAD_VOCABULARY: "1" },
    });

    try {
      const { code, signal } = await spawned.waitForExit();

      expect(signal).toBeNull();
      expect(code).not.toBe(0);

      // The refusal names the offending field, from createStateRenderer's
      // own error message ("carries an unrecognized field \"avoid\""),
      // logged to stderr through dist/utils/logger.js -- never to stdout,
      // which stayed the JSON-RPC channel right up until this process gave
      // up on ever using it.
      expect(spawned.stderr()).toMatch(/avoid/i);
      expect(spawned.stdout()).toBe("");
    } finally {
      spawned.cleanup();
    }
  });
});
