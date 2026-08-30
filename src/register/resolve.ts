import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ANNOTATIONS } from "../utils/tool-annotations.js";
import { createLogger } from "../utils/logger.js";
import { errors, formatErrorResponse } from "../utils/errors.js";
import { ConstraintViolationError } from "../timeline/registry.js";
import { ResolveProtocolError, type Resolver } from "../timeline/resolve.js";

const log = createLogger("resolve");

/**
 * The MCP surface for the resolve protocol (design §5.2a, issue #10) --
 * `resolve` and `list_mechanics`. Registered ONLY when a caller supplies a
 * non-empty `mechanics` array to `createCoreMcpServer` (src/mcp-server.ts): an
 * engine with no mechanics has no resolve surface, and that is the correct
 * shape rather than a resolve tool that could only ever answer
 * "unknown-mechanic" and a list_mechanics that could only ever answer `[]`.
 * This keeps injection at construction -- there is still no global resolver
 * anywhere in this codebase, only the one `Resolver` instance a caller built
 * and handed in, closed over by the two tool handlers below.
 */
export function registerResolveTools(server: McpServer, resolver: Resolver) {
  server.registerTool(
    "resolve",
    {
      description:
        "Propose a resolution to a registered mechanic and get back its outcome. The engine enforces the " +
        "PROTOCOL -- resolution happens before narration, writes go through the audited path, declared " +
        "expectations are checked before dispatch -- without knowing what the mechanic itself means. " +
        "Refuses (no window opens, nothing is written) for an unknown mechanic, a game with no timeline " +
        "clock, or a declared expectation that does not hold at the game's current t -- the last of these " +
        "carries one hop of causality per contradicted expectation, so a caller can tell whether the fact " +
        "is wrong or the claim is. A constraint violated mid-adjudication (bounded, monotonic, conserved, " +
        "resolve_only, irreversible) rolls back every change in the resolution and records no event.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        mechanic: z.string().min(1).max(200).describe("The name of a mechanic registered with this resolver"),
        parameters: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Opaque to the engine -- handed to the mechanic verbatim, never inspected here"),
        expects: z
          .array(
            z.object({
              entityId: z.string().max(100).describe("The entity this expectation is about"),
              key: z.string().max(200).describe("The fact key this expectation is about"),
              value: z.union([z.string(), z.number()]).describe("The value this proposal declares it depends on"),
            })
          )
          .optional()
          .describe(
            "Facts this proposal declares it depends on, verified BEFORE the mechanic is dispatched. A caller's " +
              "own declared precondition -- the engine only reports whether it holds, never why it should."
          ),
      },
      annotations: ANNOTATIONS.UPDATE,
    },
    async ({ gameId, mechanic, parameters, expects }) => {
      try {
        const outcome = resolver.resolve({ gameId, mechanic, parameters, expects });
        return { content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }] };
      } catch (error) {
        if (error instanceof ResolveProtocolError) {
          log.error("resolve refused", { gameId, mechanic, reason: error.reason, error: error.message });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: error.message,
                    reason: error.reason,
                    contradictions: error.contradictions ?? undefined,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }
        if (error instanceof ConstraintViolationError) {
          log.error("resolve rolled back", {
            gameId,
            mechanic,
            constraintKind: error.constraintKind,
            error: error.message,
          });
          return formatErrorResponse(errors.constraintViolation(error.resourceId, error.message));
        }
        log.error("resolve failed", { gameId, mechanic, error: (error as Error).message });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_mechanics",
    {
      description:
        "List every mechanic name registered with this resolver. The engine holds these names; it never " +
        "reads meaning into them -- they are exactly what a caller handed to createCoreMcpServer's mechanics option.",
      inputSchema: {},
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async () => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(resolver.mechanics(), null, 2) }] };
      } catch (error) {
        log.error("list_mechanics failed", { error: (error as Error).message });
        return {
          content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }],
          isError: true,
        };
      }
    }
  );
}
