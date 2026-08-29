import { SpanKind, SpanStatusCode, type AttributeValue } from '@opentelemetry/api'
import {
    ATTR_DB_SYSTEM_NAME,
    ATTR_HTTP_REQUEST_METHOD,
    ATTR_HTTP_RESPONSE_STATUS_CODE,
    ATTR_HTTP_ROUTE,
    ATTR_SERVER_ADDRESS,
    ATTR_URL_FULL,
} from '@opentelemetry/semantic-conventions'
import type { CapturedSpanStatus } from '../types.js'
import { MAX_ATTRIBUTE_COUNT, MAX_ATTRIBUTE_VALUE_LENGTH, NEXT_FETCH_SPAN_TYPE, NEXT_ROOT_SERVER_SPAN_TYPE } from './constants.js'
import type {
    HrTimeRangeInput,
    MapReadableSpanInput,
    MappedNextSpan,
    ResolveSpanCategoryInput,
    ResolveSpanStatusInput,
    SerializeAttributesInput,
} from './types.js'

const LEGACY_DB_SYSTEM = 'db.system'
const LEGACY_HTTP_METHOD = 'http.method'
const LEGACY_HTTP_STATUS_CODE = 'http.status_code'
const LEGACY_HTTP_URL = 'http.url'
const MESSAGING_SYSTEM = 'messaging.system'
const NEXT_ROUTE = 'next.route'
const NEXT_SPAN_TYPE = 'next.span_type'
const PEER_SERVICE = 'peer.service'
const URL_QUERY = 'url.query'

const serializeAttributeValue = (value: AttributeValue | undefined): string => {
    if (value === undefined) {
        return ''
    }

    const serialized = Array.isArray(value) ? value.join(',') : String(value)
    return serialized.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH)
}

export const serializeAttributes = ({ attributes }: SerializeAttributesInput): Record<string, string> =>
    Object.fromEntries(
        Object.entries(attributes)
            .filter(([key]) => key !== URL_QUERY)
            .slice(0, MAX_ATTRIBUTE_COUNT)
            .map(([key, value]) => {
                const serialized = serializeAttributeValue(value)
                return [key, key === ATTR_URL_FULL || key === LEGACY_HTTP_URL ? sanitizeUrl(serialized) : serialized]
            }),
    )

const getStringAttribute = ({
    attributes,
    keys,
}: {
    readonly attributes: Readonly<Partial<Record<string, string>>>
    readonly keys: ReadonlyArray<string>
}): string => keys.map(key => attributes[key]).find(value => value !== undefined && value.length > 0) ?? ''

const getNumberAttribute = ({
    attributes,
    keys,
}: {
    readonly attributes: Readonly<Partial<Record<string, string>>>
    readonly keys: ReadonlyArray<string>
}): number => {
    const value = Number(getStringAttribute({ attributes, keys }))
    return Number.isFinite(value) ? value : 0
}

const sanitizeUrl = (value: string): string => {
    if (value.length === 0) {
        return ''
    }

    return new URL(value, 'http://localhost').pathname
}

const resolveSpanKind = (kind: SpanKind): string => {
    const kinds: Readonly<Partial<Record<number, string>>> = {
        [SpanKind.INTERNAL]: 'internal',
        [SpanKind.SERVER]: 'server',
        [SpanKind.CLIENT]: 'client',
        [SpanKind.PRODUCER]: 'producer',
        [SpanKind.CONSUMER]: 'consumer',
    }

    return kinds[kind] ?? 'internal'
}

const resolveSpanStatus = ({ httpStatusCode, span }: ResolveSpanStatusInput): CapturedSpanStatus => {
    if (span.status.code === SpanStatusCode.ERROR || httpStatusCode >= 500) {
        return 'error'
    }

    return span.status.code === SpanStatusCode.OK ? 'ok' : 'unset'
}

const resolveSpanCategory = ({ attributes, spanType }: ResolveSpanCategoryInput): string => {
    if (getStringAttribute({ attributes, keys: [ATTR_DB_SYSTEM_NAME, LEGACY_DB_SYSTEM] }).length > 0) {
        return 'database'
    }

    if (getStringAttribute({ attributes, keys: [MESSAGING_SYSTEM] }).length > 0) {
        return 'messaging'
    }

    if (getStringAttribute({ attributes, keys: [ATTR_HTTP_REQUEST_METHOD, LEGACY_HTTP_METHOD] }).length > 0) {
        return 'http'
    }

    return spanType.length > 0 ? 'nextjs' : 'internal'
}

const resolveTimeRange = ({
    duration,
    startTime,
}: HrTimeRangeInput): { readonly durationUs: number; readonly endTime: string; readonly timestamp: string } => {
    const startMilliseconds = startTime[0] * 1_000 + startTime[1] / 1_000_000
    const durationMilliseconds = duration[0] * 1_000 + duration[1] / 1_000_000

    return {
        durationUs: durationMilliseconds * 1_000,
        endTime: new Date(startMilliseconds + durationMilliseconds).toISOString(),
        timestamp: new Date(startMilliseconds).toISOString(),
    }
}

const isCollectorSpan = ({ collectorUrl, spanUrl }: { readonly collectorUrl: string; readonly spanUrl: string }): boolean => {
    if (collectorUrl.length === 0 || spanUrl.length === 0) {
        return false
    }

    return new URL(spanUrl, 'http://localhost').origin === new URL(collectorUrl, 'http://localhost').origin
}

export const mapReadableSpan = ({ captureNextFetchSpans, collectorUrl, span }: MapReadableSpanInput): MappedNextSpan | null => {
    const attributes = serializeAttributes({ attributes: span.attributes })
    const spanType = getStringAttribute({ attributes, keys: [NEXT_SPAN_TYPE] })
    const spanUrl = serializeAttributeValue(span.attributes[ATTR_URL_FULL] ?? span.attributes[LEGACY_HTTP_URL])

    if ((!captureNextFetchSpans && spanType === NEXT_FETCH_SPAN_TYPE) || isCollectorSpan({ collectorUrl, spanUrl })) {
        return null
    }

    const httpMethod = getStringAttribute({ attributes, keys: [ATTR_HTTP_REQUEST_METHOD, LEGACY_HTTP_METHOD] })
    const configuredRoute = getStringAttribute({ attributes, keys: [ATTR_HTTP_ROUTE, NEXT_ROUTE] })
    const httpRoute = configuredRoute.length > 0 ? configuredRoute : sanitizeUrl(spanUrl)
    const httpStatusCode = getNumberAttribute({ attributes, keys: [ATTR_HTTP_RESPONSE_STATUS_CODE, LEGACY_HTTP_STATUS_CODE] })
    const context = span.spanContext()
    const timeRange = resolveTimeRange({ duration: span.duration, startTime: span.startTime })

    return {
        input: {
            ...timeRange,
            attributes,
            category: resolveSpanCategory({ attributes, spanType }),
            databaseSystem: getStringAttribute({ attributes, keys: [ATTR_DB_SYSTEM_NAME, LEGACY_DB_SYSTEM] }),
            httpMethod,
            httpRoute,
            httpStatusCode,
            kind: resolveSpanKind(span.kind),
            messagingSystem: getStringAttribute({ attributes, keys: [MESSAGING_SYSTEM] }),
            name: span.name,
            parentSpanId: span.parentSpanContext?.spanId,
            peerService: getStringAttribute({ attributes, keys: [PEER_SERVICE, ATTR_SERVER_ADDRESS] }),
            resourceAttributes: serializeAttributes({ attributes: span.resource.attributes }),
            spanId: context.spanId,
            statusCode: resolveSpanStatus({ httpStatusCode, span }),
            statusMessage: span.status.message,
            traceId: context.traceId,
        },
        isRootServerSpan: spanType === NEXT_ROOT_SERVER_SPAN_TYPE,
    }
}
