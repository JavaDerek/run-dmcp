import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createTestDb, destroyTestDb } from "./testDb.js";
import { getDatabase, closeDatabase } from "../connection.js";
import { initializeSchema, type SchemaMigration } from "../schema.js";
import { createGame } from "../../tools/game.js";

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

describe("initializeSchema consumer migrations", () => {
  beforeEach(() => {
    createTestDb();
  });

  afterEach(() => {
    destroyTestDb();
  });

  it("zero-arg initializeSchema() still works", () => {
    expect(() => initializeSchema()).not.toThrow();
    expect(tableExists(getDatabase(), "games")).toBe(true);
  });

  it("creates a table declared by a consumer migration", () => {
    const migration: SchemaMigration = {
      name: "grain",
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS grain (
            id TEXT PRIMARY KEY,
            treasury INTEGER NOT NULL DEFAULT 0
          )
        `);
      },
    };

    initializeSchema({ migrations: [migration] });

    expect(tableExists(getDatabase(), "grain")).toBe(true);
  });

  it("passes up() the same database handle getDatabase() returns", () => {
    let received: Database.Database | undefined;

    initializeSchema({
      migrations: [
        {
          name: "handle-check",
          up(db) {
            received = db;
          },
        },
      ],
    });

    expect(received).toBe(getDatabase());
  });

  it("runs migrations in array order (a second migration ALTERs the table the first created)", () => {
    initializeSchema({
      migrations: [
        {
          name: "create-grain",
          up(db) {
            db.exec(`
              CREATE TABLE IF NOT EXISTS grain (
                id TEXT PRIMARY KEY,
                treasury INTEGER NOT NULL DEFAULT 0
              )
            `);
          },
        },
        {
          name: "add-population-column",
          up(db) {
            try {
              db.exec(`ALTER TABLE grain ADD COLUMN population INTEGER NOT NULL DEFAULT 0`);
            } catch {
              // Column already exists
            }
          },
        },
      ],
    });

    const cols = getDatabase().prepare("PRAGMA table_info(grain)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(["id", "treasury", "population"]);
  });

  it("runs consumer migrations after core tables exist, so a FOREIGN KEY into games succeeds", () => {
    const gameId = createGame({ name: "Test Game", setting: "test", style: "test" }).id;

    initializeSchema({
      migrations: [
        {
          name: "population-table",
          up(db) {
            db.exec(`
              CREATE TABLE IF NOT EXISTS population (
                id TEXT PRIMARY KEY,
                game_id TEXT NOT NULL,
                grain INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
              )
            `);
          },
        },
      ],
    });

    const db = getDatabase();
    expect(() =>
      db.prepare(`INSERT INTO population (id, game_id, grain) VALUES (?, ?, ?)`).run("p1", gameId, 10)
    ).not.toThrow();
    expect(db.prepare("SELECT * FROM population WHERE id = ?").get("p1")).toBeTruthy();
  });

  describe("validation runs before any migration in the array is applied", () => {
    it("throws on a duplicate migration name and applies nothing from the array", () => {
      const migrations: SchemaMigration[] = [
        {
          name: "dup",
          up(db) {
            db.exec(`CREATE TABLE IF NOT EXISTS table_a (id TEXT PRIMARY KEY)`);
          },
        },
        {
          name: "dup",
          up(db) {
            db.exec(`CREATE TABLE IF NOT EXISTS table_b (id TEXT PRIMARY KEY)`);
          },
        },
      ];

      expect(() => initializeSchema({ migrations })).toThrow();

      const db = getDatabase();
      expect(tableExists(db, "table_a")).toBe(false);
      expect(tableExists(db, "table_b")).toBe(false);
    });

    it("throws on a blank (whitespace-only) migration name and applies nothing", () => {
      const migrations: SchemaMigration[] = [
        {
          name: "   ",
          up(db) {
            db.exec(`CREATE TABLE IF NOT EXISTS table_a (id TEXT PRIMARY KEY)`);
          },
        },
      ];

      expect(() => initializeSchema({ migrations })).toThrow();
      expect(tableExists(getDatabase(), "table_a")).toBe(false);
    });

    it("throws on a missing migration name and applies nothing", () => {
      const migrations = [
        {
          up(db: Database.Database) {
            db.exec(`CREATE TABLE IF NOT EXISTS table_a (id TEXT PRIMARY KEY)`);
          },
        },
      ] as unknown as SchemaMigration[];

      expect(() => initializeSchema({ migrations })).toThrow();
      expect(tableExists(getDatabase(), "table_a")).toBe(false);
    });

    it("throws on a non-string migration name and applies nothing", () => {
      const migrations = [
        {
          name: 42,
          up(db: Database.Database) {
            db.exec(`CREATE TABLE IF NOT EXISTS table_a (id TEXT PRIMARY KEY)`);
          },
        },
      ] as unknown as SchemaMigration[];

      expect(() => initializeSchema({ migrations })).toThrow();
      expect(tableExists(getDatabase(), "table_a")).toBe(false);
    });

    it("throws when up is not a function and applies nothing from an earlier valid entry", () => {
      const migrations = [
        {
          name: "good",
          up(db: Database.Database) {
            db.exec(`CREATE TABLE IF NOT EXISTS table_a (id TEXT PRIMARY KEY)`);
          },
        },
        {
          name: "bad-up",
          up: "not-a-function",
        },
      ] as unknown as SchemaMigration[];

      expect(() => initializeSchema({ migrations })).toThrow();
      expect(tableExists(getDatabase(), "table_a")).toBe(false);
    });
  });

  it("a throwing migration names the migration, preserves the original error as cause, logs it, and rolls back its partial writes", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = new Error("boom");

    const migrations: SchemaMigration[] = [
      {
        name: "partial-then-throw",
        up(db) {
          db.exec(`CREATE TABLE IF NOT EXISTS table_a (id TEXT PRIMARY KEY)`);
          throw original;
        },
      },
    ];

    let caught: unknown;
    try {
      initializeSchema({ migrations });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("partial-then-throw");
    expect((caught as Error).cause).toBe(original);

    expect(tableExists(getDatabase(), "table_a")).toBe(false);

    const loggedSomethingWithName = errorSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes("partial-then-throw"))
    );
    expect(loggedSomethingWithName).toBe(true);

    errorSpy.mockRestore();
  });

  it("re-entrancy: two consecutive calls with the same idempotent migration array succeed and leave data intact", () => {
    const migrations: SchemaMigration[] = [
      {
        name: "grain",
        up(db) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS grain (
              id TEXT PRIMARY KEY,
              treasury INTEGER NOT NULL DEFAULT 0
            )
          `);
          try {
            db.exec(`ALTER TABLE grain ADD COLUMN population INTEGER NOT NULL DEFAULT 0`);
          } catch {
            // Column already exists
          }
        },
      },
    ];

    initializeSchema({ migrations });
    const db = getDatabase();
    db.prepare("INSERT INTO grain (id, treasury, population) VALUES (?, ?, ?)").run("g1", 5, 10);

    expect(() => initializeSchema({ migrations })).not.toThrow();

    const row = db.prepare("SELECT * FROM grain WHERE id = ?").get("g1") as {
      treasury: number;
      population: number;
    };
    expect(row.treasury).toBe(5);
    expect(row.population).toBe(10);
  });
});

describe("initializeSchema consumer migrations against an existing on-disk database", () => {
  it("applies across restarts of a real file database: preserves data and adds a column idempotently", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "dmcp-migrations-test-"));
    const dbPath = join(tmpDir, "games.db");

    try {
      process.env.DMCP_DB_PATH = dbPath;

      const v1: SchemaMigration = {
        name: "population-table",
        up(db) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS population (
              id TEXT PRIMARY KEY,
              grain INTEGER NOT NULL DEFAULT 0
            )
          `);
        },
      };

      // Pass 1: fresh database on disk.
      initializeSchema({ migrations: [v1] });
      getDatabase().prepare("INSERT INTO population (id, grain) VALUES (?, ?)").run("pop1", 100);
      closeDatabase();

      // Pass 2: existing database + an idempotent added-column migration.
      const v1WithColumn: SchemaMigration = {
        name: "population-table",
        up(db) {
          db.exec(`
            CREATE TABLE IF NOT EXISTS population (
              id TEXT PRIMARY KEY,
              grain INTEGER NOT NULL DEFAULT 0
            )
          `);
          try {
            db.exec(`ALTER TABLE population ADD COLUMN treasury INTEGER NOT NULL DEFAULT 0`);
          } catch {
            // Column already exists
          }
        },
      };

      initializeSchema({ migrations: [v1WithColumn] });
      let db = getDatabase();
      let cols = db.prepare("PRAGMA table_info(population)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("treasury");

      let row = db.prepare("SELECT * FROM population WHERE id = ?").get("pop1") as {
        grain: number;
        treasury: number;
      };
      expect(row.grain).toBe(100);
      expect(row.treasury).toBe(0);
      closeDatabase();

      // Pass 3: still clean/idempotent against the now-migrated file.
      expect(() => initializeSchema({ migrations: [v1WithColumn] })).not.toThrow();
      db = getDatabase();
      cols = db.prepare("PRAGMA table_info(population)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("treasury");
      row = db.prepare("SELECT * FROM population WHERE id = ?").get("pop1") as {
        grain: number;
        treasury: number;
      };
      expect(row.grain).toBe(100);
      closeDatabase();
    } finally {
      process.env.DMCP_DB_PATH = ":memory:";
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
