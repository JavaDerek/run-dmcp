// Proves GET /api/games/:gameId/subscribe is a real, live SSE stream --
// not just a route that returns 200 with the right Content-Type and then
// never says anything.
//
// ORDERING HAZARD, read this before touching this file: src/events/emitter.ts's
// emit() looks up `this.clients.get(event.gameId)` and returns immediately if
// nobody is subscribed (`!gameClients || gameClients.size === 0`) -- it does
// not queue, buffer, or replay. A subscriber that connects AFTER the mutation
// fires simply never learns it happened; there is no missed-event channel to
// catch up on. So every test below opens the stream and confirms the initial
// `connected` frame arrived -- proof the subscription is registered in
// gameEvents -- BEFORE it POSTs to the harness control server to cause the
// mutation. Reordering that (mutate first, subscribe after) does not make the
// test flaky; it makes it deterministically wrong, waiting on a frame that
// was never sent.
//
// EVENT-DRIVEN, NOT TIMED: every wait below is a promise that resolves the
// moment a matching frame is parsed off the stream, raced against a timeout
// that exists only to fail with a useful message if the frame never comes.
// No sleep-then-assert anywhere in this file.
import { test, expect } from "@playwright/test";

import { readHandshake, appUrl, controlUrl } from "../support/handshake.js";

interface SSEFrame {
  type: string;
  gameId: string;
  entityId?: string;
  entityType?: string;
  timestamp: string;
  data?: unknown;
}

const FRAME_WAIT_TIMEOUT_MS = 10_000;

/**
 * Opens an SSE connection and hands back a reader plus a way to wait for a
 * frame matching `predicate`. Every frame seen (matching or not -- a `ping`
 * keep-alive could in principle interleave) is pushed through the pending
 * waiters so a test can register its wait either before or after the frame
 * it cares about has already arrived mid-read-loop.
 */
async function openStream(gameId: string) {
  const response = await fetch(appUrl(`/api/games/${gameId}/subscribe`), {
    headers: { Accept: "text/event-stream" },
  });

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("subscribe response carried no readable body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const seenFrames: SSEFrame[] = [];
  const waiters: Array<{ predicate: (frame: SSEFrame) => boolean; resolve: (frame: SSEFrame) => void }> = [];

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });

        // Frames are `data: {json}\n\n` (src/events/emitter.ts's sendToClient).
        // Split on the blank-line frame delimiter and keep any trailing
        // partial frame in the buffer for the next read.
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const frame = JSON.parse(line.slice("data: ".length)) as SSEFrame;
          seenFrames.push(frame);

          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].predicate(frame)) {
              waiters[i].resolve(frame);
              waiters.splice(i, 1);
            }
          }
        }
      }
    } catch {
      // Reader cancelled out from under the pump on stream close -- expected,
      // not a test failure. Nothing left to do.
    }
  })();

  function waitForFrame(predicate: (frame: SSEFrame) => boolean, label: string): Promise<SSEFrame> {
    // Already arrived before this was called? Resolve immediately rather
    // than registering a waiter that would never fire.
    const already = seenFrames.find(predicate);
    if (already) return Promise.resolve(already);

    return new Promise<SSEFrame>((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolveWaitWrapped);
        if (idx !== -1) waiters.splice(idx, 1);
        rejectWait(
          new Error(
            `Timed out after ${FRAME_WAIT_TIMEOUT_MS}ms waiting for SSE frame: ${label}. ` +
              `Frames seen so far: ${JSON.stringify(seenFrames)}`
          )
        );
      }, FRAME_WAIT_TIMEOUT_MS);

      const resolveWaitWrapped = (frame: SSEFrame) => {
        clearTimeout(timer);
        resolveWait(frame);
      };

      waiters.push({ predicate, resolve: resolveWaitWrapped });
    });
  }

  // A `const` arrow function, not a hoisted `function` declaration -- so it
  // picks up the same closed-over narrowing of `reader` (definitely not
  // undefined, established by the throw above) that the `pump` IIFE gets.
  const close = async (): Promise<void> => {
    await reader.cancel().catch(() => {});
    await pump.catch(() => {});
  };

  return { response, waitForFrame, close };
}

test.describe("GET /api/games/:gameId/subscribe", () => {
  test("sends the initial connected frame for the seeded game", async () => {
    const handshake = readHandshake();
    const stream = await openStream(handshake.seeded.gameId);
    try {
      expect(stream.response.status).toBe(200);
      const connected = await stream.waitForFrame(
        (f) => f.type === "connected" && f.gameId === handshake.seeded.gameId,
        "initial 'connected' frame"
      );
      expect(connected.gameId).toBe(handshake.seeded.gameId);
    } finally {
      await stream.close();
    }
  });

  test("a control-server log-event mutation arrives on the open stream, carrying the right gameId", async ({
    request,
  }) => {
    const handshake = readHandshake();
    // Stream open and its 'connected' frame observed BEFORE the mutation --
    // see the ordering-hazard doc comment at the top of this file.
    const stream = await openStream(handshake.seeded.gameId);
    try {
      await stream.waitForFrame((f) => f.type === "connected", "initial 'connected' frame");

      const content = `a scene logged by the SSE acceptance spec at ${Date.now()}`;
      const controlResponse = await request.post(controlUrl("/control/log-event"), {
        data: { gameId: handshake.seeded.gameId, eventType: "scene", content },
      });
      expect(controlResponse.status()).toBe(200);
      const { id: loggedEventId } = (await controlResponse.json()) as { id: string };

      const eventFrame = await stream.waitForFrame(
        (f) => f.entityId === loggedEventId,
        `narrative event frame for logged event ${loggedEventId}`
      );
      expect(eventFrame.gameId).toBe(handshake.seeded.gameId);
    } finally {
      await stream.close();
    }
  });

  test("a control-server create-character mutation arrives on the open stream, carrying the right gameId", async ({
    request,
  }) => {
    const handshake = readHandshake();
    const stream = await openStream(handshake.seeded.gameId);
    try {
      await stream.waitForFrame((f) => f.type === "connected", "initial 'connected' frame");

      const name = `an apprentice conjured by the SSE acceptance spec at ${Date.now()}`;
      const controlResponse = await request.post(controlUrl("/control/create-character"), {
        data: { gameId: handshake.seeded.gameId, name },
      });
      expect(controlResponse.status()).toBe(200);
      const { id: createdCharacterId } = (await controlResponse.json()) as { id: string };

      const eventFrame = await stream.waitForFrame(
        (f) => f.entityId === createdCharacterId,
        `character:created frame for created character ${createdCharacterId}`
      );
      expect(eventFrame.gameId).toBe(handshake.seeded.gameId);
      expect(eventFrame.type).toBe("character:created");
    } finally {
      await stream.close();
    }
  });

  test("subscribing to an unknown gameId 404s and never opens a stream", async () => {
    const response = await fetch(appUrl("/api/games/00000000-0000-4000-8000-000000000000/subscribe"), {
      headers: { Accept: "text/event-stream" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").not.toContain("text/event-stream");

    const body = (await response.json()) as { error: string };
    expect(body).toHaveProperty("error");

    // No stream to close/cancel: the 404 branch in src/http/server.ts
    // returns before ever calling gameEvents.subscribe(), so there is
    // nothing here that could leak a connection.
  });
});
