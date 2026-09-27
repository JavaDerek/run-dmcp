import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ANNOTATIONS } from "../utils/tool-annotations.js";
import { createLogger } from "../utils/logger.js";
import { evaluateConditions, type DeclaredRules } from "../timeline/declared.js";

const log = createLogger("conditions");

/**
 * `conditions_at` (GitHub issue #41): a game's DECLARED conditions evaluated
 * at `t` -- which hold, and each clause's observed value. Registered only
 * when a server was given declared rules (createCoreMcpServer's `rules`, or
 * the application's DMCP_RULES_FILE); a server with none has nothing to
 * evaluate and serves no such tool, the same silence `resolve` keeps when no
 * mechanics are registered.
 *
 * With `for`, it is one principal's condition list: the conditions declared
 * for it, in declared order, from the same data that gates the declared
 * mechanics. Rows, never a verdict -- `holds` compares a stored value to a
 * declared one; what that means is the caller's.
 */
export function registerConditionTools(server: McpServer, rules: DeclaredRules) {
  server.registerTool(
    "conditions_at",
    {
      description:
        "Evaluate this server's declared conditions for a game at t: each condition, whether it holds, and every " +
        "clause's observed value against its declared threshold. Pass `for` to get one principal's condition list " +
        "-- the conditions declared for it, in order, each with its declared 'then' -- from the same data that gates " +
        "the declared mechanics. A structural comparison of stored facts, never a verdict about the game.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        t: z.number().finite().describe("An opaque ordinal on this game's declared time axis."),
        for: z.string().max(200).optional().describe("Only the conditions declared for this principal."),
        parameters: z
          .record(z.string().max(200), z.union([z.string().max(1000), z.number(), z.null()]))
          .optional()
          .describe("Values for conditions that take {param} operands. A condition needing one not given is reported with missingParameter, and does not hold."),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, t, for: principal, parameters }) => {
      try {
        const rows = evaluateConditions({ gameId, t, rules, parameters, ...(principal !== undefined ? { for: principal } : {}) });
        return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
      } catch (error) {
        log.error("conditions_at failed", { gameId, t, error: (error as Error).message });
        return { content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }], isError: true };
      }
    }
  );
}
