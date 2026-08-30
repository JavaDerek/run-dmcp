import Database from "better-sqlite3";
import { dirname, join } from "path";
import { mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { createLogger } from "../utils/logger.js";

const log = createLogger("db");

export interface DataPathInputs {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  exists: (path: string) => boolean;
}

/**
 * Resolve database path with the following priority:
 * 1. `env.DMCP_DB_PATH` -- the explicit path, wins over everything. Passed
 *    through verbatim (including the literal ":memory:"), with
 *    `dataDir = dirname(dbPath)`.
 * 2. The XDG data directory -- `env.XDG_DATA_HOME || join(home, ".local",
 *    "share")`, plus "/dmcp/games.db" -- but only when that directory
 *    already exists. An existing `~/.local/share/dmcp` means a previous
 *    install's data already lives there, and moving the default out from
 *    under it would orphan someone's saved state.
 * 3. Otherwise `join(cwd, "data", "games.db")` -- the CONSUMING
 *    application's working directory. This is the fix for the "installed as
 *    a dependency" bug: the default lands where the application runs, never
 *    where the package is installed. `cwd` and `home` are supplied by the
 *    caller (see `resolveDataPath` below) and the package's own install
 *    location is never an input to this function, so it cannot resolve
 *    there -- structurally, not by a runtime check.
 *
 * Pure and deterministically testable: no ambient reads (`process.env`,
 * `process.cwd()`, `os.homedir()`) and no filesystem access except through
 * the injected `exists`. See `src/db/__tests__/dataPath.test.ts`.
 */
export function resolveDataPathFrom(inputs: DataPathInputs): { dataDir: string; dbPath: string } {
  const { env, cwd, home, exists } = inputs;

  // Priority 1: Explicit environment variable
  if (env.DMCP_DB_PATH) {
    const dbPath = env.DMCP_DB_PATH;
    const dataDir = dirname(dbPath);
    log.info("Using database path from DMCP_DB_PATH", { dbPath });
    return { dataDir, dbPath };
  }

  // Priority 2: XDG Base Directory spec, only if it already exists
  const xdgDataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  const xdgDataDir = join(xdgDataHome, "dmcp");
  const xdgDbPath = join(xdgDataDir, "games.db");

  if (exists(xdgDataDir)) {
    log.info("Using XDG data directory", { dbPath: xdgDbPath });
    return { dataDir: xdgDataDir, dbPath: xdgDbPath };
  }

  // Priority 3: Fallback to the consuming application's working directory
  const fallbackDataDir = join(cwd, "data");
  const fallbackDbPath = join(fallbackDataDir, "games.db");
  log.debug("Using cwd-relative data directory", { dbPath: fallbackDbPath });
  return { dataDir: fallbackDataDir, dbPath: fallbackDbPath };
}

/** Thin real-world wrapper around `resolveDataPathFrom`. */
function resolveDataPath(): { dataDir: string; dbPath: string } {
  return resolveDataPathFrom({
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    exists: existsSync,
  });
}

// Resolved lazily (on first getDatabase() call after startup, or after every
// closeDatabase()) rather than once at module-import time. This makes
// DMCP_DB_PATH re-readable at any point before the first real connection is
// opened -- in particular it lets tests point each database at a fresh
// in-memory instance without fighting ES module caching.
let db: Database.Database | null = null;
let DATA_DIR: string | undefined;
let DB_PATH: string | undefined;

function ensurePathsResolved(): { dataDir: string; dbPath: string } {
  if (DATA_DIR === undefined || DB_PATH === undefined) {
    const resolved = resolveDataPath();
    DATA_DIR = resolved.dataDir;
    DB_PATH = resolved.dbPath;
  }
  return { dataDir: DATA_DIR, dbPath: DB_PATH };
}

export function getDatabase(): Database.Database {
  if (!db) {
    const { dataDir, dbPath } = ensurePathsResolved();

    // In-memory databases have no directory or file to create on disk.
    if (dbPath !== ":memory:" && !existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
      log.info("Created data directory", { path: dataDir });
    }

    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    log.info("Database connection established", { path: dbPath });
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    log.info("Database connection closed");
  }
  // Forget the resolved paths too, so a subsequent getDatabase() call
  // re-reads DMCP_DB_PATH instead of reusing a stale value. This is what
  // lets tests swap DMCP_DB_PATH between runs and get an isolated database.
  DATA_DIR = undefined;
  DB_PATH = undefined;
}

/**
 * Execute multiple operations atomically within a single SQLite transaction.
 *
 * better-sqlite3 transactions are synchronous: `fn` must not be `async` and
 * must not contain `await`. Pass a plain function that only performs
 * synchronous statement executions. If `fn` throws, better-sqlite3 rolls
 * back everything it did and the original error propagates -- no partial
 * writes are left behind. If `fn` returns normally, the transaction commits
 * and its return value is passed through.
 */
export function withTransaction<T>(fn: () => T): T {
  const database = getDatabase();
  return database.transaction(fn)();
}

/**
 * Get the current database path (useful for debugging/logging).
 */
export function getDatabasePath(): string {
  return ensurePathsResolved().dbPath;
}

/**
 * Get the current data directory (for images and other media).
 */
export function getDataDir(): string {
  return ensurePathsResolved().dataDir;
}
