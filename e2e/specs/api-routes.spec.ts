// Every GET route src/http/server.ts defines, exercised against the seeded
// game (e2e/support/seed.ts) and asserted on the SPECIFIC seeded id --
// never `[0]` of a returned list, never a guessed name. Asserting on `[0]`
// would still pass if a route silently dropped or reordered its payload, as
// long as SOMETHING came back first; asserting on the seeded id is the only
// way a broken join or a wrong WHERE clause actually turns the test red.
//
// Every route with an explicit `if (!x) { res.status(404)... }` branch is
// also driven with a well-formed-but-unknown id, so a 404 branch is proven
// to fire rather than assumed from reading the source.
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { readHandshake, appUrl } from "../support/handshake.js";

/** A syntactically plausible id that was never created by the seed. */
function unknownId(): string {
  return randomUUID();
}

test.describe("GET /api/theme", () => {
  test("returns the global display config", async ({ request }) => {
    const response = await request.get(appUrl("/api/theme"));
    expect(response.status()).toBe(200);

    const body = await response.json();
    // A handful of fields every DisplayConfig carries (src/tools/display.ts)
    // -- enough to prove this is the real config object, not an empty shell.
    expect(typeof body.bgColor).toBe("string");
    expect(typeof body.accentColor).toBe("string");
    expect(typeof body.fontDisplay).toBe("string");
  });
});

test.describe("GET /api/games", () => {
  test("lists the seeded game", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl("/api/games"));
    expect(response.status()).toBe(200);

    const games = (await response.json()) as Array<{ id: string; name: string }>;
    const seededGame = games.find((g) => g.id === handshake.seeded.gameId);
    expect(seededGame, "seeded game present in /api/games").toBeDefined();
    expect(seededGame?.name).toBe(handshake.seeded.gameName);
  });
});

test.describe("GET /api/games/:gameId", () => {
  test("returns the full game payload for the seeded game", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}`));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      game: { id: string; name: string };
      characters: Array<{ id: string }>;
      locations: Array<{ id: string }>;
    };
    expect(body.game.id).toBe(handshake.seeded.gameId);
    expect(body.game.name).toBe(handshake.seeded.gameName);
    expect(body.characters.some((c) => c.id === handshake.seeded.playerCharacterId)).toBe(true);
    expect(body.locations.some((l) => l.id === handshake.seeded.millLocationId)).toBe(true);
  });

  test("404s with an error key for an unknown game", async ({ request }) => {
    const response = await request.get(appUrl(`/api/games/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/games/:gameId/theme", () => {
  test("returns a display config for the seeded game (falls back to global, never 404s)", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/theme`));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(typeof body.bgColor).toBe("string");
  });
});

test.describe("GET /api/games/:gameId/image-presets", () => {
  test("returns the (empty) preset list and a null default for the seeded game", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/image-presets`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { presets: unknown[]; defaultPresetId: string | null };
    expect(Array.isArray(body.presets)).toBe(true);
    expect(body.defaultPresetId).toBeNull();
  });

  test("GET .../image-presets/:presetId 404s -- no preset was ever declared for the seeded game", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const response = await request.get(
      appUrl(`/api/games/${handshake.seeded.gameId}/image-presets/${unknownId()}`)
    );
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/games/:gameId/map", () => {
  test("places both seeded locations on the map", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/map`));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { nodes: Array<{ id: string }> };
    const nodeIds = body.nodes.map((n) => n.id);
    expect(nodeIds).toContain(handshake.seeded.millLocationId);
    expect(nodeIds).toContain(handshake.seeded.granaryLocationId);
  });

  test("404s for an unknown game -- no locations means no map data", async ({ request }) => {
    const response = await request.get(appUrl(`/api/games/${unknownId()}/map`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/games/:gameId/history", () => {
  test("includes the narrative event logged during seeding", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/history`));
    expect(response.status()).toBe(200);

    const events = (await response.json()) as Array<{ id: string }>;
    expect(events.some((e) => e.id === handshake.seeded.narrativeEventId)).toBe(true);
  });
});

test.describe("GET /api/games/:gameId/images", () => {
  test("returns an empty list -- the seed never stores an image", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/images`));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });
});

test.describe("GET /api/games/:gameId/characters", () => {
  test("lists both seeded characters", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/characters`));
    expect(response.status()).toBe(200);

    const characters = (await response.json()) as Array<{ id: string }>;
    const ids = characters.map((c) => c.id);
    expect(ids).toContain(handshake.seeded.playerCharacterId);
    expect(ids).toContain(handshake.seeded.millerCharacterId);
  });

  test("?locationId= filters to characters standing at that location", async ({ request }) => {
    const handshake = readHandshake();
    // Both seeded characters stand at the mill (seed.ts); the granary has
    // neither, so filtering by it proves the filter narrows rather than
    // being silently ignored.
    const atMill = await request.get(
      appUrl(`/api/games/${handshake.seeded.gameId}/characters?locationId=${handshake.seeded.millLocationId}`)
    );
    expect(atMill.status()).toBe(200);
    const millCharacters = (await atMill.json()) as Array<{ id: string }>;
    const millIds = millCharacters.map((c) => c.id);
    expect(millIds).toContain(handshake.seeded.playerCharacterId);
    expect(millIds).toContain(handshake.seeded.millerCharacterId);

    const atGranary = await request.get(
      appUrl(`/api/games/${handshake.seeded.gameId}/characters?locationId=${handshake.seeded.granaryLocationId}`)
    );
    expect(atGranary.status()).toBe(200);
    const granaryCharacters = (await atGranary.json()) as Array<{ id: string }>;
    expect(granaryCharacters.map((c) => c.id)).not.toContain(handshake.seeded.playerCharacterId);
  });
});

test.describe("GET /api/games/:gameId/relationships", () => {
  test("returns the (empty) enriched relationship list for the seeded game", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/relationships`));
    expect(response.status()).toBe(200);
    const body = await response.json();
    // The seed never creates a relationship -- asserting the empty array is
    // the coherent-shape check here, not a placeholder for "didn't look".
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });
});

test.describe("GET /api/games/:gameId/search", () => {
  test("matches the seeded miller character, mill location and millers' guild faction by substring", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/search?q=mill`));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      characters: Array<{ id: string }>;
      locations: Array<{ id: string }>;
      factions: Array<{ id: string }>;
    };
    expect(body.characters.map((c) => c.id)).toContain(handshake.seeded.millerCharacterId);
    expect(body.locations.map((l) => l.id)).toContain(handshake.seeded.millLocationId);
    expect(body.factions.map((f) => f.id)).toContain(handshake.seeded.factionId);
  });

  test("a query under 2 characters short-circuits to every bucket empty, without even checking the game exists", async ({
    request,
  }) => {
    // Deliberately paired with an UNKNOWN game id: the length check in
    // src/http/server.ts runs before loadGame(), so this must stay 200, not
    // 404 -- proving the short-circuit really does come first.
    const response = await request.get(appUrl(`/api/games/${unknownId()}/search?q=m`));
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      characters: [],
      locations: [],
      quests: [],
      items: [],
      factions: [],
      notes: [],
      events: [],
    });
  });

  test("404s for an unknown game once the query is long enough to reach the game lookup", async ({ request }) => {
    const response = await request.get(appUrl(`/api/games/${unknownId()}/search?q=mill`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/characters/:characterId", () => {
  test("returns the seeded player character", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/characters/${handshake.seeded.playerCharacterId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: string; isPlayer: boolean; locationId: string };
    expect(body.id).toBe(handshake.seeded.playerCharacterId);
    expect(body.isPlayer).toBe(true);
    expect(body.locationId).toBe(handshake.seeded.millLocationId);
  });

  test("404s for an unknown character", async ({ request }) => {
    const response = await request.get(appUrl(`/api/characters/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/characters/:characterId/sheet", () => {
  test("renders the seeded player's sheet with location name and inventory", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/characters/${handshake.seeded.playerCharacterId}/sheet`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      character: { id: string };
      locationName: string | null;
      inventory: Array<{ name: string }>;
    };
    expect(body.character.id).toBe(handshake.seeded.playerCharacterId);
    expect(body.locationName).toBe("the mill");
    // The seeded ledger item is owned by the player character.
    expect(body.inventory.some((i) => i.name === "a dog-eared ledger")).toBe(true);
  });

  test("404s for an unknown character", async ({ request }) => {
    const response = await request.get(appUrl(`/api/characters/${unknownId()}/sheet`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/locations/:locationId", () => {
  test("returns the seeded mill location, with an exit toward the granary", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/locations/${handshake.seeded.millLocationId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      id: string;
      properties: { exits: Array<{ destinationId: string }> };
    };
    expect(body.id).toBe(handshake.seeded.millLocationId);
    expect(body.properties.exits.some((e) => e.destinationId === handshake.seeded.granaryLocationId)).toBe(
      true
    );
  });

  test("404s for an unknown location", async ({ request }) => {
    const response = await request.get(appUrl(`/api/locations/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/quests/:questId", () => {
  test("returns the seeded quest", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/quests/${handshake.seeded.questId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: string; name: string };
    expect(body.id).toBe(handshake.seeded.questId);
    expect(body.name).toBe("settle the granary count");
  });

  test("404s for an unknown quest", async ({ request }) => {
    const response = await request.get(appUrl(`/api/quests/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/factions/:factionId", () => {
  test("returns the seeded faction", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/factions/${handshake.seeded.factionId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: string; name: string };
    expect(body.id).toBe(handshake.seeded.factionId);
    expect(body.name).toBe("the millers' guild");
  });

  test("404s for an unknown faction", async ({ request }) => {
    const response = await request.get(appUrl(`/api/factions/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/resources/:resourceId", () => {
  test("returns the seeded plain grain resource", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/resources/${handshake.seeded.grainResourceId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: string; name: string; value: number };
    expect(body.id).toBe(handshake.seeded.grainResourceId);
    expect(body.name).toBe("grain");
    expect(body.value).toBe(500);
  });

  test("returns the seeded bounded population resource with its declared bounds", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/resources/${handshake.seeded.populationResourceId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: string; minValue: number; maxValue: number };
    expect(body.id).toBe(handshake.seeded.populationResourceId);
    expect(body.minValue).toBe(handshake.seeded.populationBounds.minValue);
    expect(body.maxValue).toBe(handshake.seeded.populationBounds.maxValue);
  });

  test("returns each seeded conserved treasury, and they still sum to the declared total", async ({ request }) => {
    const handshake = readHandshake();
    const north = await request.get(appUrl(`/api/resources/${handshake.seeded.conserved.northTreasuryId}`));
    const south = await request.get(appUrl(`/api/resources/${handshake.seeded.conserved.southTreasuryId}`));
    expect(north.status()).toBe(200);
    expect(south.status()).toBe(200);

    const northBody = (await north.json()) as { id: string; value: number };
    const southBody = (await south.json()) as { id: string; value: number };
    expect(northBody.id).toBe(handshake.seeded.conserved.northTreasuryId);
    expect(southBody.id).toBe(handshake.seeded.conserved.southTreasuryId);
    expect(northBody.value + southBody.value).toBe(handshake.seeded.conserved.total);
  });

  test("404s for an unknown resource", async ({ request }) => {
    const response = await request.get(appUrl(`/api/resources/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/notes/:noteId", () => {
  test("returns the seeded note", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/notes/${handshake.seeded.noteId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: string; title: string };
    expect(body.id).toBe(handshake.seeded.noteId);
    expect(body.title).toBe("toll schedule");
  });

  test("404s for an unknown note", async ({ request }) => {
    const response = await request.get(appUrl(`/api/notes/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/abilities/:abilityId", () => {
  test("returns the seeded ability", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/abilities/${handshake.seeded.abilityId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: string; name: string; ownerId: string | null };
    expect(body.id).toBe(handshake.seeded.abilityId);
    expect(body.name).toBe("true measure");
    expect(body.ownerId).toBe(handshake.seeded.playerCharacterId);
  });

  test("404s for an unknown ability", async ({ request }) => {
    const response = await request.get(appUrl(`/api/abilities/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/timers/:timerId", () => {
  test("returns the seeded timer", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/timers/${handshake.seeded.timerId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: string; name: string; currentValue: number };
    expect(body.id).toBe(handshake.seeded.timerId);
    expect(body.name).toBe("millrace freeze watch");
    expect(body.currentValue).toBe(10);
  });

  test("404s for an unknown timer", async ({ request }) => {
    const response = await request.get(appUrl(`/api/timers/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/items/:itemId", () => {
  test("returns the seeded ledger item", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/items/${handshake.seeded.itemId}`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { id: string; name: string; ownerId: string };
    expect(body.id).toBe(handshake.seeded.itemId);
    expect(body.name).toBe("a dog-eared ledger");
    expect(body.ownerId).toBe(handshake.seeded.playerCharacterId);
  });

  test("404s for an unknown item", async ({ request }) => {
    const response = await request.get(appUrl(`/api/items/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});

test.describe("GET /api/inventory/:ownerType/:ownerId", () => {
  test("returns the seeded item for its owning character", async ({ request }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/inventory/character/${handshake.seeded.playerCharacterId}`));
    expect(response.status()).toBe(200);
    const items = (await response.json()) as Array<{ id: string }>;
    expect(items.some((i) => i.id === handshake.seeded.itemId)).toBe(true);
  });

  test("returns an empty inventory for a location -- the seeded item is owned by a character", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/inventory/location/${handshake.seeded.millLocationId}`));
    expect(response.status()).toBe(200);
    const items = await response.json();
    expect(items).toEqual([]);
  });
});

test.describe("GET /api/entities/:entityType/:entityId/images", () => {
  test("returns an empty image list for the seeded player character -- no image was ever stored", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const response = await request.get(appUrl(`/api/entities/character/${handshake.seeded.playerCharacterId}/images`));
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { entityId: string; entityType: string; images: unknown[]; primaryImage: unknown };
    expect(body.entityId).toBe(handshake.seeded.playerCharacterId);
    expect(body.entityType).toBe("character");
    expect(body.images).toEqual([]);
    expect(body.primaryImage).toBeNull();
  });
});

test.describe("GET /api/images/:imageId", () => {
  test("404s for an unknown image -- the seed never stores one", async ({ request }) => {
    const response = await request.get(appUrl(`/api/images/${unknownId()}`));
    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
  });
});
