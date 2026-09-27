import { resolveCitation, validateSourceIds, type AcceptedCitation, type ReaderSource, type RejectionReason } from "./turnReader.js";

/**
 * A preflight over a declared world (GitHub issue #37), run before play.
 *
 * Two failures that are otherwise silent until a transcript is read: a
 * reachable property whose object's text holds nothing a citation could
 * quote for it (every attempt on it is refused, forever), and prose that an
 * author meant to matter with nothing modelled behind it (an actor plans
 * around it and gets nowhere). The engine cannot find either by reading a
 * description -- "does this text ground `integrity`" is a judgement about
 * meaning (hard rule 4). So the CALLER declares, as data it already owns,
 * which span of which source grounds which target, and this checks those
 * declarations with the turn reader's own citation rule (`resolveCitation`),
 * so a span that passes here is exactly a span that would pass live.
 *
 * `target` is opaque: the engine never parses it, compares it only for
 * equality, and has no idea it is usually "<object>.<property>".
 *
 * Rows, never a verdict (hard rule 2). The counts are the report: a target
 * with `grounded: 0` can never be cited, a span with `occurrences` above 1
 * does not pick out one place, a span with `reachable: false` names a target
 * nothing can act on. What any of that means for a given world is the
 * caller's to decide. Quantity claims ("one of five") are not checked here:
 * only the caller knows what it modelled, and once it has declared the span,
 * comparing two of its own numbers needs no engine.
 */
export interface DeclaredGrounding {
  target: string;
  sourceId: string;
  quote?: string;
  from?: number;
  to?: number;
}

export interface GroundingRow {
  target: string;
  sourceId: string;
  /** The span as it would be cited: the quote given, or a range rebuilt. Absent when it does not cite. */
  quote?: string;
  range?: AcceptedCitation["range"];
  /** The citation rule's own reason, when the span does not cite. */
  reason?: RejectionReason;
  /** Non-overlapping, byte-exact occurrences of the span in its source; 0 when it does not cite. */
  occurrences: number;
  /** Whether `target` is among the targets the caller listed as reachable. */
  reachable: boolean;
}

export interface TargetRow {
  target: string;
  /** Declared spans for this target that cite. */
  grounded: number;
  /** Of those, the ones that occur exactly once in their source. */
  uniquelyGrounded: number;
}

export interface GroundingReport {
  groundings: GroundingRow[];
  targets: TargetRow[];
}

function occurrencesOf(text: string, span: string): number {
  let count = 0;
  for (let at = text.indexOf(span); at !== -1; at = text.indexOf(span, at + span.length)) count++;
  return count;
}

export function checkGroundings(params: {
  sources: readonly ReaderSource[];
  targets: readonly string[];
  groundings: readonly DeclaredGrounding[];
}): GroundingReport {
  validateSourceIds(params.sources);
  const reachable = new Set<string>();
  for (const target of params.targets) {
    if (reachable.has(target)) throw new Error(`duplicate target '${target}'`);
    reachable.add(target);
  }
  const sourcesById = new Map(params.sources.map((s) => [s.id, s]));

  const groundings: GroundingRow[] = params.groundings.map((g) => {
    const { target, sourceId, quote, from, to } = g;
    const cited = resolveCitation({ sourceId, quote, from, to }, sourcesById);
    const base = { target, sourceId, reachable: reachable.has(target) };
    if ("reason" in cited) return { ...base, reason: cited.reason, occurrences: 0 };
    const text = sourcesById.get(sourceId)?.text ?? "";
    return {
      target,
      sourceId,
      quote: cited.citation.quote,
      ...(cited.citation.range ? { range: cited.citation.range } : {}),
      occurrences: occurrencesOf(text, cited.citation.quote),
      reachable: base.reachable,
    };
  });

  const targets: TargetRow[] = params.targets.map((target) => {
    const citing = groundings.filter((g) => g.target === target && g.reason === undefined);
    return { target, grounded: citing.length, uniquelyGrounded: citing.filter((g) => g.occurrences === 1).length };
  });

  return { groundings, targets };
}
