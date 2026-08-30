import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb, destroyTestDb } from '../../db/__tests__/testDb.js'
import { getDatabase } from '../../db/connection.js'

// The media cleanup is stubbed here so the wiring can be asserted directly,
// and so a cleanup FAILURE can be injected deterministically rather than by
// arranging a real un-removable directory (which a run as root would quietly
// turn into a test that cannot fail). What lands on disk when the cleanup
// succeeds is covered end-to-end in game-media-cleanup.test.ts.
const { audioSpy, imagesSpy } = vi.hoisted(() => ({
  audioSpy: vi.fn(() => 0),
  imagesSpy: vi.fn(() => 0),
}))

vi.mock('../audio.js', () => ({ deleteGameAudio: audioSpy }))
vi.mock('../images.js', () => ({ deleteGameImages: imagesSpy }))

const { createGame, deleteGame } = await import('../game.js')

describe('deleteGame media cleanup wiring', () => {
  beforeEach(() => {
    createTestDb()
    audioSpy.mockReset().mockReturnValue(0)
    imagesSpy.mockReset().mockReturnValue(0)
  })

  afterEach(() => {
    destroyTestDb()
  })

  it('calls both cleanups with the deleted game id', () => {
    const game = createGame({ name: 'Fixture', setting: 'Fixture', style: 'Fixture' })

    expect(deleteGame(game.id)).toBe(true)

    expect(audioSpy).toHaveBeenCalledWith(game.id)
    expect(imagesSpy).toHaveBeenCalledWith(game.id)
  })

  it('does not run the cleanups when no row was deleted', () => {
    expect(deleteGame('00000000-0000-4000-8000-000000000000')).toBe(false)

    expect(audioSpy).not.toHaveBeenCalled()
    expect(imagesSpy).not.toHaveBeenCalled()
  })

  it('reports success and keeps going when the audio cleanup throws', () => {
    const game = createGame({ name: 'Fixture', setting: 'Fixture', style: 'Fixture' })
    audioSpy.mockImplementation(() => {
      throw new Error('audio cleanup failed')
    })

    // The row is already gone; throwing here cannot un-delete it, and would
    // only replace a stale directory with a failed tool call.
    expect(deleteGame(game.id)).toBe(true)

    // The image cleanup still runs -- one failing does not skip the other.
    expect(imagesSpy).toHaveBeenCalledWith(game.id)
    expect(
      (getDatabase().prepare('SELECT COUNT(*) AS n FROM games WHERE id = ?').get(game.id) as { n: number }).n
    ).toBe(0)
  })

  it('reports success and keeps going when the image cleanup throws', () => {
    const game = createGame({ name: 'Fixture', setting: 'Fixture', style: 'Fixture' })
    imagesSpy.mockImplementation(() => {
      throw new Error('image cleanup failed')
    })

    expect(deleteGame(game.id)).toBe(true)

    expect(audioSpy).toHaveBeenCalledWith(game.id)
    expect(
      (getDatabase().prepare('SELECT COUNT(*) AS n FROM games WHERE id = ?').get(game.id) as { n: number }).n
    ).toBe(0)
  })
})
