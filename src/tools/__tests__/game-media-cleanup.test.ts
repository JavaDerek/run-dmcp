import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

// As in media-path-guard.test.ts: only the DATA DIR moves to a real temp
// directory, because what is under test is what survives on disk. The
// database stays in-memory via the normal fixture.
const { TEST_DATA_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: `${(process.env.TMPDIR || '/tmp').replace(/\/+$/, '')}/run-dmcp-game-media-${process.pid}`,
}))

vi.mock('../../db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/connection.js')>()
  return { ...actual, getDataDir: () => TEST_DATA_DIR }
})

const { createTestDb, destroyTestDb } = await import('../../db/__tests__/testDb.js')
const { getDatabase } = await import('../../db/connection.js')
const { createGame, deleteGame } = await import('../game.js')
const { storeAudio } = await import('../audio.js')
const { storeImage } = await import('../images.js')

const AUDIO_DIR = join(TEST_DATA_DIR, 'audio')
const IMAGES_DIR = join(TEST_DATA_DIR, 'images')

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

describe('deleteGame and the media on disk', () => {
  let sourceAudio: string

  beforeEach(() => {
    createTestDb()
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DATA_DIR, { recursive: true })
    sourceAudio = join(TEST_DATA_DIR, 'source.mp3')
    writeFileSync(sourceAudio, Buffer.from('not really an mp3'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => PNG_1X1.buffer.slice(PNG_1X1.byteOffset, PNG_1X1.byteOffset + PNG_1X1.byteLength),
      }))
    )
  })

  afterEach(() => {
    destroyTestDb()
    vi.unstubAllGlobals()
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
  })

  async function gameWithMedia() {
    const game = createGame({ name: 'Fixture', setting: 'Fixture', style: 'Fixture' })
    const audio = await storeAudio({
      gameId: game.id,
      entityId: game.id,
      entityType: 'game',
      filePath: sourceAudio,
    })
    const image = await storeImage({
      gameId: game.id,
      entityId: game.id,
      entityType: 'game',
      url: 'https://example.invalid/x.png',
    })
    return { game, audio, image }
  }

  it('removes the media tree of the deleted game from disk', async () => {
    const { game, audio, image } = await gameWithMedia()
    expect(existsSync(join(AUDIO_DIR, audio.filePath))).toBe(true)
    expect(existsSync(join(IMAGES_DIR, image.filePath))).toBe(true)

    expect(deleteGame(game.id)).toBe(true)

    expect(existsSync(join(AUDIO_DIR, game.id))).toBe(false)
    expect(existsSync(join(IMAGES_DIR, game.id))).toBe(false)
  })

  it('leaves another game its media', async () => {
    const doomed = await gameWithMedia()
    const survivor = await gameWithMedia()

    deleteGame(doomed.game.id)

    expect(existsSync(join(AUDIO_DIR, survivor.audio.filePath))).toBe(true)
    expect(existsSync(join(IMAGES_DIR, survivor.image.filePath))).toBe(true)
    expect(readdirSync(AUDIO_DIR)).toEqual([survivor.game.id])
  })

  it('takes the rows with it, so nothing is left pointing at a deleted file', async () => {
    const { game } = await gameWithMedia()

    deleteGame(game.id)

    const db = getDatabase()
    expect((db.prepare('SELECT COUNT(*) AS n FROM stored_audio').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM stored_images').get() as { n: number }).n).toBe(0)
  })

  it('reports failure and deletes nothing when the game does not exist', async () => {
    const { game, audio } = await gameWithMedia()

    expect(deleteGame('00000000-0000-4000-8000-000000000000')).toBe(false)

    expect(existsSync(join(AUDIO_DIR, audio.filePath))).toBe(true)
    expect(
      (getDatabase().prepare('SELECT COUNT(*) AS n FROM stored_audio').get() as { n: number }).n
    ).toBe(1)
    expect(existsSync(join(AUDIO_DIR, game.id))).toBe(true)
  })

  it('survives a media root that is not there at all', async () => {
    const { game } = await gameWithMedia()
    rmSync(AUDIO_DIR, { recursive: true, force: true })
    rmSync(IMAGES_DIR, { recursive: true, force: true })

    expect(deleteGame(game.id)).toBe(true)
  })
})
