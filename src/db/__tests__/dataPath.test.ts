import { describe, it, expect, afterEach } from "vitest";
import { join, sep } from "path";
import { resolveDataPathFrom, getDatabasePath, closeDatabase } from "../connection.js";

describe("resolveDataPathFrom", () => {
  const cwd = "/home/user/consumer-app";
  const home = "/home/user";

  it("DMCP_DB_PATH wins even when the XDG directory exists", () => {
    const result = resolveDataPathFrom({
      env: { DMCP_DB_PATH: "/custom/path/games.db" },
      cwd,
      home,
      exists: () => true,
    });

    expect(result.dbPath).toBe("/custom/path/games.db");
    expect(result.dataDir).toBe("/custom/path");
  });

  it("passes ':memory:' through untouched", () => {
    const result = resolveDataPathFrom({
      env: { DMCP_DB_PATH: ":memory:" },
      cwd,
      home,
      exists: () => true,
    });

    expect(result.dbPath).toBe(":memory:");
  });

  it("uses the XDG data directory when it already exists", () => {
    const xdgDir = join(home, ".local", "share", "dmcp");
    const result = resolveDataPathFrom({
      env: {},
      cwd,
      home,
      exists: (path) => path === xdgDir,
    });

    expect(result.dataDir).toBe(xdgDir);
    expect(result.dbPath).toBe(join(xdgDir, "games.db"));
  });

  it("honours XDG_DATA_HOME when set and the resulting dmcp dir exists", () => {
    const customXdgHome = "/opt/xdg-data";
    const xdgDir = join(customXdgHome, "dmcp");
    const result = resolveDataPathFrom({
      env: { XDG_DATA_HOME: customXdgHome },
      cwd,
      home,
      exists: (path) => path === xdgDir,
    });

    expect(result.dataDir).toBe(xdgDir);
    expect(result.dbPath).toBe(join(xdgDir, "games.db"));
  });

  it("when XDG_DATA_HOME is not set, the XDG candidate is computed as <home>/.local/share/dmcp (used only if it exists)", () => {
    const xdgDir = join(home, ".local", "share", "dmcp");
    // Only the home-based candidate exists -- if the implementation computed
    // some other candidate (e.g. ignoring `home`) this would miss and fall
    // through to the cwd default instead.
    const result = resolveDataPathFrom({
      env: {},
      cwd,
      home,
      exists: (path) => path === xdgDir,
    });

    expect(result.dataDir).toBe(xdgDir);
    expect(result.dbPath).toBe(join(xdgDir, "games.db"));
  });

  it("falls back to <cwd>/data/games.db when there is no DMCP_DB_PATH and no existing XDG directory", () => {
    const result = resolveDataPathFrom({
      env: {},
      cwd,
      home,
      exists: () => false,
    });

    expect(result.dataDir).toBe(join(cwd, "data"));
    expect(result.dbPath).toBe(join(cwd, "data", "games.db"));
  });

  it("regression guard: installed as a dependency, the resolved path never touches node_modules and stays inside cwd", () => {
    // Simulate `npm install run-dmcp` inside a consumer application: the
    // package's own files would live at <cwd>/node_modules/run-dmcp, but
    // that location must never be an input to (or output of) resolution.
    const consumerCwd = "/home/user/consumer-app";
    const packageInstallDir = join(consumerCwd, "node_modules", "run-dmcp");

    const result = resolveDataPathFrom({
      env: {},
      cwd: consumerCwd,
      home,
      exists: (path) => path === packageInstallDir, // only the package dir "exists"
    });

    expect(result.dbPath).not.toContain(`node_modules${sep}run-dmcp`);
    expect(result.dataDir).not.toContain(`node_modules${sep}run-dmcp`);
    expect(result.dbPath.startsWith(consumerCwd)).toBe(true);
    expect(result.dataDir.startsWith(consumerCwd)).toBe(true);
  });

  it("regression guard, XDG branch: resolved path is under home, never under cwd/node_modules", () => {
    const consumerCwd = "/home/user/consumer-app";
    const xdgDir = join(home, ".local", "share", "dmcp");

    const result = resolveDataPathFrom({
      env: {},
      cwd: consumerCwd,
      home,
      exists: (path) => path === xdgDir,
    });

    expect(result.dbPath.startsWith(home)).toBe(true);
    expect(result.dataDir.startsWith(home)).toBe(true);
    expect(result.dbPath).not.toContain("node_modules");
    expect(result.dataDir).not.toContain("node_modules");
    expect(result.dbPath.startsWith(join(consumerCwd, "node_modules"))).toBe(false);
  });

  it("an exists stub that returns true for everything still never produces a package-relative path", () => {
    // Guards against a future "if installed" heuristic creeping back in: even
    // if every path anyone can think of "exists", the function has no input
    // that could name the package's own install location, so it cannot
    // resolve there.
    const consumerCwd = "/home/user/consumer-app";

    const result = resolveDataPathFrom({
      env: {},
      cwd: consumerCwd,
      home,
      exists: () => true,
    });

    expect(result.dbPath).not.toContain("node_modules");
    expect(result.dataDir).not.toContain("node_modules");
    expect(result.dbPath).not.toContain("run-dmcp");
  });
});

describe("getDatabasePath (integration)", () => {
  afterEach(() => {
    closeDatabase();
    process.env.DMCP_DB_PATH = ":memory:";
  });

  it("reflects DMCP_DB_PATH, and re-reads it after closeDatabase()", () => {
    process.env.DMCP_DB_PATH = "/tmp/dmcp-dataPath-test-1/games.db";
    expect(getDatabasePath()).toBe("/tmp/dmcp-dataPath-test-1/games.db");

    closeDatabase();
    process.env.DMCP_DB_PATH = "/tmp/dmcp-dataPath-test-2/games.db";
    expect(getDatabasePath()).toBe("/tmp/dmcp-dataPath-test-2/games.db");
  });
});
