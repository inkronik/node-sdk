import { describe, expect, test } from 'bun:test'
import { safeJsonByteLength, safeJsonStringify, sortNumbers, truncateUtf8, utf8ByteLength } from './utils.js'

describe('sortNumbers', () => {
    test('sorts numerically without mutating the input', () => {
        const values = [10, -1, 2, 2, 0]

        expect(sortNumbers(values)).toEqual([-1, 0, 2, 2, 10])
        expect(values).toEqual([10, -1, 2, 2, 0])
    })
})

describe('truncateUtf8', () => {
    test.each([
        { maxBytes: 0, value: '', expected: '' },
        { maxBytes: 0, value: 'hello', expected: '' },
        { maxBytes: 5, value: 'hello', expected: 'hello' },
        { maxBytes: 4, value: 'hello', expected: 'hell' },
        { maxBytes: 4, value: 'żółć', expected: 'żó' },
        { maxBytes: 4, value: '😀x', expected: '😀' },
        { maxBytes: 3, value: '😀x', expected: '' },
        { maxBytes: 3, value: 'éx', expected: 'é' },
        { maxBytes: 2, value: 'éx', expected: 'e' },
    ])('returns a code-point-safe prefix for $value at $maxBytes bytes', ({ expected, maxBytes, value }) => {
        const result = truncateUtf8({ maxBytes, value })

        expect(result).toBe(expected)
        expect(utf8ByteLength(result)).toBeLessThanOrEqual(Math.max(0, maxBytes))
    })

    test('does not split a surrogate pair after an ASCII prefix', () => {
        expect(truncateUtf8({ maxBytes: 4, value: 'a😀' })).toBe('a')
        expect(truncateUtf8({ maxBytes: 5, value: 'a😀' })).toBe('a😀')
    })

    test('returns the original string when it fits exactly', () => {
        const value = 'Zażółć 😀'

        expect(truncateUtf8({ maxBytes: utf8ByteLength(value), value })).toBe(value)
    })
})

describe('safeJsonByteLength', () => {
    test.each([
        undefined,
        null,
        '',
        'plain text',
        true,
        42,
        Number.NaN,
        { message: 'Zażółć 😀', quote: '"', omitted: undefined },
        [1, undefined, null, '😀'],
        new Date('2026-08-11T00:00:00.000Z'),
        { toJSON: () => ({ nested: 'value' }) },
        '\ud800',
    ])('matches the safe serializer for %#', value => {
        const serialized = safeJsonStringify(value)

        expect(safeJsonByteLength(value)).toBe(utf8ByteLength(serialized))
    })

    test('uses the unserializable fallback for circular values and BigInt', () => {
        const circular: { self?: unknown } = {}
        // Test fixture intentionally creates a circular reference.
        // eslint-disable-next-line functional/immutable-data
        circular.self = circular

        expect(safeJsonByteLength(circular)).toBe(utf8ByteLength('[unserializable]'))
        expect(safeJsonByteLength(1n)).toBe(utf8ByteLength('[unserializable]'))
        expect(safeJsonByteLength(Object(1n))).toBe(utf8ByteLength('[unserializable]'))
    })
})
