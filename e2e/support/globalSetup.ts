// Brings the application up once, for the whole acceptance run, and proves it
// is actually ready before handing control to the specs. "Ready" means two
// things, both checked, neither assumed: the server child has published its
// handshake, AND the application's own HTTP server answers a real request --
// a process that is merely alive is not the same claim as a process that is
// serving.
//
// PER-RUN ISOLATION. Every invocation of this file gets its own directory
// under E2E_TMP (`run-<pid>-<random>/`), holding that run's handshake.json
// and teardown.json. This is not tidiness: two acceptance runs on one
// machine -- two developers, two CI jobs, an agent iterating while another
// does -- used to share one fixed handshake path, so whichever run started
// second would delete the first run's handshake, and whichever run's
// globalTeardown finished first would SIGTERM the other run's still-working
// server. A fresh directory per run makes that collision unconstructable
// instead of merely unlikely -- see handshakePath()'s doc comment in
// handshake.ts for the same reasoning from the reader's side.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDb } from "./tempDb.js";
import { E2E_TMP, runDirHandshakePath, readHandshake } from "./handshake.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

const READY_DEADLINE_MS = 45_000;
const POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Fails fast, before spawning anything, if the built artifact this suite
 * exists to accept is missing -- rather than letting the server child crash
 * three seconds from now with a confusing MODULE_NOT_FOUND against
 * `dist/tools/game.js` and no context for why.
 */
function assertBuilt(): void {
  const missing: string[] = [];
  if (!existsSync(join(REPO_ROOT, "dist"))) missing.push("dist/");
  if (!existsSync(join(REPO_ROOT, "client", "dist"))) missing.push("client/dist/");
  if (missing.length > 0) {
    throw new Error(
      `Acceptance setup: ${missing.join(" and ")} missing. This suite exercises the built artifact, not ` +
        `TypeScript sources -- run 'npm run build' first, or use 'npm run test:acceptance', which builds ` +
        `before running Playwright.`
    );
  }
}

export default async function globalSetup(): Promise<void> {
  assertBuilt();

  mkdirSync(E2E_TMP, { recursive: true });

  // This run's own directory -- never a fixed, shared path. No stale file
  // from a previous run can live here, because nothing named this directory
  // before this line ran, so there is nothing to delete on entry (compare
  // the old approach, which had to rmSync a shared handshake.json here and
  // could delete a concurrent run's file instead of its own).
  const runDir = join(E2E_TMP, `run-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(runDir, { recursive: true });
  // Genuinely useful, not just debug noise: with concurrent runs now
  // possible by design, "which directory is THIS run's" is exactly the fact
  // a developer staring at two interleaved stderr streams needs to tell them
  // apart.
  process.stderr.write(`[acceptance] run directory: ${runDir}\n`);
  const runHandshakePath = runDirHandshakePath(runDir);
  const teardownInfoPath = join(runDir, "teardown.json");

  // LOAD-BEARING ASSUMPTION: Playwright's documented behaviour is that
  // environment variables set here, in globalSetup, are visible to the
  // worker processes it later forks for the specs -- so setting
  // E2E_RUN_DIR now is what lets readHandshake() (handshake.ts,
  // via handshakePath()) find THIS run's handshake from inside a spec, with
  // no path threaded through Playwright's own config or fixtures. If that
  // assumption ever stopped holding, the symptom would be a silent fallback
  // to the old shared HANDSHAKE_PATH, not an error -- which is exactly the
  // kind of failure that goes unnoticed until two runs collide again, so it
  // is written down here rather than left to be rediscovered.
  process.env.E2E_RUN_DIR = runDir;

  const tempDb = makeTempDb("http", { webUi: true });

  const tsxBin = join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const serverScript = join(HERE, "serverProcess.ts");

  const child = spawn(tsxBin, [serverScript], {
    cwd: REPO_ROOT,
    // The child gets its own explicit E2E_HANDSHAKE_PATH rather than being
    // left to derive it from E2E_RUN_DIR itself -- serverProcess.ts is a
    // separately spawned process (not a Playwright worker), so it is not
    // covered by the same "Playwright forwards globalSetup's env" guarantee
    // this file leans on above; it gets its instructions the ordinary way,
    // through the env block handed to spawn().
    env: { ...tempDb.env, E2E_HANDSHAKE_PATH: runHandshakePath },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let stderrBuffer = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    process.stderr.write(chunk);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    // The server child is instructed to log to stderr only; anything on
    // stdout is unexpected, but swallowing it silently would hide a
    // regression of that rule. Echo it, don't fold it into the same buffer
    // readiness-failure messages are built from.
    process.stderr.write(`[server child stdout] ${chunk.toString()}`);
  });

  let childExited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on("exit", (code, signal) => {
    childExited = { code, signal };
  });

  // Deliberately does NOT kill the child or clean up the temp database
  // itself -- the surrounding try/catch does both, once, for every failure
  // path (this one and any unexpected exception alike), so there is exactly
  // one place that owns "what happens when setup doesn't finish."
  const failSetup = (message: string): never => {
    throw new Error(`${message}\n\n--- server child stderr ---\n${stderrBuffer || "(nothing captured)"}`);
  };

  try {
    const deadline = Date.now() + READY_DEADLINE_MS;
    let baseURL: string | null = null;

    while (Date.now() < deadline) {
      if (childExited !== null) {
        const { code, signal } = childExited as { code: number | null; signal: NodeJS.Signals | null };
        failSetup(`Acceptance setup: server child exited early (code=${code}, signal=${signal}) before becoming ready.`);
      }

      if (baseURL === null && existsSync(runHandshakePath)) {
        try {
          // readHandshake() resolves via handshakePath() -> E2E_RUN_DIR,
          // which was set above to THIS run's directory -- so this reads
          // exactly runHandshakePath, through the one function every spec
          // also reads it through, rather than a second parse of the same
          // file living here.
          baseURL = readHandshake().baseURL;
        } catch {
          // Caught the rename mid-flight despite it being atomic-on-POSIX --
          // exceedingly unlikely, but if JSON.parse ever does see a partial
          // file, treat it the same as "not published yet" and keep polling
          // rather than failing on a transient read.
          baseURL = null;
        }
      }

      if (baseURL !== null) {
        try {
          const response = await fetch(`${baseURL}/api/games`);
          if (response.ok) {
            // Ready: published its handshake AND is actually serving.
            writeFileSync(
              teardownInfoPath,
              JSON.stringify({ pid: child.pid, dataDir: tempDb.dataDir }, null, 2),
              "utf8"
            );
            return;
          }
        } catch {
          // Not accepting connections yet -- keep polling.
        }
      }

      await sleep(POLL_INTERVAL_MS);
    }

    failSetup(
      `Acceptance setup: server child did not become ready within ${READY_DEADLINE_MS}ms ` +
        `(handshake ${baseURL !== null ? "published" : "never appeared"}).`
    );
  } catch (error) {
    // Every failure reaching here -- an explicit failSetup() call above, or
    // any unexpected exception elsewhere in the try block -- still needs the
    // same cleanup, so it lives here, once, rather than duplicated at every
    // call site: kill the child if it is still running, remove the temp
    // database, and remove this run's own directory (nothing else will ever
    // clean it up, since teardown.json was never written into it).
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    tempDb.cleanup();
    rmSync(runDir, { recursive: true, force: true });
    throw error;
  }
}
