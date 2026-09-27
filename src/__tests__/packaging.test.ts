// What ships, and what the prose around it claims, agree with the tree.
//
// Four drifts turned up while drawing docs/ARCHITECTURE.md, and each was
// the same shape: a fact stated in one place (a package manifest, a dev
// config, a Dockerfile, a comment) that nothing compared against the place
// the fact actually lives. None was caught by a test because none had one.
//
//   1. The npm tarball omitted `client/dist`, so `npx run-dmcp` served the
//      "Vue app not built" page while the Docker image served the viewer.
//      `package.json` `files` is the declaration; `src/http/server.ts`
//      resolves the bundle at `<package>/client/dist`. They have to agree.
//   2. The client's Vite dev proxy pointed at port 3000; the server's default
//      is `DEFAULT_HTTP_PORT`. Only `npm run dev:client` noticed.
//   3. The Dockerfile declared no port although HTTP binds one inside the
//      container unless DMCP_NO_HTTP is set.
//   4. Five comments and two documents said "twenty-one register modules"
//      after the count had moved on.
//
// Every check here is a literal comparison of a token this repository wrote
// against a value this repository defines (root CLAUDE.md, hard rule 4).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_HTTP_PORT } from "../utils/webui.js";

const REPO_ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("the npm tarball carries the web viewer", () => {
  const pkg = JSON.parse(read("package.json")) as { files: string[] };

  it("declares client/dist in `files`, the directory src/http/server.ts serves from", () => {
    expect(pkg.files).toContain("client/dist/");
  });

  // `npm pack` is the only authority on what a consumer receives. This runs
  // against a built client when one is present (a checkout that ran
  // `npm run build`, or the release job) and is a no-op otherwise: the
  // unit job in CI does not build the client, and asserting on a file that
  // was never built would test the job, not the manifest.
  const built = existsSync(join(REPO_ROOT, "client", "dist", "index.html"));
  it.runIf(built)("`npm pack --dry-run` lists client/dist/index.html", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: REPO_ROOT, encoding: "utf8" });
    const [tarball] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const paths = tarball.files.map((f) => f.path);
    expect(paths).toContain("client/dist/index.html");
  });
});

describe("every stated HTTP port is DEFAULT_HTTP_PORT", () => {
  it("the client's Vite dev proxy targets it", () => {
    const targets = [...read("client/vite.config.ts").matchAll(/localhost:(\d+)/g)].map((m) => Number(m[1]));
    expect(targets.length).toBeGreaterThan(0);
    for (const port of targets) expect(port).toBe(DEFAULT_HTTP_PORT);
  });

  it("the Dockerfile exposes it", () => {
    expect(read("Dockerfile")).toMatch(new RegExp(`^EXPOSE ${DEFAULT_HTTP_PORT}$`, "m"));
  });
});

describe("the register-module count the prose quotes", () => {
  // Assembly cost is described in numbers in five places: CLAUDE.md,
  // README.md, src/index.ts, src/server.ts and src/rpg/server.ts. When this
  // test fails, a register module was added or removed -- update those
  // five and docs/ARCHITECTURE.md, then the numbers here.
  const modulesIn = (dir: string) => readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith(".ts")).length;

  it("core: 23 files under src/register", () => {
    expect(modulesIn("src/register")).toBe(23);
  });

  it("tabletop: 8 files under src/rpg/register", () => {
    expect(modulesIn("src/rpg/register")).toBe(8);
  });

  it("no source or document still says twenty-one", () => {
    for (const rel of ["CLAUDE.md", "README.md", "src/index.ts", "src/server.ts", "src/rpg/server.ts"]) {
      expect(read(rel), rel).not.toMatch(/twenty-one register/);
    }
  });
});
