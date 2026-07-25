import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, destroyTestDb } from '../../db/__tests__/testDb.js'
import { getDatabase } from '../../db/connection.js'
import { createGame } from '../game.js'
import {
  createBidirectionalRelationship,
  createRelationship,
  getRelationship,
  getRelationshipHistory,
  modifyRelationship,
  updateRelationshipValue,
} from '../relationship.js'

describe('createBidirectionalRelationship', () => {
  let gameId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('creates two relationship rows, one in each direction', () => {
    const [relA, relB] = createBidirectionalRelationship({
      gameId,
      entityA: { id: 'alice', type: 'character' },
      entityB: { id: 'bob', type: 'character' },
      relationshipType: 'ally',
      value: 10,
    })

    expect(relA.sourceId).toBe('alice')
    expect(relA.targetId).toBe('bob')
    expect(relB.sourceId).toBe('bob')
    expect(relB.targetId).toBe('alice')
  })

  it('leaves NO partial write when the second insert fails mid-operation', () => {
    const db = getDatabase()
    // Fault injection: make the INSERT for the second (bob -> alice) row
    // fail, simulating a mid-operation failure such as a constraint
    // violation or disk error.
    db.exec(`
      CREATE TRIGGER fail_second_relationship_insert
      BEFORE INSERT ON relationships
      WHEN NEW.source_id = 'bob'
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure');
      END;
    `)

    expect(() =>
      createBidirectionalRelationship({
        gameId,
        entityA: { id: 'alice', type: 'character' },
        entityB: { id: 'bob', type: 'character' },
        relationshipType: 'ally',
        value: 10,
      })
    ).toThrow()

    const rows = db.prepare('SELECT * FROM relationships').all()
    expect(rows).toHaveLength(0)
  })
})

describe('modifyRelationship', () => {
  let gameId: string
  let relationshipId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
    relationshipId = createRelationship({
      gameId,
      sourceId: 'alice',
      sourceType: 'character',
      targetId: 'bob',
      targetType: 'character',
      relationshipType: 'ally',
      value: 0,
    }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('updates the value and logs a history row together', () => {
    const result = modifyRelationship({ relationshipId, delta: 5, reason: 'helped in a fight' })

    expect(result?.relationship.value).toBe(5)
    const history = getRelationshipHistory(relationshipId)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ previousValue: 0, newValue: 5, reason: 'helped in a fight' })
  })

  it('leaves NO partial write when the history insert fails mid-operation', () => {
    const db = getDatabase()
    // Fault injection: make the relationship_history INSERT fail after the
    // relationships UPDATE has already run.
    db.exec(`
      CREATE TRIGGER fail_relationship_history_insert
      BEFORE INSERT ON relationship_history
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure');
      END;
    `)

    expect(() => modifyRelationship({ relationshipId, delta: 5, reason: 'helped in a fight' })).toThrow()

    expect(getRelationship(relationshipId)?.value).toBe(0)
    expect(getRelationshipHistory(relationshipId)).toHaveLength(0)
  })
})

describe('updateRelationshipValue', () => {
  let gameId: string
  let relationshipId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
    relationshipId = createRelationship({
      gameId,
      sourceId: 'alice',
      sourceType: 'character',
      targetId: 'bob',
      targetType: 'character',
      relationshipType: 'ally',
      value: 0,
    }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('updates the value and logs history when the value changes', () => {
    const result = updateRelationshipValue({ relationshipId, mode: 'set', value: 20, reason: 'reconciled' })

    expect(result?.relationship.value).toBe(20)
    expect(result?.change).toMatchObject({ previousValue: 0, newValue: 20, reason: 'reconciled' })
  })

  it('leaves NO partial write when the history insert fails mid-operation', () => {
    const db = getDatabase()
    db.exec(`
      CREATE TRIGGER fail_relationship_history_insert_2
      BEFORE INSERT ON relationship_history
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure');
      END;
    `)

    expect(() =>
      updateRelationshipValue({ relationshipId, mode: 'set', value: 20, reason: 'reconciled' })
    ).toThrow()

    // Value must not have moved, since the paired history write failed.
    expect(getRelationship(relationshipId)?.value).toBe(0)
    expect(getRelationshipHistory(relationshipId)).toHaveLength(0)
  })
})
