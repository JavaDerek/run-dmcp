import { z } from "zod";

/**
 * Common input length limits for security and performance.
 *
 * These prevent DoS attacks via extremely large inputs -- and they are also
 * the engine's PUBLISHED CONTRACT. A `.max()` here lands in the tool's
 * `input_schema` and `tools/list` hands it to every client before the first
 * call, so a consumer can read what a field takes instead of hard-coding a
 * copy of these numbers. One does. Leaving a string parameter unbounded is
 * therefore not a missing safety net but an active statement that the field
 * takes anything; `src/__tests__/schemaBounds.test.ts` fails on any that is
 * (issue #29).
 */
export const LIMITS = {
  // Short text fields (names, titles)
  NAME_MAX: 200,
  // Medium text fields (descriptions)
  DESCRIPTION_MAX: 5000,
  // Long text fields (notes, content)
  CONTENT_MAX: 50000,
  // Very long text fields (story exports, narrative)
  NARRATIVE_MAX: 200000,
  // Inline binary carried as a data URI or bare base64 -- an image, not prose.
  // Deliberately generous rather than a prose tier: the fields that take one
  // (`imageGen.generations[].base64`) accepted anything before they were
  // bounded, and a real inline PNG is hundreds of kilobytes.
  EMBEDDED_DATA_MAX: 2000000,
  // Array limits
  ARRAY_MAX: 100,
  // JSON object depth limit (for nested structures)
  MAX_DEPTH: 10,
} as const;

/**
 * Pre-built Zod schemas with length limits.
 *
 * EVERY PROPERTY HERE IS A GETTER, AND HANDS BACK A FRESH INSTANCE.
 *
 * That is not a style: `zod-to-json-schema` (which the MCP SDK runs over
 * every `inputSchema` on its way to `tools/list`) de-duplicates by object
 * IDENTITY. Reuse one instance twice inside a single tool and the second
 * occurrence is published as
 *
 *     { "$ref": "#/properties/imageGen/properties/subject/properties/..." }
 *
 * -- a pointer into a sibling property, in place of the declaration a
 * consumer came to read. Sharing these as plain constants put 648 of those
 * into the contract, where there had been none; a fresh instance per access
 * puts the declaration back at every site. `src/__tests__/schemaBounds.test.ts`
 * fails on any `$ref` in a published schema, which is what caught it.
 *
 * The cost is a schema object built per access. They are read at server
 * construction, not per call.
 */
export const validatedSchemas = {
  // Name fields (character names, location names, etc.)
  get name() {
    return z.string().min(1).max(LIMITS.NAME_MAX);
  },

  // Short free text with a ceiling and NO floor -- a colour, a direction, an
  // aspect ratio, a sampler. Same length as `name`, without `.min(1)`: bounding
  // a field that accepts "" today must not also start rejecting it.
  get token() {
    return z.string().max(LIMITS.NAME_MAX);
  },

  // Description fields
  get description() {
    return z.string().max(LIMITS.DESCRIPTION_MAX);
  },

  // Content fields (notes, large text)
  get content() {
    return z.string().max(LIMITS.CONTENT_MAX);
  },

  // Narrative content (very large text allowed)
  get narrative() {
    return z.string().max(LIMITS.NARRATIVE_MAX);
  },

  // Inline binary carried as base64 or a data URI -- an image, not prose.
  get embeddedData() {
    return z.string().max(LIMITS.EMBEDDED_DATA_MAX);
  },

  // ID fields (UUIDs are 36 characters)
  get id() {
    return z.string().max(100);
  },

  // Tag/category strings
  get tag() {
    return z.string().min(1).max(100);
  },

  // Array of strings with limits
  get stringArray() {
    return z.array(z.string().max(LIMITS.NAME_MAX)).max(LIMITS.ARRAY_MAX);
  },

  // Array of tags
  get tagArray() {
    return z.array(z.string().min(1).max(100)).max(LIMITS.ARRAY_MAX);
  },
};

/**
 * Helper to create a bounded string schema
 */
export function boundedString(maxLength: number = LIMITS.NAME_MAX) {
  return z.string().max(maxLength);
}

/**
 * Helper to create a bounded array schema
 */
export function boundedArray<T extends z.ZodType>(
  schema: T,
  maxItems: number = LIMITS.ARRAY_MAX
) {
  return z.array(schema).max(maxItems);
}
