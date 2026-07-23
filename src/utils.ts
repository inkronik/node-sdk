import { randomBytes, randomUUID } from 'node:crypto'

const textEncoder = new TextEncoder()

export const nowIso = (): string => new Date().toISOString()

export const createUuid = (): string => randomUUID()

export const createTraceId = (): string => randomBytes(16).toString('hex')

export const createSpanId = (): string => randomBytes(8).toString('hex')

export const normalizeCollectorUrl = (collectorUrl: string): string => collectorUrl.replaceAll(/\/+$/g, '')

export const toStringMap = (value: Record<string, unknown> | undefined): Record<string, string> =>
    Object.fromEntries(
        Object.entries(value ?? {})
            .filter((entry): entry is [string, Exclude<unknown, undefined | null>] => entry[1] !== undefined && entry[1] !== null)
            .map(([key, item]) => [key, Array.isArray(item) ? item.join(',') : String(item)]),
    )

export const utf8ByteLength = (value: string): number => textEncoder.encode(value).length

export const sortNumbers = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
    values.reduce<ReadonlyArray<number>>(
        (sorted, value) => [...sorted.filter(item => item <= value), value, ...sorted.filter(item => item > value)],
        [],
    )

export const safeJsonStringify = (value: unknown): string => {
    if (value === undefined || value === null) {
        return ''
    }

    if (typeof value === 'string') {
        return value
    }

    try {
        return JSON.stringify(value)
    } catch {
        return '[unserializable]'
    }
}

export const truncateUtf8 = ({ maxBytes, value }: { readonly maxBytes: number; readonly value: string }): string => {
    if (utf8ByteLength(value) <= maxBytes) {
        return value
    }

    return Array.from(value).reduce(
        (accumulator, character) => {
            if (accumulator.done) {
                return accumulator
            }

            const characterBytes = textEncoder.encode(character).length

            if (accumulator.bytes + characterBytes > maxBytes) {
                return { ...accumulator, done: true }
            }

            return {
                bytes: accumulator.bytes + characterBytes,
                done: false,
                value: `${accumulator.value}${character}`,
            }
        },
        { bytes: 0, done: false, value: '' },
    ).value
}

export const mergeAttributes = ({
    defaults,
    overrides,
}: {
    readonly defaults: Record<string, string>
    readonly overrides?: Record<string, string>
}): Record<string, string> => ({
    ...defaults,
    ...(overrides ?? {}),
})
