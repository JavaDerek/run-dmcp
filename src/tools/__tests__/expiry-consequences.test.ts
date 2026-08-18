// Cross-cutting tests for the opt-in "expiry consequence" capability across
// BOTH systems that support it: scheduled events (time.ts) and timers
// (timers.ts). Each system has its own focused unit tests in time.test.ts
// and timers.test.ts respectively; this file exists specifically to cover
// interleaving between them, since a DM session commonly has both a
// scheduled event and a countdown timer live at once, sometimes targeting
// the very same resource.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, destroyTestDb } from '../../db/__tests__/testDb.js'
import { createGame } from '../game.js'
import { createResource, getResource, getResourceHistory } from '../resource.js'
import { setCalendar, advanceTime, scheduleEvent } from '../time.js'
import { createTimer, tickTimer } from '../timers.js'
import type { GameDateTime } from '../../types/index.js'

const dt = (overrides: Partial<GameDateTime> = {}): GameDateTime => ({
  year: 1,
  month: 0,
  day: 0,
  hour: 8,
  minute: 0,
  ...overrides,
})

describe('interleaved scheduled events and timers', () => {
  let gameId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
    setCalendar(gameId, {})
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('applies a scheduled-event consequence and a timer consequence to the same resource, each exactly once, regardless of order', () => {
    const treasury = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 100 })

    scheduleEvent({
      gameId,
      name: 'toll collected',
      triggerTime: dt({ hour: 9 }),
      consequence: { resourceId: treasury.id, delta: -10 },
    })
    const timer = createTimer({
      gameId,
      name: 'ritual completes',
      timerType: 'countdown',
      currentValue: 2,
      triggerAt: 0,
      consequence: { resourceId: treasury.id, delta: -25 },
    })

    tickTimer(timer.id, 1) // 2 -> 1, not yet
    advanceTime(gameId, { hours: 2 }) // crosses the event's trigger, -10
    tickTimer(timer.id, 1) // 1 -> 0, crosses the timer's trigger, -25

    expect(getResource(treasury.id)?.value).toBe(65)

    const history = getResourceHistory(treasury.id)
    expect(history).toHaveLength(2)
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delta: -10, reason: expect.stringContaining('toll collected') }),
        expect.objectContaining({ delta: -25, reason: expect.stringContaining('ritual completes') }),
      ])
    )
  })

  it('ticking a timer in between two advanceTime calls does not disturb the scheduled event bookkeeping', () => {
    const grain = createResource({ gameId, ownerType: 'game', name: 'grain', value: 50 })
    const gold = createResource({ gameId, ownerType: 'game', name: 'gold', value: 50 })

    scheduleEvent({
      gameId,
      name: 'spoilage',
      triggerTime: dt({ hour: 12 }),
      consequence: { resourceId: grain.id, delta: -5 },
    })
    const timer = createTimer({
      gameId,
      name: 'a spell wearing off',
      timerType: 'countdown',
      currentValue: 3,
      triggerAt: 0,
      consequence: { resourceId: gold.id, delta: -1 },
    })

    const first = advanceTime(gameId, { hours: 1 }) // 08:00 -> 09:00, event not due yet
    expect(first?.triggeredEvents).toHaveLength(0)

    tickTimer(timer.id, 1) // 3 -> 2
    tickTimer(timer.id, 1) // 2 -> 1
    expect(getResource(gold.id)?.value).toBe(50) // timer hasn't triggered yet

    const second = advanceTime(gameId, { hours: 4 }) // 09:00 -> 13:00, crosses the event
    expect(second?.triggeredEvents).toHaveLength(1)
    expect(getResource(grain.id)?.value).toBe(45)

    tickTimer(timer.id, 1) // 1 -> 0, triggers
    expect(getResource(gold.id)?.value).toBe(49)
  })

  it('a failing timer consequence does not affect an independently-processed scheduled event, and vice versa', () => {
    const treasury = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 100 })

    scheduleEvent({
      gameId,
      name: 'healthy toll',
      triggerTime: dt({ hour: 9 }),
      consequence: { resourceId: treasury.id, delta: -10 },
    })
    const brokenTimer = createTimer({
      gameId,
      name: 'broken spell',
      timerType: 'countdown',
      currentValue: 1,
      triggerAt: 0,
      consequence: { resourceId: 'does-not-exist', delta: -999 },
    })

    const result = advanceTime(gameId, { hours: 2 })
    expect(result?.triggeredEvents).toHaveLength(1)
    expect(getResource(treasury.id)?.value).toBe(90)

    expect(() => tickTimer(brokenTimer.id, 1)).toThrow()
    // The unrelated, already-applied event consequence must be untouched.
    expect(getResource(treasury.id)?.value).toBe(90)
  })
})
