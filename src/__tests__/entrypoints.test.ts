// A dependency starts nothing; an application starts everything.
//
// The 0.1.0 tarball had one entry point that was both. Importing it from a
// consuming project opened a database and bound the web UI's port, and hours
// later that listener was still up -- a stale server, serving another
// project's code, holding a port a different application then reported as an
// already-running instance of itself.
//
// So the split is load-bearing and both halves are asserted here, from the
// outside, by running them:
//
//   * the library entry is imported in a child process. If importing it leaves
//     ANY handle open -- a listener, a timer, an open database -- that child
//     never exits, and this test fails on the timeout rather than on a clever
//     assertion about what we think we started. There is no list of things it
//     must not do; it must simply be able to stop.
//   * the executable is spawned and spoken to over stdio in the protocol it
//     serves, with the web UI on (the default) and off (DMCP_NO_HTTP), because
//     "importing does nothing" is only half the fix if running does nothing
//     too.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const LIBRARY_ENTRY = join(REPO_ROOT, "src", "index.ts");
const EXECUTABLE_ENTRY = join(REPO_ROOT, "src", "bin", "run-dmcp.ts");

// The executable announces its listener on stderr in these exact words. This
// is a literal check for a token this codebase writes itself, not an attempt
// to read meaning out of prose.
const LISTENER_ANNOUNCEMENT = "HTTP server running at http://localhost:";

const SPAWN_TIMEOUT_MS = 30_000;

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** An environment with nothing configured -- what a consumer's process looks like. */
function bareEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    XDG_DATA_HOME: join(dir, "xdg-that-does-not-exist"),
  };
  // src/test-setup.ts pins this process-wide so no test can open the real
  // database. The child must run WITHOUT it, or the assertion that importing
  // creates no database file would be testing the safety net instead.
  delete env.DMCP_DB_PATH;
  return env;
}

/** Claim an ephemeral port, then release it, so we know a port nothing is using. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolveListening) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const settle = (answer: boolean) => {
      socket.destroy();
      resolveListening(answer);
    };
    socket.setTimeout(2_000);
    socket.on("connect", () => settle(true));
    socket.on("timeout", () => settle(false));
    socket.on("error", () => settle(false));
  });
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a child to completion, or give up on it. */
function runToCompletion(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env });
    children.push(child);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveRun({ code: null, stdout, stderr, timedOut: true });
    }, SPAWN_TIMEOUT_MS - 5_000);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut: false });
    });
  });
}

/**
 * Start the executable and complete one MCP `initialize` handshake with it
 * over stdio, returning that reply plus everything it said on stderr.
 *
 * The reply is also the synchronisation point for the web UI assertions: the
 * executable starts the HTTP server before it connects the stdio transport, so
 * by the time a response to `initialize` exists, the listener either came up
 * or was never going to.
 */
function speakMcp(
  entry: string,
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ reply: Record<string, unknown>; stderr: string; child: ChildProcess }> {
  return new Promise((resolveMcp, rejectMcp) => {
    const child = spawn(TSX, [entry], { cwd: options.cwd, env: options.env });
    children.push(child);

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      rejectMcp(new Error(`no MCP reply within the timeout.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, SPAWN_TIMEOUT_MS - 5_000);

    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split("\n");
      // The last element is a partial line until a newline arrives.
      for (const line of lines.slice(0, -1)) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          clearTimeout(timer);
          resolveMcp({ reply: message, stderr, child });
          return;
        }
      }
    });

    child.on("error", rejectMcp);

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "entrypoint-test", version: "0" },
        },
      }) + "\n"
    );
  });
}

afterEach(() => {
  while (children.length) children.pop()?.kill("SIGKILL");
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("the library entry", () => {
  it(
    "can be imported and exits on its own: no listener, no database, no open handle",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const dir = tempDir("run-dmcp-library-");
      const port = await freePort();

      // A consumer's import, in a process of its own.
      const probe = join(dir, "import-the-library.mts");
      writeFileSync(
        probe,
        `await import(${JSON.stringify(pathToFileURL(LIBRARY_ENTRY).href)});\n` +
          `console.log("LIBRARY ENTRY IMPORTED");\n`
      );

      const result = await runToCompletion(TSX, [probe], {
        cwd: dir,
        env: { ...bareEnv(dir), DMCP_HTTP_PORT: String(port) },
      });

      expect(
        result.timedOut,
        "importing the library entry left a handle open, so the process could not exit. " +
          "A dependency must be able to stop.\n" +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      ).toBe(false);
      expect(result.stdout).toContain("LIBRARY ENTRY IMPORTED");
      expect(result.code, `stderr:\n${result.stderr}`).toBe(0);

      // ...and specifically, none of the three things 0.1.0 did on import.
      expect(result.stderr).not.toContain(LISTENER_ANNOUNCEMENT);
      expect(await isListening(port)).toBe(false);
      expect(
        existsSync(join(dir, "data")),
        "importing the library created a database directory in the consumer's working directory"
      ).toBe(false);
    }
  );
});

describe("the executable", () => {
  it(
    "serves MCP over stdio and the web UI on DMCP_HTTP_PORT",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const dir = tempDir("run-dmcp-app-http-");
      const port = await freePort();

      const { reply, stderr } = await speakMcp(EXECUTABLE_ENTRY, {
        cwd: dir,
        env: {
          ...bareEnv(dir),
          DMCP_DB_PATH: join(dir, "games.db"),
          DMCP_HTTP_PORT: String(port),
        },
      });

      const result = reply.result as { serverInfo?: { name?: string } } | undefined;
      expect(result?.serverInfo?.name).toBe("dmcp");
      expect(stderr).toContain(`${LISTENER_ANNOUNCEMENT}${port}`);
      expect(await isListening(port)).toBe(true);

      // An application, unlike a library, is expected to own its database.
      expect(existsSync(join(dir, "games.db"))).toBe(true);
    }
  );

  it(
    "still serves MCP over stdio with DMCP_NO_HTTP set, and binds no port",
    { timeout: SPAWN_TIMEOUT_MS },
    async () => {
      const dir = tempDir("run-dmcp-app-nohttp-");
      const port = await freePort();

      const { reply, stderr } = await speakMcp(EXECUTABLE_ENTRY, {
        cwd: dir,
        env: {
          ...bareEnv(dir),
          DMCP_DB_PATH: join(dir, "games.db"),
          DMCP_HTTP_PORT: String(port),
          DMCP_NO_HTTP: "1",
        },
      });

      const result = reply.result as { serverInfo?: { name?: string } } | undefined;
      expect(result?.serverInfo?.name).toBe("dmcp");
      expect(stderr).not.toContain(LISTENER_ANNOUNCEMENT);
      expect(
        await isListening(port),
        "DMCP_NO_HTTP was set and the executable bound the port anyway"
      ).toBe(false);
    }
  );
});
