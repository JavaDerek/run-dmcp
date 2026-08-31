// Ends what globalSetup.ts started. Runs in the same Node process that ran
// globalSetup.ts (Playwright's single CLI invocation runs setup, the test
// suite, and teardown in one process, forking only its workers) -- which is
// the same load-bearing assumption globalSetup.ts's own comment on
// E2E_RUN_DIR names: an env var set there is still set here. That is what
// lets this file find ITS OWN run's directory without a path threaded
// through Playwright's config, and why it can only ever kill the child that
// same run started -- there is no fixed, shared path left to collide with a
// concurrent run's teardown.
//
// Must never throw on an already-clean state: a suite that failed before
// teardown.json was written, or a server child that already died on its own,
// are both ordinary outcomes here, not bugs in teardown.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const EXIT_POLL_INTERVAL_MS = 100;
const EXIT_POLL_DEADLINE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** True while a process with this pid still exists. Sends no actual signal. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface TeardownInfo {
  pid: number;
  dataDir: string;
}

function readTeardownInfo(path: string): TeardownInfo | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TeardownInfo;
  } catch {
    // A corrupt or partial file here means there is nothing reliable left to
    // act on -- treat it the same as "no teardown info", not a hard failure.
    return null;
  }
}

export default async function globalTeardown(): Promise<void> {
  const runDir = process.env.E2E_RUN_DIR;
  if (!runDir) {
    // Nothing to tear down: either globalSetup never got far enough to
    // establish a run directory (its own catch block already cleaned up
    // whatever it had started in that case), or this process is not the one
    // that ran globalSetup, in which case this run's teardown is not this
    // file's to perform. Either way, silently doing nothing is the honest
    // outcome -- there is no fixed fallback path to guess at any more.
    return;
  }

  const info = readTeardownInfo(join(runDir, "teardown.json"));
  if (info === null) {
    // The run directory exists but never got as far as recording what to
    // tear down (or the file is unreadable) -- still remove the directory
    // itself so it doesn't linger as scratch debris, but there is no pid to
    // signal and no dataDir to remove beyond it.
    rmSync(runDir, { recursive: true, force: true });
    return;
  }

  if (processAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      // Gone between the check above and this call -- fine, that is the
      // outcome being waited for anyway.
    }

    const deadline = Date.now() + EXIT_POLL_DEADLINE_MS;
    while (Date.now() < deadline && processAlive(info.pid)) {
      await sleep(EXIT_POLL_INTERVAL_MS);
    }
    // If it is still alive after the deadline, proceed anyway rather than
    // hang the teardown -- an orphaned process holding a deleted temp
    // directory's file handles open is a smaller problem than a test run
    // that never finishes.
  }

  // Two separate directories, both this run's own and both removed here:
  // `dataDir` is the temp SQLite database (under the OS temp dir, from
  // makeTempDb() in globalSetup.ts); `runDir` is this run's own scratch
  // directory under e2e/.tmp (holding handshake.json and teardown.json).
  // Removing runDir is what makes a run leave no trace of itself once its
  // teardown finishes, matching every other run's teardown doing the same
  // for its own directory and nobody else's.
  rmSync(info.dataDir, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
}
