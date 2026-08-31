// The acceptance suite's runner.
//
// One runner for every surface, browser or not. Playwright's test runner is
// perfectly happy running a spec that never asks for a `page` -- the MCP
// stdio harnesses are plain Node tests that happen to be scheduled here --
// and one runner means one command, one report and one place where a
// hermeticity guarantee is made. The alternative was a second vitest project
// alongside the first, which is how a repository ends up with two fixtures
// for one database (the exact failure claude.md's testing section names).
//
// DELIBERATELY OUTSIDE THE VITEST GLOBS. vitest.config.ts includes
// `src/**/*.test.ts`; every file here is `e2e/**/*.spec.ts`, so
// `npm run test:run` sees none of it and its meaning is unchanged.
//
// HERMETIC. globalSetup boots the application on port 0 against a database
// in a fresh temp directory and publishes both facts to a handshake file
// (e2e/support/handshake.ts); every spawned child in every harness gets the
// same treatment. Nothing in this suite can open `data/games.db`, and
// nothing in it reads or requires a vendor credential.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/specs",
  outputDir: "./e2e/.tmp/test-results",

  // Serial, on purpose. Every harness spec spawns real child processes with
  // real SQLite files, and the shared application server is one process the
  // whole suite reads. The suite is small enough that determinism is worth
  // more than the wall clock, and "prefer fewer rock-solid specs over many
  // flaky ones" is the standing instruction.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  // Zero. A retry would let a genuinely flaky spec pass and be reported as
  // green, which is the one outcome this suite exists to prevent.
  retries: 0,

  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "e2e/.tmp/report" }]]
    : [["list"]],

  globalSetup: "./e2e/support/globalSetup.ts",
  globalTeardown: "./e2e/support/globalTeardown.ts",

  projects: [
    {
      // Node-only: MCP over stdio, process lifecycle, the resolve and render
      // surfaces. No browser is launched for these.
      name: "harness",
      testMatch: /(mcp|consumer)-.*\.spec\.ts/,
    },
    {
      // Node-only: the read-only JSON API and its SSE stream, over HTTP.
      name: "api",
      testMatch: /api-.*\.spec\.ts/,
    },
    {
      // The built Vue admin client, in a real browser.
      name: "ui",
      testMatch: /client-.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
      },
    },
  ],
});
