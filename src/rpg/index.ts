// The RPG layer's entry point (design §8, issue #17): dice, combat,
// abilities, status effects, random tables, quests, and the game-master
// prompt library that assumes them -- genuinely game-shaped mechanism, an
// OPTIONAL dependency for a consumer that wants it, and no part of the core.
//
// A consumer that only needs entities/facts/events/replay imports "run-dmcp"
// and gets `createCoreMcpServer`, nothing here. A consumer that wants the
// full tabletop surface imports "run-dmcp/rpg" and gets `createMcpServer`
// below -- the same name and the same options the full assembly has always
// had, so reaching it is a changed import path and nothing else.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCoreMcpServer } from "../mcp-server.js";
import type { Mechanic } from "../timeline/resolve.js";
import type { RenderVocabulary } from "../timeline/render.js";

import { registerCombatTools } from "./register/combat.js";
import { registerAbilityTools } from "./register/abilities.js";
import { registerStatusTools } from "./register/status.js";
import { registerTableTools } from "./register/tables.js";
import { registerQuestTools } from "./register/quests.js";
import { registerRpgBatchTools } from "./register/batch.js";
import { registerRpgMcpResources } from "./register/mcp-resources.js";
import { registerMcpPrompts } from "./register/mcp-prompts.js";

/**
 * Register every RPG-layer tool, resource and prompt onto an existing
 * server. Combat brings dice with it (registerCombatTools registers both,
 * matching how the pre-split assembly registered them as one domain).
 */
export function registerRpgTools(server: McpServer): void {
  registerCombatTools(server);         // Combat, Dice, Checks
  registerQuestTools(server);          // Quests, Objectives
  registerTableTools(server);          // Random Tables
  registerStatusTools(server);         // Status Effects
  registerAbilityTools(server);        // Abilities/Powers
  registerRpgBatchTools(server);       // setup_combat_encounter
  registerRpgMcpResources(server);     // game-quests, quest
  registerMcpPrompts(server);          // Reusable prompt templates (game-master session library)
}

/**
 * Build the FULL assembly: every core tool plus every RPG tool, resource and
 * prompt this engine has always served. Same name, same `{ mechanics?,
 * vocabulary? }` options as the pre-split `createMcpServer` in
 * src/mcp-server.ts -- this is that function, now composed from two layers
 * instead of one, so src/bin/run-dmcp.ts's zero-argument call site keeps
 * working unchanged and the registered tool/resource/prompt set is
 * unchanged too (src/__tests__/layerBoundary.test.ts asserts this exactly).
 */
export function createMcpServer(options?: {
  mechanics?: readonly Mechanic[];
  vocabulary?: RenderVocabulary;
}): McpServer {
  const server = createCoreMcpServer(options);
  registerRpgTools(server);
  return server;
}

// The web UI. An application opts into serving it; importing this never
// does. It lives on disk at src/http/server.ts, not under src/rpg/ -- it
// imports RPG tools (quest/ability/combat), which is why it cannot be
// reachable from the core entry point, but its CLIENT_DIST path resolution
// is depth-sensitive in both src/ and compiled dist/, so it stays put and
// only its EXPORT moves up to this layer.
export { createHttpServer, startHttpServer } from "../http/server.js";

// The RPG tool modules, exported as library functions -- the same shape
// core's index.ts uses for the timeline (replay, changesWithin, and so on):
// a consumer that wants to call combat/quest/table/status/ability/dice logic
// directly, without going through an MCP tool call, can.
export * from "./tools/dice.js";
export * from "./tools/combat.js";
export * from "./tools/ability.js";
export * from "./tools/status.js";
export * from "./tools/tables.js";
export * from "./tools/quest.js";
