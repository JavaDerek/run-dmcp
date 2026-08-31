// The other half of the consumer-shaped assembly harness.
//
// consumerServer.ts is the consumer; this file is how a spec talks to it.
// Two shapes are exposed, because this harness has to prove two different
// things:
//
//   - `connectConsumer` -- a real MCP `initialize` handshake over stdio
//     against `tsx consumerServer.ts`, mirroring e2e/support/mcpClient.ts's
//     `startShippedServer` closely enough that a reader who already knows
//     that harness recognises this one immediately. The difference is the
//     command line: that file spawns the SHIPPED BINARY
//     (dist/bin/run-dmcp.js), which registers no mechanics and no
//     vocabulary at all; this one spawns THIS harness's own consumer
//     script through `tsx`, injecting both. Two different server
//     assemblies need two different launchers -- reusing mcpClient.ts's
//     would silently test the wrong process.
//
//   - `spawnConsumerServerProcess` -- a raw child process, no MCP handshake
//     attempted at all. Exists for exactly one scenario: a consumer server
//     configured to inject a malformed vocabulary must fail BEFORE it ever
//     connects a transport (design §7, enforced at construction). A client
//     built to complete a handshake has no honest way to observe "the
//     server never tried" -- it can only time out, which would make a
//     real regression (the process hangs instead of failing fast) look
//     identical to the thing under test. Watching the raw process exit is
//     the only shape that actually distinguishes them.
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeTempDb, type TempDb } from "./tempDb.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CONSUMER_SERVER_ENTRY = join(HERE, "consumerServer.ts");

/**
 * `NodeJS.ProcessEnv` types every value as possibly `undefined`;
 * `StdioServerParameters.env`/`child_process.spawn`'s `env` both want a
 * plain `Record<string, string>`. Same gap `mcpClient.ts`'s `toChildEnv`
 * closes, for the identical reason -- kept as a private copy here rather
 * than imported, since that file is owned by another harness and this one
 * must not reach into it.
 */
function toChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The first `text` content block of a tool result, or `""` if there is none. */
export function textOf(result: CallToolResult): string {
  const block = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
  return block?.text ?? "";
}

/**
 * Polls `process.kill(pid, 0)` (throws once the pid is gone -- signal 0
 * sends nothing, it only checks existence) up to a deadline. A poll against
 * a real OS-level fact, not a fixed sleep standing in for one -- the same
 * technique `mcpClient.ts`'s `waitForExit` uses, kept as a private copy for
 * the same "don't reach into another harness's file" reason as `toChildEnv`.
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
      throw new Error(`consumerClient: server process ${pid} did not exit within ${deadlineMs}ms of close()`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface ConsumerHarness {
  client: Client;
  /**
   * Calls a tool and returns its parsed result. Every tool this engine
   * registers that succeeds returns a JSON object -- this parses it; a tool
   * that ever returned plain text would fall back to the raw string, the
   * same tolerance `mcpClient.ts`'s `call` uses.
   *
   * Throws when the call comes back `isError: true`, folding the tool's own
   * text into the thrown message, so a failing assertion reads as "tool X
   * said: <the server's own words>" rather than a bare rejection.
   */
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** The raw `CallToolResult`, for a spec that needs to assert `isError`/`reason` itself. */
  callRaw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  listToolNames(): Promise<string[]>;
  /** Everything the child has written to stderr so far, accumulated since spawn. */
  stderr(): string;
  dbPath: string;
  dataDir: string;
  /** Closes the client/transport and waits for the child process to actually exit, then removes its temp directory. */
  close(): Promise<void>;
}

export interface ConnectConsumerOptions {
  /** Shapes the temp-db directory name; defaults to "consumer". */
  label?: string;
  /** Extra env vars layered over `makeTempDb`'s hermetic env -- e.g. a
   *  harness-defined flag consumerServer.ts reads (E2E_BAD_VOCABULARY). */
  extraEnv?: Record<string, string>;
  /** Milliseconds to wait for the initialize handshake before giving up.
   *  Defaults to 15s -- comfortably under playwright.config.ts's 60s test
   *  timeout, so a server that never connects fails the test with a clear
   *  MCP timeout message instead of the runner's own generic one. */
  connectTimeoutMs?: number;
}

/**
 * Spawns `tsx e2e/support/consumerServer.ts` and completes a real MCP
 * `initialize` handshake against it over stdio -- the consumer-shaped
 * equivalent of `mcpClient.ts`'s `startShippedServer`, against a DIFFERENT
 * server assembly (see this module's own doc comment).
 *
 * Owns a fresh `makeTempDb()` temp directory for the lifetime of the
 * returned harness; `close()` removes it. One harness per test, nothing
 * left behind -- there is no restart/reopen mode here (unlike
 * `startShippedServer`'s `opts.dbPath`) because nothing in this harness's
 * test plan needs a second process to reopen the first one's database.
 */
export async function connectConsumer(options?: ConnectConsumerOptions): Promise<ConsumerHarness> {
  const label = options?.label ?? "consumer";
  const temp: TempDb = makeTempDb(label);

  const env: NodeJS.ProcessEnv = { ...temp.env, ...(options?.extraEnv ?? {}) };

  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [CONSUMER_SERVER_ENTRY],
    env: toChildEnv(env),
    cwd: REPO_ROOT,
    // "pipe", not the default "inherit" -- so this harness's own stderr
    // stays legible under playwright's serial runner instead of interleaving
    // with every other spec's child, and so `stderr()` below can hand a spec
    // the child's diagnostic output on a failed assertion.
    stderr: "pipe",
  });

  // Per the SDK's own doc comment on `.stderr`: a PassThrough is handed back
  // immediately, specifically so a caller can attach a listener before
  // `start()` (called inside `client.connect()` below) ever runs -- attaching
  // after would risk losing whatever the child wrote in its first moments.
  let stderrBuffer = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  const client = new Client({ name: `run-dmcp-e2e-${label}`, version: "0.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport, { timeout: options?.connectTimeoutMs ?? 15_000 });
  } catch (error) {
    // The handshake never completed -- fold whatever the child said on
    // stderr into the failure, since that is usually the actual reason
    // (a thrown vocabulary/mechanics validation error, a missing dist/
    // build) and the raw MCP timeout alone never names it.
    temp.cleanup();
    throw new Error(
      `consumerClient: failed to connect to consumer server: ${(error as Error).message}\n--- child stderr ---\n${stderrBuffer}`
    );
  }

  const pid = transport.pid;

  async function callRaw(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  }

  async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await callRaw(name, args);
    const text = textOf(result);
    if (result.isError) {
      throw new Error(`MCP tool '${name}' returned an error: ${text}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
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
    temp.cleanup();
  }

  return {
    client,
    call,
    callRaw,
    listToolNames,
    stderr: () => stderrBuffer,
    dbPath: temp.dbPath,
    dataDir: temp.dataDir,
    close,
  };
}

export interface SpawnedConsumerProcess {
  child: ChildProcess;
  /** Everything written to stdout so far. Should stay empty right up until
   *  a JSON-RPC message would appear on it -- a non-empty capture before
   *  that point is itself a bug (something wrote to the wrong stream). */
  stdout(): string;
  /** Everything written to stderr so far. */
  stderr(): string;
  /**
   * Resolves once the child has actually exited, with its exit code/signal.
   * Waits on the real `exit` event (never a sleep); `timeoutMs` is a safety
   * net against a hung child, not a race-avoidance delay -- comfortably
   * under playwright.config.ts's 60s test timeout so a genuine hang still
   * fails with a clear message from THIS function.
   */
  waitForExit(timeoutMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Removes the temp directory this process's database lived in. Safe to call once the process has exited. */
  cleanup(): void;
}

/**
 * Spawns `tsx e2e/support/consumerServer.ts` as a bare child process --
 * deliberately NOT through `StdioClientTransport`/`Client`, and deliberately
 * making no attempt at an MCP handshake. See this module's own doc comment
 * for why: the one thing this function exists to observe is a server that
 * fails BEFORE a transport ever connects, and a tool built to complete a
 * handshake cannot distinguish "refused fast" from "hung" without first
 * timing out either way.
 */
export function spawnConsumerServerProcess(options?: ConnectConsumerOptions): SpawnedConsumerProcess {
  const label = options?.label ?? "consumer-bad-start";
  const temp: TempDb = makeTempDb(label);
  const env: NodeJS.ProcessEnv = { ...temp.env, ...(options?.extraEnv ?? {}) };

  const child = spawn(TSX_BIN, [CONSUMER_SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: toChildEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
  });

  function waitForExit(timeoutMs = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(
          new Error(
            `consumerClient: server process ${child.pid} did not exit within ${timeoutMs}ms -- ` +
              `expected it to fail fast at construction, not hang.\n--- stderr so far ---\n${stderrBuffer}`
          )
        );
      }, timeoutMs);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal });
      });
    });
  }

  return {
    child,
    stdout: () => stdoutBuffer,
    stderr: () => stderrBuffer,
    waitForExit,
    cleanup: () => temp.cleanup(),
  };
}
