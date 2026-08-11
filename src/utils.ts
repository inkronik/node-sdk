import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import type { ErrorPropertyInput, MergeAttributesInput, TruncateUtf8Input } from './internal/types.js'
import type { CapturedError, EventUserContext } from './types.js'

const MAX_ERROR_TYPE_LENGTH = 255
const MAX_ERROR_MESSAGE_LENGTH = 4096
const MAX_ERROR_STACK_LENGTH = 16_384
const MAX_ERROR_CODE_LENGTH = 255

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

const safeString = (value: unknown): string => {
    try {
        return String(value)
    } catch {
        return '[unserializable thrown value]'
    }
}

export const getJsonStringByteLength = (value: string): number => {
    /* eslint-disable functional/no-let, functional/no-loop-statements -- Exact byte counting must stay O(1) in auxiliary memory. */
    let bytes = 2

    // Counting code units mirrors JSON.stringify's escaping rules without constructing an escaped copy.
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index)

        // This branch chain is intentionally inline: extracting it into a helper regressed large-body
        // byte counting by roughly 20% in the memory benchmark.
        if (
            codeUnit === 0x22 ||
            codeUnit === 0x5c ||
            codeUnit === 0x08 ||
            codeUnit === 0x09 ||
            codeUnit === 0x0a ||
            codeUnit === 0x0c ||
            codeUnit === 0x0d
        ) {
            bytes += 2
        } else if (
            codeUnit <= 0x1f ||
            (codeUnit >= 0xd800 &&
                codeUnit <= 0xdfff &&
                !(codeUnit <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff))
        ) {
            bytes += 6
        } else if (codeUnit <= 0x7f) {
            bytes += 1
        } else if (codeUnit <= 0x7ff) {
            bytes += 2
        } else if (codeUnit <= 0xdbff) {
            bytes += 4
            index += 1
        } else {
            bytes += 3
        }
    }
    /* eslint-enable functional/no-let, functional/no-loop-statements */

    return bytes
}

export const normalizeJsonValue = (key: string, value: unknown): unknown => {
    if ((typeof value === 'object' && value !== null) || typeof value === 'bigint') {
        const toJson = Reflect.get(Object(value), 'toJSON') as unknown

        if (typeof toJson === 'function') {
            return Reflect.apply(toJson, value, [key]) as unknown
        }
    }

    if (value instanceof Number || value instanceof String || value instanceof Boolean) {
        return value.valueOf()
    }

    if (typeof value === 'object' && value !== null && Object.prototype.toString.call(value) === '[object BigInt]') {
        return BigInt.prototype.valueOf.call(value)
    }

    return value
}

export const getNormalizedJsonValueByteLength = (stack: Array<object>, value: unknown): number | undefined => {
    if (value === null) {
        return 4
    }

    if (typeof value === 'string') {
        return getJsonStringByteLength(value)
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value).length : 4
    }

    if (typeof value === 'boolean') {
        return value ? 4 : 5
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

    /* eslint-disable functional/immutable-data, functional/no-let, functional/no-loop-statements -- A LIFO ancestor stack stays O(depth); Set.delete retains large tombstone tables in Bun for wide payloads. */
    stack.push(value)

    try {
        if (Array.isArray(value)) {
            let itemsSize = 0

            for (let index = 0; index < value.length; index += 1) {
                const itemSize = getJsonValueByteLength(String(index), stack, Reflect.get(value, index))
                itemsSize += (index === 0 ? 0 : 1) + (itemSize ?? 4)
            }

            return itemsSize + 2
        }

        let propertiesSize = 0
        let serializedProperties = 0

        for (const property of Object.keys(value)) {
            const itemSize = getJsonValueByteLength(property, stack, Reflect.get(value, property))

            if (itemSize !== undefined) {
                propertiesSize += (serializedProperties === 0 ? 0 : 1) + getJsonStringByteLength(property) + 1 + itemSize
                serializedProperties += 1
            }
        }

        return propertiesSize + 2
    } finally {
        stack.pop()
        /* eslint-enable functional/immutable-data, functional/no-let, functional/no-loop-statements */
    }
}

export const getJsonValueByteLength = (key: string, stack: Array<object>, value: unknown): number | undefined =>
    getNormalizedJsonValueByteLength(stack, normalizeJsonValue(key, value))

const errorProperty = ({ error, property }: ErrorPropertyInput): string => {
    if (!isRecord(error)) {
        return ''
    }

    const value = (() => {
        try {
            return Reflect.get(error, property) as unknown
        } catch {
            return undefined
        }
    })()

    return typeof value === 'string' || typeof value === 'number' ? safeString(value) : ''
}

export const nowIso = (): string => new Date().toISOString()

export const createUuid = (): string => randomUUID()

export const createTraceId = (): string => randomBytes(16).toString('hex')

export const createSpanId = (): string => randomBytes(8).toString('hex')

export const normalizeCapturedError = (error: unknown): CapturedError => {
    const capturedType = errorProperty({ error, property: 'name' })
    const capturedMessage = errorProperty({ error, property: 'message' })
    const errorType = capturedType === '' ? (error instanceof Error ? 'Error' : 'NonError') : capturedType
    const errorMessage = capturedMessage === '' ? safeString(error) : capturedMessage
    const errorStack = errorProperty({ error, property: 'stack' })

    return {
        type: errorType.slice(0, MAX_ERROR_TYPE_LENGTH),
        message: errorMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH),
        stack: errorStack.slice(0, MAX_ERROR_STACK_LENGTH),
        code: errorProperty({ error, property: 'code' }).slice(0, MAX_ERROR_CODE_LENGTH),
        handled: true,
    }
}

export const getUserEventAttributes = (user: EventUserContext | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(user?.attributes ?? {}).map(([key, value]) => [`user.${key}`, value]))

export const normalizeCollectorUrl = (collectorUrl: string): string => collectorUrl.replaceAll(/\/+$/g, '')

export const toStringMap = (value: Record<string, unknown> | undefined): Record<string, string> =>
    Object.fromEntries(
        Object.entries(value ?? {})
            .filter((entry): entry is [string, Exclude<unknown, undefined | null>] => entry[1] !== undefined && entry[1] !== null)
            .map(([key, item]) => [key, Array.isArray(item) ? item.join(',') : String(item)]),
    )

export const utf8ByteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

export const sortNumbers = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
    // Sorting a copy preserves caller immutability while avoiding the previous quadratic insertion algorithm.
    [...values].sort((left, right) => left - right)

export const safeJsonStringify = (value: unknown): string => {
    if (value === undefined || value === null) {
        return ''
    }

    if (typeof value === 'string') {
        return value
    }

    try {
        const serialized = JSON.stringify(value) as string | undefined

        return serialized ?? ''
    } catch {
        return '[unserializable]'
    }
}

export const safeJsonByteLength = (value: unknown): number => {
    if (value === undefined || value === null) {
        return 0
    }

    if (typeof value === 'string') {
        return utf8ByteLength(value)
    }

    try {
        return getJsonValueByteLength('', [], value) ?? 0
    } catch {
        return utf8ByteLength('[unserializable]')
    }
}

export const truncateUtf8 = ({ maxBytes, value }: TruncateUtf8Input): string => {
    if (maxBytes <= 0 || value.length === 0) {
        return ''
    }

    /* eslint-disable functional/no-let, functional/no-loop-statements -- The bounded hot path must stop without allocating per-character state. */
    let bytes = 0
    let codeUnits = 0

    // Iteration by code point keeps surrogate pairs intact. The mutation is intentional here: this hot path
    // must stop at the byte boundary without allocating an array or intermediate encoded buffers.
    for (const character of value) {
        const characterBytes = utf8ByteLength(character)

        if (bytes + characterBytes > maxBytes) {
            return value.slice(0, codeUnits)
        }

        bytes += characterBytes
        codeUnits += character.length
    }
    /* eslint-enable functional/no-let, functional/no-loop-statements */

    return value
}

export const mergeAttributes = ({ defaults, overrides }: MergeAttributesInput): Record<string, string> => ({
    ...defaults,
    ...(overrides ?? {}),
})
