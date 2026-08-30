import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ANNOTATIONS } from "../utils/tool-annotations.js";
import { createLogger } from "../utils/logger.js";
import { replay } from "../timeline/replay.js";
import { declareTimeAxis, setStoryTime, currentStoryTime } from "../timeline/clock.js";

const log = createLogger("timeline");

/**
 * The `t` every tool below takes or returns. This is the surface an
 * implementer actually meets the invariance property at (design §14, root
 * CLAUDE.md hard rule 6) -- the description is deliberately short, because
 * the property itself lives in `t.ts`'s `TimeAxis` doc comment; this is
 * where a caller is reminded of it at the moment it matters.
 */
const tSchema = z
  .number()
  .finite()
  .describe(
    "An opaque ordinal on this game's declared time axis -- never a datetime, and never an " +
      "index into units you might later re-cut."
  );

/**
 * Exactly the three variants `TimeAxis` (t.ts) allows, and no index-into-
 * units fourth one -- the schema shape itself is part of what this issue
 * asks for. `sequence` needs no `unit`; `elapsed`/`counter` need a
 * caller-named one so the tool description alone can't be mistaken for
 * always meaning "seconds".
 */
const timeAxisSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sequence").describe("The engine's own append ordinal, one tick per write. Default for a game that declares nothing."),
  }),
  z.object({
    kind: z.literal("elapsed").describe("Time since a fixed origin."),
    unit: z.string().min(1).max(100).describe("What the elapsed count is measured in (e.g. 'second', 'minute')."),
  }),
  z.object({
    kind: z.literal("counter").describe("A count of things that happened -- turns, ticks -- not of things authored."),
    unit: z.string().min(1).max(100).describe("What is being counted (e.g. 'turn', 'tick')."),
  }),
]);

export function registerTimelineTools(server: McpServer) {
  server.registerTool(
    "replay_world_at",
    {
      description:
        "Replay a game's world as it stood at a given t: every entity alive then, with every fact valid then. Works at any point in the game's recorded history, not only 'now'.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        t: tSchema,
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, t }) => {
      try {
        const snapshot = replay({ gameId, t });
        return { content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }] };
      } catch (error) {
        log.error("replay_world_at failed", { gameId, t, error: (error as Error).message });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_story_time",
    {
      description: "Get a game's current position on its own timeline: t, and the axis it is measured on.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId }) => {
      try {
        const storyTime = currentStoryTime(gameId);
        if (!storyTime) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: `timeline: game '${gameId}' has no timeline clock yet -- nothing has been declared or written for it`,
                }),
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(storyTime, null, 2) }] };
      } catch (error) {
        log.error("get_story_time failed", { gameId, error: (error as Error).message });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "declare_time_axis",
    {
      description:
        "Declare the axis a game's t is measured on -- fixed for the life of that game's timeline once set for real. Call this before creating anything else so the game's world starts at its own origin, not partway up the engine's default append ordinal. A game that already has a recorded t (e.g. from its own creation) has a floor there: startAt below it is refused with the floor named, never silently shifted down to fit.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        axis: timeAxisSchema.describe(
          "The time axis. There is no variant for an index into units you might later re-cut -- only sequence, elapsed, or counter."
        ),
        startAt: z
          .number()
          .finite()
          .optional()
          .describe(
            "Where this axis's t should start (or continue); defaults to 0 for a brand-new game, or to the current t otherwise. Must never be behind the current t."
          ),
      },
      annotations: ANNOTATIONS.IDEMPOTENT_UPDATE,
    },
    async ({ gameId, axis, startAt }) => {
      try {
        const storyTime = declareTimeAxis({ gameId, axis, startAt });
        return { content: [{ type: "text", text: JSON.stringify(storyTime, null, 2) }] };
      } catch (error) {
        log.error("declare_time_axis failed", {
          gameId,
          axis,
          startAt,
          error: (error as Error).message,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "set_story_time",
    {
      description:
        "Move a game's t forward on its declared axis. Only works once a non-sequence axis has been declared -- the engine's own append ordinal cannot be positioned by a caller. Never moves t backwards, including below whatever floor the axis inherited at declaration time.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        t: tSchema,
      },
      annotations: ANNOTATIONS.IDEMPOTENT_UPDATE,
    },
    async ({ gameId, t }) => {
      try {
        const storyTime = setStoryTime({ gameId, t });
        return { content: [{ type: "text", text: JSON.stringify(storyTime, null, 2) }] };
      } catch (error) {
        log.error("set_story_time failed", { gameId, t, error: (error as Error).message });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );
}
