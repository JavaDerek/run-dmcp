// GitHub issue #37: a preflight over a declared world, run before play.
//
// The two failures it exists for are both silent: a property whose object's
// description holds nothing a citation could quote for it (every attempt on it
// is refused, forever), and prose that describes a feature the world does not
// model (a model-driven actor plans around it). Neither can be found by the
// engine READING a description -- "does this text ground `integrity`" is a
// judgement about meaning, and hard rule 4 forbids it. So the caller declares
// which span of which source grounds which target, and the engine checks
// those declarations structurally, with the reader's own citation rule:
//
//   - each declared span: does it cite (same conjuncts as a live citation),
//     and how many times does it occur in its source (a span that occurs
//     twice grounds nothing in particular);
//   - each target the caller's effects can reach: how many accepted spans
//     ground it (zero is failure 1, found before play instead of in a
//     transcript);
//   - each span naming a target the caller did NOT list as reachable: the
//     reverse direction, failure 2 -- prose an author marked as mattering,
//     with nothing behind it.
//
// Rows, never a verdict (hard rule 2): counts and reasons, no `ok`, no score.
//
// Fixtures: grain, treasury, population.
import { describe, it, expect } from "vitest";
import { checkGroundings } from "../preflight.js";

const SOURCES = [
  { id: "desc:granary", text: "A timber granary, its door swollen shut. Grain spills from a split sack. Grain everywhere." },
  { id: "desc:treasury", text: "An iron strongbox." },
];

describe("checkGroundings", () => {
  it("reports each declared span: cited, how often it occurs, and the rebuilt quote for a range", () => {
    const report = checkGroundings({
      sources: SOURCES,
      targets: ["granary.integrity", "granary.contents"],
      groundings: [
        { target: "granary.integrity", sourceId: "desc:granary", quote: "timber granary" },
        { target: "granary.contents", sourceId: "desc:granary", quote: "Grain" },
        { target: "granary.integrity", sourceId: "desc:granary", from: 5, to: 7 },
      ],
    });
    expect(report.groundings).toEqual([
      { target: "granary.integrity", sourceId: "desc:granary", quote: "timber granary", occurrences: 1, reachable: true },
      { target: "granary.contents", sourceId: "desc:granary", quote: "Grain", occurrences: 2, reachable: true },
      { target: "granary.integrity", sourceId: "desc:granary", quote: "door swollen shut.", range: { from: 5, to: 7 }, occurrences: 1, reachable: true },
    ]);
  });

  it("a span that does not cite carries the citation rule's own reason, and grounds nothing", () => {
    const report = checkGroundings({
      sources: SOURCES,
      targets: ["treasury.integrity"],
      groundings: [
        { target: "treasury.integrity", sourceId: "desc:treasury", quote: "iron Strongbox" },
        { target: "treasury.integrity", sourceId: "desc:vault", quote: "iron" },
        { target: "treasury.integrity", sourceId: "desc:treasury", from: 9, to: 9 },
      ],
    });
    expect(report.groundings.map((g) => g.reason)).toEqual(["quote-not-in-source", "unknown-source-id", "range-start-past-end"]);
    expect(report.groundings.map((g) => g.occurrences)).toEqual([0, 0, 0]);
    expect(report.targets).toEqual([{ target: "treasury.integrity", grounded: 0, uniquelyGrounded: 0 }]);
  });

  it("counts, per reachable target, the spans that cite and the spans that cite exactly once -- zero is the silent refusal, found before play", () => {
    const report = checkGroundings({
      sources: SOURCES,
      targets: ["granary.integrity", "granary.contents", "treasury.value"],
      groundings: [
        { target: "granary.integrity", sourceId: "desc:granary", quote: "timber granary" },
        { target: "granary.contents", sourceId: "desc:granary", quote: "Grain" },
      ],
    });
    expect(report.targets).toEqual([
      { target: "granary.integrity", grounded: 1, uniquelyGrounded: 1 },
      { target: "granary.contents", grounded: 1, uniquelyGrounded: 0 },
      { target: "treasury.value", grounded: 0, uniquelyGrounded: 0 },
    ]);
  });

  it("a span naming a target the caller did not list as reachable is reported as unreachable -- prose with nothing behind it", () => {
    const report = checkGroundings({
      sources: SOURCES,
      targets: ["granary.integrity"],
      groundings: [{ target: "granary.sack", sourceId: "desc:granary", quote: "split sack" }],
    });
    expect(report.groundings[0]).toMatchObject({ target: "granary.sack", occurrences: 1, reachable: false });
    expect(report.targets).toEqual([{ target: "granary.integrity", grounded: 0, uniquelyGrounded: 0 }]);
  });

  it("occurrences are counted without overlap, byte-exact, with no case folding", () => {
    const report = checkGroundings({
      sources: [{ id: "s", text: "aaaa Grain grain" }],
      targets: ["t"],
      groundings: [
        { target: "t", sourceId: "s", quote: "aa" },
        { target: "t", sourceId: "s", quote: "grain" },
      ],
    });
    expect(report.groundings.map((g) => g.occurrences)).toEqual([2, 1]);
  });

  it("refuses duplicate source ids and duplicate targets, which would make every count ambiguous", () => {
    expect(() => checkGroundings({ sources: [SOURCES[0], SOURCES[0]], targets: [], groundings: [] })).toThrow(/duplicate source id/);
    expect(() => checkGroundings({ sources: SOURCES, targets: ["a", "a"], groundings: [] })).toThrow(/duplicate target 'a'/);
  });
});
