import type { RedactCapturedBodyInput, ResolvedCaptureRedactionOptions } from './types.js'
import { truncateUtf8 } from './utils.js'

const DEFAULT_MAX_CAPTURE_REDACTION_DEPTH = 32
const defaultSensitiveFieldNames: ReadonlyArray<string> = [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'api-key',
    'apikey',
    'x-auth-token',
    'x-csrf-token',
    'x-xsrf-token',
    'x-amz-security-token',
    'password',
    'passwd',
    'passphrase',
    'secret',
    'client-secret',
    'client_secret',
    'access-token',
    'access_token',
    'refresh-token',
    'refresh_token',
    'id-token',
    'id_token',
    'token',
    'jwt',
    'credential',
    'signature',
    'session',
    'card-number',
    'credit-card',
    'cvv',
    'cvc',
    'ssn',
]
const defaultSensitiveFieldFragments: ReadonlyArray<string> = [
    'password',
    'passwd',
    'passphrase',
    'secret',
    'token',
    'api_key',
    'apikey',
    'access_key',
    'private_key',
    'client_secret',
    'refresh_token',
    'id_token',
    'jwt',
    'credential',
    'signature',
    'session',
    'cookie',
]
const textAssignmentPattern = /(["']?([a-z0-9_.-]+)["']?(?:\s*[:=]\s*["']?|%3d))(?!\/\/)((?:(?!%26)[^&\s,"'}])+)/giu
const jwtPattern = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu

const normalizeSensitiveFieldName = (name: string): string =>
    name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '_')
        .replaceAll(/^_+|_+$/g, '')

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const isSensitiveCaptureField = ({
    key,
    redaction,
}: {
    readonly key: string
    readonly redaction: ResolvedCaptureRedactionOptions
}): boolean => {
    const normalizedKey = normalizeSensitiveFieldName(key)
    const sensitiveNames = [...defaultSensitiveFieldNames, ...redaction.fieldNames].map(normalizeSensitiveFieldName)

    return (
        sensitiveNames.includes(normalizedKey) ||
        defaultSensitiveFieldFragments.some(fragment => normalizedKey.includes(fragment)) ||
        redaction.fieldPatterns.some(pattern => new RegExp(pattern.source, pattern.flags).test(key))
    )
}

export const redactSensitiveCaptureText = ({
    redaction,
    value,
}: {
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: string
}): string =>
    value
        .replaceAll(textAssignmentPattern, (match, prefix: string, key: string) =>
            isSensitiveCaptureField({ key, redaction }) ? `${prefix}${redaction.redactedValue}` : match,
        )
        .replaceAll(jwtPattern, redaction.redactedValue)

const redactCapturedJsonValue = ({
    depth,
    redaction,
    value,
}: {
    readonly depth: number
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: unknown
}): unknown => {
    if (depth >= DEFAULT_MAX_CAPTURE_REDACTION_DEPTH) {
        return redaction.redactedValue
    }

    if (Array.isArray(value)) {
        return value.map(item => redactCapturedJsonValue({ depth: depth + 1, redaction, value: item }))
    }

    if (typeof value === 'string') {
        return redactSensitiveCaptureText({ redaction, value })
    }

    if (!isRecord(value)) {
        return value
    }

    return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
            key,
            isSensitiveCaptureField({ key, redaction })
                ? redaction.redactedValue
                : redactCapturedJsonValue({ depth: depth + 1, redaction, value: item }),
        ]),
    )
}

export const redactCapturedBody = ({ maxBytes, redaction, value }: RedactCapturedBodyInput): string => {
    const redactedBody = (() => {
        try {
            return JSON.stringify(redactCapturedJsonValue({ depth: 0, redaction, value: JSON.parse(value) as unknown }))
        } catch {
            return redactSensitiveCaptureText({ redaction, value })
        }
    })()

    return truncateUtf8({ maxBytes, value: redactedBody })
}
