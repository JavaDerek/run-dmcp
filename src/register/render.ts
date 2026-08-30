import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ANNOTATIONS } from "../utils/tool-annotations.js";
import { createLogger } from "../utils/logger.js";
import type { StateRenderer } from "../timeline/render.js";

const log = createLogger("render");

/**
 * The MCP surface for the engine's state-to-text projection (design §7,
 * §8, GitHub issue #16) -- one tool, `render_state_at`. Registered ONLY
 * when a caller supplies a `StateRenderer` to `createMcpServer`
 * (src/mcp-server.ts), itself built by `createStateRenderer({ vocabulary
 * })` (timeline/render.ts) over a caller-injected, caller-owned vocabulary.
 * An engine with no injected vocabulary has nothing to name and registers
 * no render tool at all -- the same "injection at construction" shape
 * `registerResolveTools` (resolve.ts) already uses for its `Resolver`, and
 * for the identical reason: there is no global renderer anywhere in this
 * codebase, and this file carries no vocabulary of its own, not even an
 * example (root CLAUDE.md hard rule 3, design §7's "mechanism is core, the
 * vocabulary is injected").
 */
export function registerRenderTools(server: McpServer, renderer: StateRenderer) {
  server.registerTool(
    "render_state_at",
    {
      description:
        "Render a game's world at t as positive concrete nouns, drawn only from the caller's own injected " +
        "vocabulary -- 'the grain stores are full and the treasury coffers overflow', never 'the grain stores " +
        "are no longer empty'. The renderer's sole source of state is replay(t): a fact that does not hold at " +
        "t produces nothing, not a phrase about its absence. A fact that DOES hold but has no vocabulary entry " +
        "is reported as an unnamed row rather than described or invented -- that is how a caller learns its " +
        "vocabulary is too thin, without the engine passing judgement on it. No diff, no comparison against " +
        "another t, and no transition/change form: state at one t, full stop.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        t: z
          .number()
          .finite()
          .describe(
            "An opaque ordinal on this game's declared time axis -- never a datetime, and never an index " +
              "into units you might later re-cut."
          ),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, t }) => {
      try {
        const rendered = renderer.render({ gameId, t });
        return { content: [{ type: "text", text: JSON.stringify(rendered, null, 2) }] };
      } catch (error) {
        log.error("render_state_at failed", { gameId, t, error: (error as Error).message });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );
}
