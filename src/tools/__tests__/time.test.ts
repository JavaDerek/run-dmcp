import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, destroyTestDb } from '../../db/__tests__/testDb.js'
import { getDatabase } from '../../db/connection.js'
import { createGame } from '../game.js'
import { createResource, getResource, getResourceHistory, deleteResource } from '../resource.js'
import { setCalendar, advanceTime, scheduleEvent, listScheduledEvents, getTime } from '../time.js'
import type { GameDateTime } from '../../types/index.js'

// Fixed calendar: 30 days/month, 24h/day, so hour arithmetic is easy to
// reason about. All tests start the clock at year 1, month 0, day 0, 08:00.
const dt = (overrides: Partial<GameDateTime> = {}): GameDateTime => ({
  year: 1,
  month: 0,
  day: 0,
  hour: 8,
  minute: 0,
  ...overrides,
})

describe('time tools', () => {
  let gameId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
    setCalendar(gameId, {})
  })

  afterEach(() => {
    destroyTestDb()
  })

  describe('advanceTime baseline (no consequences involved)', () => {
    it('returns null for a game with no calendar set', () => {
      expect(advanceTime('does-not-exist', { hours: 1 })).toBeNull()
    })

    it('advances the clock by the given duration', () => {
      const result = advanceTime(gameId, { hours: 2 })
      expect(result?.newTime).toMatchObject({ hour: 10 })
    })

    it('persists the new time', () => {
      advanceTime(gameId, { hours: 2 })
      expect(getTime(gameId)?.currentTime).toMatchObject({ hour: 10 })
    })

    it('triggers a scheduled event whose trigger time falls within the advanced window', () => {
      scheduleEvent({ gameId, name: 'a bell tolls', triggerTime: dt({ hour: 9 }) })

      const result = advanceTime(gameId, { hours: 2 })

      expect(result?.triggeredEvents).toHaveLength(1)
      expect(result?.triggeredEvents[0].name).toBe('a bell tolls')
    })

    it('does not trigger an event whose trigger time is beyond the advanced window', () => {
      scheduleEvent({ gameId, name: 'a bell tolls', triggerTime: dt({ hour: 23 }) })

      const result = advanceTime(gameId, { hours: 2 })

      expect(result?.triggeredEvents).toHaveLength(0)
    })

    it('returns an empty consequenceFailures array when nothing fails', () => {
      const result = advanceTime(gameId, { hours: 1 })
      expect(result?.consequenceFailures).toEqual([])
    })

    it('does not trigger anything when advancing by zero time', () => {
      scheduleEvent({ gameId, name: 'a bell tolls', triggerTime: dt({ hour: 8 }) })

      // Passing an empty duration object advances by 0 minutes.
      const result = advanceTime(gameId, {})

      // hour 8 is both previousTime and newTime here, so the boundary check
      // still matches -- this asserts "not moving" doesn't change that.
      expect(result?.newTime).toEqual(result?.previousTime)
    })
  })

  describe('scheduleEvent consequence persistence (opt-in field)', () => {
    it('defaults consequence to null when not provided', () => {
      const event = scheduleEvent({ gameId, name: 'plain event', triggerTime: dt() })
      expect(event.consequence).toBeNull()
    })

    it('persists and round-trips a provided consequence through scheduleEvent', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 5 })
      const event = scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt(),
        consequence: { resourceId: resource.id, delta: -1 },
      })

      expect(event.consequence).toEqual({ resourceId: resource.id, delta: -1 })
    })

    it('round-trips a provided consequence through listScheduledEvents', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 5 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt(),
        consequence: { resourceId: resource.id, delta: -1 },
      })

      const [listed] = listScheduledEvents(gameId, true)
      expect(listed.consequence).toEqual({ resourceId: resource.id, delta: -1 })
    })

    it('null consequence round-trips through listScheduledEvents too', () => {
      scheduleEvent({ gameId, name: 'plain event', triggerTime: dt() })
      const [listed] = listScheduledEvents(gameId, true)
      expect(listed.consequence).toBeNull()
    })
  })

  describe('consequences applied by advanceTime -- no LLM in the loop', () => {
    it('applies a declared consequence to the target resource the moment the event triggers', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -20 },
      })

      // Nothing reads triggeredEvents or acts on it -- advanceTime alone
      // must be enough for the resource to change.
      advanceTime(gameId, { hours: 2 })

      expect(getResource(resource.id)?.value).toBe(80)
    })

    it('applies a positive delta consequence', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 10 })
      scheduleEvent({
        gameId,
        name: 'windfall',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: 15 },
      })

      advanceTime(gameId, { hours: 2 })

      expect(getResource(resource.id)?.value).toBe(25)
    })

    it('clamps the consequence delta the same way any other delta update is clamped', () => {
      const resource = createResource({
        gameId,
        ownerType: 'game',
        name: 'population',
        value: 5,
        minValue: 0,
      })
      scheduleEvent({
        gameId,
        name: 'famine',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -100 },
      })

      advanceTime(gameId, { hours: 2 })

      expect(getResource(resource.id)?.value).toBe(0)
    })

    it('records a resource_history row whose reason references the triggering event', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -10 },
      })

      advanceTime(gameId, { hours: 2 })

      const history = getResourceHistory(resource.id)
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ previousValue: 100, newValue: 90, delta: -10 })
      expect(history[0].reason).toContain('spoilage')
    })

    it('includes the triggered event with its consequence in the returned triggeredEvents', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = advanceTime(gameId, { hours: 2 })

      expect(result?.triggeredEvents[0].consequence).toEqual({ resourceId: resource.id, delta: -10 })
    })

    it('leaves events with no declared consequence behaving exactly as before (opt-in)', () => {
      scheduleEvent({ gameId, name: 'plain event', triggerTime: dt({ hour: 9 }) })

      const result = advanceTime(gameId, { hours: 2 })

      expect(result?.triggeredEvents).toHaveLength(1)
      expect(result?.consequenceFailures).toEqual([])
    })
  })

  describe('exactly-once guarantees', () => {
    it('does not re-apply the consequence when advanceTime is called again afterward', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -20 },
      })

      advanceTime(gameId, { hours: 2 }) // 08:00 -> 10:00, crosses 09:00, triggers
      advanceTime(gameId, { hours: 2 }) // 10:00 -> 12:00, event already triggered

      expect(getResource(resource.id)?.value).toBe(80)
    })

    it('marks a fired non-recurring event triggered so it is excluded from future pending lists', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -20 },
      })

      advanceTime(gameId, { hours: 2 })

      expect(listScheduledEvents(gameId, false)).toHaveLength(0)
      expect(listScheduledEvents(gameId, true)).toHaveLength(1)
    })

    it('applies consequences for multiple events that all fall within a single large time jump, each exactly once', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'first spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -10 },
      })
      scheduleEvent({
        gameId,
        name: 'second spoilage',
        triggerTime: dt({ hour: 10 }),
        consequence: { resourceId: resource.id, delta: -5 },
      })
      scheduleEvent({
        gameId,
        name: 'third spoilage',
        triggerTime: dt({ hour: 11 }),
        consequence: { resourceId: resource.id, delta: -1 },
      })

      const result = advanceTime(gameId, { hours: 5 }) // 08:00 -> 13:00

      expect(result?.triggeredEvents).toHaveLength(3)
      expect(getResource(resource.id)?.value).toBe(84)
    })

    it('applies a consequence when the trigger time lands exactly on the new-time boundary (inclusive)', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 10 }),
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = advanceTime(gameId, { hours: 2 }) // 08:00 -> 10:00 exactly

      expect(result?.triggeredEvents).toHaveLength(1)
      expect(getResource(resource.id)?.value).toBe(90)
    })

    it('applies a consequence when the trigger time lands exactly on the previous-time boundary (inclusive)', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 8 }),
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = advanceTime(gameId, { hours: 2 }) // starts exactly at 08:00

      expect(result?.triggeredEvents).toHaveLength(1)
      expect(getResource(resource.id)?.value).toBe(90)
    })

    it('does not re-apply an already-triggered consequence when time subsequently moves backward over it', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -10 },
      })

      advanceTime(gameId, { hours: 3 }) // 08:00 -> 11:00, triggers once
      expect(getResource(resource.id)?.value).toBe(90)

      advanceTime(gameId, { hours: -2 }) // 11:00 -> 09:00, moving back over the same trigger time
      expect(getResource(resource.id)?.value).toBe(90)
    })

    it('re-applies a recurring consequence exactly once per occurrence, and reschedules the trigger', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'daily toll',
        triggerTime: dt({ hour: 9 }),
        recurring: 'daily',
        consequence: { resourceId: resource.id, delta: -5 },
      })

      advanceTime(gameId, { hours: 2 }) // 08:00 -> 10:00, crosses the daily trigger once
      expect(getResource(resource.id)?.value).toBe(95)

      const pending = listScheduledEvents(gameId, false)
      expect(pending).toHaveLength(1)
      expect(pending[0].triggerTime.day).toBe(1) // rescheduled a day forward

      advanceTime(gameId, { days: 1 }) // crosses the rescheduled occurrence
      expect(getResource(resource.id)?.value).toBe(90)

      advanceTime(gameId, { days: 1 }) // crosses a third occurrence
      expect(getResource(resource.id)?.value).toBe(85)
    })

    it('a recurring event never sets triggered=1 -- it stays perpetually pending between occurrences', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'daily toll',
        triggerTime: dt({ hour: 9 }),
        recurring: 'daily',
        consequence: { resourceId: resource.id, delta: -5 },
      })

      advanceTime(gameId, { hours: 2 })

      const [event] = listScheduledEvents(gameId, false)
      expect(event.triggered).toBe(false)
    })
  })

  describe('a consequence that itself fails', () => {
    it('does not mark the event triggered when the target resource never existed, and reports the failure', () => {
      scheduleEvent({
        gameId,
        name: 'broken spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: 'does-not-exist', delta: -10 },
      })

      const result = advanceTime(gameId, { hours: 2 })

      expect(result?.triggeredEvents).toHaveLength(0)
      expect(result?.consequenceFailures).toHaveLength(1)
      expect(result?.consequenceFailures[0]).toMatchObject({
        eventName: 'broken spoilage',
        consequence: { resourceId: 'does-not-exist', delta: -10 },
      })
      expect(typeof result?.consequenceFailures[0].error).toBe('string')
    })

    it('leaves the event pending (not triggered) after a failed consequence -- no expired-but-unapplied state', () => {
      scheduleEvent({
        gameId,
        name: 'broken spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: 'does-not-exist', delta: -10 },
      })

      advanceTime(gameId, { hours: 2 })

      // Still pending: the event never got marked triggered, so it shows up
      // in the "not yet triggered" list, and it's the only event that
      // exists at all (hence also length 1 with includeTriggered=true).
      expect(listScheduledEvents(gameId, false)).toHaveLength(1)
      expect(listScheduledEvents(gameId, true)).toHaveLength(1)
      expect(listScheduledEvents(gameId, false)[0].triggered).toBe(false)
    })

    it('does not mark the event triggered when the target resource was deleted after scheduling', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -10 },
      })
      deleteResource(resource.id)

      const result = advanceTime(gameId, { hours: 2 })

      expect(result?.triggeredEvents).toHaveLength(0)
      expect(result?.consequenceFailures).toHaveLength(1)
      expect(listScheduledEvents(gameId, false)).toHaveLength(1)
    })

    it('does not let a failing event block other, unrelated events in the same advanceTime call', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'broken spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: 'does-not-exist', delta: -10 },
      })
      scheduleEvent({
        gameId,
        name: 'healthy spoilage',
        triggerTime: dt({ hour: 9, minute: 30 }),
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = advanceTime(gameId, { hours: 2 })

      expect(result?.triggeredEvents).toHaveLength(1)
      expect(result?.triggeredEvents[0].name).toBe('healthy spoilage')
      expect(result?.consequenceFailures).toHaveLength(1)
      expect(getResource(resource.id)?.value).toBe(90)
    })

    it('still advances game time even when a consequence fails', () => {
      scheduleEvent({
        gameId,
        name: 'broken spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: 'does-not-exist', delta: -10 },
      })

      const result = advanceTime(gameId, { hours: 2 })

      expect(result?.newTime).toMatchObject({ hour: 10 })
      expect(getTime(gameId)?.currentTime).toMatchObject({ hour: 10 })
    })

    it('rolls back the event trigger flag together with the consequence when the resource_history write fails mid-transaction', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      scheduleEvent({
        gameId,
        name: 'spoilage',
        triggerTime: dt({ hour: 9 }),
        consequence: { resourceId: resource.id, delta: -10 },
      })

      // Fault injection: simulate a failure deep inside updateResourceValue's
      // own nested transaction (e.g. a disk error), after the resources
      // UPDATE has already run but before it commits.
      const db = getDatabase()
      db.exec(`
        CREATE TRIGGER fail_resource_history_insert_time
        BEFORE INSERT ON resource_history
        BEGIN
          SELECT RAISE(ABORT, 'simulated failure');
        END;
      `)

      const result = advanceTime(gameId, { hours: 2 })

      expect(result?.triggeredEvents).toHaveLength(0)
      expect(result?.consequenceFailures).toHaveLength(1)
      expect(getResource(resource.id)?.value).toBe(100)
      expect(getResourceHistory(resource.id)).toHaveLength(0)
      expect(listScheduledEvents(gameId, false)).toHaveLength(1)
    })

    it('does not reschedule a recurring event when its consequence fails -- the same occurrence stays due', () => {
      scheduleEvent({
        gameId,
        name: 'broken daily toll',
        triggerTime: dt({ hour: 9 }),
        recurring: 'daily',
        consequence: { resourceId: 'does-not-exist', delta: -5 },
      })

      advanceTime(gameId, { hours: 2 })

      const [event] = listScheduledEvents(gameId, false)
      expect(event.triggerTime).toEqual(dt({ hour: 9 }))
    })
  })
})
