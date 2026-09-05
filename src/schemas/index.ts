// Reusable Zod schemas, shared by the register modules.
//
// EVERY string here is bounded, and this file is where most of the engine's
// bounds actually live: `imageGenSchema` alone is accepted by seven tools, so
// one unbounded leaf in it was seven unbounded declarations in the published
// contract (issue #29 -- 698 of them, against 348 hand-written `.max()` calls
// spread across the register modules). Bounds belong in the shared schema, not
// at each call site, for the same reason the schema itself is shared.
//
// The tiers come from `validatedSchemas` (../utils/validation.ts) and nowhere
// else: `.token` for a short descriptor, `.description` for free text a model
// writes prose into, `.embeddedData` for inline base64. Reach for one of those
// rather than hand-rolling `z.string().max(...)` -- inlining the bound at each
// site is exactly how 698 of them came to be forgotten. Each access hands back
// a FRESH schema instance, deliberately; that file's comment says why, and it
// is the difference between publishing a declaration and publishing a `$ref`.
import { z } from "zod";
import { LIMITS, validatedSchemas } from "../utils/validation.js";

// Reusable Zod schemas for image generation
export const subjectDescriptionSchema = z.object({
  type: z.enum(["character", "location", "item", "scene"]),
  primaryDescription: validatedSchemas.description,
  physicalTraits: z.object({
    age: validatedSchemas.token.optional(),
    gender: validatedSchemas.token.optional(),
    bodyType: validatedSchemas.token.optional(),
    height: validatedSchemas.token.optional(),
    skinTone: validatedSchemas.token.optional(),
    hairColor: validatedSchemas.token.optional(),
    hairStyle: validatedSchemas.token.optional(),
    eyeColor: validatedSchemas.token.optional(),
    facialFeatures: validatedSchemas.description.optional(),
    distinguishingMarks: validatedSchemas.stringArray.optional(),
  }).optional(),
  attire: z.object({
    description: validatedSchemas.description,
    colors: validatedSchemas.stringArray.optional(),
    materials: validatedSchemas.stringArray.optional(),
    accessories: validatedSchemas.stringArray.optional(),
  }).optional(),
  environment: z.object({
    setting: validatedSchemas.description,
    timeOfDay: validatedSchemas.token.optional(),
    weather: validatedSchemas.token.optional(),
    lighting: validatedSchemas.token.optional(),
    architecture: validatedSchemas.token.optional(),
    vegetation: validatedSchemas.token.optional(),
    notableFeatures: validatedSchemas.stringArray.optional(),
  }).optional(),
  objectDetails: z.object({
    material: validatedSchemas.token.optional(),
    size: validatedSchemas.token.optional(),
    condition: validatedSchemas.token.optional(),
    glowOrEffects: validatedSchemas.description.optional(),
  }).optional(),
  pose: validatedSchemas.description.optional(),
  expression: validatedSchemas.description.optional(),
  action: validatedSchemas.description.optional(),
});

export const styleDescriptionSchema = z.object({
  artisticStyle: validatedSchemas.description,
  genre: validatedSchemas.token,
  mood: validatedSchemas.token,
  colorScheme: validatedSchemas.token.optional(),
  influences: validatedSchemas.stringArray.optional(),
  qualityTags: validatedSchemas.stringArray.optional(),
  negativeElements: validatedSchemas.stringArray.optional(),
});

export const compositionDescriptionSchema = z.object({
  framing: validatedSchemas.description,
  cameraAngle: validatedSchemas.token.optional(),
  aspectRatio: validatedSchemas.token.optional(),
  focusPoint: validatedSchemas.description.optional(),
  background: validatedSchemas.description.optional(),
  depth: validatedSchemas.token.optional(),
});

export const comfyUIPromptSchema = z.object({
  positive: validatedSchemas.description,
  negative: validatedSchemas.description,
  checkpoint: validatedSchemas.token.optional(),
  loras: z.array(z.object({
    name: validatedSchemas.name,
    weight: z.number(),
  })).max(LIMITS.ARRAY_MAX).optional(),
  samplerSettings: z.object({
    sampler: validatedSchemas.token.optional(),
    scheduler: validatedSchemas.token.optional(),
    steps: z.number().optional(),
    cfg: z.number().optional(),
  }).optional(),
});

export const generatedImageSchema = z.object({
  id: validatedSchemas.id,
  tool: validatedSchemas.token,
  prompt: validatedSchemas.description,
  // A URL, including a `data:` one. Over DESCRIPTION_MAX it is not an address,
  // it is a payload, and `base64` below is the field for those.
  url: validatedSchemas.description.optional(),
  base64: validatedSchemas.embeddedData.optional(),
  seed: z.number().optional(),
  timestamp: validatedSchemas.token,
  metadata: z.record(validatedSchemas.token, z.unknown()).optional(),
});

export const imageGenSchema = z.object({
  subject: subjectDescriptionSchema,
  style: styleDescriptionSchema,
  composition: compositionDescriptionSchema,
  prompts: z.object({
    generic: validatedSchemas.description.optional(),
    sdxl: validatedSchemas.description.optional(),
    dalle: validatedSchemas.description.optional(),
    midjourney: validatedSchemas.description.optional(),
    flux: validatedSchemas.description.optional(),
    comfyui: comfyUIPromptSchema.optional(),
  }).optional(),
  generations: z.array(generatedImageSchema).max(LIMITS.ARRAY_MAX).optional(),
  consistency: z.object({
    characterRef: validatedSchemas.description.optional(),
    seedImage: validatedSchemas.description.optional(),
    colorPalette: validatedSchemas.stringArray.optional(),
    styleRef: validatedSchemas.description.optional(),
  }).optional(),
}).describe("Image generation metadata for visual representation");

// Voice schema for characters
export const voiceSchema = z.object({
  pitch: z.enum(["very_low", "low", "medium", "high", "very_high"]).describe("Voice pitch"),
  speed: z.enum(["very_slow", "slow", "medium", "fast", "very_fast"]).describe("Speaking speed"),
  tone: validatedSchemas.token.describe("Voice tone (e.g., 'gravelly', 'melodic', 'nasal', 'breathy')"),
  accent: validatedSchemas.token.optional().describe("Accent (e.g., 'Scottish', 'French', 'Brooklyn')"),
  quirks: validatedSchemas.stringArray.optional().describe("Speech quirks (e.g., 'stutters when nervous')"),
  description: validatedSchemas.description.optional().describe("Free-form voice description for more nuance"),
});

// Random table entry schema
export const tableEntrySchema = z.object({
  minRoll: z.number().optional().describe("Minimum roll to get this result (for ranged tables)"),
  maxRoll: z.number().optional().describe("Maximum roll for this result"),
  weight: z.number().optional().describe("Weight for weighted random selection"),
  result: validatedSchemas.description.describe("The result text"),
  effects: z.record(validatedSchemas.token, z.unknown()).optional().describe("Optional structured effects"),
});
