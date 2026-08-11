import {
    isSensitiveCaptureField,
    MAX_CAPTURE_REDACTION_DEPTH,
    redactCapturedBody,
    redactSensitiveCaptureText,
    redactTruncatedCapturedBody,
    redactTruncatedSensitiveCaptureText,
} from './capture-redaction.js'
import type {
    BoundedUtf8Writer,
    CaptureBodyValueInput,
    CreateBoundedUtf8WriterInput,
    SerializeCapturedJsonArrayInput,
    SerializeCapturedJsonObjectInput,
    SerializeCapturedJsonValueInput,
    SerializeCapturedObjectPropertyInput,
    WriteCapturedJsonStringInput,
    WriteRedactedStringInput,
} from './internal/types.js'
import type { CapturedRequestBody } from './types.js'
import { getJsonStringByteLength, getNormalizedJsonValueByteLength, normalizeJsonValue, truncateUtf8, utf8ByteLength } from './utils.js'

const UNSERIALIZABLE_VALUE = '[unserializable]'

const createBoundedUtf8Writer = ({ maxBytes }: CreateBoundedUtf8WriterInput): BoundedUtf8Writer => {
    const state = { chunks: [] as Array<string>, stopped: maxBytes <= 0, writtenBytes: 0 }
    const append = (value: string): void => {
        if (state.stopped || value.length === 0) {
            return
        }

        const remainingBytes = maxBytes - state.writtenBytes
        const prefix = truncateUtf8({ maxBytes: remainingBytes, value })

        // Writer mutation is bounded by maxBodyBytes and avoids rebuilding an unbounded capture buffer.
        // eslint-disable-next-line functional/immutable-data
        state.chunks.push(prefix)
        // eslint-disable-next-line functional/immutable-data
        state.writtenBytes += utf8ByteLength(prefix)

        if (prefix.length < value.length || state.writtenBytes >= maxBytes) {
            // eslint-disable-next-line functional/immutable-data
            state.stopped = true
        }
    }
    const stop = (): void => {
        // Stopping output does not stop the size-only traversal of the original value.
        // eslint-disable-next-line functional/immutable-data
        state.stopped = true
    }

    return {
        append,
        get output() {
            return state.chunks.join('')
        },
        get remainingBytes() {
            return Math.max(0, maxBytes - state.writtenBytes)
        },
        stop,
        get stopped() {
            return state.stopped
        },
    }
}

const toUnicodeEscape = (codeUnit: number): string => `\\u${codeUnit.toString(16).padStart(4, '0')}`

const writeCapturedJsonString = ({ close, value, writer }: WriteCapturedJsonStringInput): void => {
    writer.append('"')

    /* eslint-disable functional/no-let, functional/no-loop-statements -- The loop stops at maxBodyBytes and avoids allocating a complete escaped copy. */
    for (let index = 0; index < value.length && !writer.stopped; index += 1) {
        const codeUnit = value.charCodeAt(index)

        // Inline branches avoid allocating a token object for every character in the captured prefix.
        if (codeUnit === 0x22) {
            writer.append('\\"')
        } else if (codeUnit === 0x5c) {
            writer.append('\\\\')
        } else if (codeUnit === 0x08) {
            writer.append('\\b')
        } else if (codeUnit === 0x09) {
            writer.append('\\t')
        } else if (codeUnit === 0x0a) {
            writer.append('\\n')
        } else if (codeUnit === 0x0c) {
            writer.append('\\f')
        } else if (codeUnit === 0x0d) {
            writer.append('\\r')
        } else if (codeUnit <= 0x1f) {
            writer.append(toUnicodeEscape(codeUnit))
        } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const nextCodeUnit = value.charCodeAt(index + 1)
            const isPair = nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff
            writer.append(isPair ? value.slice(index, index + 2) : toUnicodeEscape(codeUnit))
            index += isPair ? 1 : 0
        } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            writer.append(toUnicodeEscape(codeUnit))
        } else {
            writer.append(value[index] ?? '')
        }
    }
    /* eslint-enable functional/no-let, functional/no-loop-statements */

    if (close) {
        writer.append('"')
    }
}

const writeRedactedString = ({ redaction, value, writer }: WriteRedactedStringInput): void => {
    const prefix = truncateUtf8({ maxBytes: writer.remainingBytes, value })
    const truncated = prefix.length < value.length
    const redacted = truncated
        ? redactTruncatedSensitiveCaptureText({ redaction, value: prefix })
        : redactSensitiveCaptureText({ redaction, value: prefix })
    writeCapturedJsonString({ close: !truncated, value: redacted, writer })

    if (truncated) {
        writer.stop()
    }
}

const isUnsupportedJsonValue = (value: unknown): boolean => value === undefined || typeof value === 'function' || typeof value === 'symbol'

const serializeCapturedObjectProperty = ({
    capture,
    depth,
    property,
    redaction,
    serializedProperties,
    stack,
    value,
    writer,
}: SerializeCapturedObjectPropertyInput): number | undefined => {
    const normalizedChild = normalizeJsonValue(property, Reflect.get(value as object, property))

    if (isUnsupportedJsonValue(normalizedChild)) {
        return undefined
    }

    const childCapture = capture && !writer.stopped

    if (childCapture) {
        writer.append(serializedProperties === 0 ? '' : ',')
        writeCapturedJsonString({ close: true, value: property, writer })
        writer.append(':')
    }

    const redactChild = childCapture && isSensitiveCaptureField({ key: property, redaction })

    if (redactChild) {
        writeCapturedJsonString({ close: true, value: redaction.redactedValue, writer })
    }

    const childSize = serializeCapturedJsonValue({
        capture: childCapture && !redactChild,
        depth: depth + 1,
        redaction,
        stack,
        value: normalizedChild,
        writer,
    })

    return getJsonStringByteLength(property) + 1 + (childSize ?? 0)
}

const serializeCapturedJsonArray = ({ capture, depth, redaction, stack, value, writer }: SerializeCapturedJsonArrayInput): number => {
    if (capture) {
        writer.append('[')
    }

    /* eslint-disable functional/no-let, functional/no-loop-statements -- Size accounting must visit every item without materializing a mapped array. */
    let itemsSize = 0

    for (let index = 0; index < value.length; index += 1) {
        const normalizedItem = normalizeJsonValue(String(index), Reflect.get(value, index))
        const itemCapture = capture && !writer.stopped

        if (itemCapture && index > 0) {
            writer.append(',')
        }

        const itemSize = isUnsupportedJsonValue(normalizedItem)
            ? (() => {
                  if (itemCapture) {
                      writer.append('null')
                  }

                  return 4
              })()
            : (serializeCapturedJsonValue({ capture: itemCapture, depth: depth + 1, redaction, stack, value: normalizedItem, writer }) ?? 4)
        itemsSize += (index === 0 ? 0 : 1) + itemSize
    }
    /* eslint-enable functional/no-let, functional/no-loop-statements */

    if (capture && !writer.stopped) {
        writer.append(']')
    }

    return itemsSize + 2
}

const serializeCapturedJsonObject = ({ capture, depth, redaction, stack, value, writer }: SerializeCapturedJsonObjectInput): number => {
    if (capture) {
        writer.append('{')
    }

    /* eslint-disable functional/no-let, functional/no-loop-statements -- The key snapshot matches JSON.stringify semantics and avoids Bun retaining for-in enumeration caches per row. */
    let propertiesSize = 0
    let serializedProperties = 0

    for (const property of Object.keys(value)) {
        const propertySize = serializeCapturedObjectProperty({
            capture,
            depth,
            property,
            redaction,
            serializedProperties,
            stack,
            value,
            writer,
        })

        if (propertySize !== undefined) {
            propertiesSize += (serializedProperties === 0 ? 0 : 1) + propertySize
            serializedProperties += 1
        }
    }
    /* eslint-enable functional/no-let, functional/no-loop-statements */

    if (capture && !writer.stopped) {
        writer.append('}')
    }

    return propertiesSize + 2
}

const serializeCapturedJsonValue = ({ capture, depth, redaction, stack, value, writer }: SerializeCapturedJsonValueInput): number | undefined => {
    const redactAtDepth = capture && depth >= MAX_CAPTURE_REDACTION_DEPTH

    if (redactAtDepth) {
        writeCapturedJsonString({ close: true, value: redaction.redactedValue, writer })
    }

    if (!capture || redactAtDepth || writer.stopped) {
        return getNormalizedJsonValueByteLength(stack, value)
    }

    if (value === null) {
        writer.append('null')

        return 4
    }

    if (typeof value === 'string') {
        writeRedactedString({ redaction, value, writer })

        return getJsonStringByteLength(value)
    }

    if (typeof value === 'number') {
        const serialized = Number.isFinite(value) ? String(value) : 'null'

        writer.append(serialized)

        return serialized.length
    }

    if (typeof value === 'boolean') {
        const serialized = value ? 'true' : 'false'

        writer.append(serialized)

        return serialized.length
    }

    if (typeof value === 'bigint') {
        throw new TypeError('Do not know how to serialize a BigInt')
    }

    if (typeof value !== 'object') {
        return undefined
    }

    if (stack.includes(value)) {
        throw new TypeError('Converting circular structure to JSON')
    }

    // The LIFO ancestor stack stays O(depth); Set.delete retains large tombstone tables in Bun for wide payloads.
    // eslint-disable-next-line functional/immutable-data
    stack.push(value)

    try {
        return Array.isArray(value)
            ? serializeCapturedJsonArray({ capture: true, depth, redaction, stack, value, writer })
            : serializeCapturedJsonObject({ capture: true, depth, redaction, stack, value, writer })
    } finally {
        // eslint-disable-next-line functional/immutable-data
        stack.pop()
    }
}

export const captureBodyValue = ({ maxBodyBytes, redaction, value }: CaptureBodyValueInput): CapturedRequestBody => {
    if (value === undefined || value === null) {
        return { body: '', sizeBytes: 0 }
    }

    if (typeof value === 'string') {
        const prefix = truncateUtf8({ maxBytes: maxBodyBytes, value })
        const truncated = prefix.length < value.length

        return {
            body: truncated
                ? redactTruncatedCapturedBody({ maxBytes: maxBodyBytes, redaction, value: prefix })
                : redactCapturedBody({ maxBytes: maxBodyBytes, redaction, value: prefix }),
            sizeBytes: utf8ByteLength(value),
        }
    }

    const writer = createBoundedUtf8Writer({ maxBytes: maxBodyBytes })

    try {
        const normalized = normalizeJsonValue('', value)
        const sizeBytes = serializeCapturedJsonValue({ capture: true, depth: 0, redaction, stack: [], value: normalized, writer })

        return { body: sizeBytes === undefined ? '' : writer.output, sizeBytes: sizeBytes ?? 0 }
    } catch {
        return {
            body: truncateUtf8({ maxBytes: maxBodyBytes, value: UNSERIALIZABLE_VALUE }),
            sizeBytes: utf8ByteLength(UNSERIALIZABLE_VALUE),
        }
    }
}
