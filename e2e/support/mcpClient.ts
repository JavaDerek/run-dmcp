// A thin, real MCP client for the shipped executable.
//
// Every other harness in this repository gets to assume its shape: this one
// has to prove it from the outside. There is no shortcut through
// `src/mcp-server.ts` or `src/rpg/index.ts` here -- this file spawns
// `dist/bin/run-dmcp.js` as a real child process and speaks the actual JSON-RPC
// protocol to it over stdio, using the same `@modelcontextprotocol/sdk`
// client a real MCP host would use. A test built on this can fail for a
// reason a unit test never can: a tool registered correctly in TypeScript but
// unreachable over the wire, a schema the SDK itself rejects, a server that
// never finishes its initialize handshake.
//
// Two harnesses run in the SAME suite (mcp-invariants.spec.ts spins up a
// fresh one per test; mcp-lifecycle.spec.ts starts a second process against
// the first process's own database), so `close()` has to be trustworthy: a
// child left holding a SQLite file, or a temp directory left on disk, is
// exactly the kind of cross-test flakiness a serial, single-worker suite
// cannot afford to hide.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDb, assertHermetic, FORBIDDEN_CHILD_ENV } from "./tempDb.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * `dist/`, never `src/`. This suite exercises the built, shipped artifact --
 * the same file `npm start` runs -- not a `tsx`-transpiled stand-in. If this
 * path doesn't exist, `npm run build` hasn't been run, which is exactly what
 * the definition-of-done in the task brief that produced this file calls out
 * as step 1.
 */
const SERVER_ENTRY = join(REPO_ROOT, "dist", "bin", "run-dmcp.js");

/**
 * `NodeJS.ProcessEnv` types every value as possibly `undefined` (a var that
 * was deleted, e.g. by `makeTempDb`'s vendor-stripping loop, or never set).
 * `StdioServerParameters.env` wants a plain `Record<string, string>` -- this
 * is the one place that gap gets closed, so every other function in this
 * file can hand an env block straight from `tempDb.ts` to the transport
 * without re-deriving this filter.
 */
function toChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The same env `makeTempDb` builds, but pointed at a database that already
 * exists -- for the restart test, where a SECOND process must open the
 * FIRST process's own file rather than getting a fresh one. Still runs
 * through `assertHermetic`, for the same reason `makeTempDb` does: a caller
 * building its own env block is exactly the case that guard exists to catch.
 */
function envForExistingDb(dbPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of FORBIDDEN_CHILD_ENV) delete env[key];
  env.DMCP_DB_PATH = dbPath;
  env.DMCP_NO_HTTP = "1";
  assertHermetic(env);
  return env;
}

/** The first `text` content block of a tool result, or `""` if there is none. */
export function textOf(result: CallToolResult): string {
  const block = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
  return block?.text ?? "";
}

/**
 * Waits for a process to actually be gone, not merely for the SDK's own
 * `close()` promise to settle. `StdioClientTransport.close()` races a
 * bounded timeout at each escalation step (graceful, SIGTERM, SIGKILL) and
 * does not itself confirm the final kill landed -- so this polls
 * `process.kill(pid, 0)` (which throws once the pid is gone; see `man 2
 * kill`, signal 0 sends nothing and only checks existence) on a short
 * interval up to a deadline. A poll-with-deadline on a real OS-level fact,
 * not a fixed sleep standing in for one.
 */
async function waitForExit(pid: number, deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH: no such process. It's gone.
    }
    if (Date.now() - start >= deadlineMs) {
      throw new Error(`mcpClient: server process ${pid} did not exit within ${deadlineMs}ms of close()`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface McpHarness {
  client: Client;
  /**
   * Calls a tool and returns its parsed result. Every tool in this codebase
   * that succeeds returns EITHER a JSON object (most of them) or a short
   * plain-text confirmation ("Constraint removed", "Event cancelled") -- this
   * tries JSON.parse first and falls back to the raw string, so a caller
   * never has to know which shape a given tool uses.
   *
   * Throws when the call comes back `isError: true`, with the tool's own
   * text folded into the thrown message -- so a failing assertion in a spec
   * reads as "tool X said: <the server's own words>" instead of a bare
   * "expected resolve, got rejected".
   */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** The raw `CallToolResult`, for a spec that needs to assert `isError` itself. */
  callRaw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  listToolNames(): Promise<string[]>;
  /** Everything the child has written to stderr so far, accumulated since spawn. */
  stderr(): string;
  dbPath: string;
  /** Closes the client/transport and waits for the child process to actually exit. */
  close(): Promise<void>;
}

/**
 * Spawns the shipped `dist/bin/run-dmcp.js` and completes a real MCP
 * `initialize` handshake against it over stdio.
 *
 * With no `opts.dbPath`, this OWNS a fresh `makeTempDb()` temp directory and
 * cleans it up itself inside `close()` -- the common case, one harness per
 * test, nothing left behind. Pass `opts.dbPath` (the `dbPath` a previous
 * harness reported) to open that SAME database from a second process instead
 * -- the "quit and resume" shape -- in which case `close()` leaves the
 * directory alone, because the caller who created it is the one who gets to
 * decide when it's done being needed (see mcp-lifecycle.spec.ts's restart
 * test, which starts a second harness against the first's `dbPath` before
 * ever calling `cleanup()`).
 */
export async function startShippedServer(label: string, opts?: { dbPath?: string }): Promise<McpHarness> {
  let dbPath: string;
  let env: NodeJS.ProcessEnv;
  let ownedCleanup: (() => void) | null = null;

  if (opts?.dbPath) {
    dbPath = opts.dbPath;
    env = envForExistingDb(dbPath);
  } else {
    const temp = makeTempDb(label);
    dbPath = temp.dbPath;
    env = temp.env;
    ownedCleanup = temp.cleanup;
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_ENTRY],
    env: toChildEnv(env),
    // "pipe" so stderr doesn't spam the runner's own output and so the
    // lifecycle spec can assert on the disabled-web-UI log line without
    // racing a shared inherited stream against other harnesses in the suite.
    stderr: "pipe",
  });

  // Per the SDK's own doc comment on `.stderr`: a PassThrough is handed back
  // immediately, specifically so a caller can attach a listener before
  // `start()` (called inside `client.connect()` below) ever runs -- attaching
  // after would risk losing whatever the child wrote in its first moments,
  // which is exactly the "Web UI disabled" line this suite needs.
  let stderrBuffer = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  const client = new Client({ name: `run-dmcp-e2e-${label}`, version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const pid = transport.pid;

  async function callRaw(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  }

  async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await callRaw(name, args);
    const text = textOf(result);
    if (result.isError) {
      throw new Error(`MCP tool '${name}' returned an error: ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function listToolNames(): Promise<string[]> {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  }

  async function close(): Promise<void> {
    await client.close();
    if (pid !== null) {
      await waitForExit(pid);
    }
    ownedCleanup?.();
  }

  return {
    client,
    call,
    callRaw,
    listToolNames,
    stderr: () => stderrBuffer,
    dbPath,
    close,
  };
}

/**
 * Spawns the shipped binary directly, with no MCP client/transport attached
 * -- for a test that needs the raw `ChildProcess`, specifically to send it a
 * real OS signal and read back the real exit code.
 * `StdioClientTransport.close()` (used by every other harness in this file)
 * escalates through graceful-close, SIGTERM, and SIGKILL on its own timers
 * and never surfaces which one actually landed or what the process exited
 * with -- exactly the two facts `mcp-lifecycle.spec.ts`'s SIGTERM test needs
 * to prove `src/bin/run-dmcp.ts`'s own `process.on("SIGTERM", ...)` handler
 * (which calls `closeDatabase()` then `process.exit(0)`) is the thing that
 * ran, rather than the OS's default signal disposition (which would kill the
 * process with no exit code at all -- `code` would be `null` and `signal`
 * would be `"SIGTERM"` instead).
 *
 * Talks no protocol at all: this is for process-lifecycle assertions only.
 * A test that also needs to read or write game state should do that through
 * a real `startShippedServer()` harness before or after this one runs.
 */
export function spawnShippedServerRaw(dbPath: string): ChildProcess {
  const env = envForExistingDb(dbPath);
  return spawn("node", [SERVER_ENTRY], { env: toChildEnv(env), stdio: ["pipe", "pipe", "pipe"] });
}
