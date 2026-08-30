import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

// The media root has to be a real directory for these tests: the behaviour
// under test is what reaches the filesystem. Only the DATA DIR is redirected
// here -- the database itself stays in-memory, via the normal fixture, so this
// does not become a second database fixture. `vi.hoisted` runs before the
// imports below, so the path is computed with globals only.
const { TEST_DATA_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: `${(process.env.TMPDIR || '/tmp').replace(/\/+$/, '')}/run-dmcp-media-guard-${process.pid}`,
}))

vi.mock('../../db/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/connection.js')>()
  return { ...actual, getDataDir: () => TEST_DATA_DIR }
})

const { createTestDb, destroyTestDb } = await import('../../db/__tests__/testDb.js')
const { getDatabase } = await import('../../db/connection.js')
const { createGame } = await import('../game.js')
const { storeAudio, deleteGameAudio } = await import('../audio.js')
const { storeImage, deleteGameImages } = await import('../images.js')
const { MediaPathError } = await import('../../utils/media-path.js')

const AUDIO_DIR = join(TEST_DATA_DIR, 'audio')
const IMAGES_DIR = join(TEST_DATA_DIR, 'images')

// The file a traversal must never be able to reach: it sits in the data dir,
// one level ABOVE the media root, exactly where the real database lives.
const SENTINEL = join(TEST_DATA_DIR, 'sentinel.txt')

// A 1x1 PNG. Real bytes, so sharp's metadata read succeeds and storeImage
// gets all the way to the path composition under test.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function stubFetchReturning(body: Buffer, contentType: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    }))
  )
}

// Ids that walk out of the media root, or would if `join()` were handed them
// unchecked. `..` on its own is the worst of them for the delete paths: it
// makes the recursive delete target the data directory itself.
const TRAVERSAL_IDS = ['..', '../pwned', '../../pwned', 'nested/child', '/absolute']

describe('media paths built from caller-supplied ids', () => {
  let sourceAudio: string

  beforeEach(() => {
    createTestDb()
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
    mkdirSync(AUDIO_DIR, { recursive: true })
    mkdirSync(IMAGES_DIR, { recursive: true })
    writeFileSync(SENTINEL, 'the data directory survives')
    sourceAudio = join(TEST_DATA_DIR, 'source.mp3')
    writeFileSync(sourceAudio, Buffer.from('not really an mp3'))
    stubFetchReturning(PNG_1X1, 'image/png')
  })

  afterEach(() => {
    destroyTestDb()
    vi.unstubAllGlobals()
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
  })

  describe('storeAudio', () => {
    it.each(TRAVERSAL_IDS)('rejects the game id %j and writes nothing', async (gameId) => {
      await expect(
        storeAudio({ gameId, entityId: 'entity', entityType: 'game', filePath: sourceAudio })
      ).rejects.toThrow(MediaPathError)

      expect(existsSync(join(TEST_DATA_DIR, 'pwned'))).toBe(false)
      expect(readFileSync(SENTINEL, 'utf8')).toBe('the data directory survives')
      expect(
        (getDatabase().prepare('SELECT COUNT(*) AS n FROM stored_audio').get() as { n: number }).n
      ).toBe(0)
    })

    it.each(TRAVERSAL_IDS)('rejects the entity id %j', async (entityId) => {
      const game = createGame({ name: 'Fixture', setting: 'Fixture', style: 'Fixture' })
      await expect(
        storeAudio({ gameId: game.id, entityId, entityType: 'game', filePath: sourceAudio })
      ).rejects.toThrow(MediaPathError)
      expect(existsSync(join(TEST_DATA_DIR, 'pwned'))).toBe(false)
    })

    it.each(TRAVERSAL_IDS)('rejects the entity type %j', async (entityType) => {
      const game = createGame({ name: 'Fixture', setting: 'Fixture', style: 'Fixture' })
      await expect(
        storeAudio({ gameId: game.id, entityId: game.id, entityType, filePath: sourceAudio })
      ).rejects.toThrow(MediaPathError)
      expect(existsSync(join(TEST_DATA_DIR, 'pwned'))).toBe(false)
    })

    it('still stores audio under the media root for ids the engine mints', async () => {
      const game = createGame({ name: 'Fixture', setting: 'Fixture', style: 'Fixture' })
      const stored = await storeAudio({
        gameId: game.id,
        entityId: game.id,
        entityType: 'game',
        filePath: sourceAudio,
      })

      expect(stored.filePath).toBe(join(game.id, 'games', game.id, `${stored.id}.mp3`))
      expect(existsSync(join(AUDIO_DIR, stored.filePath))).toBe(true)
    })
  })

  describe('storeImage', () => {
    it.each(TRAVERSAL_IDS)('rejects the game id %j and writes nothing', async (gameId) => {
      await expect(
        storeImage({ gameId, entityId: 'entity', entityType: 'game', url: 'https://example.invalid/x.png' })
      ).rejects.toThrow(MediaPathError)

      expect(existsSync(join(TEST_DATA_DIR, 'pwned'))).toBe(false)
      expect(readFileSync(SENTINEL, 'utf8')).toBe('the data directory survives')
      expect(
        (getDatabase().prepare('SELECT COUNT(*) AS n FROM stored_images').get() as { n: number }).n
      ).toBe(0)
    })

    it('still stores images under the media root for ids the engine mints', async () => {
      const game = createGame({ name: 'Fixture', setting: 'Fixture', style: 'Fixture' })
      const stored = await storeImage({
        gameId: game.id,
        entityId: game.id,
        entityType: 'game',
        url: 'https://example.invalid/x.png',
      })

      expect(stored.filePath).toBe(join(game.id, 'games', game.id, `${stored.id}.png`))
      expect(existsSync(join(IMAGES_DIR, stored.filePath))).toBe(true)
    })
  })

  describe('the recursive delete paths', () => {
    beforeEach(() => {
      // Media that a correct call would remove, and that a rejected call
      // must leave exactly where it is.
      mkdirSync(join(AUDIO_DIR, 'realgame'), { recursive: true })
      writeFileSync(join(AUDIO_DIR, 'realgame', 'clip.mp3'), 'audio bytes')
      mkdirSync(join(IMAGES_DIR, 'realgame'), { recursive: true })
      writeFileSync(join(IMAGES_DIR, 'realgame', 'portrait.png'), 'image bytes')
    })

    it.each(TRAVERSAL_IDS)('deleteGameAudio refuses the id %j', (gameId) => {
      expect(() => deleteGameAudio(gameId)).toThrow(MediaPathError)

      expect(existsSync(SENTINEL)).toBe(true)
      expect(existsSync(join(AUDIO_DIR, 'realgame', 'clip.mp3'))).toBe(true)
    })

    it.each(TRAVERSAL_IDS)('deleteGameImages refuses the id %j', (gameId) => {
      expect(() => deleteGameImages(gameId)).toThrow(MediaPathError)

      expect(existsSync(SENTINEL)).toBe(true)
      expect(existsSync(join(IMAGES_DIR, 'realgame', 'portrait.png'))).toBe(true)
    })

    it('deleteGameAudio still removes the directory of a well-formed id', () => {
      deleteGameAudio('realgame')
      expect(existsSync(join(AUDIO_DIR, 'realgame'))).toBe(false)
      expect(existsSync(SENTINEL)).toBe(true)
    })

    it('deleteGameImages still removes the directory of a well-formed id', () => {
      deleteGameImages('realgame')
      expect(existsSync(join(IMAGES_DIR, 'realgame'))).toBe(false)
      expect(existsSync(SENTINEL)).toBe(true)
    })
  })
})
