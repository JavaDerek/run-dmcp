// The core does not depend on the RPG layer above it (design §8, issue #17).
//
// Splitting dice/combat/abilities/status-effects/random-tables/quests out of
// the core is only real if a consumer that imports "run-dmcp" (src/index.ts)
// can never pull any of that back in transitively. A doc comment saying so
// is not evidence; the predecessor's own history is why -- `resource_history`
// and `relationship_history` existed as an unenforced INTENTION for the life
// of that project. So this file makes the boundary a fact about the actual
// import graph, checked on every run, the same way engineVocabulary.test.ts
// makes "no client's vocabulary reaches the engine" a fact about the actual
// tracked and untracked files rather than a convention.
//
// Three things are asserted here:
//
//   (a) STRUCTURAL: walking the static import graph from src/index.ts never
//       reaches anything under src/rpg/, and never reaches any of the six
//       tool modules that moved there. This is a literal check over import
//       SYNTAX this codebase wrote -- `from "<specifier>"` after `import` or
//       `export`, `type` or not -- never an attempt to read meaning out of
//       it (root CLAUDE.md hard rule 4).
//   (b) GOLDEN SURFACE: the post-split, fully assembled server
//       (`createMcpServer` from src/rpg/index.ts) registers EXACTLY the same
//       218 tools, 1 resource, 11 resource templates and 7 prompts as the
//       pre-split server did at the commit before this split began. That
//       snapshot was captured by running the OLD src/mcp-server.ts directly,
//       before any file in this split moved, and is checked in below as a
//       constant -- proof the refactor is behaviour-preserving, not a claim
//       about it.
//   (c) PARTITION: `createCoreMcpServer()`'s names and the RPG layer's OWN
//       names (registered onto a bare server, independent of core) are
//       disjoint, and their union is exactly the golden full-assembly set --
//       so a tool cannot be silently dropped in the split, and cannot be
//       silently registered twice (which the disjointness check would catch
//       even though the union check alone could not, if the MCP SDK ever
//       tolerated a duplicate registerTool call overwriting the first).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCoreMcpServer } from "../mcp-server.js";
import { registerRpgTools } from "../rpg/index.js";
// The full assembly moved to its own entry so that importing the layer's
// tool functions stops loading a server (src/__tests__/assemblyBoundary.test.ts).
// The golden-surface checks below are unaffected: same function, same options,
// same registered set -- which is exactly what they exist to prove.
import { createMcpServer as createFullMcpServer } from "../rpg/server.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const ENTRY = join(SRC_ROOT, "index.ts");

// ============================================================================
// (a) STRUCTURAL GUARD -- the static import graph from src/index.ts
// ============================================================================

/**
 * Every `from "<specifier>"` tail in the file, relative specifiers only.
 * `import ... from`, `import type ... from`, `export ... from`, and
 * `export type ... from` all end in the same `from "<specifier>"` shape, so
 * one pattern over the text catches all four without needing to parse a
 * real AST -- this is a check over syntax this codebase wrote, not an
 * attempt to understand what the code means.
 */
const FROM_SPECIFIER = /\bfrom\s+["'](\.[^"']+)["']/g;

function importSpecifiers(filePath: string): string[] {
  const contents = readFileSync(filePath, "utf8");
  const specifiers: string[] = [];
  let match: RegExpExecArray | null;
  FROM_SPECIFIER.lastIndex = 0;
  while ((match = FROM_SPECIFIER.exec(contents))) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/** A relative specifier as this codebase writes it (`./foo.js`, `../bar/baz.js`) always names the `.ts` file it compiles from -- NodeNext moduleResolution requires the `.js` extension in source even though the file on disk is `.ts`. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  const withoutExt = specifier.replace(/\.js$/, "");
  return resolve(dirname(fromFile), `${withoutExt}.ts`);
}

interface WalkResult {
  files: Set<string>;
  /** child absolute path -> the file whose import first reached it, for reconstructing a chain. */
  parent: Map<string, string>;
}

function walk(entry: string): WalkResult {
  const files = new Set<string>();
  const parent = new Map<string, string>();
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || files.has(current)) continue;
    if (!existsSync(current)) {
      const via = parent.get(current);
      const suffix = via ? ` (imported from ${relative(REPO_ROOT, via)})` : "";
      throw new Error(`import graph resolved to a file that does not exist on disk: ${current}${suffix}`);
    }
    files.add(current);
    for (const specifier of importSpecifiers(current)) {
      const resolved = resolveSpecifier(current, specifier);
      if (!files.has(resolved) && !parent.has(resolved)) {
        parent.set(resolved, current);
        queue.push(resolved);
      }
    }
  }

  return { files, parent };
}

function relPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

/** Reconstruct the import chain from the entry point down to `target`, for a failure message that NAMES the path rather than just flagging it. */
function chainTo(parent: Map<string, string>, target: string): string {
  const chain = [target];
  let current: string | undefined = target;
  while (current !== undefined) {
    const next: string | undefined = parent.get(current);
    if (next === undefined) break;
    chain.push(next);
    current = next;
  }
  return chain.reverse().map(relPath).join(" -> ");
}

describe("the RPG layer is not reachable from the core entry point (design §8, issue #17)", () => {
  const { files, parent } = walk(ENTRY);
  const reached = [...files].map(relPath);

  it("walks a meaningful number of files (guard against a vacuous pass)", () => {
    expect(reached.length).toBeGreaterThan(40);
  });

  it("never reaches anything under src/rpg/", () => {
    const offenders = [...files].filter((f) => relPath(f).startsWith("src/rpg/"));
    const detail = offenders.map((f) => `${relPath(f)}\n  reached via: ${chainTo(parent, f)}`).join("\n");
    expect(offenders, detail).toEqual([]);
  });

  it("never reaches any of the six RPG tool modules that moved out of src/tools/", () => {
    // Named explicitly rather than derived, so a future rename of the RPG
    // tools directory can't quietly make this assertion vacuous the way
    // "starts with src/rpg/" alone would if a moved file were left behind
    // at its old path instead of being git-mv'd.
    const movedModules = new Set([
      "src/tools/dice.ts",
      "src/tools/combat.ts",
      "src/tools/ability.ts",
      "src/tools/status.ts",
      "src/tools/tables.ts",
      "src/tools/quest.ts",
    ]);
    const offenders = [...files].filter((f) => movedModules.has(relPath(f)));
    const detail = offenders.map((f) => `${relPath(f)}\n  reached via: ${chainTo(parent, f)}`).join("\n");
    expect(offenders, detail).toEqual([]);
  });
});

// ============================================================================
// (b) GOLDEN SURFACE -- captured from the OLD src/mcp-server.ts, before any
// file in this split moved, by running:
//
//   npx tsx -e 'process.env.DMCP_DB_PATH=":memory:";const m=await
//   import("./src/mcp-server.ts");const s=m.createMcpServer();console.log(
//   JSON.stringify({tools:Object.keys(s._registeredTools??{}).sort(),
//   resources:Object.keys(s._registeredResources??{}).sort(),
//   resourceTemplates:Object.keys(s._registeredResourceTemplates??{}).sort(),
//   prompts:Object.keys(s._registeredPrompts??{}).sort()}))'
//
// This is the only place these four arrays are allowed to be hand-edited --
// everywhere else in this file, they are read, never written.
// ============================================================================

const GOLDEN_TOOLS = [
  "acknowledge_update",
  "add_clue",
  "add_combat_log",
  "advance_time",
  "apply_game_theme_preset",
  "apply_status_effect",
  "apply_theme_preset",
  "apply_update",
  "auto_theme_game",
  "batch_create_npcs",
  "build_image_prompt",
  "cancel_event",
  "changes_within",
  "check",
  "check_ability_requirements",
  "check_context_freshness",
  "check_knows_secret",
  "clear_pause_state",
  "clear_status_effects",
  "connect_locations",
  "contest",
  "create_ability",
  "create_character",
  "create_faction",
  "create_game",
  "create_image_generation_preset",
  "create_image_prompt_template",
  "create_item",
  "create_location",
  "create_note",
  "create_quest",
  "create_random_table",
  "create_relationship",
  "create_resource",
  "create_secret",
  "create_timer",
  "declare_fact_irreversible",
  "declare_resource_constraint",
  "declare_time_axis",
  "delete_ability",
  "delete_audio",
  "delete_character",
  "delete_external_update",
  "delete_faction",
  "delete_game",
  "delete_image",
  "delete_image_generation_preset",
  "delete_image_prompt_template",
  "delete_item",
  "delete_note",
  "delete_random_table",
  "delete_relationship",
  "delete_resource",
  "delete_secret",
  "delete_timer",
  "end_combat",
  "export_story",
  "export_timeline",
  "find_by_tag",
  "generate_recap",
  "get_ability",
  "get_active_combat",
  "get_audio",
  "get_audio_data",
  "get_audio_file_path",
  "get_chapter_for_export",
  "get_character",
  "get_character_by_name",
  "get_character_context",
  "get_character_knowledge",
  "get_character_voice_references",
  "get_combat",
  "get_default_image_preset",
  "get_display_config",
  "get_effective_modifiers",
  "get_entity_tags",
  "get_export_styles",
  "get_external_update",
  "get_faction",
  "get_game_menu",
  "get_game_preferences",
  "get_game_state",
  "get_game_theme",
  "get_history",
  "get_image",
  "get_image_data",
  "get_image_generation_preset",
  "get_image_prompt_template",
  "get_interview_template",
  "get_inventory",
  "get_item",
  "get_location",
  "get_location_by_name",
  "get_location_context",
  "get_note",
  "get_pause_state",
  "get_pending_updates",
  "get_quest",
  "get_random_table",
  "get_relationship",
  "get_relationship_between",
  "get_relationship_history",
  "get_resource",
  "get_resource_history",
  "get_resume_context",
  "get_rules",
  "get_secret",
  "get_status_effect",
  "get_story_time",
  "get_summary",
  "get_time",
  "get_timer",
  "import_timeline",
  "learn_ability",
  "list_abilities",
  "list_character_summaries",
  "list_characters",
  "list_entities_missing_images",
  "list_entity_audio",
  "list_entity_images",
  "list_external_updates",
  "list_factions",
  "list_game_audio",
  "list_games",
  "list_image_generation_presets",
  "list_image_prompt_templates",
  "list_irreversible_facts",
  "list_locations",
  "list_notes",
  "list_quests",
  "list_random_tables",
  "list_relationships",
  "list_resource_constraints",
  "list_resources",
  "list_scheduled_events",
  "list_secrets",
  "list_status_effects",
  "list_tags",
  "list_theme_presets",
  "list_timers",
  "list_voice_references",
  "load_game",
  "log_event",
  "modify_conditions",
  "modify_effect_stacks",
  "modify_faction_goals",
  "modify_faction_traits",
  "modify_health",
  "modify_note_tags",
  "modify_objectives",
  "modify_secret_visibility",
  "modify_table_entries",
  "modify_tags",
  "modify_timer",
  "move_character",
  "narration_constraint_at",
  "next_turn",
  "pin_note",
  "prepare_pause",
  "present_choices",
  "push_external_update",
  "record_choice",
  "reject_update",
  "remove_combatant",
  "remove_resource_constraint",
  "remove_status_effect",
  "rename_tag",
  "replay_world_at",
  "reset_display_config",
  "reset_game_theme",
  "roll",
  "roll_on_table",
  "save_context_snapshot",
  "save_game_preferences",
  "save_pause_state",
  "scene_transition",
  "schedule_event",
  "search_notes",
  "set_calendar",
  "set_default_image_preset",
  "set_display_config",
  "set_game_favicon",
  "set_game_theme",
  "set_game_title_image",
  "set_primary_audio",
  "set_primary_image",
  "set_rules",
  "set_story_time",
  "set_time",
  "setup_combat_encounter",
  "start_combat",
  "store_audio",
  "store_image",
  "tick_ability_cooldowns",
  "tick_status_durations",
  "transfer_item",
  "transfer_resource_value",
  "update_ability",
  "update_audio_metadata",
  "update_character",
  "update_faction",
  "update_faction_resource",
  "update_game",
  "update_image_generation_preset",
  "update_image_metadata",
  "update_image_prompt_template",
  "update_item",
  "update_location",
  "update_note",
  "update_quest",
  "update_random_table",
  "update_relationship_value",
  "update_resource",
  "update_resource_value",
  "update_rules",
  "update_secret",
  "update_timer",
  "use_ability",
];

const GOLDEN_RESOURCES = ["dmcp://games"];

const GOLDEN_RESOURCE_TEMPLATES = [
  "character",
  "game",
  "game-characters",
  "game-history",
  "game-locations",
  "game-map",
  "game-quests",
  "game-rules",
  "game-state",
  "location",
  "quest",
];

const GOLDEN_PROMPTS = [
  "character-voice",
  "continue-game",
  "dm-persona",
  "new-game-setup",
  "persistence-rules",
  "save-game-checklist",
  "session-recap",
];

/** The registered-name maps the MCP SDK keeps on a built server. */
interface Surface {
  tools: string[];
  resources: string[];
  resourceTemplates: string[];
  prompts: string[];
}

function surfaceOf(server: unknown): Surface {
  const s = server as {
    _registeredTools?: Record<string, unknown>;
    _registeredResources?: Record<string, unknown>;
    _registeredResourceTemplates?: Record<string, unknown>;
    _registeredPrompts?: Record<string, unknown>;
  };
  return {
    tools: Object.keys(s._registeredTools ?? {}).sort(),
    resources: Object.keys(s._registeredResources ?? {}).sort(),
    resourceTemplates: Object.keys(s._registeredResourceTemplates ?? {}).sort(),
    prompts: Object.keys(s._registeredPrompts ?? {}).sort(),
  };
}

describe("the golden surface: the split changed nothing an MCP client can observe", () => {
  const full = surfaceOf(createFullMcpServer());

  it("registers exactly 218 tools, 1 resource, 11 resource templates, 7 prompts", () => {
    expect(full.tools.length).toBe(218);
    expect(full.resources.length).toBe(1);
    expect(full.resourceTemplates.length).toBe(11);
    expect(full.prompts.length).toBe(7);
  });

  it("registers exactly the golden tool names -- none added, none dropped, none renamed", () => {
    expect(full.tools).toEqual(GOLDEN_TOOLS);
  });

  it("registers exactly the golden resource names", () => {
    expect(full.resources).toEqual(GOLDEN_RESOURCES);
  });

  it("registers exactly the golden resource template names", () => {
    expect(full.resourceTemplates).toEqual(GOLDEN_RESOURCE_TEMPLATES);
  });

  it("registers exactly the golden prompt names", () => {
    expect(full.prompts).toEqual(GOLDEN_PROMPTS);
  });
});

// ============================================================================
// (c) THE PARTITION -- core and the RPG layer's own registrations never
// overlap, and together they are exactly the golden full assembly.
// ============================================================================

describe("the partition: core and the RPG layer register disjoint sets that union to the full assembly", () => {
  const core = surfaceOf(createCoreMcpServer());

  // The RPG layer's OWN registrations, on a bare server that never saw
  // createCoreMcpServer -- not "full minus core", which would make the
  // disjointness check tautological. If registerRpgTools ever re-registered
  // a name core already owns, McpServer.registerTool throws on the SECOND
  // registerTool call for that name -- so building this independently is
  // also a check that no such collision exists within a single server
  // build, not only across the two.
  const rpgOnlyServer = new McpServer({ name: "layer-boundary-test-rpg-only", version: "0.0.0" });
  registerRpgTools(rpgOnlyServer);
  const rpgOnly = surfaceOf(rpgOnlyServer);

  function assertPartition(key: keyof Surface, golden: string[]) {
    const coreNames = core[key];
    const rpgNames = rpgOnly[key];

    const overlap = coreNames.filter((name) => rpgNames.includes(name));
    expect(overlap, `core and RPG both registered: ${overlap.join(", ")}`).toEqual([]);

    const union = [...new Set([...coreNames, ...rpgNames])].sort();
    expect(union).toEqual(golden);
  }

  it("tools: core and RPG-only are disjoint, and their union is the golden set", () => {
    assertPartition("tools", GOLDEN_TOOLS);
  });

  it("resources: core and RPG-only are disjoint, and their union is the golden set", () => {
    assertPartition("resources", GOLDEN_RESOURCES);
  });

  it("resource templates: core and RPG-only are disjoint, and their union is the golden set", () => {
    assertPartition("resourceTemplates", GOLDEN_RESOURCE_TEMPLATES);
  });

  it("prompts: core and RPG-only are disjoint, and their union is the golden set", () => {
    assertPartition("prompts", GOLDEN_PROMPTS);
  });
});
