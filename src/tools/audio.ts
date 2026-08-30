import { v4 as uuidv4 } from "uuid";
import { getDatabase, getDataDir, withTransaction } from "../db/connection.js";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  rmSync,
} from "fs";
import { dirname, join, extname } from "path";
import type {
  StoredAudio,
  StoreAudioParams,
  AudioListResult,
  VoiceReferenceResult,
} from "../types/index.js";
import { mediaDirPath, mediaFilePath, mediaPathWithin } from "../utils/media-path.js";
import { getCharacter } from "./character.js";
import { getLocation } from "./world.js";
import { getFaction } from "./faction.js";

// Use the same data directory as the database, but in an 'audio' subdirectory
function getAudioDir(): string {
  return join(getDataDir(), "audio");
}

// Helper: Validate entity exists and return its name
function validateEntityAndGetName(
  entityId: string,
  entityType: string
): string {
  let entity = null;
  switch (entityType) {
    case "character":
      entity = getCharacter(entityId);
      break;
    case "location":
      entity = getLocation(entityId);
      break;
    case "faction":
      entity = getFaction(entityId);
      break;
    default:
      // For other entity types (game, scene, narration, etc.), skip validation
      return entityType.charAt(0).toUpperCase() + entityType.slice(1);
  }
  if (!entity) {
    throw new Error(`${entityType} not found: ${entityId}`);
  }
  return (entity as { name: string }).name;
}

// Helper: Ensure directory exists
function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

// Helper: Get extension from mime type
function getExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/wave": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/aac": "aac",
    "audio/m4a": "m4a",
    "audio/mp4": "m4a",
    "audio/webm": "webm",
  };
  return map[mimeType] || "mp3";
}

// Helper: Get mime type from extension
function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    aac: "audio/aac",
    m4a: "audio/m4a",
    webm: "audio/webm",
  };
  return map[ext.toLowerCase().replace(".", "")] || "audio/mpeg";
}

// Helper: Map database row to StoredAudio
function mapRowToStoredAudio(row: Record<string, unknown>): StoredAudio {
  return {
    id: row.id as string,
    gameId: row.game_id as string,
    entityId: row.entity_id as string,
    entityType: row.entity_type as string,
    filePath: row.file_path as string,
    fileSize: row.file_size as number,
    mimeType: row.mime_type as string,
    durationMs: row.duration_ms as number | null,
    sampleRate: row.sample_rate as number | null,
    label: row.label as string | null,
    description: row.description as string | null,
    source: row.source as "generated" | "uploaded" | "url",
    sourceUrl: row.source_url as string | null,
    ttsEngine: row.tts_engine as string | null,
    ttsVoice: row.tts_voice as string | null,
    ttsText: row.tts_text as string | null,
    ttsSettings: row.tts_settings ? JSON.parse(row.tts_settings as string) : null,
    isVoiceReference: (row.is_voice_reference as number) === 1,
    voiceName: row.voice_name as string | null,
    voiceDescription: row.voice_description as string | null,
    isPrimary: (row.is_primary as number) === 1,
    createdAt: row.created_at as string,
  };
}

export async function storeAudio(params: StoreAudioParams): Promise<StoredAudio> {
  // Validate entity exists and get its name for confirmation
  const entityName = validateEntityAndGetName(params.entityId, params.entityType);

  const db = getDatabase();
  const id = uuidv4();
  const now = new Date().toISOString();

  let audioBuffer: Buffer;
  let mimeType: string;
  let source: "generated" | "uploaded" | "url";
  let sourceUrl: string | null = null;

  if (params.url) {
    // Fetch audio from URL
    const response = await fetch(params.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio: ${response.status}`);
    }
    audioBuffer = Buffer.from(await response.arrayBuffer());
    mimeType = response.headers.get("content-type") || params.mimeType || "audio/mpeg";
    source = params.ttsEngine ? "generated" : "url";
    sourceUrl = params.url;
  } else if (params.filePath) {
    // Copy from local file
    if (!existsSync(params.filePath)) {
      throw new Error(`File not found: ${params.filePath}`);
    }
    audioBuffer = readFileSync(params.filePath);
    const ext = extname(params.filePath).slice(1);
    mimeType = params.mimeType || getMimeType(ext);
    source = params.ttsEngine ? "generated" : "uploaded";
  } else {
    throw new Error("Either url or filePath must be provided");
  }

  // Build file path. Every segment below arrives from the caller, so the
  // composition goes through the media-path choke point, which rejects
  // anything that would land outside the audio directory.
  const ext = getExtension(mimeType);
  const { relativePath, fullPath } = mediaFilePath(
    getAudioDir(),
    [params.gameId, `${params.entityType}s`, params.entityId],
    `${id}.${ext}`
  );

  // Ensure directory exists and write file
  ensureDir(dirname(fullPath));
  writeFileSync(fullPath, audioBuffer);

  // If setting as primary, unset current primary first
  if (params.setAsPrimary) {
    db.prepare(
      `
      UPDATE stored_audio SET is_primary = 0
      WHERE entity_id = ? AND entity_type = ?
    `
    ).run(params.entityId, params.entityType);
  }

  // Insert database record
  const stmt = db.prepare(`
    INSERT INTO stored_audio (
      id, game_id, entity_id, entity_type, file_path, file_size, mime_type,
      duration_ms, sample_rate, label, description, source, source_url,
      tts_engine, tts_voice, tts_text, tts_settings,
      is_voice_reference, voice_name, voice_description,
      is_primary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.gameId,
    params.entityId,
    params.entityType,
    relativePath,
    audioBuffer.length,
    mimeType,
    null, // duration_ms - would need audio parsing library
    null, // sample_rate - would need audio parsing library
    params.label || null,
    params.description || null,
    source,
    sourceUrl,
    params.ttsEngine || null,
    params.ttsVoice || null,
    params.ttsText || null,
    params.ttsSettings ? JSON.stringify(params.ttsSettings) : null,
    params.isVoiceReference ? 1 : 0,
    params.voiceName || null,
    params.voiceDescription || null,
    params.setAsPrimary ? 1 : 0,
    now
  );

  return {
    id,
    gameId: params.gameId,
    entityId: params.entityId,
    entityType: params.entityType,
    entityName,
    filePath: relativePath,
    fileSize: audioBuffer.length,
    mimeType,
    durationMs: null,
    sampleRate: null,
    label: params.label || null,
    description: params.description || null,
    source,
    sourceUrl,
    ttsEngine: params.ttsEngine || null,
    ttsVoice: params.ttsVoice || null,
    ttsText: params.ttsText || null,
    ttsSettings: params.ttsSettings || null,
    isVoiceReference: params.isVoiceReference || false,
    voiceName: params.voiceName || null,
    voiceDescription: params.voiceDescription || null,
    isPrimary: params.setAsPrimary || false,
    createdAt: now,
  };
}

export function getAudio(audioId: string): StoredAudio | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM stored_audio WHERE id = ?`).get(audioId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return mapRowToStoredAudio(row);
}

export function getAudioFilePath(audioId: string): string | null {
  const audio = getAudio(audioId);
  if (!audio) return null;
  const fullPath = mediaPathWithin(getAudioDir(), audio.filePath);
  if (!existsSync(fullPath)) return null;
  return fullPath;
}

export function getAudioData(
  audioId: string
): { audio: StoredAudio; base64: string } | null {
  const audio = getAudio(audioId);
  if (!audio) return null;

  const fullPath = mediaPathWithin(getAudioDir(), audio.filePath);
  if (!existsSync(fullPath)) return null;

  const buffer = readFileSync(fullPath);
  const base64 = `data:${audio.mimeType};base64,${buffer.toString("base64")}`;

  return { audio, base64 };
}

export function listEntityAudio(
  entityId: string,
  entityType: string
): AudioListResult {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT * FROM stored_audio
    WHERE entity_id = ? AND entity_type = ?
    ORDER BY is_primary DESC, created_at DESC
  `
    )
    .all(entityId, entityType) as Record<string, unknown>[];

  const audioFiles = rows.map(mapRowToStoredAudio);
  const primaryAudio = audioFiles.find((a) => a.isPrimary) || null;

  return { entityId, entityType, audioFiles, primaryAudio };
}

export function listGameAudio(gameId: string): StoredAudio[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT * FROM stored_audio
    WHERE game_id = ?
    ORDER BY created_at DESC
  `
    )
    .all(gameId) as Record<string, unknown>[];

  return rows.map(mapRowToStoredAudio);
}

export function listVoiceReferences(gameId: string, characterId?: string): StoredAudio[] {
  const db = getDatabase();

  if (characterId) {
    const rows = db
      .prepare(
        `
      SELECT * FROM stored_audio
      WHERE game_id = ? AND entity_id = ? AND is_voice_reference = 1
      ORDER BY created_at DESC
    `
      )
      .all(gameId, characterId) as Record<string, unknown>[];
    return rows.map(mapRowToStoredAudio);
  } else {
    const rows = db
      .prepare(
        `
      SELECT * FROM stored_audio
      WHERE game_id = ? AND is_voice_reference = 1
      ORDER BY entity_id, created_at DESC
    `
      )
      .all(gameId) as Record<string, unknown>[];
    return rows.map(mapRowToStoredAudio);
  }
}

export function getCharacterVoiceReferences(
  gameId: string,
  characterId: string
): VoiceReferenceResult | null {
  const character = getCharacter(characterId);
  if (!character) return null;

  const voiceRefs = listVoiceReferences(gameId, characterId);

  // Build full file paths for convenience (ready to pass to TTS tools)
  const audioDir = getAudioDir();
  const filePaths = voiceRefs
    .map((ref) => {
      const fullPath = mediaPathWithin(audioDir, ref.filePath);
      return existsSync(fullPath) ? fullPath : null;
    })
    .filter((p): p is string => p !== null);

  return {
    gameId,
    characterId,
    characterName: character.name,
    voiceReferences: voiceRefs,
    filePaths,
    totalCount: voiceRefs.length,
  };
}

export function deleteAudio(audioId: string): boolean {
  const db = getDatabase();
  const audio = getAudio(audioId);
  if (!audio) return false;

  // Delete file
  const fullPath = mediaPathWithin(getAudioDir(), audio.filePath);
  if (existsSync(fullPath)) {
    unlinkSync(fullPath);
  }

  // Delete database record
  const result = db.prepare(`DELETE FROM stored_audio WHERE id = ?`).run(audioId);
  return result.changes > 0;
}

export function setPrimaryAudio(audioId: string): StoredAudio | null {
  const audio = getAudio(audioId);
  if (!audio) return null;

  // Unsetting the old primary and setting the new one must happen
  // together -- a failure between the two could otherwise leave the entity
  // with zero primaries, or briefly with two.
  withTransaction(() => {
    const db = getDatabase();

    // Unset current primary
    db.prepare(
      `
      UPDATE stored_audio SET is_primary = 0
      WHERE entity_id = ? AND entity_type = ?
    `
    ).run(audio.entityId, audio.entityType);

    // Set new primary
    db.prepare(`UPDATE stored_audio SET is_primary = 1 WHERE id = ?`).run(audioId);
  });

  return { ...audio, isPrimary: true };
}

export function updateAudioMetadata(
  audioId: string,
  updates: {
    label?: string;
    description?: string;
    ttsText?: string;
    voiceName?: string;
    voiceDescription?: string;
    isVoiceReference?: boolean;
  }
): StoredAudio | null {
  const db = getDatabase();
  const current = getAudio(audioId);
  if (!current) return null;

  const newLabel = updates.label !== undefined ? updates.label : current.label;
  const newDescription =
    updates.description !== undefined ? updates.description : current.description;
  const newTtsText = updates.ttsText !== undefined ? updates.ttsText : current.ttsText;
  const newVoiceName = updates.voiceName !== undefined ? updates.voiceName : current.voiceName;
  const newVoiceDescription =
    updates.voiceDescription !== undefined ? updates.voiceDescription : current.voiceDescription;
  const newIsVoiceReference =
    updates.isVoiceReference !== undefined ? updates.isVoiceReference : current.isVoiceReference;

  db.prepare(
    `
    UPDATE stored_audio
    SET label = ?, description = ?, tts_text = ?, voice_name = ?, voice_description = ?, is_voice_reference = ?
    WHERE id = ?
  `
  ).run(
    newLabel,
    newDescription,
    newTtsText,
    newVoiceName,
    newVoiceDescription,
    newIsVoiceReference ? 1 : 0,
    audioId
  );

  return {
    ...current,
    label: newLabel,
    description: newDescription,
    ttsText: newTtsText,
    voiceName: newVoiceName,
    voiceDescription: newVoiceDescription,
    isVoiceReference: newIsVoiceReference,
  };
}

// Cleanup helper - delete all audio for a game
export function deleteGameAudio(gameId: string): number {
  const db = getDatabase();

  // Delete files. mediaDirPath rejects before the rmSync below, which is
  // recursive and forced: an unchecked `..` here would take the whole data
  // directory with it.
  const gameDir = mediaDirPath(getAudioDir(), [gameId]);
  if (existsSync(gameDir)) {
    rmSync(gameDir, { recursive: true, force: true });
  }

  // Delete records (cascade should handle this, but be explicit)
  const result = db
    .prepare(`DELETE FROM stored_audio WHERE game_id = ?`)
    .run(gameId);
  return result.changes;
}

// Get primary audio for an entity
export function getPrimaryAudio(
  entityId: string,
  entityType: string
): StoredAudio | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
    SELECT * FROM stored_audio
    WHERE entity_id = ? AND entity_type = ? AND is_primary = 1
  `
    )
    .get(entityId, entityType) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapRowToStoredAudio(row);
}
