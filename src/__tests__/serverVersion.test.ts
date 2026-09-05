// The version the server announces is the version we shipped.
//
// `SERVER_VERSION` (src/mcp-server.ts) goes out in the MCP handshake, so it is
// what a client logs, reports and version-gates on. It read "0.3.0" for the
// entire life of 0.4.0: releasing bumps package.json, and nothing connected the
// two. A client asking "which engine am I talking to" got a wrong answer for a
// whole minor version, and no test noticed because both values were internally
// consistent -- with each other's neighbours, not with each other.
//
// Cheaper than remembering. `npm version` will now fail CI rather than ship a
// server that misreports itself.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SERVER_VERSION } from "../mcp-server.js";

describe("the announced server version", () => {
  it("matches the published package version", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8")
    ) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
