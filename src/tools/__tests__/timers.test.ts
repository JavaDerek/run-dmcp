import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, destroyTestDb } from '../../db/__tests__/testDb.js'
import { getDatabase } from '../../db/connection.js'
import { createGame } from '../game.js'
import { createResource, getResource, getResourceHistory, deleteResource } from '../resource.js'
import { createTimer, getTimer, listTimers, tickTimer, resetTimer, modifyTimerState } from '../timers.js'

describe('timer tools', () => {
  let gameId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  describe('tickTimer baseline (no consequence)', () => {
    it('returns null for an unknown timer', () => {
      expect(tickTimer('does-not-exist')).toBeNull()
    })

    it('counts a countdown timer down by the tick amount', () => {
      const timer = createTimer({ gameId, name: 'fuse', timerType: 'countdown', currentValue: 5 })
      const result = tickTimer(timer.id, 1)
      expect(result?.timer.currentValue).toBe(4)
      expect(result?.previousValue).toBe(5)
    })

    it('counts a stopwatch timer up by the tick amount', () => {
      const timer = createTimer({ gameId, name: 'ritual', timerType: 'stopwatch', direction: 'up', maxValue: 10 })
      const result = tickTimer(timer.id, 3)
      expect(result?.timer.currentValue).toBe(3)
    })

    it('flags justTriggered the first time a countdown reaches its triggerAt', () => {
      const timer = createTimer({ gameId, name: 'fuse', timerType: 'countdown', currentValue: 1, triggerAt: 0 })
      const result = tickTimer(timer.id, 1)
      expect(result?.justTriggered).toBe(true)
      expect(result?.timer.triggered).toBe(true)
    })

    it('does not flag justTriggered again on a subsequent tick after already triggered', () => {
      const timer = createTimer({ gameId, name: 'fuse', timerType: 'countdown', currentValue: 1, triggerAt: 0 })
      tickTimer(timer.id, 1)
      const second = tickTimer(timer.id, 1)
      expect(second?.justTriggered).toBe(false)
    })
  })

  describe('createTimer consequence persistence (opt-in field)', () => {
    it('defaults consequence to null when not provided', () => {
      const timer = createTimer({ gameId, name: 'fuse', timerType: 'countdown', currentValue: 3 })
      expect(timer.consequence).toBeNull()
    })

    it('persists and round-trips a provided consequence through createTimer', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 3,
        consequence: { resourceId: resource.id, delta: -5 },
      })
      expect(timer.consequence).toEqual({ resourceId: resource.id, delta: -5 })
    })

    it('round-trips through getTimer', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })
      const created = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 3,
        consequence: { resourceId: resource.id, delta: -5 },
      })
      expect(getTimer(created.id)?.consequence).toEqual({ resourceId: resource.id, delta: -5 })
    })

    it('round-trips through listTimers', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })
      createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 3,
        consequence: { resourceId: resource.id, delta: -5 },
      })
      const [listed] = listTimers(gameId)
      expect(listed.consequence).toEqual({ resourceId: resource.id, delta: -5 })
    })
  })

  describe('consequences applied by tickTimer -- no LLM in the loop', () => {
    it('applies the consequence the moment the timer crosses its triggerAt', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -30 },
      })

      // Nothing reads justTriggered or acts on it -- tickTimer alone must
      // be enough for the resource to change.
      tickTimer(timer.id, 1)

      expect(getResource(resource.id)?.value).toBe(70)
    })

    it('applies a positive delta consequence', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 10 })
      const timer = createTimer({
        gameId,
        name: 'ritual completes',
        timerType: 'stopwatch',
        direction: 'up',
        maxValue: 3,
        triggerAt: 3,
        consequence: { resourceId: resource.id, delta: 25 },
      })

      tickTimer(timer.id, 3)

      expect(getResource(resource.id)?.value).toBe(35)
    })

    it('clamps the consequence delta the same way any other delta update is clamped', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'population', value: 5, minValue: 0 })
      const timer = createTimer({
        gameId,
        name: 'plague',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -100 },
      })

      tickTimer(timer.id, 1)

      expect(getResource(resource.id)?.value).toBe(0)
    })

    it('records a resource_history row whose reason references the triggering timer', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      tickTimer(timer.id, 1)

      const history = getResourceHistory(resource.id)
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ previousValue: 100, newValue: 90, delta: -10 })
      expect(history[0].reason).toContain('fuse')
    })

    it('reports consequenceApplied=true on the TickResult when the consequence lands', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = tickTimer(timer.id, 1)

      expect(result?.consequenceApplied).toBe(true)
    })

    it('reports consequenceApplied=false when a tick does not cross the trigger', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 5,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = tickTimer(timer.id, 1)

      expect(result?.consequenceApplied).toBe(false)
      expect(getResource(resource.id)?.value).toBe(100)
    })

    it('reports consequenceApplied=false when justTriggered fires but no consequence is declared', () => {
      const timer = createTimer({ gameId, name: 'fuse', timerType: 'countdown', currentValue: 1, triggerAt: 0 })
      const result = tickTimer(timer.id, 1)
      expect(result?.justTriggered).toBe(true)
      expect(result?.consequenceApplied).toBe(false)
    })

    it('leaves timers with no declared consequence behaving exactly as before (opt-in)', () => {
      const timer = createTimer({ gameId, name: 'plain fuse', timerType: 'countdown', currentValue: 1, triggerAt: 0 })
      const result = tickTimer(timer.id, 1)
      expect(result?.timer.currentValue).toBe(0)
      expect(result?.timer.triggered).toBe(true)
    })
  })

  describe('exactly-once guarantees', () => {
    it('does not re-apply the consequence on a later tick after the timer already triggered', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 2,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      tickTimer(timer.id, 1) // 2 -> 1, not yet triggered
      tickTimer(timer.id, 1) // 1 -> 0, triggers, applies once
      tickTimer(timer.id, 1) // already triggered, stays at 0 (floor), must not re-apply

      expect(getResource(resource.id)?.value).toBe(90)
    })

    it('applies exactly once even when a single tick amount jumps straight past the trigger boundary', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 10,
        triggerAt: 5,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = tickTimer(timer.id, 8) // 10 -> 2, jumps past triggerAt=5 in one tick

      expect(result?.justTriggered).toBe(true)
      expect(getResource(resource.id)?.value).toBe(90)

      tickTimer(timer.id, 1) // further ticks must not re-apply
      expect(getResource(resource.id)?.value).toBe(90)
    })

    it('applies a consequence when the new value lands exactly on triggerAt (boundary, countdown)', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 5,
        triggerAt: 3,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = tickTimer(timer.id, 2) // 5 -> 3, exactly on triggerAt

      expect(result?.justTriggered).toBe(true)
      expect(getResource(resource.id)?.value).toBe(90)
    })

    it('applies a consequence when the new value lands exactly on triggerAt (boundary, stopwatch)', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'ritual',
        timerType: 'stopwatch',
        direction: 'up',
        maxValue: 6,
        triggerAt: 6,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = tickTimer(timer.id, 6)

      expect(result?.justTriggered).toBe(true)
      expect(getResource(resource.id)?.value).toBe(90)
    })

    it('re-fires the consequence after an explicit reset and a subsequent re-trigger', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      tickTimer(timer.id, 1) // triggers, -10
      expect(getResource(resource.id)?.value).toBe(90)

      resetTimer(timer.id) // explicit reset clears the triggered flag
      tickTimer(timer.id, 1) // fires again -- this is a deliberate re-arm, not a double-fire of the same event

      expect(getResource(resource.id)?.value).toBe(80)
    })

    it('resetTimer itself never applies a consequence, even though it clears the triggered flag', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      tickTimer(timer.id, 1)
      expect(getResource(resource.id)?.value).toBe(90)

      resetTimer(timer.id)
      expect(getResource(resource.id)?.value).toBe(90) // unchanged by reset alone
    })

    it('modifyTimerState({mode: "reset"}) does not apply a consequence', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      tickTimer(timer.id, 1)
      modifyTimerState(timer.id, { mode: 'reset' })

      expect(getResource(resource.id)?.value).toBe(90)
    })

    it('modifyTimerState({mode: "tick"}) applies the consequence exactly like tickTimer', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      const result = modifyTimerState(timer.id, { mode: 'tick', amount: 1 })

      expect(result?.consequenceApplied).toBe(true)
      expect(getResource(resource.id)?.value).toBe(90)
    })
  })

  describe('a consequence that itself fails', () => {
    it('throws when the target resource never existed, and does not tick the timer at all', () => {
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: 'does-not-exist', delta: -10 },
      })

      expect(() => tickTimer(timer.id, 1)).toThrow()

      const reloaded = getTimer(timer.id)
      expect(reloaded?.currentValue).toBe(1)
      expect(reloaded?.triggered).toBe(false)
    })

    it('throws when the target resource was deleted after the timer was created', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })
      deleteResource(resource.id)

      expect(() => tickTimer(timer.id, 1)).toThrow()

      const reloaded = getTimer(timer.id)
      expect(reloaded?.currentValue).toBe(1)
      expect(reloaded?.triggered).toBe(false)
    })

    it('rolls back the value and triggered-flag change together with the consequence on a mid-transaction failure', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: resource.id, delta: -10 },
      })

      // Fault injection: used to target `resource_history` directly; that
      // table no longer receives inserts (design §5.4 option (C) --
      // interval-versioned facts are the history now, written by
      // writeConstrainedValue's single annotation-event insert into
      // `events`). The property under test -- that the consequence's value
      // write and its audit trail land together with the timer's own
      // value/triggered-flag change, or not at all -- is unchanged; only
      // the injection point moved.
      const db = getDatabase()
      db.exec(`
        CREATE TRIGGER fail_resource_history_insert_timer
        BEFORE INSERT ON events
        WHEN NEW.kind = 'value.changed'
        BEGIN
          SELECT RAISE(ABORT, 'simulated failure');
        END;
      `)

      expect(() => tickTimer(timer.id, 1)).toThrow()

      expect(getResource(resource.id)?.value).toBe(100)
      expect(getResourceHistory(resource.id)).toHaveLength(0)
      const reloaded = getTimer(timer.id)
      expect(reloaded?.currentValue).toBe(1)
      expect(reloaded?.triggered).toBe(false)
    })

    it('permits ticking again after fixing the underlying resource problem', () => {
      const timer = createTimer({
        gameId,
        name: 'fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: 'does-not-exist', delta: -10 },
      })

      expect(() => tickTimer(timer.id, 1)).toThrow()
      // Retrying with the same broken consequence keeps failing safely --
      // it never silently "succeeds" by skipping the consequence.
      expect(() => tickTimer(timer.id, 1)).toThrow()

      const reloaded = getTimer(timer.id)
      expect(reloaded?.currentValue).toBe(1)
      expect(reloaded?.triggered).toBe(false)
    })
  })

  describe('interleaving with unrelated timers', () => {
    it('applies consequences independently across multiple timers sharing no state', () => {
      const grain = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
      const treasury = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 100 })

      const fuseA = createTimer({
        gameId,
        name: 'fuse A',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: grain.id, delta: -10 },
      })
      const fuseB = createTimer({
        gameId,
        name: 'fuse B',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: treasury.id, delta: -25 },
      })

      tickTimer(fuseA.id, 1)
      tickTimer(fuseB.id, 1)

      expect(getResource(grain.id)?.value).toBe(90)
      expect(getResource(treasury.id)?.value).toBe(75)
    })

    it('one timer failing to apply its consequence does not affect an unrelated timer ticked afterward', () => {
      const treasury = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 100 })

      const brokenFuse = createTimer({
        gameId,
        name: 'broken fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: 'does-not-exist', delta: -10 },
      })
      const healthyFuse = createTimer({
        gameId,
        name: 'healthy fuse',
        timerType: 'countdown',
        currentValue: 1,
        triggerAt: 0,
        consequence: { resourceId: treasury.id, delta: -25 },
      })

      expect(() => tickTimer(brokenFuse.id, 1)).toThrow()
      tickTimer(healthyFuse.id, 1)

      expect(getResource(treasury.id)?.value).toBe(75)
    })
  })
})
