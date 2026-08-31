// Routing and the production SPA fallback, as actually served -- not as a
// dev server would serve them. client/dist is built by Vite and handed to a
// real Express route (src/http/server.ts's `/{*path}` tail, "Must be after
// API routes"); every test here targets something that route is responsible
// for, and a dev-server-only test suite would not catch a regression in it.
import { test, expect, type Page } from "@playwright/test";

import { readHandshake, appUrl } from "../support/handshake.js";

/**
 * Same collector as client-smoke.spec.ts -- see that file's header for why
 * a `/subscribe` (EventSource) abort and a `/favicon` HEAD abort are the
 * only two things worth filtering, and why each is matched narrowly (the
 * specific route AND net::ERR_ABORTED, not "any 404" or "any aborted
 * request").
 */
function collectPageIssues(page: Page) {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const errorText = request.failure()?.errorText ?? "";
    const isAborted = errorText.includes("ABORTED");
    const pathname = new URL(request.url()).pathname;

    if (isAborted && pathname.endsWith("/subscribe")) return;
    if (isAborted && pathname.endsWith("/favicon")) return;

    failedRequests.push(`${request.url()} -- ${errorText}`);
  });

  return { pageErrors, failedRequests };
}

test.describe("client navigation", () => {
  test("a deep link to a sub-screen loads directly, proving the server's SPA fallback is wired", async ({
    page,
  }) => {
    const { seeded } = readHandshake();

    // This is the ONLY navigation this test performs -- no prior visit to
    // `/`. A dev server that serves every path from memory would pass this
    // trivially for the wrong reason; what actually has to be true for this
    // to pass is that Express itself answers a deep path with index.html
    // rather than a bare 404, which is why this suite runs against the
    // built artifact (globalSetup.ts asserts client/dist exists first).
    const response = await page.goto(appUrl(`/games/${seeded.gameId}/characters`));
    expect(response?.status()).toBe(200);

    await expect(page.getByRole("heading", { name: "the miller's apprentice", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "the miller", exact: true })).toBeVisible();
    await expect(page).toHaveURL(appUrl(`/games/${seeded.gameId}/characters`));
  });

  test("in-app navigation: home -> game -> characters, asserting URL and content at each step", async ({
    page,
  }) => {
    const { seeded } = readHandshake();
    const { pageErrors, failedRequests } = collectPageIssues(page);

    await page.goto(appUrl("/"));
    await page.getByRole("link", { name: seeded.gameName, exact: true }).click();
    await expect(page).toHaveURL(appUrl(`/games/${seeded.gameId}`));
    await expect(page.getByRole("heading", { name: seeded.gameName, level: 2, exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Characters" }).click();
    await expect(page).toHaveURL(appUrl(`/games/${seeded.gameId}/characters`));
    await expect(page.getByRole("heading", { name: "the miller's apprentice", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "the miller", exact: true })).toBeVisible();

    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(failedRequests, "failed requests").toEqual([]);
  });

  test("an unknown client-side path still returns the SPA shell, not a server 404", async ({ page }) => {
    // client/src/router/index.ts declares no catch-all route, so Vue Router
    // renders nothing into <router-view> for a path it doesn't recognise --
    // that's the app's own documented behaviour, not something this spec
    // should paper over. What this test actually guards is the layer below
    // Vue Router: server.ts's fallback must still answer with the SPA shell
    // (200, index.html) for ANY unmatched path, rather than an Express 404.
    const response = await page.goto(appUrl("/this-route-does-not-exist"));
    expect(response?.status()).toBe(200);

    // App.vue renders <AppHeader v-if="!gameId" />, and there's no :gameId
    // param on this path, so AppHeader's own heading is visible proof the
    // Vue app actually mounted here -- not just that some HTML came back.
    await expect(page.getByRole("heading", { name: "DMCP Game Viewer" })).toBeVisible();
  });

  test("/api and /images requests reach their real handlers, not the SPA fallback", async ({ page }) => {
    const { seeded } = readHandshake();

    const apiResponse = await page.request.get(appUrl("/api/games"));
    expect(apiResponse.status()).toBe(200);
    expect(apiResponse.headers()["content-type"]).toContain("application/json");
    const games = (await apiResponse.json()) as Array<{ id: string }>;
    expect(games.some((game) => game.id === seeded.gameId)).toBe(true);

    // A path under /images/ that doesn't exist still reaches server.ts's own
    // image route and its own 404 -- never the SPA's index.html. The
    // fallback explicitly skips `/api/` and `/images/` (server.ts, "Skip API
    // routes and image routes"); if that skip ever regressed, this request
    // would silently start returning 200 + the Vue app shell instead of a
    // 404, which is exactly what the assertions below would catch.
    const imageResponse = await page.request.get(appUrl("/images/does-not-exist/file"));
    expect(imageResponse.status()).toBe(404);
    const imageBody = await imageResponse.text();
    expect(imageBody).not.toContain('<div id="app">');
  });
});
