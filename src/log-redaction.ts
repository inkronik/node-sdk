import { isSensitiveCaptureField, redactSensitiveCaptureText, redactTelemetryText } from './capture-redaction.js'
import type { RedactLogAttributesInput, RedactLogTextInput } from './internal/types.js'
import type { LogRedactionOptions, ResolvedLogRedactionOptions } from './types.js'

const DEFAULT_REDACTED_VALUE = '[REDACTED]'

const isJsonContainerText = (value: string): boolean => {
    const trimmedValue = value.trim()

    return (trimmedValue.startsWith('{') && trimmedValue.endsWith('}')) || (trimmedValue.startsWith('[') && trimmedValue.endsWith(']'))
}

export const resolveLogRedactionOptions = (options: LogRedactionOptions = {}): ResolvedLogRedactionOptions => ({
    enabled: options.enabled ?? true,
    fieldNames: options.fieldNames ?? [],
    fieldPatterns: options.fieldPatterns ?? [],
    redactedValue: options.redactedValue ?? DEFAULT_REDACTED_VALUE,
})

export const redactLogText = ({ redaction, value }: RedactLogTextInput): string => {
    if (!redaction.enabled) {
        return value
    }

    return isJsonContainerText(value) ? redactTelemetryText({ redaction, value }) : redactSensitiveCaptureText({ redaction, value })
}

export const redactLogAttributes = ({ attributes, redaction }: RedactLogAttributesInput): Record<string, string> => {
    if (!redaction.enabled) {
        return attributes
    }

    return Object.fromEntries(
        Object.entries(attributes).map(([key, value]) => [
            key,
            isSensitiveCaptureField({ key, redaction }) ? redaction.redactedValue : redactLogText({ redaction, value }),
        ]),
    )
}
