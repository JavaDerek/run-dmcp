// The tripwires for decisions this repo has deliberately NOT made yet.
//
// run-dmcp carries two open design issues that are deferred on purpose --
// per-entity visibility (#18) and fact granularity (#21) -- and each is
// recorded with a list of signals that should make someone act on it. Those
// signals were, until this file existed, entirely human-observed: nothing
// ran, nothing failed, and the issues were the only record of what to watch
// for.
//
// That is not a hypothetical weakness. It has already cost this project
// once. #21's own comment predicted its first signal would fire during #7's
// implementation and instructed that the decision be "recorded here instead
// of being made implicitly in a function body". #7 landed; the decision was
// made deliberately and argued well -- and it was recorded in a schema
// comment and a test, in a function body, exactly as warned. The issue never
// found out. It took a fresh read of the tree, months later, to notice.
//
// So the general lesson, which is the same one `engineVocabulary.test.ts`
// and `layerBoundary.test.ts` were written from and which root CLAUDE.md
// states outright: GOOD INTENTIONS DO NOT GENERALISE; TESTS DO. A deferral
// that lives only in an issue decays into a deferral nobody remembers, and
// the first person to trip over it will not know they did.
//
// Three guards, each a literal check over syntax THIS CODEBASE WROTE --
// never an attempt to read meaning out of anything (root CLAUDE.md hard
// rule 4, which guard (b) is itself the enforcement of):
//
//   (a) CHOKE POINT: no module outside `src/timeline/` issues SQL against
//       the timeline tables. #18's whole "leave no seam" conclusion rests on
//       the read paths staying single-choke-point, so that a visibility
//       predicate has exactly ONE place to be added per query when it
//       eventually arrives.
//   (b) NO MEANING-MATCHING: the timeline core reaches for no regex API.
//       #21's floor signal is "someone writes a contradiction check and the
//       only implementation reads English" -- and the shape that takes, in
//       practice, is a regex against a fact's value.
//   (c) DECISION MARKERS: the sites where a deferred decision is recorded
//       still carry their `DECISION(#N):` marker, and every marker in the
//       tree is well-formed. This is what `.github/workflows/decision-
//       markers.yml` propagates to the issue itself, closing the loop that
//       #7 fell through.
//
// WHAT THESE DO NOT DO, deliberately: none of them decides anything. Guard
// (a) going red does not mean the query is wrong; guard (b) going red does
// not mean the regex is wrong. Each says "you are standing on a deferred
// decision, go read the issue named in the failure" -- which is the engine's
// own rule 2 applied to its CI: record, never adjudicate.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative, sep } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const TIMELINE_DIR = join(SRC_ROOT, "timeline");

/**
 * This file itself, excluded from every scan below and ONLY this file.
 *
 * A guard has to be able to name the thing it forbids -- the patterns below
 * contain the very table names and API names they reject -- so scanning
 * itself would make it permanently red. Same exclusion-with-a-reason as
 * `engineVocabulary.test.ts`'s single-entry list, and the test immediately
 * after this one asserts the list stays at one entry, so routing around a
 * guard means editing the assertion that says you may not.
 */
const SELF = relative(REPO_ROOT, __filename).split(sep).join("/");
const EXCLUDED_PATHS = new Set([SELF]);

/** Every `.ts` file under `src/`, in a stable order. */
function sourceFiles(root: string = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root).sort()) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join("/");
}

/**
 * Source with comments removed, so every guard below reads CODE rather than
 * prose about code.
 *
 * Load-bearing, not tidiness: `src/db/schema.ts` explains the interval-close
 * write in a comment that quotes the SQL verbatim, and guard (a) would
 * otherwise fail on an accurate description of a rule it is enforcing --
 * the most demoralising possible false positive, and the kind that gets a
 * guard deleted rather than fixed.
 *
 * Strings are preserved, which is the entire point: SQL in this codebase
 * lives inside template literals, so stripping those would blind (a)
 * completely. Line numbers are preserved too (comments become blank lines,
 * block comments keep their newlines) so a failure can name a real line.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
  let mode: Mode = "code";
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (mode === "code") {
      if (two === "//") {
        mode = "line";
        i += 2;
        continue;
      }
      if (two === "/*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (source[i] === "'") mode = "single";
      else if (source[i] === '"') mode = "double";
      else if (source[i] === "`") mode = "template";
      out += source[i];
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (source[i] === "\n") {
        mode = "code";
        out += "\n";
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (two === "*/") {
        mode = "code";
        i += 2;
        continue;
      }
      if (source[i] === "\n") out += "\n";
      i += 1;
      continue;
    }
    // Inside a string literal: copy through, honouring backslash escapes so
    // an escaped quote never ends the literal early.
    if (source[i] === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (mode === "single" && source[i] === "'") ||
      (mode === "double" && source[i] === '"') ||
      (mode === "template" && source[i] === "`")
    ) {
      mode = "code";
    }
    out += source[i];
    i += 1;
  }
  return out;
}

interface Offence {
  file: string;
  line: number;
  text: string;
}

function scan(files: string[], pattern: RegExp): Offence[] {
  const offences: Offence[] = [];
  for (const file of files) {
    const path = repoPath(file);
    if (EXCLUDED_PATHS.has(path)) continue;
    const lines = stripComments(readFileSync(file, "utf-8")).split("\n");
    lines.forEach((line, index) => {
      // A fresh regex per line: `pattern` may carry /g, whose lastIndex is
      // stateful across calls and would silently skip every other match.
      if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(line)) {
        offences.push({ file: path, line: index + 1, text: line.trim() });
      }
    });
  }
  return offences;
}

function render(offences: Offence[]): string {
  return offences.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
}

describe("deferred decisions have tripwires, not just issues", () => {
  const allSources = sourceFiles();

  it("scans a meaningful number of files (guard against a vacuous pass)", () => {
    expect(allSources.length).toBeGreaterThan(50);
  });

  it("excludes exactly one path, and it is this file", () => {
    expect([...EXCLUDED_PATHS]).toEqual([SELF]);
  });

  // ==========================================================================
  // (a) CHOKE POINT -- issue #18
  // ==========================================================================
  describe("(a) the timeline read paths stay single-choke-point (#18)", () => {
    const TIMELINE_TABLES = ["entities", "facts", "events", "timeline_clock"];
    const TIMELINE_SQL = new RegExp(
      `\\b(?:from|into|update|join)\\s+(?:${TIMELINE_TABLES.join("|")})\\b`,
      "i"
    );

    it("no module outside src/timeline/ issues SQL against the timeline tables", () => {
      const outside = allSources.filter((f) => !f.startsWith(TIMELINE_DIR + sep));
      const offences = scan(outside, TIMELINE_SQL);
      expect(
        offences.length === 0 ? "" : render(offences)
      ).toBe("");
    });

    it("the guard can actually fail -- the same pattern DOES match the timeline's own queries", () => {
      // Plant-and-watch-red, executed rather than promised (root CLAUDE.md).
      // If this ever goes empty, the pattern above stopped matching real SQL
      // and the guard above is passing vacuously.
      const inside = sourceFiles(TIMELINE_DIR).filter((f) => !f.includes("__tests__"));
      expect(scan(inside, TIMELINE_SQL).length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // (b) NO MEANING-MATCHING -- issue #21's floor signal, hard rule 4
  // ==========================================================================
  describe("(b) the timeline core matches no meaning (#21, hard rule 4)", () => {
    // The reach for a regex API, not an attempt to parse regex literals --
    // detecting `/.../` in TS text without a parser confuses division and
    // URLs for patterns, and a guard with false positives gets deleted. Every
    // form below is a method or constructor name this codebase would have to
    // type on purpose.
    const REGEX_API = /new RegExp|\.match\(|\.matchAll\(|\.search\(|\.test\(|\.replace\(\s*\/|\.split\(\s*\//;

    it("no timeline module constructs or applies a regex", () => {
      const modules = sourceFiles(TIMELINE_DIR).filter((f) => !f.includes("__tests__"));
      const offences = scan(modules, REGEX_API);
      expect(offences.length === 0 ? "" : render(offences)).toBe("");
    });

    it("the guard can actually fail -- the same pattern DOES match regex use elsewhere in src/", () => {
      expect(scan(allSources, REGEX_API).length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // (c) DECISION MARKERS -- the loop #7 fell through
  // ==========================================================================
  describe("(c) recorded decisions stay recorded, and reach their issue (#18, #21)", () => {
    // A token this codebase defines, so finding it is a literal string match
    // over our own output -- explicitly the permitted half of hard rule 4.
    // `.github/workflows/decision-markers.yml` scans a push for ADDED markers
    // and comments them onto the issue, which is what makes a decision made
    // in a function body unable to stay there silently.
    const MARKER = /DECISION\(#(\d+)\):/;
    const MARKER_GLOBAL = /DECISION\(#(\d+)\):/g;

    /**
     * Sites that MUST carry a marker, and the issue each answers to.
     *
     * Not a style rule -- each of these is a place where the tree encodes a
     * decision that an issue is the record of, and where deleting the comment
     * would silently un-record it. Adding a row here is how a future deferral
     * gets the same protection.
     */
    const REQUIRED: Array<{ file: string; issue: number; what: string }> = [
      { file: "src/timeline/replay.ts", issue: 18, what: "replay() is omniscient by decision" },
      { file: "src/timeline/changes.ts", issue: 18, what: "changesWithin() is omniscient by decision" },
      { file: "src/timeline/export.ts", issue: 18, what: "the export artifact carries no per-principal projection" },
      { file: "src/timeline/schema.ts", issue: 21, what: "irreversible is per-fact, so a property needs its own key" },
      { file: "src/timeline/irreversible.ts", issue: 21, what: "contradiction is whole-value comparison under one key" },
    ];

    it.each(REQUIRED)("$file still records: $what (#$issue)", ({ file, issue }) => {
      const source = readFileSync(join(REPO_ROOT, file), "utf-8");
      const markers = [...source.matchAll(MARKER_GLOBAL)].map((m) => Number(m[1]));
      expect(markers).toContain(issue);
    });

    /**
     * A marker's statement must be COMPLETE on the marker's own line, and
     * this is the one rule here that was learned rather than designed.
     *
     * The first five markers written were wrapped across two comment lines,
     * because that is what reads well in a doc comment. The propagation
     * workflow reads a unified diff line by line, so every one of them
     * arrived at its issue truncated mid-sentence -- "the frozen artifact is
     * the omniscient timeline -- it", and nothing else. A notification that
     * mangles the thing it is announcing is worse than none: it trains a
     * reader to skim past exactly the comment they should stop at.
     *
     * Terminating punctuation is the check, because it is the one property
     * that distinguishes "the author finished the sentence here" from "the
     * author continued it below" without reading either. A literal check for
     * a character in a format this codebase defines -- not an attempt to
     * understand the sentence (hard rule 4).
     */
    it("every marker in src/ carries a complete, single-line statement", () => {
      const malformed: Offence[] = [];
      for (const file of allSources) {
        const path = repoPath(file);
        if (EXCLUDED_PATHS.has(path)) continue;
        readFileSync(file, "utf-8")
          .split("\n")
          .forEach((line, index) => {
            const match = MARKER.exec(line);
            if (!match) return;
            const statement = line.slice(match.index + match[0].length).trim();
            const complete = statement.length > 0 && /[.!?]$/.test(statement);
            if (!complete) {
              malformed.push({
                file: path,
                line: index + 1,
                text: `${line.trim()}   <-- statement must end on this line, with terminating punctuation`,
              });
            }
          });
      }
      expect(malformed.length === 0 ? "" : render(malformed)).toBe("");
    });

    it("the required-sites list covers both open deferred issues (guard against silent shrinkage)", () => {
      expect([...new Set(REQUIRED.map((r) => r.issue))].sort()).toEqual([18, 21]);
    });
  });
});
