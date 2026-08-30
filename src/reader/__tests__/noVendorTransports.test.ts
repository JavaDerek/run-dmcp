// No vendor SDK, credential, or network call reaches the turn reader.
//
// `turnReader.ts`'s entire contract (design §12 seam 3, issue #15) is that a
// model transport is an INJECTED INTERFACE -- a plain async function the
// caller wrote and handed to `createTurnReader`. The engine dispatches it
// and never talks to a network itself. That claim is easy to make and easy
// to erode one convenience import at a time, so it gets the same device
// `engineVocabulary.test.ts` (src/__tests__/) uses for client vocabulary: a
// test that reads every file in this directory off disk and fails CI the
// moment a vendor/credential/network token appears in it.
//
// Modeled directly on `engineVocabulary.test.ts` -- same shape, same
// "each entry carries why" discipline, same self-exclusion idiom (there,
// `basename(f) !== "engineVocabulary.test.ts"`; here, this file excludes
// itself for the identical reason: this file's own doc comment and test
// names necessarily discuss the forbidden tokens by name, which is not the
// same thing as the *reader module* containing one).
//
// WHAT THIS IS NOT: a ban on the words "source" or "citation" or "request" --
// ordinary vocabulary this module's own contract needs. The forbidden list
// is specifically the fingerprints of a vendor SDK, a credential, or a live
// network call reaching `src/reader/`, not a ban on any word that could
// plausibly appear near one.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const READER_DIR = resolve(__dirname, "..");

/**
 * Every file under `src/reader/`, walked by hand (no `recursive: true` --
 * this avoids depending on a Node version's own readdir shape) except this
 * one -- see the module doc comment on why self-exclusion is correct here
 * rather than a hole in the rule: this file's job is to name the forbidden
 * tokens, which it cannot do without containing them.
 */
function scannedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        out.push(path);
      }
    }
  };
  walk(READER_DIR);
  return out.filter((path) => basename(path) !== "noVendorTransports.test.ts");
}

/**
 * Each entry carries why, same discipline as `engineVocabulary.test.ts`'s
 * own `FORBIDDEN` list -- a bare list of forbidden tokens is exactly the
 * thing a future contributor deletes when it gets in their way.
 */
const FORBIDDEN: Array<{ pattern: RegExp; what: string; why: string }> = [
  {
    pattern: /@anthropic-ai|openai|\bopenai\b|anthropic-sdk|@google\/generative-ai|@aws-sdk/i,
    what: "a vendor SDK package name",
    why: "a transport is a plain async function the CALLER builds and injects -- this module dispatches it and never imports anything to talk to a vendor itself.",
  },
  {
    pattern: /api[_-]?key/i,
    what: "a credential field name",
    why: "the engine never holds a credential. If a key belongs anywhere, it belongs inside a caller's own transport closure, never in this module.",
  },
  {
    pattern: /\bBearer\b/,
    what: "an HTTP bearer-auth token prefix",
    why: "this module makes no HTTP call, so nothing here ever needs to attach an auth header.",
  },
  {
    pattern: /\bAuthorization\b/,
    what: "an HTTP auth header name",
    why: "same as Bearer above -- there is no outbound HTTP request for a header to attach to.",
  },
  {
    pattern: /base[_-]?url/i,
    what: "an API base-URL configuration field",
    why: "a transport is injected already-configured; this module never assembles a request URL of its own.",
  },
  {
    pattern: /\bendpoint\b/i,
    what: "a network endpoint reference",
    why: "the engine calls a transport function, never a URL -- there is no endpoint for this module to know about.",
  },
  {
    pattern: /https?:\/\//,
    what: "a hardcoded network URL",
    why: "any URL a transport needs belongs inside the caller's own closure, injected at construction -- never written into the engine.",
  },
  {
    pattern: /\bfetch\s*\(/,
    what: "a direct network call",
    why: "this module has no network code of any kind. The call happens inside a caller-supplied `ReaderTransport`, never here.",
  },
  {
    pattern: /process\.env/,
    what: "a read of process environment (the usual home of a credential or endpoint override)",
    why: "the engine takes its capability by injection (createTurnReader({ transports })), never by reading ambient configuration.",
  },
];

describe("no vendor SDK, credential, or network call reaches the turn reader", () => {
  const files = scannedFiles();

  it("scans a non-zero number of files (guard against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("contains no $what", ({ pattern, why }) => {
    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, "utf8");
      contents.split("\n").forEach((line, i) => {
        if (pattern.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders, `${why}\n\n${offenders.join("\n")}`).toEqual([]);
  });
});
