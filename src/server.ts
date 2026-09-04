// The core assembly: the MCP server built from the core's tools.
//
// This is a SEPARATE entry point (`run-dmcp/server`) from the core library
// (`run-dmcp`, src/index.ts) for one reason, and it is a cost. Building a
// server means loading the MCP SDK and twenty-one register modules; wanting
// `LIMITS` or `createGame` does not. While these lived on the same entry,
// every consumer paid for both -- 97.4ms per process against 46.8ms for the
// mechanism alone, measured cold at 0.3.0 over nine spawns, on a consumer
// that spawns a fresh process per turn and never calls this function.
//
// The split is a move, not a change: `createCoreMcpServer` is the same
// function with the same options, reached by a different specifier.
// src/__tests__/assemblyBoundary.test.ts asserts that it stays reachable
// from here, and unreachable from there.
//
// Importing this module must still do nothing to the machine -- the rule
// src/index.ts's header states applies to every library entry this package
// publishes, and src/__tests__/entrypoints.test.ts holds it. Starting things
// is src/bin/run-dmcp.ts.
export { createCoreMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp-server.js";
