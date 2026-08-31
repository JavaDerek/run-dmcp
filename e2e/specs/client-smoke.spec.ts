// Smoke coverage for the built Vue admin client (client/dist, served by
// src/http/server.ts's static + SPA-fallback tail). For each core screen this
// asserts the seeded fixture (e2e/support/seed.ts, "The Millhouse Ledger")
// actually rendered -- not merely that the route answered 200. A screen that
// 200s but shows an empty list (a broken prop wire, a stale API response
// shape) is exactly the failure a bare status-code check would sail past;
// asserting real seeded text on screen is what catches it.
//
// Every test also asserts the SPA shell stayed healthy: no uncaught page
// error, and no network request that failed outright -- the check that would
// catch a broken build or a missing chunk, which a text assertion alone
// would miss entirely.
//
// Two entries need filtering, and only two:
//
// - useGameEvents.ts opens a long-lived `/subscribe` (EventSource)
//   connection on mount and tears it down from JS (component unmount,
//   page/context teardown) -- Playwright reports that as a failed request
//   with net::ERR_ABORTED, and it is the stream doing exactly what it is
//   for, not a regression.
// - useFavicon.ts fires a HEAD at `/api/games/:gameId/favicon` on every
//   mount, unconditionally -- even for the seeded game, which deliberately
//   has no favicon (seed.ts never creates one). The server's own 404 for
//   that ("No favicon set for this game", server.ts) is correct behaviour,
//   and the in-flight HEAD is what shows up as an aborted request at
//   page/test teardown.
//
// Both filters match on the specific route AND net::ERR_ABORTED -- not "any
// 404" and not "any aborted request" -- so a genuinely broken asset or a
// missing JS chunk still fails this check.
import { test, expect, type Page } from "@playwright/test";

import { readHandshake, appUrl } from "../support/handshake.js";

/**
 * Wires the two collectors that catch a broken build: an uncaught exception
 * in the page, and a request that failed outright. Call at the top of a
 * test, before any navigation, and assert both are empty once the test's
 * real assertions are done.
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

test.describe("client smoke", () => {
  test("home lists the seeded game", async ({ page }) => {
    const { seeded } = readHandshake();
    const { pageErrors, failedRequests } = collectPageIssues(page);

    await page.goto(appUrl("/"));
    await expect(page.getByRole("heading", { name: seeded.gameName, exact: true })).toBeVisible();

    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(failedRequests, "failed requests").toEqual([]);
  });

  test("game screen loads and shows the game", async ({ page }) => {
    const { seeded } = readHandshake();
    const { pageErrors, failedRequests } = collectPageIssues(page);

    await page.goto(appUrl(`/games/${seeded.gameId}`));
    await expect(page.getByRole("heading", { name: seeded.gameName, level: 2, exact: true })).toBeVisible();

    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(failedRequests, "failed requests").toEqual([]);
  });

  test("characters screen shows both seeded characters", async ({ page }) => {
    const { seeded } = readHandshake();
    const { pageErrors, failedRequests } = collectPageIssues(page);

    await page.goto(appUrl(`/games/${seeded.gameId}/characters`));
    // exact:true on both -- "the miller" is a substring of "the miller's
    // apprentice", and a non-exact match would let either card satisfy both
    // assertions, silently proving nothing about the second character.
    await expect(page.getByRole("heading", { name: "the miller's apprentice", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "the miller", exact: true })).toBeVisible();

    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(failedRequests, "failed requests").toEqual([]);
  });

  test("locations screen shows both seeded locations", async ({ page }) => {
    const { seeded } = readHandshake();
    const { pageErrors, failedRequests } = collectPageIssues(page);

    await page.goto(appUrl(`/games/${seeded.gameId}/locations`));
    await expect(page.getByRole("heading", { name: "the mill", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "the granary", exact: true })).toBeVisible();

    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(failedRequests, "failed requests").toEqual([]);
  });

  test("resources screen shows the seeded resources", async ({ page }) => {
    const { seeded } = readHandshake();
    const { pageErrors, failedRequests } = collectPageIssues(page);

    await page.goto(appUrl(`/games/${seeded.gameId}/resources`));
    await expect(page.getByRole("heading", { name: "grain", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "population", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "north treasury", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "south treasury", exact: true })).toBeVisible();

    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(failedRequests, "failed requests").toEqual([]);
  });

  test("history screen shows the seeded narrative event's content", async ({ page }) => {
    const { seeded } = readHandshake();
    const { pageErrors, failedRequests } = collectPageIssues(page);

    await page.goto(appUrl(`/games/${seeded.gameId}/history`));
    await expect(
      page.getByText("The apprentice opens the ledger to a fresh page and starts the count.")
    ).toBeVisible();

    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(failedRequests, "failed requests").toEqual([]);
  });

  test("character page renders the player character's own name", async ({ page }) => {
    const { seeded } = readHandshake();
    const { pageErrors, failedRequests } = collectPageIssues(page);

    await page.goto(appUrl(`/characters/${seeded.playerCharacterId}`));
    // Not exact: CharacterView's <h2> also carries a "PC"/"NPC" tag as a
    // child span, so the heading's full accessible name is "the miller's
    // apprentice PC" -- a substring match is the correct check here, an
    // exact one would never pass.
    await expect(page.getByRole("heading", { name: "the miller's apprentice" })).toBeVisible();

    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(failedRequests, "failed requests").toEqual([]);
  });
});
