// The full assembly: every core tool plus every RPG tool, resource and
// prompt this engine has always served, and the web UI that shows them.
//
// A SEPARATE entry point (`run-dmcp/rpg/server`) from the layer's mechanism
// (`run-dmcp/rpg`, src/rpg/index.ts), for the reason src/server.ts states
// one level down: assembling a server costs the MCP SDK, the core's
// twenty-one register modules and express, and calling `roll()` or
// `startCombat()` does not. 123.6ms per process against 87.5ms, cold, at
// 0.3.0, on a consumer that imports this layer thirteen times for tool
// functions and calls `createMcpServer` never.
//
// The split is a move, not a change: same name, same options, same
// registered surface -- src/__tests__/layerBoundary.test.ts still checks
// that surface against the golden set captured before the core/RPG split.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCoreMcpServer } from "../mcp-server.js";
import type { Mechanic } from "../timeline/resolve.js";
import type { RenderVocabulary } from "../timeline/render.js";
import { registerRpgTools } from "./index.js";

/**
 * Build the FULL assembly: every core tool plus every RPG tool, resource and
 * prompt this engine has always served. Same name and same `{ mechanics?,
 * vocabulary? }` options as the pre-split `createMcpServer` in
 * src/mcp-server.ts, so src/bin/run-dmcp.ts's zero-argument call site keeps
 * working unchanged and the registered tool/resource/prompt set is unchanged
 * too (src/__tests__/layerBoundary.test.ts asserts this exactly).
 */
export function createMcpServer(options?: {
  mechanics?: readonly Mechanic[];
  vocabulary?: RenderVocabulary;
}): McpServer {
  const server = createCoreMcpServer(options);
  registerRpgTools(server);
  return server;
}

// The web UI. An application opts into serving it; importing this never
// does. It lives on disk at src/http/server.ts, not under src/rpg/ -- it
// imports RPG tools (quest/ability/combat), which is why it cannot be
// reachable from the core entry point, but its CLIENT_DIST path resolution
// is depth-sensitive in both src/ and compiled dist/, so it stays put and
// only its EXPORT moves up to this layer.
export { createHttpServer, startHttpServer } from "../http/server.js";
