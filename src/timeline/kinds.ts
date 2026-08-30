/**
 * The timeline's entity-kind vocabulary -- and the single owner of it.
 *
 * These are exactly the projected tables of design §8's "Core, and this is
 * the correction" row: entity/property concepts (games, characters,
 * locations, items, resources, relationships, factions, secrets), not
 * narrative furniture. Issue #2's projection registry imports `EntityKind`,
 * so a typo in a caller is a compile error before it can ever become a
 * constraint violation -- the `entity_kinds` table and the FK on
 * `entities.kind` (see schema.ts) are the backstop for anything that
 * reaches the database without going through a typed caller.
 */
export const ENTITY_KINDS = [
  "game",
  "character",
  "location",
  "item",
  "resource",
  "relationship",
  "faction",
  "secret",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];
