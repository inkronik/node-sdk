import { describe, expect, test } from 'bun:test'
import { redactCapturedBody } from './capture-redaction.js'
import { resolveCaptureOptions } from './http-utils.js'

const redact = (value: string): string =>
    redactCapturedBody({
        maxBytes: 16_384,
        redaction: resolveCaptureOptions({}).redaction,
        value,
    })

describe('redactCapturedBody', () => {
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
})
