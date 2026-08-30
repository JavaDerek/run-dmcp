import { describe, it, expect } from 'vitest'
import { join, resolve, sep } from 'path'
import { mediaDirPath, mediaFilePath, mediaPathWithin, MediaPathError } from '../media-path.js'

// The media root these tests compose against. Nothing here touches the disk --
// path composition is pure, which is the point of having a choke point at all.
const ROOT = resolve('/data/dmcp/audio')

// Every value below escapes, or tries to, when handed to `join()` unchecked.
// `join(ROOT, '..', 'x')` is not a hypothetical: it is what the unguarded
// call sites did with a caller-supplied id.
const TRAVERSALS = [
  '..',
  '../escape',
  '../../etc',
  'a/../../b',
  'nested/child',
  '/absolute',
  '/etc/passwd',
  '.',
  './here',
  '',
  'has space',
  'semi;colon',
  'tilde~',
  'null\0byte',
]

describe('mediaFilePath', () => {
  it('composes a relative path and a full path from safe segments', () => {
    const { relativePath, fullPath } = mediaFilePath(
      ROOT,
      ['3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'characters', 'c8f1a2b3'],
      '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d.mp3'
    )

    expect(relativePath).toBe(
      join('3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'characters', 'c8f1a2b3', '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d.mp3')
    )
    expect(fullPath).toBe(join(ROOT, relativePath))
  })

  it.each(TRAVERSALS)('rejects %j as a path segment', (segment) => {
    expect(() => mediaFilePath(ROOT, [segment, 'characters', 'entity'], 'file.mp3')).toThrow(MediaPathError)
    expect(() => mediaFilePath(ROOT, ['game', segment, 'entity'], 'file.mp3')).toThrow(MediaPathError)
    expect(() => mediaFilePath(ROOT, ['game', 'characters', segment], 'file.mp3')).toThrow(MediaPathError)
  })

  it.each(['../escape.mp3', 'nested/file.mp3', '/absolute.mp3', '..', 'no-extension', 'two dots.tar.gz'])(
    'rejects %j as a filename',
    (filename) => {
      expect(() => mediaFilePath(ROOT, ['game', 'characters', 'entity'], filename)).toThrow(MediaPathError)
    }
  )

  it('rejects rather than normalising: a segment that would resolve back inside the root is still refused', () => {
    // `resolve(ROOT, 'a/../b')` is ROOT/b -- inside the root, and therefore
    // invisible to a containment check alone. Normalising it would silently
    // rewrite the caller's id into a different one, so it is rejected.
    expect(() => mediaFilePath(ROOT, ['a/../b', 'characters', 'entity'], 'file.mp3')).toThrow(MediaPathError)
  })

  it('names the offending value in the error', () => {
    expect(() => mediaFilePath(ROOT, ['../escape', 'characters', 'entity'], 'file.mp3')).toThrow(/\.\.\/escape/)
  })
})

describe('mediaDirPath', () => {
  it('composes a directory under the root from safe segments', () => {
    expect(mediaDirPath(ROOT, ['3f2504e0-4f89-11d3-9a0c-0305e82c3301'])).toBe(
      join(ROOT, '3f2504e0-4f89-11d3-9a0c-0305e82c3301')
    )
  })

  it.each(TRAVERSALS)('rejects %j -- this path is handed to a recursive delete', (segment) => {
    expect(() => mediaDirPath(ROOT, [segment])).toThrow(MediaPathError)
  })

  it('rejects an empty segment list, which would resolve to the media root itself', () => {
    expect(() => mediaDirPath(ROOT, [])).toThrow(MediaPathError)
  })
})

describe('mediaPathWithin', () => {
  it('resolves a stored relative path against the root', () => {
    const stored = join('game', 'characters', 'entity', 'file.mp3')
    expect(mediaPathWithin(ROOT, stored)).toBe(join(ROOT, stored))
  })

  it.each(['../escape.mp3', '../../etc/passwd', 'game/../../escape.mp3', '/etc/passwd', '', '.', '..'])(
    'rejects the stored path %j',
    (stored) => {
      expect(() => mediaPathWithin(ROOT, stored)).toThrow(MediaPathError)
    }
  )

  it('rejects a path resolving to the root itself', () => {
    expect(() => mediaPathWithin(ROOT, 'game/..')).toThrow(MediaPathError)
  })

  it('rejects a sibling directory sharing the root as a string prefix', () => {
    // `${ROOT}-evil` starts with ROOT as a string but is not under it: the
    // containment check compares path segments, not string prefixes.
    expect(() => mediaPathWithin(ROOT, `..${sep}audio-evil${sep}file.mp3`)).toThrow(MediaPathError)
  })
})
