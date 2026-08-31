import { v4 as uuidv4 } from "uuid";
import { getDatabase, withTransaction } from "../db/connection.js";
import { safeJsonParse } from "../utils/json.js";
import { updateResourceValue } from "./resource.js";
import { createLogger } from "../utils/logger.js";
import type { GameTime, GameDateTime, CalendarConfig, ScheduledEvent, ExpiryConsequence } from "../types/index.js";

const log = createLogger("time");

function parseConsequence(raw: unknown): ExpiryConsequence | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  return safeJsonParse<ExpiryConsequence | null>(raw, null);
}

// Default calendar (fantasy-style)
const DEFAULT_CALENDAR: CalendarConfig = {
  monthNames: [
    "Deepwinter", "Thawing", "Seedtime", "Blossoming", "Highsun", "Summertide",
    "Harvest", "Leaffall", "Dimming", "Frostfall", "Darknight", "Yearsend"
  ],
  daysPerMonth: [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  hoursPerDay: 24,
  minutesPerHour: 60,
  startYear: 1,
  eraName: "Age of Wonder",
};

function dateTimeToMinutes(dt: GameDateTime, config: CalendarConfig): number {
  let totalMinutes = dt.minute;
  totalMinutes += dt.hour * config.minutesPerHour;
  totalMinutes += dt.day * config.hoursPerDay * config.minutesPerHour;

  // Add days from previous months
  for (let m = 0; m < dt.month; m++) {
    totalMinutes += config.daysPerMonth[m] * config.hoursPerDay * config.minutesPerHour;
  }

  // Add days from previous years
  const daysPerYear = config.daysPerMonth.reduce((a, b) => a + b, 0);
  totalMinutes += (dt.year - config.startYear) * daysPerYear * config.hoursPerDay * config.minutesPerHour;

  return totalMinutes;
}

function minutesToDateTime(totalMinutes: number, config: CalendarConfig): GameDateTime {
  const minutesPerHour = config.minutesPerHour;
  const minutesPerDay = config.hoursPerDay * minutesPerHour;
  const daysPerYear = config.daysPerMonth.reduce((a, b) => a + b, 0);
  const minutesPerYear = daysPerYear * minutesPerDay;

  let remaining = totalMinutes;

  const year = config.startYear + Math.floor(remaining / minutesPerYear);
  remaining = remaining % minutesPerYear;

  let month = 0;
  for (let m = 0; m < config.daysPerMonth.length; m++) {
    const monthMinutes = config.daysPerMonth[m] * minutesPerDay;
    if (remaining < monthMinutes) {
      month = m;
      break;
    }
    remaining -= monthMinutes;
  }

  const day = Math.floor(remaining / minutesPerDay);
  remaining = remaining % minutesPerDay;

  const hour = Math.floor(remaining / minutesPerHour);
  const minute = remaining % minutesPerHour;

  return { year, month, day, hour, minute };
}

function compareDateTime(a: GameDateTime, b: GameDateTime, config: CalendarConfig): number {
  return dateTimeToMinutes(a, config) - dateTimeToMinutes(b, config);
}

export function setCalendar(gameId: string, config: Partial<CalendarConfig>, currentTime?: GameDateTime): GameTime {
  const db = getDatabase();

  const calendarConfig: CalendarConfig = {
    ...DEFAULT_CALENDAR,
    ...config,
  };

  const time: GameDateTime = currentTime || {
    year: calendarConfig.startYear,
    month: 0,
    day: 0,
    hour: 8,
    minute: 0,
  };

  // Upsert
  const existing = db.prepare(`SELECT game_id FROM game_time WHERE game_id = ?`).get(gameId);

  if (existing) {
    db.prepare(`UPDATE game_time SET current_time = ?, calendar_config = ? WHERE game_id = ?`)
      .run(JSON.stringify(time), JSON.stringify(calendarConfig), gameId);
  } else {
    db.prepare(`INSERT INTO game_time (game_id, current_time, calendar_config) VALUES (?, ?, ?)`)
      .run(gameId, JSON.stringify(time), JSON.stringify(calendarConfig));
  }

  return { gameId, currentTime: time, calendarConfig };
}

export function getTime(gameId: string): GameTime | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM game_time WHERE game_id = ?`).get(gameId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    gameId: row.game_id as string,
    currentTime: safeJsonParse<GameDateTime>(row.current_time as string, { year: 1, month: 1, day: 1, hour: 0, minute: 0 }),
    calendarConfig: safeJsonParse<CalendarConfig>(row.calendar_config as string, DEFAULT_CALENDAR),
  };
}

export function setTime(gameId: string, time: GameDateTime): GameTime | null {
  const db = getDatabase();
  const gameTime = getTime(gameId);
  if (!gameTime) return null;

  db.prepare(`UPDATE game_time SET current_time = ? WHERE game_id = ?`)
    .run(JSON.stringify(time), gameId);

  return { ...gameTime, currentTime: time };
}

export interface ConsequenceFailure {
  eventId: string;
  eventName: string;
  consequence: ExpiryConsequence;
  error: string;
}

export interface AdvanceResult {
  previousTime: GameDateTime;
  newTime: GameDateTime;
  triggeredEvents: ScheduledEvent[];
  consequenceFailures: ConsequenceFailure[];
}

export function advanceTime(
  gameId: string,
  duration: { days?: number; hours?: number; minutes?: number }
): AdvanceResult | null {
  const db = getDatabase();
  const gameTime = getTime(gameId);
  if (!gameTime) return null;

  const { currentTime, calendarConfig } = gameTime;
  const previousTime = { ...currentTime };

  // Convert to minutes, add, convert back
  let totalMinutes = dateTimeToMinutes(currentTime, calendarConfig);
  totalMinutes += (duration.minutes || 0);
  totalMinutes += (duration.hours || 0) * calendarConfig.minutesPerHour;
  totalMinutes += (duration.days || 0) * calendarConfig.hoursPerDay * calendarConfig.minutesPerHour;

  const newTime = minutesToDateTime(totalMinutes, calendarConfig);

  // Update time. This happens unconditionally and outside any per-event
  // transaction below -- the clock is global state, not tied to any one
  // event's consequence, so a broken consequence on one event must never
  // block time from moving for everyone else.
  db.prepare(`UPDATE game_time SET current_time = ? WHERE game_id = ?`)
    .run(JSON.stringify(newTime), gameId);

  // Check for triggered events
  const events = db.prepare(`
    SELECT * FROM scheduled_events
    WHERE game_id = ? AND triggered = 0
  `).all(gameId) as Record<string, unknown>[];

  const triggeredEvents: ScheduledEvent[] = [];
  const consequenceFailures: ConsequenceFailure[] = [];

  for (const row of events) {
    const triggerTime = safeJsonParse<GameDateTime>(row.trigger_time as string, { year: 1, month: 1, day: 1, hour: 0, minute: 0 });

    // Due if the trigger time has been reached -- deliberately NOT also gated
    // on `triggerTime >= previousTime`.
    //
    // That lower bound looks like the right window ("did we cross it on THIS
    // call?") and quietly broke the retry the catch block below promises. When
    // a consequence throws, the transaction rolls back and the row stays
    // pending, exactly as intended -- but the clock has already moved past
    // triggerTime by then, because it is updated unconditionally above. On
    // every subsequent call the lower bound therefore excluded the row, and
    // the event sat pending forever with its consequence never applied. The
    // rollback was correct and unreachable.
    //
    // Without the lower bound, "pending and past due" is the whole condition,
    // which is the same retry semantics timers already have. The `triggered =
    // 0` filter in the query above is what keeps this exactly-once: a
    // successful event is marked (or, if recurring, rescheduled forward) in
    // the same transaction as its consequence, so it cannot come back.
    if (compareDateTime(triggerTime, newTime, calendarConfig) <= 0) {
      const eventId = row.id as string;
      const eventName = row.name as string;
      const recurring = row.recurring as string | null;
      const consequence = parseConsequence(row.consequence);

      // Recurring events reschedule instead of being marked triggered=1.
      const newTrigger = recurring ? rescheduleEvent(triggerTime, recurring, calendarConfig) : null;

      // The row mutation (triggered=1, or reschedule to the next
      // occurrence) and the consequence application must land together or
      // not at all -- otherwise a failed consequence could leave the event
      // permanently marked "handled" with its effect never applied, and
      // exactly-once would be broken forever with no way to retry.
      try {
        withTransaction(() => {
          if (newTrigger) {
            db.prepare(`UPDATE scheduled_events SET trigger_time = ? WHERE id = ?`)
              .run(JSON.stringify(newTrigger), eventId);
          } else {
            db.prepare(`UPDATE scheduled_events SET triggered = 1 WHERE id = ?`)
              .run(eventId);
          }

          if (consequence) {
            const applied = updateResourceValue({
              resourceId: consequence.resourceId,
              mode: "delta",
              value: consequence.delta,
              reason: `Expiry consequence: ${eventName}`,
            });
            if (!applied) {
              throw new Error(
                `Resource '${consequence.resourceId}' not found for consequence of scheduled event '${eventName}' (${eventId})`
              );
            }
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Failed to apply expiry consequence for scheduled event; leaving it pending", {
          gameId,
          eventId,
          eventName,
          consequence,
          error: message,
        });
        if (consequence) {
          consequenceFailures.push({ eventId, eventName, consequence, error: message });
        }
        // Transaction rolled back: the row is untouched, so the event stays
        // pending (not triggered, not rescheduled) and is excluded from
        // triggeredEvents below -- no expired-but-unapplied state.
        continue;
      }

      triggeredEvents.push({
        id: eventId,
        gameId: row.game_id as string,
        name: eventName,
        description: row.description as string || "",
        triggerTime,
        recurring,
        triggered: !newTrigger,
        metadata: safeJsonParse<Record<string, unknown>>(row.metadata as string || "{}", {}),
        consequence,
      });
    }
  }

  return { previousTime, newTime, triggeredEvents, consequenceFailures };
}

function rescheduleEvent(current: GameDateTime, recurring: string, config: CalendarConfig): GameDateTime {
  const minutesPerDay = config.hoursPerDay * config.minutesPerHour;
  const daysPerYear = config.daysPerMonth.reduce((a, b) => a + b, 0);
  let minutes = dateTimeToMinutes(current, config);

  switch (recurring) {
    case "daily":
      minutes += minutesPerDay;
      break;
    case "weekly":
      minutes += minutesPerDay * 7;
      break;
    case "monthly":
      minutes += config.daysPerMonth[current.month] * minutesPerDay;
      break;
    case "yearly":
      minutes += daysPerYear * minutesPerDay;
      break;
  }

  return minutesToDateTime(minutes, config);
}

export function scheduleEvent(params: {
  gameId: string;
  name: string;
  description?: string;
  triggerTime: GameDateTime;
  recurring?: string;
  metadata?: Record<string, unknown>;
  consequence?: ExpiryConsequence;
}): ScheduledEvent {
  const db = getDatabase();
  const id = uuidv4();
  const consequence = params.consequence ?? null;

  db.prepare(`
    INSERT INTO scheduled_events (id, game_id, name, description, trigger_time, recurring, metadata, consequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.gameId,
    params.name,
    params.description || "",
    JSON.stringify(params.triggerTime),
    params.recurring || null,
    JSON.stringify(params.metadata || {}),
    consequence ? JSON.stringify(consequence) : null
  );

  return {
    id,
    gameId: params.gameId,
    name: params.name,
    description: params.description || "",
    triggerTime: params.triggerTime,
    recurring: params.recurring || null,
    triggered: false,
    metadata: params.metadata || {},
    consequence,
  };
}

export function listScheduledEvents(gameId: string, includeTriggered = false): ScheduledEvent[] {
  const db = getDatabase();

  let query = `SELECT * FROM scheduled_events WHERE game_id = ?`;
  if (!includeTriggered) {
    query += ` AND triggered = 0`;
  }
  query += ` ORDER BY trigger_time`;

  const rows = db.prepare(query).all(gameId) as Record<string, unknown>[];

  return rows.map(row => ({
    id: row.id as string,
    gameId: row.game_id as string,
    name: row.name as string,
    description: row.description as string || "",
    triggerTime: safeJsonParse<GameDateTime>(row.trigger_time as string, { year: 1, month: 1, day: 1, hour: 0, minute: 0 }),
    recurring: row.recurring as string | null,
    triggered: (row.triggered as number) === 1,
    metadata: safeJsonParse<Record<string, unknown>>(row.metadata as string || "{}", {}),
    consequence: parseConsequence(row.consequence),
  }));
}

export function cancelEvent(eventId: string): boolean {
  const db = getDatabase();
  const result = db.prepare(`DELETE FROM scheduled_events WHERE id = ?`).run(eventId);
  return result.changes > 0;
}

export function formatDateTime(dt: GameDateTime, config: CalendarConfig): string {
  const monthName = config.monthNames[dt.month] || `Month ${dt.month + 1}`;
  const hour = dt.hour.toString().padStart(2, "0");
  const minute = dt.minute.toString().padStart(2, "0");
  const era = config.eraName ? ` ${config.eraName}` : "";

  return `${dt.day + 1} ${monthName}, Year ${dt.year}${era} - ${hour}:${minute}`;
}
