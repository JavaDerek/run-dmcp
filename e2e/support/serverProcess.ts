// The acceptance suite's server child -- run as a standalone process (spawned
// by globalSetup.ts via tsx), never imported by a spec. Its whole job is to
// bring up exactly what a real deployment brings up (schema, seeded state,
// the application's own read-only HTTP server), plus one harness-only side
// door a spec needs to prove the SSE stream carries real events, and then
// publish where all of that ended up so specs can find it.
//
// Everything here goes through the BUILT artifact (`../../dist/`), matching
// seed.ts's own reasoning: this suite exists to accept dist/, not src/.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import express, { Request, Response } from "express";

import { assertHermetic } from "./tempDb.js";
import { handshakePath, type Handshake } from "./handshake.js";
import { seedWorld } from "./seed.js";

import { closeDatabase } from "../../dist/db/connection.js";
import { initializeSchema } from "../../dist/db/schema.js";
import { startHttpServer } from "../../dist/http/server.js";
import { logEvent } from "../../dist/tools/narrative.js";
import { createCharacter } from "../../dist/tools/character.js";
import { createLogger } from "../../dist/utils/logger.js";

const log = createLogger("e2e-server");

// Refuses to run against anything but a temp database. This is the second
// half of the hermeticity guarantee tempDb.ts makes on the parent side --
// makeTempDb() builds a safe env block, but nothing stops a future edit to
// globalSetup.ts from spawning this file with a different one. Checking here
// too means a hermeticity bug fails loudly in THIS process, immediately, not
// three specs later as an obscure assertion failure against the wrong data.
assertHermetic(process.env);

/** Binds `app` on port 0 and resolves the port the OS actually handed back. */
function listenOnRandomPort(app: express.Express): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error(`harness control server: expected a bound AddressInfo, got ${JSON.stringify(addr)}`));
        return;
      }
      resolvePort(addr.port);
    });
    server.on("error", reject);
  });
}

/**
 * The harness's own control server -- NOT part of the product. It lives here,
 * in e2e/, purely because sharing this process is what lets its mutations
 * fire the same `gameEvents` emitter the application's SSE route reads from
 * (src/events/emitter.ts is a module-scope singleton; two processes would
 * each get their own, and a spec watching the app's stream would never see a
 * mutation made from anywhere else). The product's own HTTP surface is
 * read-only by design (src/http/server.ts -- every route is GET) and stays
 * that way; this is a side door that exists only so an acceptance spec has
 * something to poke that produces a real, observable event.
 */
function createControlServer(): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/control/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post("/control/log-event", (req: Request, res: Response) => {
    const { gameId, eventType, content } = req.body as {
      gameId?: string;
      eventType?: string;
      content?: string;
    };
    if (!gameId || !eventType || !content) {
      res.status(400).json({ ok: false, error: "gameId, eventType and content are all required" });
      return;
    }
    try {
      const event = logEvent({ gameId, eventType, content });
      res.json({ ok: true, id: event.id });
    } catch (error) {
      log.error("control/log-event failed", { gameId, eventType, error: (error as Error).message });
      res.status(500).json({ ok: false, error: (error as Error).message });
    }
  });

  app.post("/control/create-character", (req: Request, res: Response) => {
    const { gameId, name } = req.body as { gameId?: string; name?: string };
    if (!gameId || !name) {
      res.status(400).json({ ok: false, error: "gameId and name are both required" });
      return;
    }
    try {
      const character = createCharacter({ gameId, name, isPlayer: false });
      res.json({ ok: true, id: character.id });
    } catch (error) {
      log.error("control/create-character failed", { gameId, name, error: (error as Error).message });
      res.status(500).json({ ok: false, error: (error as Error).message });
    }
  });

  return app;
}

/**
 * Where this run publishes its handshake. globalSetup.ts always sets
 * E2E_HANDSHAKE_PATH explicitly -- this process is a plain spawned child, not
 * a Playwright worker, so it is not covered by the "globalSetup's env
 * reaches workers" guarantee globalSetup.ts's own comment on E2E_RUN_DIR
 * leans on; it gets told directly instead. `handshakePath()` (handshake.ts)
 * is the fallback for a manual run of this script outside the suite (e.g.
 * while developing against it directly) -- never the norm here.
 */
function resolveHandshakePath(): string {
  return process.env.E2E_HANDSHAKE_PATH ?? handshakePath();
}

/**
 * Writes `handshake` so a reader can never observe a half-written file:
 * serialize to a temp path in the same directory, then rename it into place.
 * `renameSync` on the same filesystem is atomic -- globalSetup.ts's poll loop
 * either sees no file yet or sees the complete one, never a partial JSON blob
 * mid-write.
 */
function publishHandshake(handshake: Handshake): void {
  const path = resolveHandshakePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(handshake, null, 2), "utf8");
  renameSync(tmpPath, path);
}

async function main(): Promise<void> {
  const dbPath = process.env.DMCP_DB_PATH;
  if (!dbPath) {
    // assertHermetic() above already refuses an unset DMCP_DB_PATH, so this
    // is unreachable in practice -- kept as a named failure rather than a
    // silent `as string` cast, per the same "never invent a value" reasoning
    // src/timeline/constrained.ts's readLiveValue gives for itself.
    throw new Error("DMCP_DB_PATH is unset after assertHermetic passed -- this should be unreachable");
  }
  // Mirrors src/db/connection.ts's own resolveDataPathFrom(), which derives
  // dataDir the same way (`dirname(dbPath)`) -- using the same function
  // instead of a hand-rolled regex is what keeps this a restatement of that
  // rule rather than a second, subtly different implementation of it.
  const dataDir = process.env.DMCP_DATA_DIR ?? dirname(dbPath);

  log.info("initializing schema", { dbPath });
  initializeSchema();

  log.info("seeding world");
  const seeded = seedWorld();

  log.info("starting application HTTP server");
  const appPort = await startHttpServer(0);

  log.info("starting harness control server");
  const controlApp = createControlServer();
  const controlPort = await listenOnRandomPort(controlApp);

  const handshake: Handshake = {
    baseURL: `http://localhost:${appPort}`,
    controlURL: `http://localhost:${controlPort}`,
    dbPath,
    dataDir,
    pid: process.pid,
    seeded,
  };

  publishHandshake(handshake);
  log.info("handshake published", { baseURL: handshake.baseURL, controlURL: handshake.controlURL });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    try {
      closeDatabase();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  log.error("server child failed to start", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
