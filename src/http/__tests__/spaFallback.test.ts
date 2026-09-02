// The SPA fallback must serve index.html no matter where this package is
// installed -- including under a directory whose name begins with a dot.
//
// THE BUG THIS PINS. `res.sendFile(absolutePath)` with no `root` option hands
// the WHOLE absolute path to `send`, and `send`'s `dotfiles` option defaults
// to "ignore". So if any segment of the installation path starts with a dot,
// `send` refuses the file with NotFoundError, the error handler turns that
// into a 500, and EVERY client-side route breaks at once -- while `/` keeps
// working, because `/` is served by `express.static`, which dotfile-checks
// only the REQUEST path and not its own root. An operator sees a working home
// page, a 500 on every deep link, an index.html that is plainly present on
// disk, and no explanation.
//
// It was found by the acceptance suite's deep-link spec, in a git worktree
// living under `.claude/worktrees/`, and it is not a hypothetical: a deploy
// under `~/.local/share`, a CI checkout in a dotted cache directory, or any
// tool that stages a working copy inside its own dot directory reproduces it
// exactly.
//
// The guard being disabled protects nothing here. It exists to stop a
// USER-SUPPLIED path from reaching `.env` or `.git`; the path in question is
// a server-controlled constant (CLIENT_DIST plus a literal file name), and no
// part of it comes from the request.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHttpServer } from "../server.js";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";

const SHELL_HTML = "<!doctype html><title>shell</title><div id=\"app\"></div>";

const openServers: Server[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const server of openServers.splice(0)) server.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Binds on port 0 and returns the origin the OS actually gave us. */
async function listen(app: express.Express): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      openServers.push(server);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error(`expected a bound AddressInfo, got ${JSON.stringify(addr)}`));
        return;
      }
      resolve(`http://127.0.0.1:${addr.port}`);
    });
    server.on("error", reject);
  });
}

/** A directory containing index.html, nested under a dot segment. */
function stageDottedShell(): string {
  const base = mkdtempSync(join(tmpdir(), "spa-fallback-"));
  tempDirs.push(base);
  const dir = join(base, ".hidden", "worktrees", "checkout", "client", "dist");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), SHELL_HTML);
  return dir;
}

describe("SPA fallback serves index.html from a dot-segment installation path", () => {
  // These two tests are deliberately a matched pair. The first proves the
  // option is what fixes it; the second proves the default is what broke it.
  // Without the second, the first would keep passing if someone removed the
  // option AND the mechanism changed underneath -- and this file would be
  // guarding a rule nobody could see the shape of any more.
  it("serves the shell for a deep link when sendFile is given dotfiles: allow -- the call shape server.ts uses", async () => {
    const dir = stageDottedShell();
    const app = express();
    app.get("/{*path}", (_req, res) => {
      res.sendFile(join(dir, "index.html"), { dotfiles: "allow" });
    });

    const origin = await listen(app);
    const response = await fetch(`${origin}/games/abc-123`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<div id=\"app\">");
  });

  it("refuses that same file at the default dotfiles setting -- the behaviour that made every deep link 500", async () => {
    const dir = stageDottedShell();
    const app = express();
    app.get("/{*path}", (_req, res) => {
      res.sendFile(join(dir, "index.html"));
    });

    const origin = await listen(app);
    const response = await fetch(`${origin}/games/abc-123`);

    // 404 from `send` itself here. In the real server this same refusal
    // arrives at the error handler and is reported as a 500, which is what
    // made it so hard to read.
    expect(response.status).toBe(404);
  });
});

describe("the real server's SPA fallback", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const CLIENT_INDEX = join(HERE, "..", "..", "..", "client", "dist", "index.html");

  // createHttpServer() does not bring up a schema -- an application does that
  // (src/bin/run-dmcp.ts), which is exactly the library/application split
  // CLAUDE.md calls load-bearing. So the API route below needs the ordinary
  // in-memory fixture underneath it, or listGames() throws against a database
  // with no tables and the route answers 500 for a reason that has nothing to
  // do with routing.
  beforeEach(() => {
    createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  // Only meaningful once the client has been built. `npm run test:run` does
  // not build it (CI's unit job installs client deps but never runs vite), so
  // this skips there rather than failing for a reason that has nothing to do
  // with the code under test. The acceptance suite always builds first, and
  // covers this same route against the real server every run -- so the
  // guarantee is enforced in CI by that job, and this test is the fast local
  // signal.
  it.skipIf(!existsSync(CLIENT_INDEX))(
    "answers a deep link with the built shell rather than a 500",
    async () => {
      const origin = await listen(createHttpServer() as unknown as express.Express);

      const response = await fetch(`${origin}/games/some-game-id`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    }
  );

  it.skipIf(!existsSync(CLIENT_INDEX))("still routes /api/ past the fallback rather than swallowing it", async () => {
    const origin = await listen(createHttpServer() as unknown as express.Express);

    const response = await fetch(`${origin}/api/games`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
