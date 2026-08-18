// No client's vocabulary reaches the engine.
//
// run-dmcp exists to serve more than one piece of interactive fiction. Two
// consumers were in the room when it was designed and they are deliberately
// unlike each other: a geopolitical roleplay whose world advances one turn at a
// time, and a music-video pipeline whose units have duration and no player at
// all. Neither may become the reason the engine exists.
//
// That intention cannot survive as a rule people remember. The predecessor's
// own history shows why: `resource_history` and `relationship_history` were
// added because somebody needed them, and nothing generalised the idea, so the
// concept of versioning existed for exactly two tables for the life of the
// project. Good intentions do not generalise; tests do.
//
// So the line is a test. It runs in CI on every push, against the actual
// tracked file list, and it fails when a specific client's language appears in
// the engine — which is the first observable symptom of "engine with two
// consumers" decaying into "one client's library with a second bolted on".
//
// WHAT THIS IS NOT: a check that the engine is free of narrative vocabulary.
// Dice, combat, quests and factions are inherited and generic — they belong to
// the RPG layer above the core, not to any one client. The forbidden list is
// specifically the vocabulary of the two named consumers, plus terms that could
// only have come from one of them.
//
// WHERE FIXTURES COME FROM: grain, treasury, population. A throwaway vocabulary
// for exercising the mechanism, never a starter set anyone should build on.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * The design brief is excluded, and only it.
 *
 * That document's entire job is to explain where the boundary between engine
 * and consumer falls, and it cannot do that without naming the consumers on
 * either side of it. Excluding the explanation of a rule is not a hole in the
 * rule. Excluding anything else would be.
 */
const EXCLUDED_PATHS = new Set(["docs/DESIGN.md"]);

function scannedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !EXCLUDED_PATHS.has(f))
    .filter((f) => basename(f) !== "engineVocabulary.test.ts")
    .filter((f) => !/package-lock\.json$/.test(f))
    .filter((f) => !/\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp3|wav|onnx|pth|bin)$/i.test(f));
}

/**
 * Each entry carries why, because a bare list of forbidden words is exactly the
 * thing a future contributor deletes when it gets in their way.
 *
 * Note the shapes chosen. `\baccords?\b` and not `\baccord` — the latter also
 * matches "accordance" and "according", which are ordinary English. `chunk_id`
 * and not `chunk` — a chunked read is a legitimate generic idea. No bare
 * `shot`: the tree already says "in one shot" and `"wide shot"` as an image
 * framing, both of which are fine. A rule that cries wolf gets deleted, and
 * then it is protecting nothing.
 */
const FORBIDDEN: Array<{ pattern: RegExp; what: string; why: string }> = [
  {
    pattern: /\bDEFCON\b/i,
    what: "a consumer's escalation ladder",
    why: "one game's bounded resource. The engine has `bounded` constraints; it has never heard of a ladder.",
  },
  {
    pattern: /\bprestige\b/i,
    what: "a consumer's conserved resource",
    why: "the engine offers conserved resource SETS. Which resource is conserved, and among whom, is the game's.",
  },
  {
    pattern: /\bflashpoints?\b/i,
    what: "a consumer's contested location",
    why: "the engine has entities and locations. 'Flashpoint' is a geopolitical reading of one.",
  },
  {
    pattern: /\bcohesion\b/i,
    what: "a consumer's per-location scalar",
    why: "a resource on a location. The name belongs to the game that decided what it measures.",
  },
  {
    pattern: /\bcompellence\b|\bARMED_STRIKE\b|\bPRESTIGE_CONTEST\b|\bFLASHPOINT_SEIZURE\b/,
    what: "a consumer's mechanic names",
    why: "mechanics are registered BY a game (design §5.2a). The engine dispatches them and never learns what they mean.",
  },
  {
    pattern: /\baccords?\b/i,
    what: "a consumer's negotiated agreement",
    why: "the engine has facts with obligations. 'Accord' is one game's word for a bundle of them.",
  },
  {
    pattern: /\bseats?\b/i,
    what: "a consumer's player positions",
    why: "the engine has entities and (eventually) per-entity visibility. Seats are how one game partitions them.",
  },
  {
    pattern: /\bcrises\b|\bcrisis\b/i,
    what: "a consumer's timed pressure",
    why: "the engine has scheduled events with on-expiry consequences. What makes one a crisis is the game's fiction.",
  },
  {
    pattern: /\blyrics?\b|\bchorus\b|\bverses?\b|\bstoryboards?\b/i,
    what: "the other consumer's source material",
    why: "the engine renders state at t. That the state was authored against a song is not its business.",
  },
  {
    pattern: /\bchunk_id\b|\bchunkId\b|\bshot_id\b|\bshotId\b|\bshot lines?\b/i,
    what: "the other consumer's unit identifiers",
    why:
      "and these are the ones that must never appear, because that client's own rule is that an index " +
      "into re-segmentable units is the wrong axis (design §5.1). The engine takes `t`, never a unit id.",
  },
  {
    pattern: /\bgeopolitic(s|al)\b/i,
    what: "the domain of one consumer",
    why: "if the engine describes itself by one client's genre, the second client is already a guest.",
  },
];

describe("no client's vocabulary reaches the engine", () => {
  const files = scannedFiles();

  it("scans a meaningful number of tracked files (guard against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(FORBIDDEN)("contains no $what", ({ pattern, why }) => {
    const offenders: string[] = [];
    for (const file of files) {
      let contents: string;
      try {
        contents = readFileSync(resolve(REPO_ROOT, file), "utf8");
      } catch {
        continue;
      }
      contents.split("\n").forEach((line, i) => {
        if (pattern.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(offenders, `${why}\n\n${offenders.join("\n")}`).toEqual([]);
  });

  it("keeps the design brief excluded, and nothing else", () => {
    // If this list ever grows, the rule is being routed around rather than
    // enforced. One exclusion, for the document that explains the rule.
    expect([...EXCLUDED_PATHS]).toEqual(["docs/DESIGN.md"]);
  });
});
