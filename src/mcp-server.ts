// The CORE MCP server, built but not started.
//
// This module exists so that "which tools does this engine serve" is separable
// from "and now go listen on stdio and bind a port". Constructing the server
// opens no database, binds no port and connects no transport; a caller decides
// all three. src/bin/run-dmcp.ts is the caller that decides them the way an
// application would.
//
// This is the CORE half of design §8's split (issue #17): entities, facts,
// events, the timeline, resource/relationship/faction/secret/location/item
// concepts, and the resolve/render/timeline surfaces that sit on top of them.
// Dice, combat, abilities, status effects, random tables and quests are
// genuinely game-shaped and live one layer up, in src/rpg/index.ts, which
// calls `registerRpgTools(server)` on a server this file already built.
// `createMcpServer` (the full assembly, unchanged in name and behaviour from
// before the split) lives there too now, not here -- this file only knows
// how to build the core.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Import registration functions
import { registerCoreTools } from "./register/core.js";
import { registerWorldTools } from "./register/world.js";
import { registerCharacterTools } from "./register/character.js";
import { registerInventoryTools } from "./register/inventory.js";
import { registerNarrativeTools } from "./register/narrative.js";
import { registerResourceTools } from "./register/resources.js";
import { registerTimeTools } from "./register/time.js";
import { registerSecretTools } from "./register/secrets.js";
import { registerRelationshipTools } from "./register/relationships.js";
import { registerTagTools } from "./register/tags.js";
import { registerFactionTools } from "./register/factions.js";
import { registerNoteTools } from "./register/notes.js";
import { registerPauseTools } from "./register/pause.js";
import { registerImageTools } from "./register/images.js";
import { registerAudioTools } from "./register/audio.js";
import { registerDisplayTools } from "./register/display.js";
import { registerBatchTools } from "./register/batch.js";
import { registerMcpResources } from "./register/mcp-resources.js";
import { registerTimelineTools } from "./register/timeline.js";
import { registerResolveTools } from "./register/resolve.js";
import { registerRenderTools } from "./register/render.js";
import { createResolver, type Mechanic } from "./timeline/resolve.js";
import { createStateRenderer, type RenderVocabulary } from "./timeline/render.js";

export const SERVER_NAME = "dmcp";
export const SERVER_VERSION = "0.2.0";

/**
 * Build an MCP server with every CORE tool, resource and prompt this engine
 * serves -- entities, facts, events, the timeline, and the entity/property
 * domains (resources, relationships, factions, secrets, locations, items)
 * design §8 keeps out of the RPG layer because a consumer that lost them
 * would have to drag that layer back in to get them. No dice, no combat, no
 * abilities, no status effects, no random tables, no quests, and no
 * game-master prompt library -- those are `registerRpgTools` in
 * src/rpg/index.ts, which calls this function first and adds its layer on
 * top of what it returns. `createMcpServer` there is the full assembly this
 * function used to be, under the same name, with the same behaviour, so
 * nothing that already depends on the full server sees any difference.
 *
 * The returned server is not connected to anything. Connect it to a transport
 * yourself, and call `initializeSchema()` before serving a request -- both are
 * the caller's to decide, and neither happens on import.
 *
 * `mechanics` (design §5.2a, issue #10) is injection at construction, the
 * same way `initializeSchema({ migrations })` (src/db/schema.ts) is -- there
 * is no global resolver anywhere in this codebase, only the one a caller
 * builds by passing its mechanics here. Every existing zero-argument call
 * site (src/bin/run-dmcp.ts, via src/rpg/index.ts) keeps working unchanged:
 * `options` and `options.mechanics` are both optional, and calling
 * `createCoreMcpServer()` with nothing at all registers every core tool this
 * engine serves and no resolve surface. That absence is deliberate, not an
 * oversight -- an engine with no mechanics registered has nothing a
 * `resolve` tool could ever dispatch, so it gets no `resolve`/`list_mechanics`
 * tools rather than a pair that could only ever answer "unknown-mechanic"
 * and "[]".
 *
 * `vocabulary` (design §7, issue #16) is injected the same way and for the
 * same reason -- and here the injection is not merely a style choice, it is
 * the design's own line: the state-to-text projection's MECHANISM is core,
 * and the NOUNS it may emit belong to each caller. A vocabulary rich enough
 * to render a real world would fail this engine's vocabulary hygiene test on
 * day one, correctly, so this package ships none and there is no default to
 * fall back to. An engine with no vocabulary injected has nothing it could
 * name, so it registers no `render_state_at` tool at all -- the identical
 * shape (and the identical silence) as `mechanics` above.
 */
export function createCoreMcpServer(options?: {
  mechanics?: readonly Mechanic[];
  vocabulary?: RenderVocabulary;
}): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Register all core tools by domain
  registerCoreTools(server);           // Game, Interview, Rules
  registerWorldTools(server);          // Locations, Connections, Map
  registerCharacterTools(server);      // Characters (PC/NPC)
  registerInventoryTools(server);      // Items
  registerNarrativeTools(server);      // Events, History, Export, Player Choices
  registerResourceTools(server);       // Custom Resources
  registerTimeTools(server);           // Calendar, Time, Timers
  registerSecretTools(server);         // Secrets, Knowledge
  registerRelationshipTools(server);   // Relationships
  registerTagTools(server);            // Tags
  registerFactionTools(server);        // Factions
  registerNoteTools(server);           // Game Notes
  registerPauseTools(server);          // Pause/Resume, Context Snapshots, External Updates
  registerImageTools(server);          // Stored Images
  registerAudioTools(server);          // Stored Audio (TTS, Voice References)
  registerDisplayTools(server);        // Display/Theme Configuration
  registerBatchTools(server);          // Batch Operations (multi-entity, workflows -- entity/property only)
  registerTimelineTools(server);       // replay(t), story-time axis declaration

  const mechanics = options?.mechanics;
  if (mechanics && mechanics.length > 0) {
    const resolver = createResolver({ mechanics });
    registerResolveTools(server, resolver); // resolve(), list_mechanics -- only when mechanics are registered
  }

  const vocabulary = options?.vocabulary;
  if (vocabulary) {
    // Built here rather than accepted pre-built so the vocabulary is
    // validated at construction of the SERVER too, not merely at
    // construction of a renderer a caller might have made anywhere:
    // `createStateRenderer` throws on a malformed vocabulary, so a server
    // that would have served an unnameable projection never comes up.
    registerRenderTools(server, createStateRenderer({ vocabulary })); // render_state_at -- only when a vocabulary is injected
  }

  // Register core MCP Resources (RPG resources -- game-quests, quest -- are
  // registered by registerRpgMcpResources, one layer up)
  registerMcpResources(server);        // Read-only data access via URI

  return server;
}
