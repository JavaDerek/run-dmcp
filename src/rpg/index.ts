// The RPG layer's entry point (design §8, issue #17): dice, combat,
// abilities, status effects, random tables, quests, and the game-master
// prompt library that assumes them -- genuinely game-shaped mechanism, an
// OPTIONAL dependency for a consumer that wants it, and no part of the core.
//
// A consumer that only needs entities/facts/events/replay imports "run-dmcp",
// nothing here. A consumer that wants the full tabletop surface ASSEMBLED as
// a server imports "run-dmcp/rpg/server" and gets `createMcpServer` -- the
// same name and the same options the full assembly has always had.
//
// This entry is the layer's MECHANISM: the tool functions, and
// `registerRpgTools` for putting them on a server somebody else built.
// Neither needs the core assembly, and since 0.4.0 neither loads it --
// `import * as combatTools from "run-dmcp/rpg"` used to pull in
// src/mcp-server.ts and express with it, 123.6ms against 87.5ms without,
// cold, per process. src/__tests__/assemblyBoundary.test.ts holds that line.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

// `createMcpServer` and the web UI are NOT here. Both are assembly, and both
// moved to "run-dmcp/rpg/server" (src/rpg/server.ts) so that importing the
// layer's tool functions stops loading a server and an HTTP framework with
// them.

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
