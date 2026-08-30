import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ANNOTATIONS } from "../utils/tool-annotations.js";
import { createLogger } from "../utils/logger.js";
import { replay } from "../timeline/replay.js";
import { declareTimeAxis, setStoryTime, currentStoryTime } from "../timeline/clock.js";
import { declareIrreversible, listIrreversibleFacts } from "../timeline/irreversible.js";
import { exportTimelineToFile, importTimelineFromFile } from "../timeline/export.js";
import { changesWithin } from "../timeline/changes.js";
import { narrationConstraintAt } from "../timeline/narration.js";

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
    "changes_within",
    {
      description:
        "List every event and fact-interval transition a game recorded in the half-open window [t0, t1) -- t0 is in, t1 is not. The range companion to replay_world_at's point query, for callers whose units have duration. A fact that both opens and closes inside the window returns two rows, one per endpoint. Returns rows and nothing else: no verdict, no severity, no judgement about whether the window is 'clean'. What a change inside a window means is the caller's policy, not the engine's.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        t0: tSchema.describe("Start of the window, inclusive. Same axis as every other t for this game."),
        t1: tSchema.describe(
          "End of the window, exclusive. Must be >= t0. There is no open-ended form and no start-plus-length form -- a window is two points on the axis, never a point and a duration."
        ),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, t0, t1 }) => {
      try {
        const changeSet = changesWithin({ gameId, t0, t1 });
        return { content: [{ type: "text", text: JSON.stringify(changeSet, null, 2) }] };
      } catch (error) {
        log.error("changes_within failed", { gameId, t0, t1, error: (error as Error).message });
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

  server.registerTool(
    "declare_fact_irreversible",
    {
      description:
        "Mark the fact currently open for one entity and key as irreversible: from its valid_from_t onward, the engine refuses any later assertion of a different value under that key. The temporal member of the same constraint family as bounded, monotonic and conserved sets. Closing the fact, and deleting the entity, both remain legal -- ending a record is not asserting its opposite -- but reopening the key at a different value is still refused. Irreversibility cannot be withdrawn once declared. Because the flag is per-fact, a property you intend to declare irreversible must live under its own key: declaring it locks the whole value stored under that key.",
      inputSchema: {
        entityId: z
          .string()
          .max(100)
          .describe("The entity ID -- the same id as the row it was projected from (e.g. a resource ID)"),
        key: z
          .string()
          .max(200)
          .describe("The fact key, i.e. the column name the fact was projected from (e.g. 'value')"),
      },
      annotations: ANNOTATIONS.IDEMPOTENT_UPDATE,
    },
    async ({ entityId, key }) => {
      try {
        const fact = declareIrreversible({ entityId, key });
        return { content: [{ type: "text", text: JSON.stringify(fact, null, 2) }] };
      } catch (error) {
        log.error("declare_fact_irreversible failed", {
          entityId,
          key,
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
    "list_irreversible_facts",
    {
      description:
        "List every fact declared irreversible in a game, optionally narrowed to one entity. Each row carries the fact, its valid_from_t, and the event that opened it -- one hop of provenance, so a reviewer meeting a refusal can tell whether the fact is wrong or the claim is. Returns rows, never a verdict.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        entityId: z.string().max(100).optional().describe("Narrow the listing to one entity"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, entityId }) => {
      try {
        const facts = listIrreversibleFacts({ gameId, entityId });
        return { content: [{ type: "text", text: JSON.stringify(facts, null, 2) }] };
      } catch (error) {
        log.error("list_irreversible_facts failed", {
          gameId,
          entityId,
          error: (error as Error).message,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  /**
   * Both export tools deal in a PATH and return only counts, never the
   * artifact itself. That is design §6's point -- the deliverable is a file
   * the client owns, not a payload passed back through a conversation -- and
   * it is also what keeps a whole world's timeline from being pasted into
   * the caller's context window, which is how a tool result kills the
   * conversation that asked for it.
   */
  server.registerTool(
    "export_timeline",
    {
      description:
        "Freeze a game's entire timeline -- every entity, every fact interval, every event, and the declared time axis -- into a JSON file the caller owns. Deterministic: the same world exports byte-identically every time. Carries no media references and no live table rows by design, so the file can be re-imported anywhere and answer replay(t) identically. Returns the path and row counts, never the artifact itself.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        filePath: z.string().min(1).max(4096).describe("Absolute path to write the export file to"),
      },
      annotations: ANNOTATIONS.IDEMPOTENT_UPDATE,
    },
    async ({ gameId, filePath }) => {
      try {
        const artifact = exportTimelineToFile({ gameId, filePath });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  filePath,
                  gameId: artifact.gameId,
                  formatVersion: artifact.formatVersion,
                  entities: artifact.entities.length,
                  facts: artifact.facts.length,
                  events: artifact.events.length,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        log.error("export_timeline failed", { gameId, filePath, error: (error as Error).message });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "import_timeline",
    {
      description:
        "Restore a frozen timeline export into this database, verbatim -- ids and every t are carried through unchanged. Refuses rather than merges if the game already has any recorded history, and refuses an artifact whose rows do not all belong to the game it names. Imports the timeline only; the live tables are not repopulated.",
      inputSchema: {
        filePath: z.string().min(1).max(4096).describe("Absolute path of the export file to read"),
      },
      annotations: ANNOTATIONS.CREATE,
    },
    async ({ filePath }) => {
      try {
        const result = importTimelineFromFile(filePath);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        log.error("import_timeline failed", { filePath, error: (error as Error).message });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "narration_constraint_at",
    {
      description:
        "Return what IS true for a game at t, and nothing else: every fact valid then on an entity alive then, plus every irreversible fact from valid_from_t onward even if it has since closed or its entity has been destroyed. Each fact carries one hop of causality -- the event that opened it, if any is recorded -- so a reviewer can tell whether a disputed fact or a disputed claim is the one that's wrong. This tool does not check anything and returns no verdict: it hands back the serialized constraint so a caller can run its own check (a live one now, or an offline lint over the saved JSON hours later) -- see the library-exported `contradictions` function for that half, which takes no database and is not exposed as a tool because wrapping a pure function in a tool call would defeat the point of it being callable offline.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        t: tSchema,
        entityIds: z
          .array(z.string().max(100))
          .optional()
          .describe(
            "Narrow the constraint to only these entities. Omit for the whole game; an empty array narrows to nothing."
          ),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, t, entityIds }) => {
      try {
        const constraint = narrationConstraintAt({ gameId, t, entityIds });
        return { content: [{ type: "text", text: JSON.stringify(constraint, null, 2) }] };
      } catch (error) {
        log.error("narration_constraint_at failed", {
          gameId,
          t,
          entityIds,
          error: (error as Error).message,
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );
}
