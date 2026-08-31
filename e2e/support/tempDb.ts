// The hermeticity guarantee, in one place.
//
// src/test-setup.ts pins DMCP_DB_PATH to ":memory:" for the whole vitest
// process, so no unit test can reach the real database. This suite cannot
// borrow that: an acceptance run needs a database that OUTLIVES a process,
// because half of what it proves is that state survives one -- an HTTP
// server the specs talk to from outside, a stdio server killed and started
// again on the same file. ":memory:" dies with its process by definition.
//
// So the equivalent guarantee is made here instead, and it is made the same
// way: not by asking callers to remember, but by leaving them nothing to
// get wrong. Every entry point below hands back an env block with
// DMCP_DB_PATH already pointing inside a fresh `mkdtemp` directory. There is
// no parameter for "which database", no default that falls through to
// `data/games.db`, and `assertHermetic` re-checks the answer on the way out
// so a future edit that reintroduces one fails loudly here rather than
// quietly writing to a developer's real campaign.
//
// The temp directory matters as much as the file. src/db/connection.ts
// derives `dataDir` from `dirname(dbPath)`, and that directory is where
// media would be written -- so putting the database in a temp directory of
// its own keeps generated files out of the repository too, not just rows.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Environment variables this suite refuses to pass to any child it spawns.
 *
 * Not a credential check for its own sake: run-dmcp's own routing has no
 * vendor client in it, and nothing in this suite calls a model. That is
 * exactly why the list is short and absolute -- there is no legitimate
 * reason for any of these to be set in a process this suite starts, so
 * "none of them, ever" is a rule with no exceptions to argue about, and a
 * leaked key in CI logs is a bad day regardless of who would have spent it.
 */
export const FORBIDDEN_CHILD_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

export interface TempDb {
  /** Fresh directory, created. Also where any media would land. */
  dataDir: string;
  /** The database file inside it. It does not exist until something opens it. */
  dbPath: string;
  /**
   * Environment for a child process: the ambient environment, minus every
   * vendor variable, plus DMCP_DB_PATH pointing at {@link dbPath}.
   * `DMCP_NO_HTTP` is set unless `webUi` was asked for -- a stdio harness
   * has no use for an admin page and squatting a port would be a second
   * reason for it to fail.
   */
  env: NodeJS.ProcessEnv;
  /** Removes the directory and everything in it. Safe to call twice. */
  cleanup(): void;
}

/**
 * A database for one process, in a directory of its own.
 *
 * `label` only shapes the directory name, so a leftover directory in a
 * crashed run says which harness produced it.
 */
export function makeTempDb(label: string, options?: { webUi?: boolean }): TempDb {
  const dataDir = mkdtempSync(join(tmpdir(), `run-dmcp-e2e-${label}-`));
  const dbPath = join(dataDir, "acceptance.db");

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of FORBIDDEN_CHILD_ENV) delete env[key];

  env.DMCP_DB_PATH = dbPath;
  if (options?.webUi) {
    // Port 0: let the OS choose. The child reports back what it got.
    env.DMCP_HTTP_PORT = "0";
    delete env.DMCP_NO_HTTP;
  } else {
    env.DMCP_NO_HTTP = "1";
  }

  assertHermetic(env);

  return {
    dataDir,
    dbPath,
    env,
    cleanup() {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Refuses an environment that could reach the real database or carry a
 * vendor credential into a child.
 *
 * Called on the way out of {@link makeTempDb} rather than only at the call
 * site, so it guards every future caller including ones that build their own
 * env block and pass it through here. Throws rather than warns: a suite that
 * has just been pointed at `data/games.db` should not run at all.
 */
export function assertHermetic(env: NodeJS.ProcessEnv): void {
  const dbPath = env.DMCP_DB_PATH;
  if (!dbPath) {
    throw new Error("Acceptance hermeticity: DMCP_DB_PATH is unset, so this process would open the real database.");
  }
  if (dbPath === ":memory:") {
    throw new Error(
      "Acceptance hermeticity: DMCP_DB_PATH is ':memory:'. That is the unit suite's guarantee and it cannot be " +
        "this one's -- an acceptance run has to outlive a process to prove anything survives one."
    );
  }
  if (!dbPath.startsWith(tmpdir()) && !dbPath.startsWith("/private" + tmpdir()) && !dbPath.startsWith("/tmp")) {
    throw new Error(
      `Acceptance hermeticity: DMCP_DB_PATH is '${dbPath}', which is not inside the system temp directory. ` +
        `Every acceptance database is created by makeTempDb(); nothing in this suite may name a path itself.`
    );
  }
  const leaked = FORBIDDEN_CHILD_ENV.filter((key) => env[key] !== undefined);
  if (leaked.length > 0) {
    throw new Error(
      `Acceptance hermeticity: refusing to spawn a child carrying ${leaked.join(", ")}. Nothing in this suite ` +
        `calls a model, so a vendor variable reaching a child is a mistake with no upside.`
    );
  }
}
