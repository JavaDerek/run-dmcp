import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as audioTools from "../tools/audio.js";
import { LIMITS } from "../utils/validation.js";
import { ANNOTATIONS } from "../utils/tool-annotations.js";

export function registerAudioTools(server: McpServer) {
  server.registerTool(
    "store_audio",
    {
      description:
        "Store an audio file for an entity. Provide either a URL to fetch from or a local file path. Useful for TTS-generated narration, character dialogue, or voice reference clips for voice cloning.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        entityId: z
          .string()
          .max(100)
          .describe("ID of the entity (character, location, game, scene, etc.)"),
        entityType: z
          .string()
          .max(50)
          .describe(
            "Type of entity (e.g., character, location, game, scene, narration, dialogue)"
          ),
        url: z
          .string()
          .max(2000)
          .optional()
          .describe("URL to fetch the audio from (provide url OR filePath)"),
        filePath: z
          .string()
          .max(1000)
          .optional()
          .describe("Local file path to copy from (provide url OR filePath)"),
        label: z
          .string()
          .max(LIMITS.NAME_MAX)
          .optional()
          .describe("Label for the audio (e.g., 'Greeting', 'Battle Cry', 'Voice Sample')"),
        description: z
          .string()
          .max(LIMITS.DESCRIPTION_MAX)
          .optional()
          .describe("Description of the audio content"),
        mimeType: z
          .string()
          .max(100)
          .optional()
          .describe("MIME type (e.g., 'audio/mp3'). Inferred if not provided."),
        ttsEngine: z
          .string()
          .max(100)
          .optional()
          .describe(
            "TTS engine used to generate (e.g., 'maya1', 'chatterbox', 'kokoro', 'xtts', 'mira', 'cosyvoice')"
          ),
        ttsVoice: z
          .string()
          .max(200)
          .optional()
          .describe("Voice name/ID used for TTS generation"),
        ttsText: z
          .string()
          .max(LIMITS.CONTENT_MAX)
          .optional()
          .describe("The text that was synthesized (for TTS audio)"),
        ttsSettings: z
          .record(z.unknown())
          .optional()
          .describe("Engine-specific TTS settings (temperature, exaggeration, etc.)"),
        isVoiceReference: z
          .boolean()
          .optional()
          .describe(
            "Mark this as a voice reference clip for voice cloning. These clips can be used as reference audio for TTS engines that support voice cloning."
          ),
        voiceName: z
          .string()
          .max(LIMITS.NAME_MAX)
          .optional()
          .describe("Name for this voice (for voice cloning reference clips)"),
        voiceDescription: z
          .string()
          .max(LIMITS.DESCRIPTION_MAX)
          .optional()
          .describe(
            "Description of voice characteristics (accent, tone, pitch, etc.) for voice cloning"
          ),
        setAsPrimary: z
          .boolean()
          .optional()
          .describe("Set this as the primary audio for the entity"),
      },
      annotations: ANNOTATIONS.EXTERNAL,
    },
    async (params) => {
      try {
        if (!params.url && !params.filePath) {
          return {
            content: [
              { type: "text", text: "Error: Either url or filePath must be provided" },
            ],
            isError: true,
          };
        }
        const audio = await audioTools.storeAudio(params);
        return {
          content: [{ type: "text", text: JSON.stringify(audio, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error storing audio: ${error}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_audio",
    {
      description: "Get audio file metadata by ID",
      inputSchema: {
        audioId: z.string().max(100).describe("The audio ID"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ audioId }) => {
      const audio = audioTools.getAudio(audioId);
      if (!audio) {
        return {
          content: [{ type: "text", text: "Audio not found" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(audio, null, 2) }],
      };
    }
  );

  server.registerTool(
    "get_audio_file_path",
    {
      description:
        "Get the full local file path for an audio file. Useful when you need to pass the audio file to another tool (like TTS voice cloning).",
      inputSchema: {
        audioId: z.string().max(100).describe("The audio ID"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ audioId }) => {
      const filePath = audioTools.getAudioFilePath(audioId);
      if (!filePath) {
        return {
          content: [{ type: "text", text: "Audio file not found" }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ audioId, filePath }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_audio_data",
    {
      description: "Get audio with base64 data included (for playback or processing)",
      inputSchema: {
        audioId: z.string().max(100).describe("The audio ID"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ audioId }) => {
      const result = audioTools.getAudioData(audioId);
      if (!result) {
        return {
          content: [{ type: "text", text: "Audio not found" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "list_entity_audio",
    {
      description: "List all audio files for an entity",
      inputSchema: {
        entityId: z.string().max(100).describe("ID of the entity"),
        entityType: z
          .string()
          .max(50)
          .describe("Type of entity (e.g., character, location, game, scene)"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ entityId, entityType }) => {
      const result = audioTools.listEntityAudio(entityId, entityType);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "list_game_audio",
    {
      description: "List all audio files in a game",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId }) => {
      const audioFiles = audioTools.listGameAudio(gameId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { gameId, count: audioFiles.length, audioFiles },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "list_voice_references",
    {
      description:
        "List voice reference clips for voice cloning. These are audio samples that can be used as reference audio for TTS engines that support voice cloning (like Chatterbox, XTTS, CosyVoice).",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        characterId: z
          .string()
          .max(100)
          .optional()
          .describe("Filter by character ID (optional, returns all if not specified)"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, characterId }) => {
      const voiceRefs = audioTools.listVoiceReferences(gameId, characterId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                gameId,
                characterId: characterId || "all",
                count: voiceRefs.length,
                voiceReferences: voiceRefs,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_character_voice_references",
    {
      description:
        "Get all voice reference clips for a specific character, along with character info. Returns file paths ready to use with voice cloning TTS engines.",
      inputSchema: {
        gameId: z.string().max(100).describe("The game ID"),
        characterId: z.string().max(100).describe("The character ID"),
      },
      annotations: ANNOTATIONS.READ_ONLY,
    },
    async ({ gameId, characterId }) => {
      const result = audioTools.getCharacterVoiceReferences(gameId, characterId);
      if (!result) {
        return {
          content: [{ type: "text", text: "Character not found" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.registerTool(
    "delete_audio",
    {
      description: "Delete a stored audio file (removes file and database record)",
      inputSchema: {
        audioId: z.string().max(100).describe("The audio ID"),
      },
      annotations: ANNOTATIONS.DESTRUCTIVE,
    },
    async ({ audioId }) => {
      const success = audioTools.deleteAudio(audioId);
      return {
        content: [
          { type: "text", text: success ? "Audio deleted" : "Audio not found" },
        ],
        isError: !success,
      };
    }
  );

  server.registerTool(
    "set_primary_audio",
    {
      description: "Set an audio file as the primary audio for its entity",
      inputSchema: {
        audioId: z.string().max(100).describe("The audio ID to set as primary"),
      },
      annotations: ANNOTATIONS.UPDATE,
    },
    async ({ audioId }) => {
      const audio = audioTools.setPrimaryAudio(audioId);
      if (!audio) {
        return {
          content: [{ type: "text", text: "Audio not found" }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(audio, null, 2) }],
      };
    }
  );

  server.registerTool(
    "update_audio_metadata",
    {
      description:
        "Update metadata for an audio file (label, description, voice reference info)",
      inputSchema: {
        audioId: z.string().max(100).describe("The audio ID"),
        label: z.string().max(LIMITS.NAME_MAX).optional().describe("New label"),
        description: z
          .string()
          .max(LIMITS.DESCRIPTION_MAX)
          .optional()
          .describe("New description"),
        ttsText: z
          .string()
          .max(LIMITS.CONTENT_MAX)
          .optional()
          .describe("Update the TTS text transcript"),
        voiceName: z
          .string()
          .max(LIMITS.NAME_MAX)
          .optional()
          .describe("New voice name (for voice references)"),
        voiceDescription: z
          .string()
          .max(LIMITS.DESCRIPTION_MAX)
          .optional()
          .describe("New voice description (for voice references)"),
        isVoiceReference: z
          .boolean()
          .optional()
          .describe("Mark/unmark as voice reference clip"),
      },
      annotations: ANNOTATIONS.UPDATE,
    },
    async ({ audioId, ...updates }) => {
      try {
        const audio = audioTools.updateAudioMetadata(audioId, updates);
        if (!audio) {
          return {
            content: [{ type: "text", text: "Audio not found" }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(audio, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error updating audio: ${error}` }],
          isError: true,
        };
      }
    }
  );
}
