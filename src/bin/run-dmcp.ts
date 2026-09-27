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
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { closeDatabase } from "../db/connection.js";
import { initializeSchema } from "../db/schema.js";
import { startHttpServer } from "../http/server.js";
// The full assembly -- core plus the RPG layer -- now lives one layer up
// (design §8, issue #17). The application always served the full surface,
// so it reaches for it here rather than the core-only `createCoreMcpServer`
// in ../mcp-server.js.
import { createMcpServer } from "../rpg/server.js";
import { httpPortFromEnv, setHttpPort, webUiEnabled } from "../utils/webui.js";
import { createLogger } from "../utils/logger.js";
import type { DeclaredRules } from "../timeline/declared.js";

const log = createLogger("bin");

async function main(): Promise<void> {
  // An application owns its database, so this is where the schema is brought
  // up -- not at import time, and not in any module a consumer might load.
  initializeSchema();

  // A game's rules as declared data (issue #41): a stock server loads its
  // mechanics, gates and conditions from a JSON file. Unreadable or invalid
  // rules stop startup here, loudly -- a server that came up without the
  // rules it was pointed at would answer every resolve with unknown-mechanic.
  const rulesPath = process.env.DMCP_RULES_FILE;
  let rules: DeclaredRules | undefined;
  if (rulesPath) {
    try {
      rules = JSON.parse(readFileSync(rulesPath, "utf8")) as DeclaredRules;
    } catch (error) {
      throw new Error(`DMCP_RULES_FILE '${rulesPath}' could not be read as JSON: ${(error as Error).message}`);
    }
  }

  const server = createMcpServer(rules ? { rules } : undefined);

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
