// Proves the acceptance infrastructure itself, before any spec relies on it:
// the server child actually booted against an isolated database, actually
// seeded a game, and its two HTTP surfaces (the application's read-only API,
// the harness's own control server) actually answer. Every later spec takes
// all of this for granted -- this file is where that trust is earned.
import { test, expect } from "@playwright/test";
import { join } from "node:path";

import { readHandshake, appUrl, controlUrl } from "../support/handshake.js";
import { assertHermetic } from "../support/tempDb.js";

test.describe("acceptance handshake", () => {
  test("dbPath is inside the OS temp dir, never the repo's own database", () => {
    const handshake = readHandshake();

    // Reuses tempDb.ts's own hermeticity guarantee rather than re-deriving
    // "is this inside the temp dir" here -- a second, independent
    // implementation of that check could silently drift from the one that
    // actually gates what globalSetup.ts is willing to run.
    expect(() => assertHermetic({ DMCP_DB_PATH: handshake.dbPath })).not.toThrow();
    expect(handshake.dbPath).not.toBe(join("data", "games.db"));
    expect(handshake.dbPath.endsWith(join("data", "games.db"))).toBe(false);
  });

  test("GET /api/games returns 200 and lists the seeded game", async ({ request }) => {
    const handshake = readHandshake();

    const response = await request.get(appUrl("/api/games"));
    expect(response.status()).toBe(200);

    const games = (await response.json()) as Array<{ id: string }>;
    expect(Array.isArray(games)).toBe(true);
    expect(games.some((game) => game.id === handshake.seeded.gameId)).toBe(true);
  });

  test("GET /api/games/:id returns the seeded game with populated counts", async ({ request }) => {
    const handshake = readHandshake();

    const response = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}`));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      game: { id: string };
      counts: Record<string, number>;
    };
    expect(body.game.id).toBe(handshake.seeded.gameId);

    // One of everything was seeded (seed.ts) -- every entity type that has a
    // count on this payload should show at least one.
    for (const key of [
      "characters",
      "locations",
      "quests",
      "factions",
      "resources",
      "notes",
      "abilities",
      "timers",
      "secrets",
      "items",
      "events",
    ] as const) {
      expect(body.counts[key], `counts.${key}`).toBeGreaterThan(0);
    }
  });

  test("the harness control server answers on /control/health", async ({ request }) => {
    const response = await request.get(controlUrl("/control/health"));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
