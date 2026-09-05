import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getDisplayConfig,
  setDisplayConfig,
  resetDisplayConfig,
  applyThemePreset,
  listThemePresets,
  getGameDisplayConfig,
  setGameDisplayConfig,
  applyGameThemePreset,
  resetGameTheme,
  inferAndApplyTheme,
} from "../tools/display.js";
import { ANNOTATIONS } from "../utils/tool-annotations.js";
import { validatedSchemas } from "../utils/validation.js";

// All available theme presets
const themePresetNames = [
  "high-fantasy",
  "dark-fantasy",
  "sci-fi",
  "cyberpunk",
  "western",
  "noir",
  "cosmic-horror",
  "steampunk",
  "post-apocalyptic",
  "pirate",
  "modern",
  "superhero",
] as const;

export function registerDisplayTools(server: McpServer): void {
  // Get display configuration
  server.registerTool(
    "get_display_config",
    {
      description: "Get the current display configuration for the web viewer (colors, fonts, visibility options)",
      inputSchema: {},
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async () => {
      const config = getDisplayConfig();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(config, null, 2),
          },
        ],
      };
    }
  );

  // Set display configuration (full or partial)
  server.registerTool(
    "set_display_config",
    {
      description: "Set display configuration for the web viewer. Can set any subset of options.",
      inputSchema: {
        bgColor: validatedSchemas.token.optional().describe("Background color (e.g., '#1a1a2e')"),
        bgSecondary: validatedSchemas.token.optional().describe("Secondary background color"),
        bgElevated: validatedSchemas.token.optional().describe("Elevated surface background"),
        textColor: validatedSchemas.token.optional().describe("Main text color"),
        textMuted: validatedSchemas.token.optional().describe("Muted text color"),
        accentColor: validatedSchemas.token.optional().describe("Accent color for links and highlights"),
        accentHover: validatedSchemas.token.optional().describe("Accent color on hover"),
        borderColor: validatedSchemas.token.optional().describe("Border color"),
        successColor: validatedSchemas.token.optional().describe("Success/positive color"),
        warningColor: validatedSchemas.token.optional().describe("Warning/caution color"),
        dangerColor: validatedSchemas.token.optional().describe("Danger/error color"),
        codeBackground: validatedSchemas.token.optional().describe("Code/monospace block background"),
        codeText: validatedSchemas.token.optional().describe("Code/monospace text color"),
        borderRadius: z
          .enum(["sharp", "rounded", "soft"])
          .optional()
          .describe("Border radius style: sharp (0px), rounded (12px), soft (24px)"),
        cardStyle: z
          .enum(["clean", "grungy", "tech", "parchment", "metallic", "wooden"])
          .optional()
          .describe("Card visual style"),
        fontDisplay: validatedSchemas.token.optional().describe("Display/heading font (Google Font name)"),
        fontBody: validatedSchemas.token.optional().describe("Body text font (Google Font name)"),
        fontMono: validatedSchemas.token.optional().describe("Monospace font (Google Font name)"),
        showHealthBars: z.boolean().optional().describe("Show health bars on character cards"),
        showConditionTags: z.boolean().optional().describe("Show condition tags"),
        showImages: z.boolean().optional().describe("Show images in the viewer"),
        appTitle: validatedSchemas.token.optional().describe("Custom title for the web viewer"),
      },
      annotations: ANNOTATIONS.SET,
    },
    async (args) => {
      const config = setDisplayConfig(args);
      return {
        content: [
          {
            type: "text",
            text: `Display configuration updated:\n${JSON.stringify(config, null, 2)}`,
          },
        ],
      };
    }
  );

  // Reset display configuration
  server.registerTool(
    "reset_display_config",
    {
      description: "Reset display configuration to defaults",
      inputSchema: {},
      annotations: ANNOTATIONS.SET,
    },
    async () => {
      const config = resetDisplayConfig();
      return {
        content: [
          {
            type: "text",
            text: `Display configuration reset to defaults:\n${JSON.stringify(config, null, 2)}`,
          },
        ],
      };
    }
  );

  // Apply theme preset (global)
  server.registerTool(
    "apply_theme_preset",
    {
      description: "Apply a predefined theme preset globally. Available presets include genre-specific themes with appropriate colors, fonts, and styles.",
      inputSchema: {
        preset: z
          .enum(themePresetNames)
          .describe("Theme preset name"),
      },
      annotations: ANNOTATIONS.SET,
    },
    async ({ preset }) => {
      const config = applyThemePreset(preset);
      if (!config) {
        return {
          content: [{ type: "text", text: `Unknown preset: ${preset}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Applied '${preset}' theme preset:\n${JSON.stringify(config, null, 2)}`,
          },
        ],
      };
    }
  );

  // List theme presets
  server.registerTool(
    "list_theme_presets",
    {
      description: "List all available theme presets with their colors and styles",
      inputSchema: {},
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async () => {
      const presets = listThemePresets();
      return {
        content: [
          {
            type: "text",
            text: `Available theme presets:\n${JSON.stringify(presets, null, 2)}`,
          },
        ],
      };
    }
  );

  // ============================================
  // Per-Game Theme Tools
  // ============================================

  // Get game theme
  server.registerTool(
    "get_game_theme",
    {
      description: "Get the display configuration for a specific game",
      inputSchema: {
        gameId: validatedSchemas.id.describe("The game ID"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId }) => {
      const config = getGameDisplayConfig(gameId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(config, null, 2),
          },
        ],
      };
    }
  );

  // Set game theme
  server.registerTool(
    "set_game_theme",
    {
      description: "Set display configuration for a specific game. Each game can have its own visual theme.",
      inputSchema: {
        gameId: validatedSchemas.id.describe("The game ID"),
        bgColor: validatedSchemas.token.optional().describe("Background color"),
        bgSecondary: validatedSchemas.token.optional().describe("Secondary background"),
        bgElevated: validatedSchemas.token.optional().describe("Elevated surface background"),
        textColor: validatedSchemas.token.optional().describe("Text color"),
        textMuted: validatedSchemas.token.optional().describe("Muted text"),
        accentColor: validatedSchemas.token.optional().describe("Accent color"),
        accentHover: validatedSchemas.token.optional().describe("Accent hover color"),
        borderColor: validatedSchemas.token.optional().describe("Border color"),
        successColor: validatedSchemas.token.optional().describe("Success color"),
        warningColor: validatedSchemas.token.optional().describe("Warning color"),
        dangerColor: validatedSchemas.token.optional().describe("Danger color"),
        codeBackground: validatedSchemas.token.optional().describe("Code block background"),
        codeText: validatedSchemas.token.optional().describe("Code text color"),
        borderRadius: z.enum(["sharp", "rounded", "soft"]).optional().describe("Border radius style"),
        cardStyle: z.enum(["clean", "grungy", "tech", "parchment", "metallic", "wooden"]).optional().describe("Card style"),
        fontDisplay: validatedSchemas.token.optional().describe("Display font"),
        fontBody: validatedSchemas.token.optional().describe("Body font"),
        fontMono: validatedSchemas.token.optional().describe("Mono font"),
        showHealthBars: z.boolean().optional().describe("Show health bars"),
        showConditionTags: z.boolean().optional().describe("Show condition tags"),
        showImages: z.boolean().optional().describe("Show images"),
        appTitle: validatedSchemas.token.optional().describe("App title"),
      },
      annotations: ANNOTATIONS.SET,
    },
    async ({ gameId, ...config }) => {
      const updated = setGameDisplayConfig(gameId, config);
      return {
        content: [
          {
            type: "text",
            text: `Game theme updated for ${gameId}:\n${JSON.stringify(updated, null, 2)}`,
          },
        ],
      };
    }
  );

  // Apply preset to game
  server.registerTool(
    "apply_game_theme_preset",
    {
      description: "Apply a predefined theme preset to a specific game. This allows different games to have completely different visual themes.",
      inputSchema: {
        gameId: validatedSchemas.id.describe("The game ID"),
        preset: z.enum(themePresetNames).describe("Theme preset name"),
      },
      annotations: ANNOTATIONS.SET,
    },
    async ({ gameId, preset }) => {
      const config = applyGameThemePreset(gameId, preset);
      if (!config) {
        return {
          content: [{ type: "text", text: `Unknown preset: ${preset}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Applied '${preset}' theme to game ${gameId}:\n${JSON.stringify(config, null, 2)}`,
          },
        ],
      };
    }
  );

  // Reset game theme
  server.registerTool(
    "reset_game_theme",
    {
      description: "Remove a game's custom theme, reverting to the global theme",
      inputSchema: {
        gameId: validatedSchemas.id.describe("The game ID"),
      },
      annotations: ANNOTATIONS.SET,
    },
    async ({ gameId }) => {
      resetGameTheme(gameId);
      return {
        content: [
          {
            type: "text",
            text: `Game theme reset. Game ${gameId} will now use the global theme.`,
          },
        ],
      };
    }
  );

  // Auto-apply theme based on genre
  server.registerTool(
    "auto_theme_game",
    {
      description: "Automatically apply an appropriate theme to a game based on its genre and setting. Call this when creating a new game to set up the visual style.",
      inputSchema: {
        gameId: validatedSchemas.id.describe("The game ID"),
        genre: validatedSchemas.token.describe("Game genre (e.g., 'fantasy', 'sci-fi', 'western', 'noir')"),
        setting: validatedSchemas.description.optional().describe("Optional setting description for more accurate theme matching"),
      },
      annotations: ANNOTATIONS.SET,
    },
    async ({ gameId, genre, setting }) => {
      const config = inferAndApplyTheme(gameId, genre, setting);
      return {
        content: [
          {
            type: "text",
            text: `Auto-themed game ${gameId} based on genre "${genre}":\n${JSON.stringify(config, null, 2)}`,
          },
        ],
      };
    }
  );
}
