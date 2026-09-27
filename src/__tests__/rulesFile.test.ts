// GitHub issue #41's promise, end to end: a STOCK run-dmcp -- the published
// executable, no caller TypeScript assembled into it -- loads a game's
// mechanics, gates and conditions from a JSON file named by DMCP_RULES_FILE,
// and a client plays it with the stock tools. Spoken to over stdio by a real
// MCP client, against a throwaway database (never the default library).
//
// Fixtures: grain, treasury, population.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCoreMcpServer } from "../mcp-server.js";
import type { DeclaredRules } from "../timeline/declared.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const ENTRY = join(REPO_ROOT, "src", "bin", "run-dmcp.ts");

const RULES: DeclaredRules = {
  conditions: [
    {
      id: "granary-full",
      for: "steward",
      then: "the surplus may be sold",
      all: [{ entity: { named: "grain" }, key: "value", op: ">=", value: 80 }],
    },
  ],
  mechanics: [
    { name: "HARVEST", legs: [{ kind: "adjust", entity: { named: "grain" }, key: "value", amount: { param: "amount" }, min: 0, max: 100 }] },
    {
      name: "SELL_SURPLUS",
      when: ["granary-full"],
      legs: [
        { kind: "adjust", entity: { named: "grain" }, key: "value", sign: -1, amount: 30, min: 0, max: 100 },
        { kind: "adjust", entity: { named: "treasury" }, key: "value", amount: 30, min: 0, max: 100 },
      ],
    },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(rules: unknown): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "dmcp-rules-file-"));
  dirs.push(dir);
  const rulesPath = join(dir, "rules.json");
  writeFileSync(rulesPath, typeof rules === "string" ? rules : JSON.stringify(rules));
  const env = { ...(process.env as Record<string, string>), DMCP_DB_PATH: join(dir, "games.db"), DMCP_NO_HTTP: "1", DMCP_RULES_FILE: rulesPath };
  return { dir, env };
}

describe("a stock server loads a game's rules from DMCP_RULES_FILE (issue #41)", () => {
  it("serves resolve, list_mechanics and conditions_at, and plays the declared game", async () => {
    const { env } = scratch(RULES);
    const client = new Client({ name: "rules-file", version: "0" });
    await client.connect(new StdioClientTransport({ command: TSX, args: [ENTRY], env, stderr: "ignore" }));
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
        if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
        return JSON.parse(r.content[0].text);
      };
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["resolve", "list_mechanics", "conditions_at"]));

      const game = await call("create_game", { name: "depot", setting: "test", style: "test" });
      const gameId = game.id ?? game.game?.id;
      await call("declare_time_axis", { gameId, axis: { kind: "counter", unit: "turn" } });
      await call("create_resource", { gameId, ownerType: "game", name: "grain", value: 50, minValue: 0, maxValue: 100 });
      await call("create_resource", { gameId, ownerType: "game", name: "treasury", value: 10, minValue: 0, maxValue: 100 });

      const before = await call("conditions_at", { gameId, t: 1000, for: "steward" });
      expect(before.map((r: { id: string; holds: boolean }) => [r.id, r.holds])).toEqual([["granary-full", false]]);

      const refused = await call("resolve", { gameId, mechanic: "SELL_SURPLUS" });
      expect(refused.result).toMatchObject({ applied: "none" });

      await call("resolve", { gameId, mechanic: "HARVEST", parameters: { amount: 35 } });
      const sold = await call("resolve", { gameId, mechanic: "SELL_SURPLUS" });
      expect(sold.result).toMatchObject({ applied: "legs", when: [{ id: "granary-full", holds: true }] });
      expect(sold.result.legs.map((l: { after: number }) => l.after)).toEqual([55, 40]);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("a malformed rules file stops the application at startup, naming the problem -- never a server without its rules", () => {
    const { env } = scratch({ conditions: [], mechanics: [{ name: "X", when: ["nope"], legs: [] }] });
    const run = spawnSync(TSX, [ENTRY], { env, input: "", timeout: 30_000, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/unknown condition 'nope'/);
  }, 40_000);

  it("unparseable JSON stops it too, naming the file", () => {
    const { env } = scratch("{ not json");
    const run = spawnSync(TSX, [ENTRY], { env, input: "", timeout: 30_000, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/DMCP_RULES_FILE/);
  }, 40_000);
});

describe("createCoreMcpServer({ rules })", () => {
  const toolNames = (s: ReturnType<typeof createCoreMcpServer>) =>
    Object.keys((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

  it("registers conditions_at only when rules are given, and the declared mechanics beside hand-written ones", () => {
    expect(toolNames(createCoreMcpServer())).not.toContain("conditions_at");
    const names = toolNames(
      createCoreMcpServer({ rules: RULES, mechanics: [{ name: "TALLY", adjudicate: () => ({}) }] })
    );
    expect(names).toEqual(expect.arrayContaining(["conditions_at", "resolve", "list_mechanics"]));
  });

  it("refuses rules that do not validate, at construction", () => {
    expect(() => createCoreMcpServer({ rules: { conditions: [], mechanics: [{ name: "X", when: ["nope"], legs: [] }] } })).toThrow(
      /unknown condition/
    );
  });
});
