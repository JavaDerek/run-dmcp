import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as characterTools from "../../tools/character.js";
import * as narrativeTools from "../../tools/narrative.js";
import * as combatTools from "../tools/combat.js";
import { LIMITS } from "../../utils/validation.js";
import { ANNOTATIONS } from "../../utils/tool-annotations.js";
import type { Character } from "../../types/index.js";

// The one multi-entity workflow tool that reaches into combat, split out of
// src/register/batch.ts (design §8, issue #17): everything else there --
// batch_create_npcs, scene_transition, get_character_context,
// get_location_context -- touches only entity/property concepts and stays in
// core. This one calls combatTools.startCombat, so it is genuinely
// game-shaped and belongs in the RPG layer above it, not beside it.
export function registerRpgBatchTools(server: McpServer) {
  // ============================================================================
  // SETUP COMBAT ENCOUNTER - Create NPCs, start combat with all participants
  // ============================================================================
  server.registerTool(
    "setup_combat_encounter",
    {
      description:
        "Complete combat setup in one call: creates enemy NPCs and starts combat with all participants (enemies + players at location). Returns the ready-to-play combat state.",
      inputSchema: {
        gameId: z.string().describe("The game ID"),
        locationId: z.string().describe("Location where combat takes place"),
        enemies: z
          .array(
            z.object({
              name: z.string().min(1).max(LIMITS.NAME_MAX).describe("Enemy name"),
              attributes: z.record(z.string(), z.number()).optional(),
              status: z
                .object({
                  health: z.number().optional(),
                  maxHealth: z.number().optional(),
                })
                .optional(),
            })
          )
          .min(1)
          .max(10)
          .describe("Enemies to create and add to combat"),
        includePlayersAtLocation: z
          .boolean()
          .default(true)
          .describe("Auto-add player characters at this location"),
      },
      annotations: ANNOTATIONS.CREATE,
    },
    async ({ gameId, locationId, enemies, includePlayersAtLocation = true }) => {
      // 1. Create enemy NPCs
      const createdEnemies: Character[] = [];
      for (const enemy of enemies) {
        const character = characterTools.createCharacter({
          gameId,
          name: enemy.name,
          isPlayer: false,
          attributes: enemy.attributes,
          status: enemy.status,
          locationId,
        });
        createdEnemies.push(character);
      }

      // 2. Get players at location if needed
      const participantIds: string[] = [...createdEnemies.map((e) => e.id)];

      if (includePlayersAtLocation) {
        const playersAtLocation = characterTools.listCharacters(gameId, {
          isPlayer: true,
          locationId,
        });
        participantIds.push(...playersAtLocation.map((p) => p.id));
      }

      // 3. Start combat with all participants
      const combat = combatTools.startCombat({
        gameId,
        locationId,
        participantIds,
      });

      // 4. Log the encounter start
      narrativeTools.logEvent({
        gameId,
        eventType: "combat",
        content: `Combat begins! ${createdEnemies.length} enemies attack.`,
        metadata: {
          enemyIds: createdEnemies.map((e) => e.id),
          locationId,
        },
      });

      const result = {
        combat,
        createdEnemies: createdEnemies.map((e) => ({ id: e.id, name: e.name })),
        participantCount: participantIds.length,
        summary: `Combat started with ${participantIds.length} participants. ${createdEnemies.length} enemies created.`,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );
}
