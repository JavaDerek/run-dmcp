import { v4 as uuidv4 } from "uuid";
import { getDatabase } from "../db/connection.js";
import { currentStoryTime, setStoryTime } from "./clock.js";
import { assertT, type T } from "./t.js";

/**
 * A principal is due to act (GitHub issue #40). The issue draws the line:
 * "The engine records whose turn it is and refuses out-of-turn proposals if
 * a game declares turns. It never runs the turn itself." So this module holds
 * a DECLARATION -- which entities act, in what cycle, from which t -- and
 * answers "who is due at t" for any t, past included. It never schedules,
 * waits, notifies or calls anything: an MCP server answers calls, so
 * whatever runs minds asks (pull), moves the clock with `advanceTurn`, and
 * proposes as that principal. `resolve()` refuses a proposal whose `actor` is
 * not the one due (resolve.ts, `out-of-turn`).
 *
 * WHY A COUNTER AXIS ONLY. A turn is a count of things that happened, which is
 * exactly what `counter` means (t.ts). On `sequence` the engine's own writes
 * advance t, so "one principal per t" would hand the turn over mid-action;
 * on `elapsed` t is a measure, and turns-per-second is a policy this engine
 * has no business guessing.
 *
 * WHY APPEND-ONLY. `dueAt(t)` for a past t is history, and this engine can
 * always say what the world looked like at any point. A changed order is a
 * NEW declaration from a later t; the old one keeps answering for the t it
 * covered. The `turn_orders` triggers (schema.ts) make an edit
 * unconstructable rather than discouraged.
 *
 * A principal is an entity of the game (DESIGN.md §8's admission criterion:
 * it resolves to an entity the engine already has). The engine never learns
 * what a principal is for.
 */
export interface TurnDue {
  t: T;
  principal: string;
  /** 1-based: which pass through the declared cycle this t belongs to. */
  round: number;
  /** 0-based position in the cycle. */
  position: number;
  /** The declaration this answer comes from. */
  fromT: T;
}

interface TurnOrderRow {
  from_t: number;
  principals: string;
}

function declarationAt(gameId: string, t: T): TurnOrderRow | undefined {
  return getDatabase()
    .prepare(`SELECT from_t, principals FROM turn_orders WHERE game_id = ? AND from_t <= ? ORDER BY from_t DESC LIMIT 1`)
    .get(gameId, t) as TurnOrderRow | undefined;
}

function latestDeclaration(gameId: string): TurnOrderRow | undefined {
  return getDatabase()
    .prepare(`SELECT from_t, principals FROM turn_orders WHERE game_id = ? ORDER BY from_t DESC LIMIT 1`)
    .get(gameId) as TurnOrderRow | undefined;
}

export function declareTurnOrder(params: { gameId: string; principals: readonly string[]; fromT: T }): { fromT: T; principals: string[] } {
  const { gameId, fromT } = params;
  assertT(fromT);
  const principals = [...params.principals];
  const story = currentStoryTime(gameId);
  if (!story || story.axis.kind !== "counter") {
    throw new Error(
      `declareTurnOrder: game '${gameId}' must be on a counter axis -- a turn is a count of things that happened ` +
        `(declare_time_axis with kind 'counter')`
    );
  }
  if (!Number.isInteger(fromT)) throw new Error(`declareTurnOrder: fromT must be an integer t on the counter axis, got ${fromT}`);
  if (fromT < story.t) {
    throw new Error(`declareTurnOrder: fromT ${fromT} is before the game's current t (${story.t}); turns already taken cannot be reordered`);
  }
  const latest = latestDeclaration(gameId);
  // The current t may already be someone's turn (and a resolution may
  // already record them acting in it); reassigning it would rewrite that.
  if (latest && latest.from_t <= story.t && fromT <= story.t) {
    throw new Error(
      `declareTurnOrder: t=${story.t} is already covered by the declaration from ${latest.from_t}; a new order can start at t=${story.t + 1} at the earliest`
    );
  }
  if (latest && fromT <= latest.from_t) {
    throw new Error(`declareTurnOrder: fromT ${fromT} must come after the latest declaration's fromT (${latest.from_t})`);
  }
  if (principals.length === 0) throw new Error(`declareTurnOrder: a turn order needs at least one principal`);
  const seen = new Set<string>();
  const alive = getDatabase().prepare(
    `SELECT 1 FROM entities WHERE id = ? AND game_id = ? AND created_at_t <= ? AND (destroyed_at_t IS NULL OR destroyed_at_t > ?)`
  );
  for (const principal of principals) {
    if (typeof principal !== "string") throw new Error(`declareTurnOrder: a principal must be an entity id, got ${JSON.stringify(principal)}`);
    if (seen.has(principal)) throw new Error(`declareTurnOrder: principal '${principal}' appears twice in one cycle`);
    seen.add(principal);
    if (!alive.get(principal, gameId, fromT, fromT)) {
      throw new Error(`declareTurnOrder: '${principal}' is not an entity of this game alive at t=${fromT}`);
    }
  }
  getDatabase()
    .prepare(`INSERT INTO turn_orders (id, game_id, from_t, principals, declared_at) VALUES (?, ?, ?, ?, ?)`)
    .run(uuidv4(), gameId, fromT, JSON.stringify(principals), new Date().toISOString());
  return { fromT, principals };
}

/** Who is due at `t`, or `null`: no declaration covers `t`, or `t` is not a
 *  whole step on from the declaration's `fromT`. */
export function dueAt(params: { gameId: string; t: T }): TurnDue | null {
  const { gameId, t } = params;
  assertT(t);
  const declaration = declarationAt(gameId, t);
  if (!declaration) return null;
  const offset = t - declaration.from_t;
  if (!Number.isInteger(offset)) return null;
  const principals = JSON.parse(declaration.principals) as string[];
  const position = offset % principals.length;
  return { t, principal: principals[position], round: Math.floor(offset / principals.length) + 1, position, fromT: declaration.from_t };
}

/** Moves the clock to the next turn -- one step on, or to the first
 *  declaration's `fromT` if the clock has not reached it -- and says who is
 *  due there. Moves time only; runs nothing. */
export function advanceTurn(params: { gameId: string }): TurnDue {
  const { gameId } = params;
  const story = currentStoryTime(gameId);
  const first = getDatabase()
    .prepare(`SELECT from_t FROM turn_orders WHERE game_id = ? ORDER BY from_t ASC LIMIT 1`)
    .get(gameId) as { from_t: number } | undefined;
  if (!story || !first) throw new Error(`advanceTurn: game '${gameId}' has no turn order declared (declare_turn_order)`);
  const next = story.t < first.from_t ? first.from_t : Math.floor(story.t) + 1;
  const due = dueAt({ gameId, t: next });
  if (!due) throw new Error(`advanceTurn: nobody is due at t=${next}`);
  setStoryTime({ gameId, t: next });
  return due;
}

/** Whether the game has declared any turn order at all. */
export function hasTurnOrder(gameId: string): boolean {
  return getDatabase().prepare(`SELECT 1 FROM turn_orders WHERE game_id = ? LIMIT 1`).get(gameId) !== undefined;
}
