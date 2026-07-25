import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { createTestDb, destroyTestDb } from '../../db/__tests__/testDb.js'
import { getDatabase } from '../../db/connection.js'
import { createGame } from '../game.js'
import { createCharacter } from '../character.js'
import { getImage, setPrimaryImage } from '../images.js'

// Inserts a stored_images row directly via SQL so these tests can exercise
// setPrimaryImage() without going through storeImage()'s file I/O / network
// fetch, which is unrelated to the atomicity behavior under test here.
function insertStoredImage(params: { gameId: string; entityId: string; entityType: string; isPrimary: boolean }): string {
  const db = getDatabase()
  const id = uuidv4()
  db.prepare(`
    INSERT INTO stored_images (id, game_id, entity_id, entity_type, file_path, file_size, mime_type, source, is_primary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.gameId, params.entityId, params.entityType, `${id}.png`, 100, 'image/png', 'uploaded', params.isPrimary ? 1 : 0, new Date().toISOString())
  return id
}

describe('setPrimaryImage', () => {
  let gameId: string
  let characterId: string

  beforeEach(() => {
    createTestDb()
    gameId = createGame({ name: 'Test Game', setting: 'Test Setting', style: 'Test Style' }).id
    characterId = createCharacter({ gameId, name: 'Narrator', isPlayer: false }).id
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('unsets the previous primary and sets the new one', () => {
    const first = insertStoredImage({ gameId, entityId: characterId, entityType: 'character', isPrimary: true })
    const second = insertStoredImage({ gameId, entityId: characterId, entityType: 'character', isPrimary: false })

    setPrimaryImage(second)

    expect(getImage(first)?.isPrimary).toBe(false)
    expect(getImage(second)?.isPrimary).toBe(true)
  })

  it('leaves NO partial write when the second update fails mid-operation: the old primary stays primary', () => {
    const first = insertStoredImage({ gameId, entityId: characterId, entityType: 'character', isPrimary: true })
    const second = insertStoredImage({ gameId, entityId: characterId, entityType: 'character', isPrimary: false })

    // Fault injection: make the UPDATE that sets `second` as primary fail,
    // simulating a mid-operation failure between the unset and the set.
    const db = getDatabase()
    db.exec(`
      CREATE TRIGGER fail_set_new_primary_image
      BEFORE UPDATE ON stored_images
      WHEN NEW.id = '${second}' AND NEW.is_primary = 1
      BEGIN
        SELECT RAISE(ABORT, 'simulated failure');
      END;
    `)

    expect(() => setPrimaryImage(second)).toThrow()

    // Without a real transaction, the first UPDATE (unsetting `first`)
    // would have already committed, leaving NO primary at all. With a
    // transaction, `first` must still be primary.
    expect(getImage(first)?.isPrimary).toBe(true)
    expect(getImage(second)?.isPrimary).toBe(false)
  })
})
