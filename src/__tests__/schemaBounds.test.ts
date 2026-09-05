// Every string parameter this engine DECLARES carries a maxLength.
//
// `LIMITS` (src/utils/validation.ts) says it exists to "prevent DoS attacks
// via extremely large inputs", and that reason still holds. It is not the
// reason this file exists. The schemas are also the engine's PUBLISHED
// CONTRACT: zod's `.max()` lands in each tool's `input_schema`, and
// `tools/list` hands it to every client before the first call. A client that
// reads the declaration -- which is the direction of travel -- sees
// "unbounded" and correctly clamps nothing. An unbounded declaration is not a
// missing safety net; it is an active statement to every consumer that the
// field takes anything.
//
// A consumer survey turned this up rather than a test (issue #29). A loader
// downstream hand-mirrors NAME_MAX/DESCRIPTION_MAX/CONTENT_MAX as constants
// copied from validation.ts, because nobody noticed we already publish them.
// It is about to stop copying and start reading. On the day it does,
// `connect_locations` -- which declared no bound on any of its five strings --
// would have lost the clamp it applies today, correctly, because it would be
// following what we say. What we say should be what we mean.
//
// WHAT THIS ASKS, AND WHY IT ASKS IT OF A CLIENT.
// The question is not "does the source contain `.max()`" -- a grep answers
// that, and answers it wrongly, because a bound can arrive through a shared
// schema module or be lost in a `z.union` branch that no call site shows. The
// question is what a consumer RECEIVES. So this connects a real MCP client to
// a real server over an in-memory transport and walks the JSON Schema that
// comes back from `tools/list`: the same bytes Adventurer parses, arrived at
// the same way. That is also why the walk descends into `anyOf`, `items` and
// nested `properties` -- `resolve`'s `expects[].value` is a union whose string
// branch is a leaf no register module mentions by name.
//
// THE WALK DOES NOT FOLLOW `$ref`, AND THE SECOND HALF OF THIS FILE IS WHY IT
// DOES NOT HAVE TO. `zod-to-json-schema` de-duplicates by object IDENTITY, so
// a schema instance reused twice inside one tool is published the second time
// as a pointer into a sibling property path. That is not hypothetical: the
// first draft of the fix shared each bound as a constant and put 648 `$ref`s
// into a contract that had none, which would have made this guard walk past
// the very leaves it had just bounded. So the tiers hand back a fresh instance
// per access (see `validatedSchemas`), and a second test below fails on any
// `$ref` at all. Together they say: every declaration is present, and every
// declaration is where a consumer will look for it.
//
// WHAT IS EXEMPT, AND NOTHING ELSE IS.
// A string constrained to an enumerated set (`z.enum`, `z.literal`) is bounded
// by that set; it needs no length. That is the entire exemption list. Not
// `format`, not `pattern`: an anchored regex may still admit an unbounded
// string, and "it's a UUID" is a claim about intent, not a bound.
//
// INPUT ONLY. `outputSchema` is left alone on purpose: a maxLength there is a
// promise about content the ENGINE produces, and a validating client would
// reject a long-but-correct response -- which is run-dmcp#24's failure mode
// with the sign flipped. Bounds constrain what a caller may send.
//
// THE BOUND IS A CEILING, NOT A SHAPE. Bounding a field means adding `.max()`
// and NOTHING else. `validatedSchemas.name` carries `.min(1)`, so it is used
// only where a call site already declared `min(1)` -- adding one elsewhere
// would reject empty strings that are accepted today, which is a different
// change wearing this one's clothes. This guard demands a ceiling; it must not
// become the reason a field acquired a floor.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCoreMcpServer } from "../mcp-server.js";
import { createMcpServer } from "../rpg/server.js";
import type { Mechanic } from "../timeline/resolve.js";
import type { RenderVocabulary } from "../timeline/render.js";

/** grain, treasury, population -- a throwaway fixture vocabulary for
 *  exercising mechanism, never a starter set (design §10). */
const FIXTURE_VOCABULARY: RenderVocabulary = {
  grain: { full: { noun: "stores", adjectives: ["brimming"] } },
};

/** Present only so `resolve` and `list_mechanics` get registered and their
 *  schemas are walked. A server built with neither mechanics nor vocabulary
 *  serves neither tool, and this guard would silently not cover them. */
const FIXTURE_MECHANIC: Mechanic = {
  name: "fixture",
  adjudicate: () => ({ changes: [] }),
};

type JsonSchema = Record<string, unknown>;

interface StringLeaf {
  tool: string;
  path: string;
  maxLength: number | undefined;
}

/**
 * Every string-typed leaf in a tool's declared input schema, by field path.
 *
 * Structural throughout: it reads JSON Schema keywords -- tokens this
 * codebase's own toolchain emitted -- and never inspects a description, a
 * field name or any natural language (root CLAUDE.md hard rule 4).
 */
function stringLeaves(schema: JsonSchema | undefined, tool: string, path = ""): StringLeaf[] {
  if (!schema || typeof schema !== "object") return [];
  const leaves: StringLeaf[] = [];
  const at = (segment: string) => (path === "" ? segment : `${path}${segment}`);

  for (const branchKey of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[branchKey];
    if (Array.isArray(branches)) {
      branches.forEach((branch, i) =>
        leaves.push(...stringLeaves(branch as JsonSchema, tool, at(`|${branchKey}[${i}]`)))
      );
    }
  }

  const declared = schema.type;
  const types = Array.isArray(declared) ? declared : [declared];

  if (types.includes("string")) {
    // Bounded by an enumerated set rather than by length. The only exemption.
    const enumerated = schema.enum !== undefined || schema.const !== undefined;
    if (!enumerated) {
      const max = schema.maxLength;
      leaves.push({ tool, path, maxLength: typeof max === "number" ? max : undefined });
    }
  }

  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    for (const [key, sub] of Object.entries(properties as Record<string, JsonSchema>)) {
      leaves.push(...stringLeaves(sub, tool, path === "" ? key : `${path}.${key}`));
    }
  }
  // `z.record(z.string(), ...)` declares its VALUES here and its KEYS in
  // propertyNames; both are strings a caller sends.
  for (const key of ["additionalProperties", "propertyNames"] as const) {
    const sub = schema[key];
    if (sub && typeof sub === "object") {
      leaves.push(...stringLeaves(sub as JsonSchema, tool, at(key === "propertyNames" ? ".<key>" : ".*")));
    }
  }
  if (schema.items && typeof schema.items === "object") {
    leaves.push(...stringLeaves(schema.items as JsonSchema, tool, at("[]")));
  }
  return leaves;
}

/** The declared schemas as a CLIENT receives them, over a real transport. */
async function declaredStringLeaves(server: ReturnType<typeof createCoreMcpServer>): Promise<StringLeaf[]> {
  const client = new Client({ name: "schema-bounds-guard", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.flatMap((tool) => stringLeaves(tool.inputSchema as JsonSchema, tool.name));
  } finally {
    await client.close();
  }
}

const unbounded = (leaves: StringLeaf[]) => leaves.filter((leaf) => leaf.maxLength === undefined);

const report = (leaves: StringLeaf[]) =>
  `${leaves.length} string parameter(s) declared with no maxLength:\n` +
  leaves.map((leaf) => `  ${leaf.tool}  ${leaf.path || "(root)"}`).join("\n");

// A guard that cannot go red is worse than no guard (root CLAUDE.md,
// Testing). The walker is the whole mechanism here, so it is tested against
// planted violations rather than trusted because it passes.
describe("the walker finds what it claims to find", () => {
  it("flags a bare string parameter", () => {
    const found = stringLeaves({ type: "object", properties: { name: { type: "string" } } }, "t");
    expect(found).toEqual([{ tool: "t", path: "name", maxLength: undefined }]);
  });

  it("accepts a bounded one", () => {
    const found = stringLeaves({ type: "object", properties: { name: { type: "string", maxLength: 200 } } }, "t");
    expect(unbounded(found)).toEqual([]);
  });

  it("exempts an enum, and a const", () => {
    const schema = {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["a", "b"] },
        tag: { type: "string", const: "fixed" },
      },
    };
    expect(stringLeaves(schema, "t")).toEqual([]);
  });

  it("does not exempt a format or a pattern -- neither is a length", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        slug: { type: "string", pattern: "^[a-z]+$" },
      },
    };
    expect(unbounded(stringLeaves(schema, "t")).map((leaf) => leaf.path)).toEqual(["id", "slug"]);
  });

  it("descends into nested objects, arrays, records and union branches", () => {
    const schema = {
      type: "object",
      properties: {
        nested: { type: "object", properties: { deep: { type: "string" } } },
        list: { type: "array", items: { type: "string" } },
        map: { type: "object", additionalProperties: { type: "string" } },
        either: { anyOf: [{ type: "string" }, { type: "number" }] },
      },
    };
    expect(unbounded(stringLeaves(schema, "t")).map((leaf) => leaf.path).sort()).toEqual([
      "either|anyOf[0]",
      "list[]",
      "map.*",
      "nested.deep",
    ]);
  });
});

/** Every `$ref` in a published input schema, by the path it sits at. */
function refs(schema: unknown, tool: string, path = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  const found: string[] = [];
  if (typeof node.$ref === "string") found.push(`${tool}  ${path || "(root)"} -> ${node.$ref}`);
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") found.push(...refs(value, tool, `${path}/${key}`));
  }
  return found;
}

async function declaredRefs(server: ReturnType<typeof createCoreMcpServer>): Promise<string[]> {
  const client = new Client({ name: "schema-bounds-guard", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { tools } = await client.listTools();
    return tools.flatMap((tool) => refs(tool.inputSchema, tool.name));
  } finally {
    await client.close();
  }
}

// A declaration, not a pointer to one. This is what a consumer parses, and
// half of them will not resolve a JSON pointer at all -- but the reason it is
// a TEST is that nothing about writing `validatedSchemas.name` twice looks
// like it changes the wire format, and it does.
describe("the published schemas are declarations, not pointers", () => {
  it("the walker finds a planted $ref", () => {
    const planted = { type: "object", properties: { b: { $ref: "#/properties/a" } } };
    expect(refs(planted, "t")).toEqual(["t  /properties/b -> #/properties/a"]);
  });

  it("the full assembly publishes no $ref anywhere", async () => {
    const found = await declaredRefs(
      createMcpServer({ mechanics: [FIXTURE_MECHANIC], vocabulary: FIXTURE_VOCABULARY })
    );
    expect(found, `${found.length} $ref(s) published:\n${found.slice(0, 20).join("\n")}`).toEqual([]);
  });
});

describe("every string parameter the engine declares carries a maxLength", () => {
  it("walks a meaningful number of them (guard against a vacuous pass)", async () => {
    const leaves = await declaredStringLeaves(createCoreMcpServer());
    expect(leaves.length).toBeGreaterThan(300);
  });

  it("the core server declares no unbounded string", async () => {
    const offenders = unbounded(
      await declaredStringLeaves(
        createCoreMcpServer({ mechanics: [FIXTURE_MECHANIC], vocabulary: FIXTURE_VOCABULARY })
      )
    );
    expect(offenders, report(offenders)).toEqual([]);
  });

  it("the full assembly declares no unbounded string either", async () => {
    const offenders = unbounded(
      await declaredStringLeaves(
        createMcpServer({ mechanics: [FIXTURE_MECHANIC], vocabulary: FIXTURE_VOCABULARY })
      )
    );
    expect(offenders, report(offenders)).toEqual([]);
  });
});
