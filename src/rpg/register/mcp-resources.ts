import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as questTools from "../tools/quest.js";
import { createGameListCallback } from "../../register/mcp-resources.js";

// The two RPG-shaped MCP resources split out of src/register/mcp-resources.ts
// (design §8, issue #17): game-quests and quest are the only two of that
// file's twelve registrations that touch questTools, so they moved here and
// core no longer imports quest.js at all. `createGameListCallback` is NOT
// duplicated here -- it is imported from the core module that owns it, so
// there remains exactly one implementation of "list this resource across
// every game."
export function registerRpgMcpResources(server: McpServer) {
  // Game quests
  server.registerResource(
    "game-quests",
    new ResourceTemplate("dmcp://game/{gameId}/quests", {
      list: createGameListCallback("/quests", (g) => `${g.name} - Quests`),
    }),
    {
      description: "All quests in the game",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const gameId = variables.gameId as string;
      const quests = questTools.listQuests(gameId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(quests, null, 2),
          },
        ],
      };
    }
  );

  // Quest by ID
  server.registerResource(
    "quest",
    new ResourceTemplate("dmcp://quest/{questId}", {
      list: undefined, // No enumeration - access by ID only
    }),
    {
      description: "Quest details with objectives",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const questId = variables.questId as string;
      const quest = questTools.getQuest(questId);
      if (!quest) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "Quest not found" }),
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(quest, null, 2),
          },
        ],
      };
    }
  );
}
