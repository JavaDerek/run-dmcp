// The two questions the executable asks its environment before it starts
// anything: which port, and whether to serve the web UI at all.
//
// Both live here rather than in the executable so they can be answered from a
// value instead of from the ambient process -- these functions take the
// environment as an argument and read nothing on their own.
import { describe, it, expect } from "vitest";
import { DEFAULT_HTTP_PORT, httpPortFromEnv, webUiEnabled } from "../webui.js";

describe("httpPortFromEnv", () => {
  it("defaults when DMCP_HTTP_PORT is unset", () => {
    expect(httpPortFromEnv({})).toBe(DEFAULT_HTTP_PORT);
  });

  it("defaults when DMCP_HTTP_PORT is empty", () => {
    expect(httpPortFromEnv({ DMCP_HTTP_PORT: "" })).toBe(DEFAULT_HTTP_PORT);
  });

  it("uses the configured port", () => {
    expect(httpPortFromEnv({ DMCP_HTTP_PORT: "8080" })).toBe(8080);
  });

  it("keeps 0, which asks the operating system for any free port", () => {
    expect(httpPortFromEnv({ DMCP_HTTP_PORT: "0" })).toBe(0);
  });

  it("falls back to the default rather than passing a non-port on to listen()", () => {
    // The inherited code did `parseInt(value || "3456", 10)`, so "banana"
    // reached app.listen() as NaN and quietly bound a random port instead.
    expect(httpPortFromEnv({ DMCP_HTTP_PORT: "banana" })).toBe(DEFAULT_HTTP_PORT);
    expect(httpPortFromEnv({ DMCP_HTTP_PORT: "-1" })).toBe(DEFAULT_HTTP_PORT);
    expect(httpPortFromEnv({ DMCP_HTTP_PORT: "70000" })).toBe(DEFAULT_HTTP_PORT);
    expect(httpPortFromEnv({ DMCP_HTTP_PORT: "3456.5" })).toBe(DEFAULT_HTTP_PORT);
  });
});

describe("webUiEnabled", () => {
  it("serves the web UI when nothing says otherwise -- an application's default", () => {
    expect(webUiEnabled({})).toBe(true);
  });

  it("is turned off by DMCP_NO_HTTP", () => {
    expect(webUiEnabled({ DMCP_NO_HTTP: "1" })).toBe(false);
    expect(webUiEnabled({ DMCP_NO_HTTP: "true" })).toBe(false);
    expect(webUiEnabled({ DMCP_NO_HTTP: "TRUE" })).toBe(false);
    expect(webUiEnabled({ DMCP_NO_HTTP: "yes" })).toBe(false);
  });

  it("treats the values that spell 'no' as leaving it on", () => {
    // A launcher that computes `DMCP_NO_HTTP=${disabled ? 1 : 0}` means the
    // web UI to run when it writes 0, and an empty value is not a setting.
    expect(webUiEnabled({ DMCP_NO_HTTP: "0" })).toBe(true);
    expect(webUiEnabled({ DMCP_NO_HTTP: "false" })).toBe(true);
    expect(webUiEnabled({ DMCP_NO_HTTP: "" })).toBe(true);
  });
});
