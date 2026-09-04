// Importing mechanism must not load the assembly.
//
// The package publishes two entries a consumer reaches for mechanism -- the
// core (`run-dmcp`, src/index.ts) and the RPG layer (`run-dmcp/rpg`,
// src/rpg/index.ts) -- and 0.3.0 welded the SERVER onto both of them.
// src/index.ts re-exported `createCoreMcpServer`, so `import { LIMITS } from
// "run-dmcp"` loaded src/mcp-server.ts and its twenty-one register modules.
// src/rpg/index.ts did the same with `createMcpServer` and additionally
// re-exported the web UI, so `import * as combatTools from "run-dmcp/rpg"`
// loaded the core assembly AND express.
//
// That is paid on every process spawn, by a consumer that may never build a
// server at all -- and one of them does not. A consumer measured while this
// was written imports the package 216 times from the root and 13 times from
// /rpg, calls a server factory exactly zero times (it constructs its own
// McpServer and registers its own tools), and spawns a fresh process per
// turn of play. Measured against 0.3.0, cold, median of nine spawns each:
//
//     run-dmcp                    97.4ms  ->  46.8ms  without the assembly
//     run-dmcp/rpg               123.6ms  ->  87.5ms  without the assembly
//     @modelcontextprotocol/sdk   55.0ms
//
// The middle column is the point: the mechanism-only core lands BELOW the
// cost of the MCP SDK, because with the assembly gone it does not import the
// SDK at all. A consumer that wants `createGame` was paying for the whole
// Model Context Protocol.
//
// The fix is that the assembly gets its own entries -- `run-dmcp/server` and
// `run-dmcp/rpg/server` -- and this file is what keeps it there, because
// re-welding it is one convenient re-export and nothing else would notice.
//
// ---------------------------------------------------------------------------
// This deliberately asks a DIFFERENT question from layerBoundary.test.ts, and
// the two must not be merged. That file asks what the layering ALLOWS, so it
// counts `import type` as reaching -- a type dependency on the layer above is
// still a dependency. This file asks what Node LOADS, so it does not: a
// type-only import is erased by the compiler and costs nothing at runtime.
// Same walk, opposite treatment of one syntax, because they are evidence for
// different claims.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative, sep } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");

const CORE_ENTRY = join(SRC_ROOT, "index.ts");
const RPG_ENTRY = join(SRC_ROOT, "rpg", "index.ts");
const CORE_SERVER_ENTRY = join(SRC_ROOT, "server.ts");
const RPG_SERVER_ENTRY = join(SRC_ROOT, "rpg", "server.ts");

/**
 * Relative specifiers that survive compilation, in file order.
 *
 * A line whose statement begins `import type` or `export type` is erased
 * whole by the compiler, so it is skipped. Anything else is counted, even
 * `import { type X, y }` where only `y` survives -- counting a statement
 * that might have been elided can only make this guard stricter, never let a
 * real load through, and an assembly import whose every binding is a type is
 * worth a failure that says so anyway.
 *
 * A check over import SYNTAX this codebase wrote. It never tries to read
 * meaning out of the code (root CLAUDE.md hard rule 4).
 */
function runtimeSpecifiers(filePath: string): string[] {
  const specifiers: string[] = [];
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (/^\s*(?:import|export)\s+type\s/.test(line)) continue;
    const match = /\bfrom\s+["'](\.[^"']+)["']/.exec(line);
    if (match) specifiers.push(match[1]);
  }
  return specifiers;
}

/** NodeNext requires the `.js` extension in source; the file on disk is `.ts`. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  return resolve(dirname(fromFile), `${specifier.replace(/\.js$/, "")}.ts`);
}

function relPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

interface Walk {
  files: Set<string>;
  parent: Map<string, string>;
}

function walk(entry: string): Walk {
  const files = new Set<string>();
  const parent = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || files.has(current)) continue;
    if (!existsSync(current)) {
      const via = parent.get(current);
      throw new Error(
        `import graph resolved to a file that is not on disk: ${relPath(current)}` +
          (via ? ` (from ${relPath(via)})` : "")
      );
    }
    files.add(current);
    for (const specifier of runtimeSpecifiers(current)) {
      const resolved = resolveSpecifier(current, specifier);
      if (!files.has(resolved) && !parent.has(resolved)) {
        parent.set(resolved, current);
        queue.push(resolved);
      }
    }
  }
  return { files, parent };
}

/** The chain from the entry down to `target`, so a failure NAMES the path. */
function chainTo(parent: Map<string, string>, target: string): string {
  const chain = [target];
  let current: string | undefined = target;
  while (current !== undefined) {
    const next: string | undefined = parent.get(current);
    if (next === undefined) break;
    chain.push(next);
    current = next;
  }
  return chain.reverse().map(relPath).join(" -> ");
}

// ASSEMBLY is the thing that BUILDS a server (src/mcp-server.ts) and the
// thing that SERVES it (src/http/**). Neither mechanism entry may reach
// either: that is the whole cost, and it is what moved.
//
// REGISTRATION -- putting tools onto a server somebody else built -- is not
// the same thing and is not forbidden the same way. `registerRpgTools` is
// exported from the RPG mechanism entry ON PURPOSE, so that entry reaches
// register modules by design, including `createGameListCallback` which it
// shares with the core's. The core entry exports no registrar at all, so
// anything under a register directory that it reaches got there by accident
// and is worth failing on.
//
// The earlier draft of this file called every register module assembly, which
// forbade the core's registers on the RPG entry while permitting the RPG's
// own -- a rule that would have been satisfied by copying a fifteen-line
// helper rather than by fixing anything.
const isAssembly = (p: string) => p === "src/mcp-server.ts" || p.startsWith("src/http/");
const isRegistration = (p: string) =>
  p.startsWith("src/register/") || p.startsWith("src/rpg/register/");

function reachedFrom(
  entry: string,
  predicate: (relative: string) => boolean
): { offenders: string[]; detail: string } {
  const { files, parent } = walk(entry);
  const offenders = [...files].filter((f) => predicate(relPath(f)));
  const detail = offenders
    .map((f) => `${relPath(f)}\n  reached via: ${chainTo(parent, f)}`)
    .join("\n");
  return { offenders: offenders.map(relPath), detail };
}

describe("the mechanism entries do not load the assembly", () => {
  it("walks a meaningful number of files from the core entry (guard against a vacuous pass)", () => {
    expect(walk(CORE_ENTRY).files.size).toBeGreaterThan(40);
  });

  it("walks a meaningful number of files from the RPG entry (guard against a vacuous pass)", () => {
    expect(walk(RPG_ENTRY).files.size).toBeGreaterThan(10);
  });

  it("run-dmcp (src/index.ts) never loads the server assembly", () => {
    const { offenders, detail } = reachedFrom(CORE_ENTRY, isAssembly);
    expect(offenders, detail).toEqual([]);
  });

  it("run-dmcp/rpg (src/rpg/index.ts) never loads the server assembly", () => {
    const { offenders, detail } = reachedFrom(RPG_ENTRY, isAssembly);
    expect(offenders, detail).toEqual([]);
  });

  it("run-dmcp (src/index.ts) never loads a register module either -- it exports no registrar", () => {
    const { offenders, detail } = reachedFrom(CORE_ENTRY, isRegistration);
    expect(offenders, detail).toEqual([]);
  });
});

// The other half. A guard that only forbids can be satisfied by deleting the
// feature, so these assert the assembly is still THERE, on its own entries --
// which is also what makes the forbidding above a move rather than a loss.
describe("the assembly is reachable from its own entries", () => {
  it("run-dmcp/server (src/server.ts) loads src/mcp-server.ts", () => {
    const reached = [...walk(CORE_SERVER_ENTRY).files].map(relPath);
    expect(reached).toContain("src/mcp-server.ts");
  });

  it("run-dmcp/rpg/server (src/rpg/server.ts) loads src/mcp-server.ts and the web UI", () => {
    const reached = [...walk(RPG_SERVER_ENTRY).files].map(relPath);
    expect(reached).toContain("src/mcp-server.ts");
    expect(reached).toContain("src/http/server.ts");
  });
});
