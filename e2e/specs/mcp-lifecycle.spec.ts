// Proves the shipped executable's process lifecycle -- the guarantees a unit
// test cannot make, because a unit test never leaves its own process. This
// suite starts and stops REAL `dist/bin/run-dmcp.js` child processes and
// checks what survives between them: the database file, and the process's
// own exit behavior.
//
// Three things, each its own test:
//   1. "Quit and resume" -- state written by one process is still there when
//      a second process opens the SAME database file.
//   2. DMCP_NO_HTTP=1 actually disables the web UI, evidenced by the child's
//      own stderr log line (src/utils/webui.ts / src/bin/run-dmcp.ts) --
//      not by probing a port, which this suite's own instructions call out
//      as unsafe: assuming port 3456 is free on the machine running the
//      test is exactly the kind of environmental assumption that makes a
//      suite flaky somewhere it has never run before.
//   3. A real SIGTERM is handled by run-dmcp.ts's own handler (exit code 0,
//      not the OS default disposition) and does not corrupt the database.
import { test, expect } from "@playwright/test";
import { makeTempDb } from "../support/tempDb.js";
import { startShippedServer, spawnShippedServerRaw } from "../support/mcpClient.js";

/**
 * Polls a predicate on a short interval up to a deadline, rather than a
 * fixed sleep -- the stderr text this suite waits for can arrive on either
 * side of `client.connect()` resolving (it is a separate pipe from the
 * stdio JSON-RPC channel), so a fixed wait would either be too short on a
 * loaded machine or needlessly long on a fast one.
 */
async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitUntil: timed out after ${timeoutMs}ms waiting for: ${description}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

test.describe("process lifecycle: state persists across a restart", () => {
  test("a game, its resources and a value change written by one process are all still there when a second process opens the same database file", async () => {
    const temp = makeTempDb("lifecycle-restart");
    try {
      let gameId: string;
      let resourceId: string;

      const first = await startShippedServer("lifecycle-restart-1", { dbPath: temp.dbPath });
      try {
        const game = (await first.call("create_game", {
          name: "restart test",
          setting: "test",
          style: "test",
        })) as { id: string };
        gameId = game.id;
        await first.call("declare_time_axis", { gameId, axis: { kind: "sequence" } });

        const resource = (await first.call("create_resource", {
          gameId,
          ownerType: "game",
          name: "mill_stock",
          value: 10,
        })) as { id: string };
        resourceId = resource.id;

        const updated = (await first.call("update_resource_value", {
          resourceId: resource.id,
          mode: "delta",
          value: 15,
        })) as { resource: { value: number } };
        expect(updated.resource.value).toBe(25);
      } finally {
        // Waits for the process to actually exit before the second harness
        // ever tries to open its file -- see mcpClient.ts's close().
        await first.close();
      }

      const second = await startShippedServer("lifecycle-restart-2", { dbPath: temp.dbPath });
      try {
        const game = (await second.call("load_game", { gameId })) as { id: string; name: string };
        expect(game.id).toBe(gameId);
        expect(game.name).toBe("restart test");

        const resource = (await second.call("get_resource", { resourceId })) as {
          name: string;
          value: number;
        };
        expect(resource.name).toBe("mill_stock");
        // 10 + 15, carried across the full process restart -- not merely
        // held in the first process's memory.
        expect(resource.value).toBe(25);

        const time = (await second.call("get_story_time", { gameId })) as { t: number };
        expect(typeof time.t).toBe("number");
      } finally {
        await second.close();
      }
    } finally {
      // Neither harness owns this directory -- both were given an explicit
      // dbPath, so mcpClient.ts's close() deliberately leaves it alone (see
      // its doc comment). This test created it, so this test removes it.
      temp.cleanup();
    }
  });
});

test.describe("process lifecycle: DMCP_NO_HTTP=1 binds no port", () => {
  test("the child reports the web UI disabled rather than binding a port", async () => {
    const harness = await startShippedServer("lifecycle-no-http");
    try {
      // The startup log line is written before the MCP transport ever
      // connects (src/bin/run-dmcp.ts calls it ahead of
      // `server.connect(transport)`), but it travels over a separate pipe
      // (stderr) from the one the initialize handshake completes over, so
      // polling with a bounded deadline is the honest way to wait for it
      // rather than assuming it already arrived the instant connect()
      // resolved.
      await waitUntil(
        () => harness.stderr().includes("Web UI disabled by DMCP_NO_HTTP"),
        "the child's stderr to report the web UI disabled"
      );
      // A literal check for a token this project defined in output this
      // project generated (src/bin/run-dmcp.ts's own log.info call) -- not
      // language understanding, and not a stand-in for actually asking the
      // OS whether a port is bound. Deliberately NOT probing localhost:3456
      // here: this suite's own instructions call that unsafe, since nothing
      // guarantees that port is free on whatever machine runs this test,
      // and a bind failure on an already-occupied 3456 would be
      // indistinguishable from "correctly did not bind anything".
      expect(harness.stderr()).toContain("no port will be bound");
    } finally {
      await harness.close();
    }
  });
});

test.describe("process lifecycle: SIGTERM", () => {
  test("a real SIGTERM exits cleanly with code 0, and the database is intact afterward", async () => {
    const temp = makeTempDb("lifecycle-sigterm");
    try {
      let gameId: string;
      let resourceId: string;

      // Write some state through a normal, fully-closed harness first, so
      // this test can prove the SIGTERM path leaves EXISTING data intact --
      // not merely that an empty file survives.
      const writer = await startShippedServer("lifecycle-sigterm-writer", { dbPath: temp.dbPath });
      try {
        const game = (await writer.call("create_game", {
          name: "sigterm test",
          setting: "test",
          style: "test",
        })) as { id: string };
        gameId = game.id;
        await writer.call("declare_time_axis", { gameId, axis: { kind: "sequence" } });
        const resource = (await writer.call("create_resource", {
          gameId,
          ownerType: "game",
          name: "granary_reserve",
          value: 30,
        })) as { id: string };
        resourceId = resource.id;
      } finally {
        await writer.close();
      }

      // A raw child, no MCP client attached -- this test needs the actual
      // ChildProcess to read back a real exit code, which
      // StdioClientTransport's own close() sequence (used everywhere else
      // in this suite) never exposes. See spawnShippedServerRaw's doc
      // comment in mcpClient.ts.
      const raw = spawnShippedServerRaw(temp.dbPath);
      let stderrBuffer = "";
      raw.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString("utf8");
      });

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        raw.once("exit", (code, signal) => resolveExit({ code, signal }));
      });

      // Wait for proof the process actually got as far as opening the
      // database and initializing its schema (the same log line the
      // no-HTTP test above waits for) before sending the signal -- sending
      // it any earlier would still be a valid test of the handler, but this
      // way the test is provably exercising a live, fully-started server,
      // not a lucky race against process startup.
      await waitUntil(
        () => stderrBuffer.includes("Web UI disabled by DMCP_NO_HTTP"),
        "the raw child to finish starting up"
      );

      raw.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("process did not exit within 5000ms of SIGTERM")), 5000)
        ),
      ]);

      // Exit code 0 specifically, not merely "the process ended" -- proof
      // that src/bin/run-dmcp.ts's own `process.on("SIGTERM", () => {
      // closeDatabase(); process.exit(0); })` ran, rather than the OS's
      // default disposition for an unhandled SIGTERM (no exit code at all:
      // `code` would be null and `signal` would be "SIGTERM").
      expect(result.signal).toBeNull();
      expect(result.code).toBe(0);

      // Restart on the same file and read the pre-existing state back --
      // the database was not left corrupted or partially written by the
      // signal.
      const reader = await startShippedServer("lifecycle-sigterm-reader", { dbPath: temp.dbPath });
      try {
        const game = (await reader.call("load_game", { gameId })) as { id: string };
        expect(game.id).toBe(gameId);
        const resource = (await reader.call("get_resource", { resourceId })) as { value: number };
        expect(resource.value).toBe(30);
      } finally {
        await reader.close();
      }
    } finally {
      temp.cleanup();
    }
  });
});
