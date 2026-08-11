import type { RedactCapturedJsonValueInput, SensitiveCaptureFieldInput } from './internal/types.js'
import type { RedactCapturedBodyInput, RedactSerializedBodyInput, RedactTelemetryTextInput } from './types.js'
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
const defaultSensitiveFieldCandidatePattern =
    /password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|jwt|credential|signature|session|cookie|authorization|card|cvv|cvc|ssn/iu
const textAssignmentPattern = /(^|[^a-z0-9_.-])(["']?([a-z0-9_.-]+)["']?(?:\s*[:=]\s*["']?|%3d))(?!\/\/)((?:(?!%26)[^&\s,"'}])+)/giu
const jwtPattern = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu
const encodedAssignmentPattern = /%3d/iu

const normalizeSensitiveFieldName = (name: string): string =>
    name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '_')
        .replaceAll(/^_+|_+$/g, '')

const defaultSensitiveFieldNameSet = new Set(defaultSensitiveFieldNames.map(normalizeSensitiveFieldName))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const isSensitiveCaptureField = ({ key, redaction }: SensitiveCaptureFieldInput): boolean => {
    const normalizedKey = normalizeSensitiveFieldName(key)

    return (
        defaultSensitiveFieldNameSet.has(normalizedKey) ||
        redaction.fieldNames.some(name => normalizeSensitiveFieldName(name) === normalizedKey) ||
        defaultSensitiveFieldFragments.some(fragment => normalizedKey.includes(fragment)) ||
        redaction.fieldPatterns.some(pattern => new RegExp(pattern.source, pattern.flags).test(key))
    )
}

export const redactSensitiveCaptureText = ({ redaction, value }: RedactTelemetryTextInput): string => {
    const hasAssignment = value.includes('=') || value.includes(':') || encodedAssignmentPattern.test(value)
    const assignmentRedacted = hasAssignment
        ? value.replaceAll(textAssignmentPattern, (match, boundary: string, prefix: string, key: string) =>
              isSensitiveCaptureField({ key, redaction }) ? `${boundary}${prefix}${redaction.redactedValue}` : match,
          )
        : value

    return assignmentRedacted.includes('eyJ') ? assignmentRedacted.replaceAll(jwtPattern, redaction.redactedValue) : assignmentRedacted
}

const redactCapturedJsonValue = ({ depth, redaction, value }: RedactCapturedJsonValueInput): unknown => {
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

const hasDeepJsonStructure = (value: string): boolean => {
    /* eslint-disable functional/no-let, functional/no-loop-statements -- Streaming syntax inspection avoids parsing and copying a large body. */
    let depth = 0
    let escaped = false
    let inString = false

    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index)
        const wasEscaped = escaped

        if (wasEscaped) {
            escaped = false
        }

        const beginsEscape = !wasEscaped && codeUnit === 0x5c && inString

        if (beginsEscape) {
            escaped = true
        }

        const togglesString = !wasEscaped && !beginsEscape && codeUnit === 0x22

        if (togglesString) {
            inString = !inString
        }

        const isStructuralCharacter = !wasEscaped && !beginsEscape && !togglesString && !inString
        const opensContainer = isStructuralCharacter && (codeUnit === 0x7b || codeUnit === 0x5b)

        if (opensContainer) {
            depth += 1

            if (depth >= DEFAULT_MAX_CAPTURE_REDACTION_DEPTH) {
                return true
            }
        }

        const closesContainer = isStructuralCharacter && (codeUnit === 0x7d || codeUnit === 0x5d)

        if (closesContainer) {
            depth -= 1
        }
    }
    /* eslint-enable functional/no-let, functional/no-loop-statements */

    return false
}

export const redactTelemetryText = ({ redaction, value }: RedactTelemetryTextInput): string => {
    try {
        return JSON.stringify(redactCapturedJsonValue({ depth: 0, redaction, value: JSON.parse(value) as unknown }))
    } catch {
        return redactSensitiveCaptureText({ redaction, value })
    }
}

export const redactCapturedBody = ({ maxBytes, redaction, value }: RedactCapturedBodyInput): string =>
    truncateUtf8({ maxBytes, value: redactTelemetryText({ redaction, value }) })

export const redactSerializedBody = ({ maxBytes, preserveRawStringSemantics, redaction, value }: RedactSerializedBodyInput): string => {
    if (preserveRawStringSemantics) {
        return redactCapturedBody({ maxBytes, redaction, value })
    }

    const requiresStructuredRedaction =
        hasDeepJsonStructure(value) ||
        defaultSensitiveFieldCandidatePattern.test(value) ||
        value.includes('eyJ') ||
        redaction.fieldNames.length > 0 ||
        redaction.fieldPatterns.length > 0

    if (requiresStructuredRedaction) {
        return redactCapturedBody({ maxBytes, redaction, value })
    }

    return truncateUtf8({ maxBytes, value })
}
