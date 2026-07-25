import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, destroyTestDb } from '../../db/__tests__/testDb.js'
import { getDatabase } from '../../db/connection.js'
import { createGame } from '../game.js'
import { connectLocations, createLocation, getLocation } from '../world.js'

describe('connectLocations', () => {
  let gameId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('adds a one-way exit when bidirectional is false', () => {
    const a = createLocation({ gameId, name: 'Field', description: 'An open field' })
    const b = createLocation({ gameId, name: 'Barn', description: 'A wooden barn' })

    const result = connectLocations({
      fromLocationId: a.id,
      toLocationId: b.id,
      fromDirection: 'north',
      toDirection: 'south',
      bidirectional: false,
    })

    expect(result?.success).toBe(true)
    expect(result?.reverseExitCreated).toBeNull()
    expect(getLocation(a.id)?.properties.exits).toHaveLength(1)
    expect(getLocation(b.id)?.properties.exits).toHaveLength(0)
  })

  it('adds exits to both locations when bidirectional', () => {
    const a = createLocation({ gameId, name: 'Field', description: 'An open field' })
    const b = createLocation({ gameId, name: 'Barn', description: 'A wooden barn' })

    connectLocations({
      fromLocationId: a.id,
      toLocationId: b.id,
      fromDirection: 'north',
      toDirection: 'south',
    })

    expect(getLocation(a.id)?.properties.exits).toHaveLength(1)
    expect(getLocation(b.id)?.properties.exits).toHaveLength(1)
  })

  it('leaves NO partial write when the second (reverse-exit) update fails mid-operation', () => {
    const a = createLocation({ gameId, name: 'Field', description: 'An open field' })
    const b = createLocation({ gameId, name: 'Barn', description: 'A wooden barn' })

    // Fault injection: make the UPDATE against location `b` (the second
    // write connectLocations performs) fail, simulating a mid-operation
    // failure such as a disk error or constraint violation. If the two
    // writes aren't wrapped in a real transaction, location `a` will have
    // already been updated by the time this trigger fires.
    const db = getDatabase()
    db.exec(`
      CREATE TRIGGER fail_second_update
      BEFORE UPDATE ON locations
      WHEN NEW.id = '${b.id}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure');
      END;
    `)

    expect(() =>
      connectLocations({
        fromLocationId: a.id,
        toLocationId: b.id,
        fromDirection: 'north',
        toDirection: 'south',
      })
    ).toThrow()

    // Neither location should show any exit -- the forward-exit write to
    // `a` must have been rolled back along with the failed write to `b`.
    expect(getLocation(a.id)?.properties.exits).toHaveLength(0)
    expect(getLocation(b.id)?.properties.exits).toHaveLength(0)
  })
})
