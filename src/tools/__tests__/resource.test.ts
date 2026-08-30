import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, destroyTestDb } from '../../db/__tests__/testDb.js'
import { getDatabase } from '../../db/connection.js'
import { createGame } from '../game.js'
import { createResource, getResource, getResourceHistory, updateResourceValue } from '../resource.js'

describe('updateResourceValue', () => {
  let gameId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('returns null when the resource does not exist', () => {
    const result = updateResourceValue({ resourceId: 'does-not-exist', mode: 'delta', value: 5 })
    expect(result).toBeNull()
  })

  describe('delta mode', () => {
    it('adds the delta to the current value', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })

      const result = updateResourceValue({ resourceId: resource.id, mode: 'delta', value: 5 })

      expect(result).not.toBeNull()
      expect(result?.resource.value).toBe(15)
    })

    it('subtracts when the delta is negative', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })

      const result = updateResourceValue({ resourceId: resource.id, mode: 'delta', value: -4 })

      expect(result?.resource.value).toBe(6)
    })

    it('persists the new value to the database', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })

      updateResourceValue({ resourceId: resource.id, mode: 'delta', value: 5 })

      const reloaded = getResource(resource.id)
      expect(reloaded?.value).toBe(15)
    })
  })

  describe('set mode', () => {
    it('replaces the current value entirely, ignoring the previous value', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 100 })

      const result = updateResourceValue({ resourceId: resource.id, mode: 'set', value: 42 })

      expect(result?.resource.value).toBe(42)
    })
  })

  describe('clamping', () => {
    it('clamps delta results to max_value', () => {
      const resource = createResource({
        gameId,
        ownerType: 'game',
        name: 'population',
        value: 90,
        maxValue: 100,
      })

      const result = updateResourceValue({ resourceId: resource.id, mode: 'delta', value: 50 })

      expect(result?.resource.value).toBe(100)
    })

    it('clamps delta results to min_value', () => {
      const resource = createResource({
        gameId,
        ownerType: 'game',
        name: 'population',
        value: 10,
        minValue: 0,
      })

      const result = updateResourceValue({ resourceId: resource.id, mode: 'delta', value: -50 })

      expect(result?.resource.value).toBe(0)
    })

    it('clamps set-mode values to max_value', () => {
      const resource = createResource({
        gameId,
        ownerType: 'game',
        name: 'population',
        value: 10,
        maxValue: 100,
      })

      const result = updateResourceValue({ resourceId: resource.id, mode: 'set', value: 500 })

      expect(result?.resource.value).toBe(100)
    })

    it('clamps set-mode values to min_value', () => {
      const resource = createResource({
        gameId,
        ownerType: 'game',
        name: 'population',
        value: 10,
        minValue: 0,
      })

      const result = updateResourceValue({ resourceId: resource.id, mode: 'set', value: -500 })

      expect(result?.resource.value).toBe(0)
    })

    it('does not clamp when no bounds are set', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })

      const result = updateResourceValue({ resourceId: resource.id, mode: 'delta', value: 1000000 })

      expect(result?.resource.value).toBe(1000010)
    })
  })

  describe('resource_history rows', () => {
    it('records previous_value, new_value, delta, and reason for a delta update', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })

      const result = updateResourceValue({
        resourceId: resource.id,
        mode: 'delta',
        value: 5,
        reason: 'harvest',
      })

      expect(result?.change).toMatchObject({
        resourceId: resource.id,
        previousValue: 10,
        newValue: 15,
        delta: 5,
        reason: 'harvest',
      })

      const history = getResourceHistory(resource.id)
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({
        resourceId: resource.id,
        previousValue: 10,
        newValue: 15,
        delta: 5,
        reason: 'harvest',
      })
    })

    it('records the post-clamp delta, not the requested delta', () => {
      const resource = createResource({
        gameId,
        ownerType: 'game',
        name: 'population',
        value: 90,
        maxValue: 100,
      })

      updateResourceValue({ resourceId: resource.id, mode: 'delta', value: 50, reason: 'growth' })

      const history = getResourceHistory(resource.id)
      expect(history[0]).toMatchObject({
        previousValue: 90,
        newValue: 100,
        delta: 10,
      })
    })

    it('records a history row for a set-mode update, with delta as the difference', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 100 })

      updateResourceValue({ resourceId: resource.id, mode: 'set', value: 42, reason: 'audit correction' })

      const history = getResourceHistory(resource.id)
      expect(history[0]).toMatchObject({
        previousValue: 100,
        newValue: 42,
        delta: -58,
        reason: 'audit correction',
      })
    })

    it('defaults reason to null when not provided', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })

      updateResourceValue({ resourceId: resource.id, mode: 'delta', value: 1 })

      const history = getResourceHistory(resource.id)
      expect(history[0].reason).toBeNull()
    })

    it('appends multiple history rows across repeated updates', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 0 })

      updateResourceValue({ resourceId: resource.id, mode: 'delta', value: 5, reason: 'first' })
      updateResourceValue({ resourceId: resource.id, mode: 'delta', value: 3, reason: 'second' })

      const history = getResourceHistory(resource.id)
      expect(history).toHaveLength(2)
      // Both updates can land in the same millisecond, so don't assume a
      // strict order between same-timestamp rows -- just check both exist.
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ previousValue: 0, newValue: 5, delta: 5, reason: 'first' }),
          expect.objectContaining({ previousValue: 5, newValue: 8, delta: 3, reason: 'second' }),
        ])
      )
    })
  })

  describe('atomicity', () => {
    it('leaves NO partial write when the resource_history insert fails mid-operation', () => {
      const resource = createResource({ gameId, ownerType: 'game', name: 'grain', value: 10 })

      // Fault injection: make the write's annotation event INSERT fail
      // after the resources UPDATE has already run, simulating a
      // mid-operation failure such as a disk error or constraint
      // violation. This used to target `resource_history` directly, but
      // that table no longer receives inserts (design §5.4 option (C) --
      // interval-versioned facts are the history now, written by
      // writeConstrainedValue's single annotation-event insert into
      // `events`). The property under test -- that the value write and its
      // audit trail land together or not at all -- is unchanged; only the
      // table carrying the audit trail moved, so the injection point moves
      // with it.
      const db = getDatabase()
      db.exec(`
        CREATE TRIGGER fail_resource_history_insert
        BEFORE INSERT ON events
        WHEN NEW.kind = 'value.changed'
        BEGIN
          SELECT RAISE(ABORT, 'simulated failure');
        END;
      `)

      expect(() =>
        updateResourceValue({ resourceId: resource.id, mode: 'delta', value: 5, reason: 'harvest' })
      ).toThrow()

      // The resources.value write must have been rolled back along with
      // the failed resource_history write.
      expect(getResource(resource.id)?.value).toBe(10)
      expect(getResourceHistory(resource.id)).toHaveLength(0)
    })
  })
})
