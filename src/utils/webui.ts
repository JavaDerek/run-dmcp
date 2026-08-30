import { createLogger } from "./logger.js";

const log = createLogger("webui");

/**
 * Port the web UI listens on when nothing says otherwise.
 */
export const DEFAULT_HTTP_PORT = 3456;

/**
 * Which port the web UI should listen on, read from an environment rather than
 * from the ambient process, so the answer can be tested from a value.
 *
 * An out-of-range or unparseable DMCP_HTTP_PORT falls back to the default. The
 * inherited code did `parseInt(value || "3456", 10)` and handed the NaN
 * straight to `listen()`, which quietly bound a random port instead -- an
 * operator who mistyped a port got a working server on an address they could
 * not predict. `0` is kept, because that is the real way to ask for any free
 * port.
 */
export function httpPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DMCP_HTTP_PORT;
  if (!raw) return DEFAULT_HTTP_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log.warn("DMCP_HTTP_PORT is not a port number; using the default", {
      value: raw,
      default: DEFAULT_HTTP_PORT,
    });
    return DEFAULT_HTTP_PORT;
  }
  return port;
}

/**
 * Whether the executable should serve the web UI.
 *
 * The web UI is an application's feature, not a library's: a process that only
 * needs the engine has no use for an admin page, and one that starts a server
 * squats a port and cannot exit. Importing this package therefore starts
 * nothing at all (see src/index.ts), and the shipped executable serves the
 * web UI by default -- unless DMCP_NO_HTTP says not to, which is what a host
 * that spawns this as an MCP subprocess sets for it.
 *
 * `0`, `false` and an empty value leave it on, because a launcher that writes
 * `DMCP_NO_HTTP=${disabled ? 1 : 0}` means the web UI to run when it writes 0.
 * These are literal tokens in a variable this project defines, not an attempt
 * to read intent out of prose.
 */
export function webUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DMCP_NO_HTTP;
  if (!raw) return true;
  const value = raw.trim().toLowerCase();
  return value === "0" || value === "false";
}

/**
 * Actual port the HTTP server is running on (set at runtime)
 */
let actualHttpPort: number | null = null;

/**
 * Set the actual HTTP port after server starts
 */
export function setHttpPort(port: number): void {
  actualHttpPort = port;
}

/**
 * Get the base URL for the HTTP web UI
 */
export function getWebUiBaseUrl(): string {
  const port = actualHttpPort ?? httpPortFromEnv();
  return `http://localhost:${port}`;
}

/**
 * Get the web UI URL for a game
 */
export function getGameUrl(gameId: string): string {
  return `${getWebUiBaseUrl()}/games/${gameId}`;
}

/**
 * Get the web UI URL for a character
 */
export function getCharacterUrl(characterId: string): string {
  return `${getWebUiBaseUrl()}/characters/${characterId}`;
}

/**
 * Get the web UI URL for a location
 */
export function getLocationUrl(locationId: string): string {
  return `${getWebUiBaseUrl()}/locations/${locationId}`;
}
