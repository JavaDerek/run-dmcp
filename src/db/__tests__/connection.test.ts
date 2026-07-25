import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, destroyTestDb } from './testDb.js'
import { withTransaction, getDatabase } from '../connection.js'
import { createGame } from '../../tools/game.js'
import { createResource, getResource } from '../../tools/resource.js'

describe('withTransaction', () => {
  let gameId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('commits all writes performed inside the callback when it succeeds', () => {
    const result = withTransaction(() => {
      const a = createResource({ gameId, ownerType: 'game', name: 'grain', value: 1 })
      const b = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 2 })
      return { a, b }
    })

    expect(getResource(result.a.id)?.value).toBe(1)
    expect(getResource(result.b.id)?.value).toBe(2)
  })

  it('returns the callback return value', () => {
    const value = withTransaction(() => 42)
    expect(value).toBe(42)
  })

  it('rolls back every write in the callback when it throws, leaving no partial writes', () => {
    const first = createResource({ gameId, ownerType: 'game', name: 'grain', value: 1 })

    expect(() => {
      withTransaction(() => {
        // This write should succeed at the SQLite level...
        createResource({ gameId, ownerType: 'game', name: 'treasury', value: 2 });
        // ...but the transaction as a whole should never commit because of this throw.
        throw new Error('boom');
      })
    }).toThrow('boom')

    // The pre-existing resource is untouched.
    expect(getResource(first.id)?.value).toBe(1)

    // The resource created inside the doomed transaction must not exist.
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM resources WHERE name = ?').all('treasury')
    expect(rows).toHaveLength(0)
  })

  it('propagates the original error when rolling back', () => {
    class CustomError extends Error {}

    expect(() =>
      withTransaction(() => {
        createResource({ gameId, ownerType: 'game', name: 'grain', value: 1 })
        throw new CustomError('custom failure')
      })
    ).toThrow(CustomError)
  })

  it('rolls back a mid-operation failure across two dependent writes (debit/credit style)', () => {
    const from = createResource({ gameId, ownerType: 'game', name: 'grain', value: 100 })
    const to = createResource({ gameId, ownerType: 'game', name: 'treasury', value: 0 })

    const shouldFailBeforeCredit = true

    expect(() => {
      withTransaction(() => {
        const db = getDatabase()
        db.prepare('UPDATE resources SET value = value - 10 WHERE id = ?').run(from.id)
        // Simulate a failure that happens after the first write but before the second.
        if (shouldFailBeforeCredit) {
          throw new Error('credit step failed')
        }
        db.prepare('UPDATE resources SET value = value + 10 WHERE id = ?').run(to.id)
      })
    }).toThrow('credit step failed')

    // Neither side of the transfer should have taken effect.
    expect(getResource(from.id)?.value).toBe(100)
    expect(getResource(to.id)?.value).toBe(0)
  })
})
