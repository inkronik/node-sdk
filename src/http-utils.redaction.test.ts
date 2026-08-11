import { describe, expect, mock, test } from 'bun:test'
import { redactCapturedBody, redactSensitiveCaptureText, redactSerializedBody } from './capture-redaction.js'
import { appendBodyChunk, getCapturedRequestBody, getHttpBodySample, resolveCaptureOptions } from './http-utils.js'
import { safeJsonStringify, utf8ByteLength } from './utils.js'

const redact = (value: string): string =>
    redactCapturedBody({
        maxBytes: 16_384,
        redaction: resolveCaptureOptions({}).redaction,
        value,
    })

describe('redactCapturedBody', () => {
    test('handles large plain strings in linear time without changing them', () => {
        const value = 'x'.repeat(1_000_000)
        const redaction = resolveCaptureOptions({}).redaction
        const startedAt = performance.now()

        expect(redactSensitiveCaptureText({ redaction, value })).toBe(value)
        expect(performance.now() - startedAt).toBeLessThan(100)
    })

    test('redacts prefixed token parameters inside nested JSON strings', () => {
        const result = redact(
            JSON.stringify({
                appLink: 'https://service.example/auth/set-password?setPasswordToken=opaque-reset-value&source=invitation',
            }),
        )

        expect(JSON.parse(result)).toEqual({
            appLink: 'https://service.example/auth/set-password?setPasswordToken=[REDACTED]&source=invitation',
        })
    })

    test('redacts encoded assignments without removing later encoded parameters', () => {
        expect(redact('setPasswordToken%3Dopaque-reset-value%26source%3Dinvitation')).toBe('setPasswordToken%3D[REDACTED]%26source%3Dinvitation')
    })

    test('redacts JWT-like values under non-sensitive field names', () => {
        expect(redact('{"value":"eyJhbGciOiJIUzI1NiJ9.payload.signature"}')).toBe('{"value":"[REDACTED]"}')
    })

    test('redacts JWT-like values embedded in other text', () => {
        expect(redact('prefixeyJhbGciOiJIUzI1NiJ9.payload.signatureSuffix')).toBe('prefix[REDACTED]')
    })

    test('applies configured field names and patterns to raw JSON bodies', () => {
        const redaction = resolveCaptureOptions({
            redaction: {
                fieldNames: ['operatorCode'],
                fieldPatterns: [/^partnerCredential$/u],
                redactedValue: '***',
            },
        }).redaction
        const result = redactCapturedBody({
            maxBytes: 16_384,
            redaction,
            value: JSON.stringify({ operatorCode: 'code-value', partnerCredential: 123, safe: 'visible' }),
        })

        expect(JSON.parse(result)).toEqual({ operatorCode: '***', partnerCredential: '***', safe: 'visible' })
    })

    test('preserves depth-limit redaction on the optimized serialized-body path', () => {
        const redaction = resolveCaptureOptions({}).redaction
        const value = Array.from({ length: 32 }).reduce<unknown>(nested => ({ nested }), 'visible')
        const serialized = JSON.stringify(value)

        expect(redactSerializedBody({ maxBytes: 16_384, preserveRawStringSemantics: false, redaction, value: serialized })).toBe(
            redactCapturedBody({ maxBytes: 16_384, redaction, value: serialized }),
        )
    })

    test('preserves parse-and-normalize behavior for raw string bodies', () => {
        const redaction = resolveCaptureOptions({}).redaction
        const value = ' { "safe": true } '

        expect(redactSerializedBody({ maxBytes: 16_384, preserveRawStringSemantics: true, redaction, value })).toBe('{"safe":true}')
    })

    test('redacts sensitive assignments nested inside an otherwise safe request field', () => {
        const redaction = resolveCaptureOptions({}).redaction
        const captured = getCapturedRequestBody({
            maxBodyBytes: 16_384,
            redaction,
            request: { body: { appLink: 'https://service.example/reset?setPasswordToken=opaque-value&source=invite' } },
        })

        expect(JSON.parse(captured.body)).toEqual({
            appLink: 'https://service.example/reset?setPasswordToken=[REDACTED]&source=invite',
        })
    })
})

describe('appendBodyChunk', () => {
    test('retains a bounded string prefix without splitting code points', () => {
        expect(appendBodyChunk({ chunk: '😀x', maxBytes: 4, value: '' })).toBe('😀')
        expect(appendBodyChunk({ chunk: '😀', maxBytes: 4, value: 'a' })).toBe('a')
    })

    test('drops an incomplete trailing UTF-8 byte sequence', () => {
        const emoji = new TextEncoder().encode('😀')

        expect(appendBodyChunk({ chunk: emoji, maxBytes: 3, value: '' })).toBe('')
        expect(appendBodyChunk({ chunk: emoji, maxBytes: 4, value: '' })).toBe('😀')
    })
})

describe('getCapturedRequestBody', () => {
    test('preserves structured redaction and JSON serialization semantics for bounded bodies', () => {
        const redaction = resolveCaptureOptions({}).redaction
        const value = {
            accessToken: 'opaque-token',
            createdAt: new Date('2026-08-11T00:00:00.000Z'),
            omitted: undefined,
            values: [1, undefined, 'quote"', '\ud800'],
            nested: { appLink: 'https://service.example/reset?setPasswordToken=opaque-value&source=invite' },
        }
        const serialized = safeJsonStringify(value)
        const captured = getCapturedRequestBody({ maxBodyBytes: 16_384, redaction, request: { body: value } })

        expect(captured.body).toBe(redactCapturedBody({ maxBytes: 16_384, redaction, value: serialized }))
        expect(captured.sizeBytes).toBe(utf8ByteLength(serialized))
    })

    test('redacts a large sensitive value without expanding the captured output', () => {
        const redaction = resolveCaptureOptions({}).redaction
        const accessToken = 'x'.repeat(1_000_000)
        const captured = getCapturedRequestBody({
            maxBodyBytes: 1024,
            redaction,
            request: { body: { accessToken, safe: 'visible' } },
        })

        expect(captured.body).toBe('{"accessToken":"[REDACTED]","safe":"visible"}')
        expect(captured.body).not.toContain(accessToken.slice(0, 32))
        expect(captured.sizeBytes).toBe(1_000_035)
    })

    test('keeps large captured prefixes bounded and UTF-8 safe', () => {
        const captured = getCapturedRequestBody({
            maxBodyBytes: 101,
            redaction: resolveCaptureOptions({}).redaction,
            request: { body: { payload: '😀'.repeat(10_000) } },
        })

        expect(utf8ByteLength(captured.body)).toBeLessThanOrEqual(101)
        expect(captured.body).not.toContain('\uFFFD')
        expect(captured.sizeBytes).toBe(40_014)
    })

    test('redacts a JWT crossing a small structured capture boundary', () => {
        const captured = getCapturedRequestBody({
            maxBodyBytes: 32,
            redaction: resolveCaptureOptions({}).redaction,
            request: { body: { message: 'aaaaeyJheader.payload.signature' } },
        })

        expect(captured.body).toContain('[REDACTED]')
        expect(captured.body).not.toContain('eyJ')
    })

    test('redacts a JWT crossing the default structured capture boundary', () => {
        const captured = getCapturedRequestBody({
            maxBodyBytes: 16_384,
            redaction: resolveCaptureOptions({}).redaction,
            request: { body: { payload: `${'a'.repeat(16_360)}eyJheader.payload.signature` } },
        })

        expect(utf8ByteLength(captured.body)).toBeLessThanOrEqual(16_384)
        expect(captured.body).toContain('[REDACTED]')
        expect(captured.body).not.toContain('eyJ')
    })

    test('redacts a JWT crossing a raw string capture boundary', () => {
        const captured = getCapturedRequestBody({
            maxBodyBytes: 18,
            redaction: resolveCaptureOptions({}).redaction,
            request: { body: 'aaaaeyJheader.payload.signature' },
        })

        expect(captured.body).toBe('aaaa[REDACTED]')
        expect(captured.sizeBytes).toBe(31)
    })

    test('redacts a sensitive value from a truncated raw JSON body', () => {
        const value = `{"accessToken":"${'x'.repeat(1_000_000)}","safe":true}`
        const captured = getCapturedRequestBody({
            maxBodyBytes: 1024,
            redaction: resolveCaptureOptions({}).redaction,
            request: { body: value },
        })

        expect(utf8ByteLength(captured.body)).toBeLessThanOrEqual(1024)
        expect(captured.body).toContain('[REDACTED]')
        expect(captured.body).not.toContain('x'.repeat(32))
        expect(captured.sizeBytes).toBe(1_000_030)
    })

    test('preserves raw string normalization and unserializable fallback behavior', () => {
        const redaction = resolveCaptureOptions({}).redaction
        const circular: { self?: unknown } = {}
        // Test fixture intentionally creates a circular reference.
        // eslint-disable-next-line functional/immutable-data
        circular.self = circular

        expect(getCapturedRequestBody({ maxBodyBytes: 16_384, redaction, request: { body: ' { "safe": true } ' } })).toEqual({
            body: '{"safe":true}',
            sizeBytes: 18,
        })
        expect(getCapturedRequestBody({ maxBodyBytes: 16_384, redaction, request: { body: circular } })).toEqual({
            body: '[unserializable]',
            sizeBytes: 16,
        })
    })
})

describe('getHttpBodySample', () => {
    test('reads only the bounded object-field prefix', () => {
        const readField = mock((index: number) => index)
        const descriptors = Object.fromEntries(
            Array.from({ length: 100 }, (_, index) => [
                `field_${index}`,
                {
                    configurable: true,
                    enumerable: true,
                    get: () => readField(index),
                },
            ]),
        )
        const value = Object.defineProperties({}, descriptors)
        const sample = getHttpBodySample({ depth: 0, redaction: resolveCaptureOptions({}).redaction, value })

        expect(Object.keys(sample as object)).toHaveLength(64)
        expect(readField).toHaveBeenCalledTimes(64)
    })
})
