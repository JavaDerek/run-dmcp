#!/usr/bin/env node
// A consumer, played by this harness.
//
// Every other server this repository starts either exercises the engine
// through its own unit tests (no MCP wire involved) or spawns the SHIPPED
// binary (dist/bin/run-dmcp.js), which registers no mechanics and no
// vocabulary at all -- src/mcp-server.ts's own doc comment is explicit that
// an engine built with neither option gets no resolve/render surface, and
// that absence is deliberate. So the shipped binary alone can never prove
// design §5.2a/§7's actual promise: that a REAL consumer, injecting its OWN
// mechanics and its OWN vocabulary at construction, gets a resolve protocol
// and a state-to-text projection that behave exactly as advertised, over
// the real MCP wire, in a fresh process.
//
// This script is that consumer. It is deliberately thin -- two mechanics
// and one small vocabulary, both grain/treasury/population flavoured
// (root CLAUDE.md, engineVocabulary.test.ts) -- because its only job is to
// exercise the injection SEAM, not to look like a real game.
//
// Built the way a real consumer would build it: `createMcpServer` from
// `dist/rpg/index.js`, never from `src/`. A consumer never imports this
// engine's TypeScript sources -- it imports the published package, which is
// dist/. Importing src/ here would let a harness accidentally prove
// something true only of the source tree and never of what actually ships.
//
// STDOUT IS THE JSON-RPC CHANNEL. Every diagnostic here goes to stderr,
// through dist/utils/logger.js (already stderr-only) or console.error
// directly -- never console.log, never process.stdout.write. A single stray
// stdout write would corrupt every message after it for the client on the
// other end of this pipe.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertHermetic } from "./tempDb.js";
import { initializeSchema } from "../../dist/db/schema.js";
import { closeDatabase } from "../../dist/db/connection.js";
import { createMcpServer } from "../../dist/rpg/index.js";
import type { Mechanic, AdjudicationInput, Adjudication } from "../../dist/timeline/resolve.js";
import type { RenderVocabulary } from "../../dist/timeline/render.js";
import { createLogger } from "../../dist/utils/logger.js";

const log = createLogger("consumer-server");

// ============================================================================
// Mechanics -- design §5.2a. The engine dispatches these by name and never
// learns what they mean; everything below is this HARNESS's own opinion, not
// the engine's. Both mechanics take the entity/resource ids they operate on
// as `parameters`, exactly the way a real consumer would: a mechanic
// registered once, at process construction, has no way to know which
// resource a future `resolve()` call will actually name.
// ============================================================================

/** Parameters `TITHE` expects on `Proposal.parameters`. Opaque to the engine
 *  (resolve.ts's own doc comment); validated here, by the mechanic, because
 *  nothing upstream of `adjudicate` ever will. */
interface TitheParameters {
  resourceId: string;
  amount: number;
  reason?: string;
}

function asTitheParameters(parameters: Record<string, unknown>): TitheParameters {
  const { resourceId, amount, reason } = parameters;
  if (typeof resourceId !== "string" || resourceId.length === 0) {
    throw new Error(`TITHE: parameters.resourceId must be a non-empty string, got ${JSON.stringify(resourceId)}`);
  }
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new Error(`TITHE: parameters.amount must be a finite number, got ${JSON.stringify(amount)}`);
  }
  if (reason !== undefined && typeof reason !== "string") {
    throw new Error(`TITHE: parameters.reason must be a string when supplied, got ${JSON.stringify(reason)}`);
  }
  return { resourceId, amount, reason };
}

/**
 * Moves a value through the audited path -- design §5.4's "one choke point",
 * proven from OUTSIDE the engine: a caller declares a `resolve_only`
 * constraint on a resource (via `declare_resource_constraint`), which
 * refuses every DIRECT write to it, and this mechanic is the only door left
 * standing. One `IntendedWrite`, nothing clever -- the interesting behaviour
 * belongs to the engine's own constraint enforcement, not to this mechanic.
 */
const TITHE: Mechanic = {
  name: "TITHE",
  adjudicate(input: AdjudicationInput): Adjudication {
    const { resourceId, amount, reason } = asTitheParameters(input.parameters);
    return {
      changes: [
        {
          kind: "write",
          entityId: resourceId,
          key: "value",
          mode: "delta",
          value: amount,
          reason: reason ?? "a tithe was collected",
        },
      ],
      result: { collected: amount },
      description: "a tithe was collected",
    };
  },
};

/** Parameters `SPOIL` expects. Two independent writes, each named by the
 *  caller -- see the mechanic's own doc comment for why. */
interface SpoilParameters {
  grainResourceId: string;
  grainLoss: number;
  secondResourceId: string;
  secondDelta: number;
}

function asSpoilParameters(parameters: Record<string, unknown>): SpoilParameters {
  const { grainResourceId, grainLoss, secondResourceId, secondDelta } = parameters;
  if (typeof grainResourceId !== "string" || grainResourceId.length === 0) {
    throw new Error(`SPOIL: parameters.grainResourceId must be a non-empty string, got ${JSON.stringify(grainResourceId)}`);
  }
  if (typeof grainLoss !== "number" || !Number.isFinite(grainLoss)) {
    throw new Error(`SPOIL: parameters.grainLoss must be a finite number, got ${JSON.stringify(grainLoss)}`);
  }
  if (typeof secondResourceId !== "string" || secondResourceId.length === 0) {
    throw new Error(`SPOIL: parameters.secondResourceId must be a non-empty string, got ${JSON.stringify(secondResourceId)}`);
  }
  if (typeof secondDelta !== "number" || !Number.isFinite(secondDelta)) {
    throw new Error(`SPOIL: parameters.secondDelta must be a finite number, got ${JSON.stringify(secondDelta)}`);
  }
  return { grainResourceId, grainLoss, secondResourceId, secondDelta };
}

/**
 * Two `IntendedWrite`s, applied in order inside resolve.ts's ONE transaction
 * (step 5 of its own doc comment). The first is always legal on its own; the
 * second is left to the CALLER to make legal or not -- this mechanic never
 * decides that, it only proposes two writes. A caller that has separately
 * declared a constraint the second write violates gets to watch the whole
 * resolution roll back, including the first write that would otherwise have
 * landed cleanly: the same "mid-adjudication failure rolls back everything"
 * guarantee resolve.test.ts proves from inside the engine, proven here from
 * outside it, over the real MCP wire. Deliberately not a mechanic that
 * throws a plain `Error` itself -- that would refuse BEFORE resolve.ts's
 * transaction ever opens (dispatch precedes apply), which is a real and
 * already-covered refusal shape (the unknown-mechanic test covers the same
 * "nothing opens" property) but proves nothing about ROLLING BACK a write
 * that had already, moments earlier in the same call, gone through the
 * choke point.
 */
const SPOIL: Mechanic = {
  name: "SPOIL",
  adjudicate(input: AdjudicationInput): Adjudication {
    const { grainResourceId, grainLoss, secondResourceId, secondDelta } = asSpoilParameters(input.parameters);
    return {
      changes: [
        { kind: "write", entityId: grainResourceId, key: "value", mode: "delta", value: -Math.abs(grainLoss), reason: "spoilage" },
        { kind: "write", entityId: secondResourceId, key: "value", mode: "delta", value: secondDelta, reason: "spoilage side-effect" },
      ],
      result: { spoiled: Math.abs(grainLoss) },
      description: "grain spoiled in storage",
    };
  },
};

/** Parameters `REDISTRIBUTE` expects: a two-leg move between two resources
 *  that must already belong to the same declared `conserved` set. */
interface RedistributeParameters {
  fromResourceId: string;
  toResourceId: string;
  amount: number;
  reason?: string;
}

function asRedistributeParameters(parameters: Record<string, unknown>): RedistributeParameters {
  const { fromResourceId, toResourceId, amount, reason } = parameters;
  if (typeof fromResourceId !== "string" || fromResourceId.length === 0) {
    throw new Error(`REDISTRIBUTE: parameters.fromResourceId must be a non-empty string, got ${JSON.stringify(fromResourceId)}`);
  }
  if (typeof toResourceId !== "string" || toResourceId.length === 0) {
    throw new Error(`REDISTRIBUTE: parameters.toResourceId must be a non-empty string, got ${JSON.stringify(toResourceId)}`);
  }
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new Error(`REDISTRIBUTE: parameters.amount must be a finite number, got ${JSON.stringify(amount)}`);
  }
  if (reason !== undefined && typeof reason !== "string") {
    throw new Error(`REDISTRIBUTE: parameters.reason must be a string when supplied, got ${JSON.stringify(reason)}`);
  }
  return { fromResourceId, toResourceId, amount, reason };
}

/**
 * The one mechanic here that proposes an `IntendedTransfer` rather than an
 * `IntendedWrite` -- needed because a `conserved` member's value can NEVER
 * move through a single-resource write, not even inside resolve()'s own
 * adjudication window (constrained.ts's `assertConstraintsAllow`: a direct
 * write to a conserved member is rejected unconditionally, since a
 * single-resource write can never say where the offsetting change should
 * come from -- only the two-leg transfer preserves the set's total). A
 * resource that is BOTH `conserved` and `resolve_only` -- the combination
 * `resolveOnly.test.ts`'s own "transferConstrainedValue ALSO refused"
 * test exercises -- can therefore only ever move through THIS mechanic, and
 * only via resolve(): TITHE's plain write would be refused by the conserved
 * check even with an adjudication window open, and a direct
 * transfer_resource_value call is refused by the resolve_only check outside
 * one. This mechanic is what closes that loop from outside the engine.
 */
const REDISTRIBUTE: Mechanic = {
  name: "REDISTRIBUTE",
  adjudicate(input: AdjudicationInput): Adjudication {
    const { fromResourceId, toResourceId, amount, reason } = asRedistributeParameters(input.parameters);
    return {
      changes: [
        {
          kind: "transfer",
          fromEntityId: fromResourceId,
          toEntityId: toResourceId,
          key: "value",
          amount,
          reason: reason ?? "redistributed",
        },
      ],
      result: { moved: amount },
      description: "value redistributed between two conserved members",
    };
  },
};

const MECHANICS: Mechanic[] = [TITHE, SPOIL, REDISTRIBUTE];

// ============================================================================
// Vocabulary -- design §7. Keyed on `category`, a REAL, freely-settable
// column of the `resources` table (src/db/schema.ts) -- not a fact key this
// harness invented, because create_resource/update_resource are the only
// tools available over MCP to open and close fact intervals on a value this
// vocabulary can name. grain/treasury/population flavoured throughout
// (root CLAUDE.md, engineVocabulary.test.ts) -- a throwaway fixture for
// exercising mechanism, never a starter set. Positive nouns and adjectives
// only, in the style of src/__tests__/renderTool.test.ts's own
// FIXTURE_VOCABULARY.
// ============================================================================
const FIXTURE_VOCABULARY: RenderVocabulary = {
  category: {
    full: { noun: "grain stores", adjectives: ["brimming", "full"] },
    spent: { noun: "grain husks", adjectives: ["swept", "dry"] },
    stacked: { noun: "treasury coffers", adjectives: ["stacked", "gleaming"] },
    growing: { noun: "population count", adjectives: ["growing"] },
  },
};

/**
 * Deliberately malformed: an `avoid` field alongside `noun`, the exact
 * regression `src/__tests__/renderTool.test.ts` guards against inside the
 * same process. Reachable only via `E2E_BAD_VOCABULARY=1` -- a token this
 * HARNESS defines for itself (root CLAUDE.md hard rule 5's "a literal check
 * for a token we defined is fine" exception), never parsed out of anything
 * the engine produced. Exists so a spec can prove the refusal from OUTSIDE
 * the engine, in a fresh process, rather than only inside
 * createCoreMcpServer's own unit test.
 */
const BAD_VOCABULARY = {
  category: {
    full: { noun: "grain stores", avoid: ["empty granaries"] },
  },
} as unknown as RenderVocabulary;

async function main(): Promise<void> {
  // Hermeticity first, before this process opens anything -- the same
  // ordering every harness in e2e/support uses.
  assertHermetic(process.env);

  initializeSchema();

  // `createMcpServer` validates `vocabulary` AT CONSTRUCTION (mcp-server.ts's
  // own doc comment: it builds the renderer here, not later, specifically so
  // a malformed vocabulary never reaches a running server). If
  // E2E_BAD_VOCABULARY=1, this call throws before a transport is ever
  // connected -- caught below, never silently swallowed.
  const vocabulary = process.env.E2E_BAD_VOCABULARY === "1" ? BAD_VOCABULARY : FIXTURE_VOCABULARY;

  const server = createMcpServer({ mechanics: MECHANICS, vocabulary });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("consumer server connected", { pid: process.pid, mechanics: MECHANICS.map((m) => m.name) });
}

process.on("SIGINT", () => {
  closeDatabase();
  process.exit(0);
});

process.on("SIGTERM", () => {
  closeDatabase();
  process.exit(0);
});

main().catch((error) => {
  // The one path E2E_BAD_VOCABULARY=1 is meant to take: a construction-time
  // throw, logged with a real message, exiting non-zero BEFORE any
  // transport connects. A spec watching this process from outside sees a
  // dead child and a useful stderr line, never a hang.
  log.error("consumer server failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    closeDatabase();
  } catch {
    // Never opened, or already closed -- either way, nothing left to do.
  }
  process.exit(1);
});
