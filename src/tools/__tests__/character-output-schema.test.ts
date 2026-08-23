import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createTestDb, destroyTestDb } from "../../db/__tests__/testDb.js";
import { createGame } from "../game.js";
import { createCharacter, getCharacter, updateCharacter, getCharacterByName } from "../character.js";
import { characterOutputSchema } from "../../utils/output-schemas.js";

// registerTool's zod -> JSON Schema conversion emits `additionalProperties: false`,
// so a validating MCP client rejects any key the declared outputSchema doesn't
// list. `.strict()` reproduces that same rejection here.
const strictCharacterSchema = z.object(characterOutputSchema).strict();

describe("characterOutputSchema", () => {
  let gameId: string;

  beforeEach(() => {
    createTestDb();
    gameId = createGame({ name: "Test Game", setting: "Test Setting", style: "Test Style" }).id;
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("accepts a character created without voice or imageGen", () => {
    const character = createCharacter({ gameId, name: "Doctor", isPlayer: false });

    expect(() => strictCharacterSchema.parse(character)).not.toThrow();
  });

  it("accepts a character created with voice and imageGen", () => {
    const character = createCharacter({
      gameId,
      name: "Bard",
      isPlayer: false,
      voice: { pitch: "medium", speed: "medium", tone: "melodic" },
      imageGen: {
        subject: { type: "character", primaryDescription: "a traveling bard" },
        style: { artisticStyle: "digital painting", genre: "fantasy", mood: "whimsical" },
        composition: { framing: "portrait" },
      },
    });

    expect(() => strictCharacterSchema.parse(character)).not.toThrow();
  });

  it("accepts the output of getCharacter", () => {
    const created = createCharacter({ gameId, name: "Guard", isPlayer: false });
    const fetched = getCharacter(created.id);

    expect(() => strictCharacterSchema.parse(fetched)).not.toThrow();
  });

  it("accepts the output of updateCharacter", () => {
    const created = createCharacter({ gameId, name: "Merchant", isPlayer: false });
    const updated = updateCharacter(created.id, { notes: "sells potions" });

    expect(() => strictCharacterSchema.parse(updated)).not.toThrow();
  });

  it("accepts the output of getCharacterByName", () => {
    createCharacter({ gameId, name: "Innkeeper", isPlayer: false });
    const found = getCharacterByName(gameId, "Innkeeper");

    expect(() => strictCharacterSchema.parse(found)).not.toThrow();
  });
});
