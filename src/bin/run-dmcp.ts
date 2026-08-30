#!/usr/bin/env node
// The application.
//
// Everything this file does to the machine -- create the database, bind a
// port, hold stdio open until it is killed -- is exactly what a library must
// not do on import, which is why it lives here and not in src/index.ts. The
// package's `bin` points at this file; the package's `main` points at the
// library, which starts nothing.
//
// The web UI runs by default, as it always has. DMCP_NO_HTTP turns it off, for
// a host that spawns this as an MCP subprocess and has no use for an admin
// page it cannot close.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { closeDatabase } from "../db/connection.js";
import { initializeSchema } from "../db/schema.js";
import { startHttpServer } from "../http/server.js";
// The full assembly -- core plus the RPG layer -- now lives one layer up
// (design §8, issue #17). The application always served the full surface,
// so it reaches for it here rather than the core-only `createCoreMcpServer`
// in ../mcp-server.js.
import { createMcpServer } from "../rpg/index.js";
import { httpPortFromEnv, setHttpPort, webUiEnabled } from "../utils/webui.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("bin");

async function main(): Promise<void> {
  // An application owns its database, so this is where the schema is brought
  // up -- not at import time, and not in any module a consumer might load.
  initializeSchema();

  const server = createMcpServer();

  if (webUiEnabled(process.env)) {
    const actualPort = await startHttpServer(httpPortFromEnv(process.env));
    setHttpPort(actualPort);
  } else {
    log.info("Web UI disabled by DMCP_NO_HTTP; no port will be bound");
  }

  // Start MCP server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Handle cleanup
process.on("SIGINT", () => {
  closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeDatabase();
  process.exit(0);
});

main().catch((error) => {
  log.error("Server error", { error: error instanceof Error ? error.message : String(error) });
  console.error(error);
  closeDatabase();
  process.exit(1);
});
