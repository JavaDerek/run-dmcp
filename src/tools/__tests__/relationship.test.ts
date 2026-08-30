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
  updateRelationship,
  updateRelationshipValue,
} from '../relationship.js'
import { currentStoryTime } from '../../timeline/clock.js'
import { replay } from '../../timeline/replay.js'
import { changesWithin } from '../../timeline/changes.js'

// currentStoryTime() returns `T | null` -- null only for a game nothing has
// ever declared a clock for (clock.ts). Every test below creates a
// relationship before calling this, which always writes at least once, so
// the clock always exists; this helper asserts that instead of using a
// non-null assertion at each call site.
function requireStoryT(gameId: string): number {
  const story = currentStoryTime(gameId)
  if (!story) {
    throw new Error(`test setup error: game '${gameId}' has no timeline clock`)
  }
  return story.t
}

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
    // Fault injection point MOVED: modifyRelationship() now delegates its
    // value write to writeConstrainedValue() (src/timeline/constrained.ts),
    // which records the audit trail as a 'value.changed' row in `events`,
    // not as an INSERT into `relationship_history` (that table is frozen --
    // see relationship_history_frozen in src/db/schema.ts, nothing writes to
    // it any more). A trigger on `relationship_history` would simply never
    // fire and this test would silently stop testing the atomicity property
    // it exists to test. Re-pointed to the write that now carries the audit
    // record instead: the same live column UPDATE plus paired history-event
    // INSERT must still land together or not at all, so failing the events
    // INSERT is the equivalent fault injection under the new substrate.
    db.exec(`
      CREATE TRIGGER fail_relationship_history_insert
      BEFORE INSERT ON events WHEN NEW.kind = 'value.changed'
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
    // Fault injection point MOVED, same reason as modifyRelationship's test
    // above: updateRelationshipValue() now routes its (conditional) value
    // write through writeConstrainedValue(), which annotates the change as
    // a 'value.changed' row in `events`, not an INSERT into the now-frozen
    // `relationship_history`. Re-pointed to the write that actually carries
    // the audit record; every assertion below is unchanged -- the property
    // under test (the metadata update, the value write, and its history
    // annotation land together or not at all) is the same, only the point
    // where the fault is injected has moved to match the new substrate.
    db.exec(`
      CREATE TRIGGER fail_relationship_history_insert_2
      BEFORE INSERT ON events WHEN NEW.kind = 'value.changed'
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

// ==========================================================================
// Issue #9 / design §5.4 option (C), Phase 3 step 3: relationship_history
// stops being a mechanism. `getRelationshipHistory` is now built entirely
// from the timeline (valueHistory() in src/timeline/constrained.ts), the
// same substrate resource.ts's own history already converged onto. Every
// test below is written against the CLAIM that merge makes: one write path
// for "what did this value used to be", and a strictly MORE complete
// history than relationship_history ever held, not merely an equivalent
// one.
// ==========================================================================

describe('getRelationshipHistory after modifyRelationship', () => {
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

  it('returns the same fields it always did: previousValue, newValue, reason', () => {
    modifyRelationship({ relationshipId, delta: 12, reason: 'shared a meal' })

    const history = getRelationshipHistory(relationshipId)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ previousValue: 0, newValue: 12, reason: 'shared a meal' })
  })

  // Routing the value column through the one choke point takes the value
  // write out of this function's own UPDATE, and `updated_at` came along in
  // that same statement. It must not be lost with it: listRelationships()
  // orders by `updated_at DESC`, so a relationship modified through this
  // path would silently stop sorting as recently touched -- a regression no
  // history assertion would ever catch.
  it('still refreshes updated_at, on the live row and in what it returns', () => {
    // Backdate the column to a value this call cannot possibly produce,
    // rather than comparing against whatever createRelationship() stamped a
    // moment ago -- both are ISO strings from Date.now(), and inside one
    // test they can easily land in the same millisecond, which would make
    // this assertion pass or fail on timing rather than on behaviour.
    const backdated = '2020-01-01T00:00:00.000Z'
    getDatabase()
      .prepare(`UPDATE relationships SET updated_at = ? WHERE id = ?`)
      .run(backdated, relationshipId)

    const result = modifyRelationship({ relationshipId, delta: 12, reason: 'shared a meal' })

    const live = getRelationship(relationshipId)
    expect(live?.updatedAt).not.toBe(backdated)
    expect(result?.relationship.updatedAt).toBe(live?.updatedAt)
  })
})

describe('zero-delta modifyRelationship vs a no-op updateRelationshipValue -- different behaviours, on purpose', () => {
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
      value: 10,
    }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  // modifyRelationship() always delegates to writeConstrainedValue(), which
  // leaves an annotation event even for a write that changes nothing (see
  // applyLiveWrite()/valueHistory() in src/timeline/constrained.ts) -- so a
  // zero-delta call still produces a history row, exactly as it always has.
  it('a zero-delta modifyRelationship still produces a history row', () => {
    const result = modifyRelationship({ relationshipId, delta: 0, reason: 'no change, still logged' })

    expect(result?.relationship.value).toBe(10)
    const history = getRelationshipHistory(relationshipId)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ previousValue: 10, newValue: 10, reason: 'no change, still logged' })
  })

  // updateRelationshipValue() has the OPPOSITE contract (see its doc comment
  // in src/tools/relationship.ts): it never calls writeConstrainedValue() at
  // all when the value doesn't change, so a no-op 'set' produces NO history
  // row and returns change: null. This is the load-bearing difference the
  // two functions have always had, preserved across the substrate change.
  it('a no-op updateRelationshipValue produces NO history row and returns change: null', () => {
    const result = updateRelationshipValue({ relationshipId, mode: 'set', value: 10, reason: 'no-op' })

    expect(result?.change).toBeNull()
    expect(result?.relationship.value).toBe(10)
    expect(getRelationshipHistory(relationshipId)).toHaveLength(0)
  })
})

describe('the payoff -- replay() and changesWithin() see relationship value writes directly', () => {
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

  it('replay(t) at each recorded t reports the value that held then', () => {
    modifyRelationship({ relationshipId, delta: 5 })
    const t0 = requireStoryT(gameId)

    updateRelationshipValue({ relationshipId, mode: 'set', value: 40 })
    const t1 = requireStoryT(gameId)

    const factAt = (t: number) =>
      replay({ gameId, t }).entities.find((e) => e.id === relationshipId)?.facts.value.value

    // relationships.value is declared INTEGER (unlike resources.value,
    // which is REAL) -- the projection triggers CAST it to TEXT
    // (projection.ts), and SQLite's INTEGER->TEXT cast for a whole number
    // renders "5", not "5.0" the way REAL->TEXT does (measured directly
    // against better-sqlite3; see constrained.test.ts's resource-side
    // assertions for the REAL case).
    expect(factAt(t0)).toBe('5')
    expect(factAt(t1)).toBe('40')
  })

  it('changesWithin(t0, t1) returns the "value" fact transitions in the window', () => {
    const before = requireStoryT(gameId)

    modifyRelationship({ relationshipId, delta: 5 })
    const first = requireStoryT(gameId)

    updateRelationshipValue({ relationshipId, mode: 'set', value: 40 })
    const second = requireStoryT(gameId)

    const window = changesWithin({ gameId, t0: before, t1: second + 1 })
    const valueOpens = window.changes.filter(
      (c) => c.kind === 'fact' && c.factKey === 'value' && c.entityId === relationshipId && c.endpoint === 'opened'
    )

    expect(valueOpens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: '5', t: first }),
        expect.objectContaining({ value: '40', t: second }),
      ])
    )
  })
})

describe('an unannotated transition (a direct SQL write, bypassing every tool)', () => {
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

  it('comes back from getRelationshipHistory with reason: null', () => {
    const db = getDatabase()
    // The projection trigger (timeline_relationships_au, projection.ts)
    // fires on ANY UPDATE to `relationships`, not only ones routed through
    // writeConstrainedValue() -- so this still opens a real fact transition,
    // just with no annotation event to join it to.
    db.prepare(`UPDATE relationships SET value = ? WHERE id = ?`).run(99, relationshipId)

    const history = getRelationshipHistory(relationshipId)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ previousValue: 0, newValue: 99, reason: null })
  })
})

describe('planted violations -- run and watched red before being trusted', () => {
  let gameId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('a direct INSERT into relationship_history is refused by relationship_history_frozen', () => {
    const relationship = createRelationship({
      gameId,
      sourceId: 'alice',
      sourceType: 'character',
      targetId: 'bob',
      targetType: 'character',
      relationshipType: 'ally',
      value: 0,
    })
    const db = getDatabase()

    expect(() =>
      db
        .prepare(
          `INSERT INTO relationship_history (id, relationship_id, previous_value, new_value, reason, timestamp)
           VALUES ('planted', ?, 0, 1, NULL, '2026-01-01T00:00:00.000Z')`
        )
        .run(relationship.id)
    ).toThrow(/frozen/i)
  })

  it('no code path under createRelationship/modifyRelationship/updateRelationshipValue/updateRelationship writes to relationship_history', () => {
    const relationship = createRelationship({
      gameId,
      sourceId: 'alice',
      sourceType: 'character',
      targetId: 'bob',
      targetType: 'character',
      relationshipType: 'ally',
      value: 0,
    })

    modifyRelationship({ relationshipId: relationship.id, delta: 5 })
    updateRelationshipValue({ relationshipId: relationship.id, mode: 'set', value: 20 })
    updateRelationship(relationship.id, { notes: 'a note' })

    const db = getDatabase()
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM relationship_history`).get() as { n: number }).n
    expect(count).toBe(0)
  })
})
