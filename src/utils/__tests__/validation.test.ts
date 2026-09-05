import { describe, it, expect } from 'vitest'
import { LIMITS, validatedSchemas, boundedString, boundedArray } from '../validation.js'
import { z } from 'zod'

describe('LIMITS', () => {
  it('should have correct values', () => {
    expect(LIMITS.NAME_MAX).toBe(200)
    expect(LIMITS.DESCRIPTION_MAX).toBe(5000)
    expect(LIMITS.CONTENT_MAX).toBe(50000)
    expect(LIMITS.NARRATIVE_MAX).toBe(200000)
    expect(LIMITS.EMBEDDED_DATA_MAX).toBe(2000000)
    expect(LIMITS.ARRAY_MAX).toBe(100)
    expect(LIMITS.MAX_DEPTH).toBe(10)
  })
})

describe('validatedSchemas', () => {
  // Load-bearing, not an implementation detail: the JSON Schema converter the
  // MCP SDK runs de-duplicates by object identity, so a SHARED instance used
  // twice inside one tool is published the second time as a `$ref` pointing at
  // the first. Handing back a fresh instance per access is what keeps a
  // declaration at every site (issue #29, and see schemaBounds.test.ts).
  describe('each access is a fresh instance', () => {
    it('never hands back the same object twice', () => {
      expect(validatedSchemas.name).not.toBe(validatedSchemas.name)
      expect(validatedSchemas.token).not.toBe(validatedSchemas.token)
      expect(validatedSchemas.stringArray).not.toBe(validatedSchemas.stringArray)
    })

    it('hands back an equivalent schema every time', () => {
      expect(validatedSchemas.token.parse('north')).toBe('north')
      expect(validatedSchemas.token.parse('north')).toBe('north')
    })
  })

  describe('token', () => {
    it('accepts an empty string -- a ceiling with no floor, unlike name', () => {
      expect(validatedSchemas.token.parse('')).toBe('')
    })

    it('rejects a string over NAME_MAX', () => {
      expect(() => validatedSchemas.token.parse('a'.repeat(LIMITS.NAME_MAX + 1))).toThrow()
    })
  })

  describe('embeddedData', () => {
    it('accepts an inline image far larger than any prose tier', () => {
      const inlineImage = 'data:image/png;base64,' + 'A'.repeat(LIMITS.NARRATIVE_MAX)
      expect(validatedSchemas.embeddedData.parse(inlineImage)).toBe(inlineImage)
    })

    it('rejects one over EMBEDDED_DATA_MAX', () => {
      expect(() =>
        validatedSchemas.embeddedData.parse('A'.repeat(LIMITS.EMBEDDED_DATA_MAX + 1))
      ).toThrow()
    })
  })

  describe('name', () => {
    it('should accept valid names', () => {
      expect(validatedSchemas.name.parse('Test Name')).toBe('Test Name')
    })

    it('should reject empty names', () => {
      expect(() => validatedSchemas.name.parse('')).toThrow()
    })

    it('should reject names exceeding max length', () => {
      const longName = 'a'.repeat(LIMITS.NAME_MAX + 1)
      expect(() => validatedSchemas.name.parse(longName)).toThrow()
    })

    it('should accept names at max length', () => {
      const maxName = 'a'.repeat(LIMITS.NAME_MAX)
      expect(validatedSchemas.name.parse(maxName)).toBe(maxName)
    })
  })

  describe('description', () => {
    it('should accept valid descriptions', () => {
      expect(validatedSchemas.description.parse('A description')).toBe('A description')
    })

    it('should accept empty descriptions', () => {
      expect(validatedSchemas.description.parse('')).toBe('')
    })

    it('should reject descriptions exceeding max length', () => {
      const longDesc = 'a'.repeat(LIMITS.DESCRIPTION_MAX + 1)
      expect(() => validatedSchemas.description.parse(longDesc)).toThrow()
    })
  })

  describe('id', () => {
    it('should accept valid UUIDs', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000'
      expect(validatedSchemas.id.parse(uuid)).toBe(uuid)
    })

    it('should reject IDs exceeding 100 characters', () => {
      const longId = 'a'.repeat(101)
      expect(() => validatedSchemas.id.parse(longId)).toThrow()
    })
  })

  describe('stringArray', () => {
    it('should accept valid arrays', () => {
      const arr = ['one', 'two', 'three']
      expect(validatedSchemas.stringArray.parse(arr)).toEqual(arr)
    })

    it('should accept empty arrays', () => {
      expect(validatedSchemas.stringArray.parse([])).toEqual([])
    })

    it('should reject arrays exceeding max items', () => {
      const longArr = Array(LIMITS.ARRAY_MAX + 1).fill('item')
      expect(() => validatedSchemas.stringArray.parse(longArr)).toThrow()
    })
  })
})

describe('boundedString', () => {
  it('should create a schema with default max length', () => {
    const schema = boundedString()
    expect(schema.parse('test')).toBe('test')
    expect(() => schema.parse('a'.repeat(LIMITS.NAME_MAX + 1))).toThrow()
  })

  it('should create a schema with custom max length', () => {
    const schema = boundedString(10)
    expect(schema.parse('test')).toBe('test')
    expect(() => schema.parse('a'.repeat(11))).toThrow()
  })
})

describe('boundedArray', () => {
  it('should create an array schema with default max items', () => {
    const schema = boundedArray(z.string())
    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b'])
    expect(() => schema.parse(Array(LIMITS.ARRAY_MAX + 1).fill('x'))).toThrow()
  })

  it('should create an array schema with custom max items', () => {
    const schema = boundedArray(z.number(), 3)
    expect(schema.parse([1, 2, 3])).toEqual([1, 2, 3])
    expect(() => schema.parse([1, 2, 3, 4])).toThrow()
  })
})
