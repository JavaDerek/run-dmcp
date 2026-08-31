// The contract between the acceptance suite's global setup and its specs.
//
// Playwright's `globalSetup` runs in its own process and its workers run in
// theirs, so "which port did the server actually bind, and what is in its
// database" cannot simply be a shared variable. It is a file: the server
// child writes this JSON once it is genuinely listening and genuinely
// seeded, and every spec reads it. A file is deliberate rather than lazy --
// `process.env` mutated in globalSetup reaches workers only by inheritance,
// which is a rule about process ancestry that would quietly stop being true
// the day anything is spawned differently.
//
// EPHEMERAL BY CONSTRUCTION. Nothing here names a port or a database path.
// The server binds port 0 and reports back what it got; the database is a
// file in a fresh temp directory. There is no configuration a developer
// could get wrong that would point this suite at `data/games.db`, because
// there is no configuration at all -- see tempDb.ts.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The acceptance suite's scratch directory. Gitignored; safe to delete. */
export const E2E_TMP = join(HERE, "..", ".tmp");

/** Where the server child publishes {@link Handshake}. */
export const HANDSHAKE_PATH = join(E2E_TMP, "handshake.json");

/**
 * Every id the seed created, so a spec can ask for a specific entity by id
 * rather than by guessing at a name or taking `[0]` off a list. Names are
 * drawn from this engine's throwaway fixture vocabulary -- grain, treasury,
 * population -- which is the only vocabulary a test in this repository may
 * use (root claude.md, engineVocabulary.test.ts).
 */
export interface Seeded {
  gameId: string;
  gameName: string;
  /** The character flagged `isPlayer`. */
  playerCharacterId: string;
  /** A second character, not the player. */
  millerCharacterId: string;
  /** Two connected locations. `mill` is where the player character stands. */
  millLocationId: string;
  granaryLocationId: string;
  factionId: string;
  questId: string;
  itemId: string;
  noteId: string;
  timerId: string;
  secretId: string;
  abilityId: string;
  /** A plain, unconstrained resource -- the control case. */
  grainResourceId: string;
  /**
   * A resource carrying minValue/maxValue AND a declared `bounded`
   * constraint, so a write outside the bounds is REJECTED rather than
   * silently clamped.
   */
  populationResourceId: string;
  populationBounds: { minValue: number; maxValue: number };
  /**
   * Two members of one declared `conserved` set, which must always sum to
   * `total`. The only legal way to move value between them is a transfer.
   */
  conserved: {
    constraintId: string;
    total: number;
    northTreasuryId: string;
    southTreasuryId: string;
  };
  /** A scheduled event carrying an on-expiry consequence. */
  scheduledEventId: string;
  /** The narrative event logged during the seed. */
  narrativeEventId: string;
}

export interface Handshake {
  /** Origin of the application's own read-only HTTP server, e.g. `http://127.0.0.1:53412`. */
  baseURL: string;
  /**
   * Origin of the acceptance suite's OWN control server -- a harness-only
   * side door that performs a mutation through this project's ordinary tool
   * functions so a spec can watch the resulting event arrive on the
   * application's SSE stream.
   *
   * It is emphatically NOT part of the product: it lives in e2e/, runs in
   * the same child process purely so it shares the emitter, and exists
   * because the application's HTTP surface is read-only by design and must
   * stay that way. Proving the stream carries real events needs something
   * to cause one; borrowing the product's own writers from inside the same
   * process is the way to do that without putting a write route on the
   * product.
   */
  controlURL: string;
  /** The temp database this run is bound to. Never `data/games.db`. */
  dbPath: string;
  /** The temp directory holding it -- also where any media would land. */
  dataDir: string;
  /** The server child, so globalTeardown can end it. */
  pid: number;
  seeded: Seeded;
}

/**
 * Reads the handshake, or fails with the instruction that fixes it rather
 * than a bare ENOENT from somewhere deep in a spec.
 */
export function readHandshake(): Handshake {
  if (!existsSync(HANDSHAKE_PATH)) {
    throw new Error(
      `Acceptance handshake missing at ${HANDSHAKE_PATH}. The server child either never came up or ` +
        `never finished seeding. Run the suite through 'npm run test:acceptance', which builds first -- ` +
        `the suite exercises the built artifact in dist/ and client/dist, not the TypeScript sources.`
    );
  }
  return JSON.parse(readFileSync(HANDSHAKE_PATH, "utf8")) as Handshake;
}

/** Absolute URL onto the application server. `path` starts with a slash. */
export function appUrl(path: string): string {
  return `${readHandshake().baseURL}${path}`;
}

/** Absolute URL onto the harness's control server. `path` starts with a slash. */
export function controlUrl(path: string): string {
  return `${readHandshake().controlURL}${path}`;
}
