// Proves the one property this HTTP surface actually promises: read-only.
// src/http/server.ts registers every route with `app.get(...)`, and the
// module's own header comment says so -- this spec is what would go red if
// that ever stopped being true, either behaviorally (a write silently lands)
// or structurally (someone adds a mutating route to a surface documented as
// read-only).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readHandshake, appUrl } from "../support/handshake.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SOURCE_PATH = join(HERE, "..", "..", "src", "http", "server.ts");

// ============================================================================
// Behavioral: a mutating verb against a representative set of routes must
// not perform a mutation, and the read-back afterwards must prove it -- a
// status code alone only shows the request was rejected, not that nothing
// happened as a side effect of handling it.
// ============================================================================

test.describe("mutating verbs perform no mutation", () => {
  test("POST /api/games/:gameId does not touch the seeded game, and it reads back unchanged", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const before = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}`));
    const beforeBody = await before.json();

    const mutationAttempt = await request.post(appUrl(`/api/games/${handshake.seeded.gameId}`), {
      data: { name: "a name this route has no way to accept" },
    });
    // No app.post() exists for this path -- Express's own router has nothing
    // to dispatch to, so this is a 404 from Express itself, not a handler
    // that considered the write and declined it.
    expect(mutationAttempt.status()).toBe(404);

    const after = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}`));
    const afterBody = await after.json();
    expect(afterBody.game.name).toBe(beforeBody.game.name);
    expect(afterBody.game).toEqual(beforeBody.game);
  });

  test("PUT /api/characters/:characterId does not touch the seeded character, and it reads back unchanged", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const before = await request.get(appUrl(`/api/characters/${handshake.seeded.playerCharacterId}`));
    const beforeBody = await before.json();

    const mutationAttempt = await request.put(appUrl(`/api/characters/${handshake.seeded.playerCharacterId}`), {
      data: { name: "an impostor apprentice" },
    });
    expect(mutationAttempt.status()).toBe(404);

    const after = await request.get(appUrl(`/api/characters/${handshake.seeded.playerCharacterId}`));
    const afterBody = await after.json();
    expect(afterBody).toEqual(beforeBody);
  });

  test("PATCH /api/resources/:resourceId does not touch the seeded grain resource's value, and it reads back unchanged", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const before = await request.get(appUrl(`/api/resources/${handshake.seeded.grainResourceId}`));
    const beforeBody = await before.json();

    const mutationAttempt = await request.patch(appUrl(`/api/resources/${handshake.seeded.grainResourceId}`), {
      data: { value: 999999 },
    });
    expect(mutationAttempt.status()).toBe(404);

    const after = await request.get(appUrl(`/api/resources/${handshake.seeded.grainResourceId}`));
    const afterBody = await after.json();
    expect(afterBody.value).toBe(beforeBody.value);
    expect(afterBody).toEqual(beforeBody);
  });

  test("DELETE /api/notes/:noteId does not remove the seeded note, and it still reads back", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const before = await request.get(appUrl(`/api/notes/${handshake.seeded.noteId}`));
    const beforeBody = await before.json();

    const mutationAttempt = await request.delete(appUrl(`/api/notes/${handshake.seeded.noteId}`));
    expect(mutationAttempt.status()).toBe(404);

    // The important half: if DELETE had actually landed, this would now
    // 404. It doesn't -- the note is still exactly what it was.
    const after = await request.get(appUrl(`/api/notes/${handshake.seeded.noteId}`));
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    expect(afterBody).toEqual(beforeBody);
  });

  test("DELETE /api/games/:gameId does not remove the seeded game -- GET /api/games still lists it", async ({
    request,
  }) => {
    const handshake = readHandshake();

    const mutationAttempt = await request.delete(appUrl(`/api/games/${handshake.seeded.gameId}`));
    expect(mutationAttempt.status()).toBe(404);

    const after = await request.get(appUrl("/api/games"));
    const games = (await after.json()) as Array<{ id: string }>;
    expect(games.some((g) => g.id === handshake.seeded.gameId)).toBe(true);
  });

  test("POST /api/games/:gameId/characters (no such route -- creation is not part of this surface) mutates nothing", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const before = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/characters`));
    const beforeIds = ((await before.json()) as Array<{ id: string }>).map((c) => c.id).sort();

    const mutationAttempt = await request.post(appUrl(`/api/games/${handshake.seeded.gameId}/characters`), {
      data: { name: "a character this route has no way to create" },
    });
    expect(mutationAttempt.status()).toBe(404);

    const after = await request.get(appUrl(`/api/games/${handshake.seeded.gameId}/characters`));
    const afterIds = ((await after.json()) as Array<{ id: string }>).map((c) => c.id).sort();
    expect(afterIds).toEqual(beforeIds);
  });
});

// ============================================================================
// Structural: read the server's own source and check what verbs it actually
// registers routes with. This is a check for tokens THIS PROJECT wrote in
// its own generated-nowhere source file -- not language understanding, not
// pattern-matching meaning out of prose (claude.md hard rule 4/5). It is the
// same shape as pillarZero.ts's literal search for a word this codebase
// defined itself. What it catches: someone adding `app.post(...)` (or
// `app.put`/`app.patch`/`app.delete`/a mounted `app.use` router) to a
// surface whose entire contract, in the module's own header, is "every
// route is GET". The behavioral tests above show today's server rejects
// writes; this is what keeps that true tomorrow, at the moment the mutating
// route is ADDED, not three specs later when someone notices data moved.
// ============================================================================

test.describe("no mutating route is registered, structurally", () => {
  test("src/http/server.ts registers only app.get(...) -- no app.post/put/patch/delete/use route", () => {
    const source = readFileSync(SERVER_SOURCE_PATH, "utf8");

    const getRegistrations = source.match(/\bapp\.get\(/g) ?? [];
    const postRegistrations = source.match(/\bapp\.post\(/g) ?? [];
    const putRegistrations = source.match(/\bapp\.put\(/g) ?? [];
    const patchRegistrations = source.match(/\bapp\.patch\(/g) ?? [];
    const deleteRegistrations = source.match(/\bapp\.delete\(/g) ?? [];
    // `app.use(express.static(...))` and `app.use(express.json())` are
    // expected and fine -- serving static files and parsing a request body
    // are both read-only. So is the trailing 4-arg error handler
    // (`app.use((err, req, res, next) => ...)`), which only ever runs on a
    // thrown exception and never performs a write of its own. What this
    // line actually guards against is a mounted ROUTER
    // (`app.use("/api/whatever", someRouter)`), which could carry mutating
    // routes invisible to a scan for `app.post(` et al. Any `app.use(`
    // that is none of those three is suspect.
    const useRegistrations = (source.match(/\bapp\.use\([^)]*/g) ?? []).filter(
      (call) =>
        !call.includes("express.static(") &&
        !call.includes("express.json(") &&
        !/^app\.use\(\(err/.test(call)
    );

    // Guard against a vacuous pass: if the regex stopped matching (a rename,
    // a reformat that breaks `\bapp\.get\(`), every count below would read
    // zero and the "no mutating verb" assertions would trivially hold for
    // the wrong reason. Asserting the GET count matches what api-routes.spec.ts
    // actually exercises is proof the scan is really seeing the file's
    // routes, not silently matching nothing. Count: every app.get( call in
    // src/http/server.ts as of this writing (API JSON routes, the SSE
    // subscribe route, the favicon and image-file routes, and the two
    // possible dev-mode/SPA-fallback routes are mutually exclusive at
    // runtime but both exist in source).
    expect(getRegistrations.length).toBeGreaterThanOrEqual(25);

    expect(postRegistrations, "app.post( registrations").toEqual([]);
    expect(putRegistrations, "app.put( registrations").toEqual([]);
    expect(patchRegistrations, "app.patch( registrations").toEqual([]);
    expect(deleteRegistrations, "app.delete( registrations").toEqual([]);
    expect(useRegistrations, "app.use( registrations other than static/json body-parsing").toEqual([]);
  });
});
