import type {
    BuildCaptureContextInput,
    GetBoundedObjectEntriesInput,
    GetCompleteUtf8PrefixInput,
    GetHttpBodySampleInput,
    GetHttpHeaderValueInput,
    GetRequestRouteInput,
    GetResponseTypeHeadersInput,
    GetSerializedHttpBodySampleInput,
    HasHeaderValueInput,
    MergeObjectSamplesInput,
    ResolveCapturedResponseHeadersInput,
    ResponseBodyTypeHeadersInput,
    SanitizeSampleStringInput,
} from './internal/types.js'
import type {
    AppendBodyChunkInput,
    BuildRequestTelemetryContextInput,
    CaptureRequestResponseOptions,
    CapturedRequestBody,
    HttpBodySample,
    HttpBodySampleEntry,
    HttpCaptureContext,
    HttpLikeRequest,
    HttpLikeResponse,
    HttpRequestInstrumentationState,
    HttpRequestKind,
    InstrumentedFetchOptions,
    NodeHttpInstrumentationOptions,
    GetRequestBodyInput,
    ResolvedCaptureRequestResponseOptions,
    ResolveHttpMessageSizeInput,
} from './types.js'
import { createRootTraceContext, parseTraceparent } from './trace-context.js'
import { isSensitiveCaptureField, redactSensitiveCaptureText } from './capture-redaction.js'
import { captureBodyValue } from './capture-serializer.js'
import { resolveGraphqlCaptureOptions } from './graphql/extractor.js'
import { safeJsonByteLength, toStringMap, truncateUtf8, utf8ByteLength } from './utils.js'

const DEFAULT_MAX_BODY_BYTES = 16_384
const DEFAULT_MAX_BODY_SAMPLE_DEPTH = 5
const DEFAULT_MAX_BODY_SAMPLE_KEYS = 64
const DEFAULT_MAX_BODY_SAMPLE_STRING_LENGTH = 10
const DEFAULT_REDACTED_VALUE = '[REDACTED]'
const TEXT_EVENT_STREAM = 'text/event-stream'
const RESPONSE_BODY_MODE_HEADER = 'inkronik-response-body-mode'
const RESPONSE_BODY_TYPE_HEADER = 'inkronik-response-body-type'
const INKRONIK_HTTP_REQUEST_STATE = Symbol.for('@inkronik/node-sdk.http-request-state.v1')
const UUID_ROUTE_SEGMENT_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u
const NUMERIC_ROUTE_SEGMENT_PATTERN = /^[0-9]+$/u
const defaultRequestUserContainers: ReadonlyArray<'currentAccount' | 'user'> = ['user', 'currentAccount']
const defaultRequestUserIdFields: ReadonlyArray<string> = ['uuid', 'id', 'userId', 'user_id', 'sub', 'accountId', 'account_id']

const stripUrlSuffix = (url: string): string => url.split(/[?#]/u)[0] ?? ''

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const toUserId = (value: unknown): string => {
    if (typeof value === 'string') {
        return value
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value)
    }

    return ''
}

const getUserContextId = (value: unknown): string => {
    const directUserId = toUserId(value)

    if (directUserId.length > 0) {
        return directUserId
    }

    if (!isRecord(value)) {
        return ''
    }

    return defaultRequestUserIdFields.map(field => toUserId(value[field])).find(userId => userId.length > 0) ?? ''
}

const normalizeRouteSegment = (segment: string): string =>
    UUID_ROUTE_SEGMENT_PATTERN.test(segment) || NUMERIC_ROUTE_SEGMENT_PATTERN.test(segment) ? ':id' : segment

export const normalizeHttpRoute = (route: string): string => stripUrlSuffix(route).split('/').map(normalizeRouteSegment).join('/')

export const getRequestMethod = (request: HttpLikeRequest): string => (request.method ?? 'GET').toUpperCase()

export const getRequestUrl = (request: HttpLikeRequest): string => request.originalUrl ?? request.url ?? ''

export const getRequestRoute = ({ request, url }: GetRequestRouteInput): string => normalizeHttpRoute(request.route?.path ?? url)

export const getRequestHeaders = (request: HttpLikeRequest): Record<string, string> => toStringMap(request.headers)

const getHttpRequestInstrumentationState = (request: HttpLikeRequest): HttpRequestInstrumentationState | undefined => {
    const state = Reflect.get(request, INKRONIK_HTTP_REQUEST_STATE) as unknown

    if (typeof state !== 'object' || state === null || !('traceContext' in state) || !('captured' in state)) {
        return undefined
    }

    return state as HttpRequestInstrumentationState
}

const createHttpRequestInstrumentationState = (request: HttpLikeRequest): HttpRequestInstrumentationState => {
    const state: HttpRequestInstrumentationState = {
        captured: false,
        traceContext: parseTraceparent(getRequestHeaders(request).traceparent) ?? createRootTraceContext(),
    }

    try {
        // The request object is the shared lifecycle boundary between early HTTP middleware and framework adapters.
        // eslint-disable-next-line functional/immutable-data
        Object.defineProperty(request, INKRONIK_HTTP_REQUEST_STATE, {
            configurable: true,
            enumerable: false,
            value: state,
            writable: false,
        })
    } catch {
        return state
    }

    return state
}

const getOrCreateHttpRequestInstrumentationState = (request: HttpLikeRequest): HttpRequestInstrumentationState =>
    getHttpRequestInstrumentationState(request) ?? createHttpRequestInstrumentationState(request)

export const getRequestTraceContext = (request: HttpLikeRequest) => getOrCreateHttpRequestInstrumentationState(request).traceContext

export const hasCapturedHttpExchange = (request: HttpLikeRequest): boolean => getHttpRequestInstrumentationState(request)?.captured === true

export const markHttpExchangeCaptured = (request: HttpLikeRequest): void => {
    const state = getOrCreateHttpRequestInstrumentationState(request)

    // Request-scoped instrumentation state coordinates independently bundled framework adapters.
    // eslint-disable-next-line functional/immutable-data
    state.captured = true
}

export const getRequestQuery = (request: HttpLikeRequest): Record<string, string> => toStringMap(request.query)

export const getResponseHeaders = (response: HttpLikeResponse): Record<string, string> => toStringMap(response.getHeaders?.())

export const getRequestUserId = (request: HttpLikeRequest): string =>
    defaultRequestUserContainers.map(container => getUserContextId(request[container])).find(userId => userId.length > 0) ?? ''

export const getHttpHeaderValue = ({ headers, name }: GetHttpHeaderValueInput): string =>
    Object.entries(headers).find(([headerName]) => headerName.toLowerCase() === name.toLowerCase())?.[1] ?? ''

const withResponseBodyTypeHeader = ({ bodyMode, headers, responseBodyType }: ResponseBodyTypeHeadersInput): Record<string, string> => ({
    ...headers,
    ...(bodyMode === 'none' ? {} : { [RESPONSE_BODY_MODE_HEADER]: bodyMode }),
    ...(responseBodyType === '' ? {} : { [RESPONSE_BODY_TYPE_HEADER]: responseBodyType }),
})

export const getResponseTypeHeaders = ({ headers, responseBodyType }: GetResponseTypeHeadersInput): Record<string, string> => {
    const contentType = getHttpHeaderValue({ headers, name: 'content-type' })

    return {
        ...(contentType.length === 0 ? {} : { 'content-type': contentType }),
        ...(responseBodyType === '' ? {} : { [RESPONSE_BODY_TYPE_HEADER]: responseBodyType }),
    }
}

export const isErrorStatusCode = (statusCode: number): boolean => statusCode >= 400

export const resolveCapturedResponseHeaders = ({
    bodyMode,
    headers,
    responseBodyType,
    shouldCaptureRawResponse,
}: ResolveCapturedResponseHeadersInput): Record<string, string> =>
    shouldCaptureRawResponse
        ? withResponseBodyTypeHeader({ bodyMode, headers, responseBodyType })
        : {
              ...getResponseTypeHeaders({ headers, responseBodyType }),
              ...(bodyMode === 'none' ? {} : { [RESPONSE_BODY_MODE_HEADER]: bodyMode }),
          }

export const getResponseBodyType = (value: unknown): string => {
    if (value === null) {
        return 'null'
    }

    if (Array.isArray(value)) {
        return 'array'
    }

    return typeof value
}

export const getSerializedResponseBodyType = (value: string): string => {
    const trimmed = value.trim()

    if (trimmed.length === 0) {
        return ''
    }

    if (trimmed.startsWith('{')) {
        return 'object'
    }

    if (trimmed.startsWith('[')) {
        return 'array'
    }

    if (trimmed.startsWith('"')) {
        return 'string'
    }

    if (trimmed === 'true' || trimmed === 'false') {
        return 'boolean'
    }

    if (trimmed === 'null') {
        return 'null'
    }

    return Number.isFinite(Number(trimmed)) ? 'number' : 'string'
}

const truncateSampleString = (value: string): string =>
    value.length > DEFAULT_MAX_BODY_SAMPLE_STRING_LENGTH ? `${value.slice(0, 5)}...${value.slice(-5)}` : value

const sanitizeSampleString = ({ redaction, value }: SanitizeSampleStringInput): string =>
    truncateSampleString(redactSensitiveCaptureText({ redaction, value }))

const getBoundedObjectEntries = ({ maxEntries, value }: GetBoundedObjectEntriesInput): ReadonlyArray<HttpBodySampleEntry> => {
    const entries: Array<HttpBodySampleEntry> = []

    // Only sampled fields are read. Object.entries would materialize and access every property first.
    // eslint-disable-next-line functional/no-loop-statements
    for (const key in value) {
        if (Object.hasOwn(value, key)) {
            // Bounded sampler state is intentionally mutable to avoid rebuilding the prefix per key.
            // eslint-disable-next-line functional/immutable-data
            entries.push([key, value[key]])

            if (entries.length >= maxEntries) {
                break
            }
        }
    }

    return entries
}

const getMergedSampleKeys = (values: ReadonlyArray<Readonly<Record<string, unknown>>>): ReadonlyArray<string> => {
    const keys: Array<string> = []
    const seenKeys = new Set<string>()
    const appendKey = (key: string): boolean => {
        if (seenKeys.has(key)) {
            return false
        }

        // Both collections are bounded by the sample key limit.
        // eslint-disable-next-line functional/immutable-data
        seenKeys.add(key)
        // eslint-disable-next-line functional/immutable-data
        keys.push(key)

        return keys.length >= DEFAULT_MAX_BODY_SAMPLE_KEYS
    }
    const appendKeys = (value: Readonly<Record<string, unknown>>): void => {
        // eslint-disable-next-line functional/no-loop-statements
        for (const key in value) {
            if (Object.hasOwn(value, key) && appendKey(key)) {
                return
            }
        }
    }

    // eslint-disable-next-line functional/no-loop-statements
    for (const value of values) {
        appendKeys(value)

        if (keys.length >= DEFAULT_MAX_BODY_SAMPLE_KEYS) {
            return keys
        }
    }

    return keys
}

const mergeObjectSamples = ({ depth, redaction, values }: MergeObjectSamplesInput): HttpBodySample =>
    Object.fromEntries(
        getMergedSampleKeys(values).map(key => {
            const childValue = values.map(value => value[key]).find(value => value !== undefined)

            return [
                key,
                isSensitiveCaptureField({ key, redaction })
                    ? redaction.redactedValue
                    : getHttpBodySample({ depth: depth + 1, redaction, value: childValue }),
            ]
        }),
    )

export const getHttpBodySample = ({ depth = 0, redaction, value }: GetHttpBodySampleInput): HttpBodySample => {
    if (depth >= DEFAULT_MAX_BODY_SAMPLE_DEPTH) {
        return getResponseBodyType(value)
    }

    if (Array.isArray(value)) {
        const objectItems: Array<Record<string, unknown>> = []

        // A representative sample needs at most five object shapes. Stopping there avoids retaining a second
        // array proportional to a potentially very large response.
        // eslint-disable-next-line functional/no-loop-statements
        for (const arrayItem of value as ReadonlyArray<unknown>) {
            const item = arrayItem

            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
                // eslint-disable-next-line functional/immutable-data -- The bounded five-item sample avoids a full-array allocation.
                objectItems.push(item as Record<string, unknown>)
            }

            if (objectItems.length === 5) {
                break
            }
        }

        if (objectItems.length > 0) {
            return value.length > 1
                ? [mergeObjectSamples({ depth, redaction, values: objectItems }), '...']
                : [mergeObjectSamples({ depth, redaction, values: objectItems })]
        }

        const firstItem = value.find(item => item !== undefined)
        const sampledItem = firstItem === undefined ? 'unknown' : getHttpBodySample({ depth: depth + 1, redaction, value: firstItem })

        return value.length > 1 ? [sampledItem, '...'] : [sampledItem]
    }

    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
            getBoundedObjectEntries({ maxEntries: DEFAULT_MAX_BODY_SAMPLE_KEYS, value: value as Readonly<Record<string, unknown>> }).map(
                ([key, childValue]) => [
                    key,
                    isSensitiveCaptureField({ key, redaction })
                        ? redaction.redactedValue
                        : getHttpBodySample({ depth: depth + 1, redaction, value: childValue }),
                ],
            ),
        )
    }

    if (typeof value === 'string') {
        return sanitizeSampleString({ redaction, value })
    }

    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
        return value
    }

    return getResponseBodyType(value)
}

export const getSerializedHttpBodySample = ({ redaction, value }: GetSerializedHttpBodySampleInput): HttpBodySample | undefined => {
    const trimmed = value.trim()

    if (trimmed.length === 0) {
        return undefined
    }

    try {
        return getHttpBodySample({ redaction, value: JSON.parse(trimmed) as unknown })
    } catch {
        return getHttpBodySample({ redaction, value })
    }
}

export const stringifyHttpBodySample = (sample: HttpBodySample | undefined): string => (sample === undefined ? '' : JSON.stringify(sample))

export const getHttpContentLength = (headers: Record<string, string>): number | undefined => {
    const headerValue = getHttpHeaderValue({ headers, name: 'content-length' }).trim()

    if (headerValue.length === 0) {
        return undefined
    }

    const value = Number(headerValue)

    return Number.isFinite(value) && value >= 0 ? value : undefined
}

const hasHeaderValue = ({ expected, headers, name }: HasHeaderValueInput): boolean =>
    getHttpHeaderValue({ headers, name }).toLowerCase().includes(expected)

export const acceptsEventStream = (request: HttpLikeRequest): boolean =>
    getHttpHeaderValue({ headers: getRequestHeaders(request), name: 'accept' })
        .split(',')
        .some(value => value.split(';')[0]?.trim().toLowerCase() === TEXT_EVENT_STREAM)

export const inferHttpRequestKind = (context: HttpCaptureContext): HttpRequestKind => {
    if (
        hasHeaderValue({ expected: TEXT_EVENT_STREAM, headers: context.requestHeaders, name: 'accept' }) ||
        hasHeaderValue({ expected: TEXT_EVENT_STREAM, headers: context.responseHeaders, name: 'content-type' })
    ) {
        return 'sse'
    }

    return 'http'
}

export const getCapturedRequestBody = ({ maxBodyBytes, redaction, request }: GetRequestBodyInput): CapturedRequestBody =>
    captureBodyValue({ maxBodyBytes, redaction, value: request.body })

export const getRequestBody = (input: GetRequestBodyInput): string => getCapturedRequestBody(input).body

export const getRequestBodySizeBytes = (request: HttpLikeRequest): number => safeJsonByteLength(request.body)

export const getResponseBodySizeBytes = safeJsonByteLength

export const getBodyChunkSizeBytes = (chunk: unknown): number => {
    if (chunk === undefined || chunk === null) {
        return 0
    }

    if (typeof chunk === 'string') {
        return utf8ByteLength(chunk)
    }

    if (chunk instanceof Uint8Array) {
        return chunk.byteLength
    }

    if (chunk instanceof ArrayBuffer) {
        return chunk.byteLength
    }

    return 0
}

const getUtf8SequenceLength = (leadingByte: number): number => {
    if (leadingByte <= 0x7f) {
        return 1
    }

    if (leadingByte >= 0xc0 && leadingByte <= 0xdf) {
        return 2
    }

    if (leadingByte >= 0xe0 && leadingByte <= 0xef) {
        return 3
    }

    return leadingByte >= 0xf0 && leadingByte <= 0xf7 ? 4 : 1
}

const getCompleteUtf8Prefix = ({ bytes, maxBytes }: GetCompleteUtf8PrefixInput): Uint8Array => {
    const boundedEnd = Math.min(bytes.byteLength, maxBytes)

    if (boundedEnd === 0 || boundedEnd === bytes.byteLength) {
        return bytes.subarray(0, boundedEnd)
    }

    /* eslint-disable functional/no-let, functional/no-loop-statements -- Inspecting the bounded UTF-8 suffix avoids copying the chunk. */
    let sequenceStart = boundedEnd - 1

    // At most three continuation bytes can precede a UTF-8 boundary.
    while (sequenceStart > 0 && (bytes[sequenceStart] ?? 0) >= 0x80 && (bytes[sequenceStart] ?? 0) <= 0xbf) {
        sequenceStart -= 1
    }
    /* eslint-enable functional/no-let, functional/no-loop-statements */

    const availableSequenceBytes = boundedEnd - sequenceStart
    const expectedSequenceBytes = getUtf8SequenceLength(bytes[sequenceStart] ?? 0)
    const completeEnd = availableSequenceBytes < expectedSequenceBytes ? sequenceStart : boundedEnd

    return bytes.subarray(0, completeEnd)
}

export const appendBodyChunk = ({ chunk, maxBytes, value }: AppendBodyChunkInput): string => {
    const remainingBytes = maxBytes - utf8ByteLength(value)

    if (remainingBytes <= 0 || chunk === undefined || chunk === null) {
        return value
    }

    const chunkValue = (() => {
        if (typeof chunk === 'string') {
            return chunk
        }

        if (chunk instanceof Uint8Array) {
            return new TextDecoder().decode(getCompleteUtf8Prefix({ bytes: chunk, maxBytes: remainingBytes }))
        }

        if (chunk instanceof ArrayBuffer) {
            return new TextDecoder().decode(getCompleteUtf8Prefix({ bytes: new Uint8Array(chunk), maxBytes: remainingBytes }))
        }

        return ''
    })()

    return `${value}${truncateUtf8({ maxBytes: remainingBytes, value: chunkValue })}`
}

export const resolveHttpMessageSize = ({ body = '', explicitSizeBytes, headers }: ResolveHttpMessageSizeInput): number =>
    explicitSizeBytes ?? getHttpContentLength(headers) ?? utf8ByteLength(body)

export const buildCaptureContext = ({ request, response }: BuildCaptureContextInput): HttpCaptureContext => {
    const url = getRequestUrl(request)

    return {
        method: getRequestMethod(request),
        route: getRequestRoute({ request, url }),
        url,
        statusCode: response.statusCode ?? 0,
        userId: getRequestUserId(request),
        requestHeaders: getRequestHeaders(request),
        requestQuery: getRequestQuery(request),
        responseHeaders: getResponseHeaders(response),
    }
}

export const buildRequestTelemetryContext = ({ options, request, response, traceContext }: BuildRequestTelemetryContextInput) => ({
    ...traceContext,
    resolveUser: () => {
        const explicitUser = options.getUserContext(request)

        if (explicitUser !== undefined) {
            return explicitUser
        }

        const userId = options.getUserId(buildCaptureContext({ request, response }))

        return userId === '' ? undefined : { id: userId }
    },
    resolveSessionId: () => options.getSessionId(buildCaptureContext({ request, response })),
})

export const resolveCaptureOptions = (options: CaptureRequestResponseOptions = {}): ResolvedCaptureRequestResponseOptions => ({
    enabled: options.enabled ?? true,
    exclude: options.exclude ?? (() => false),
    captureRequestResponse: options.captureRequestResponse ?? true,
    captureRequestBody: options.captureRequestBody ?? true,
    captureResponseBody: options.captureResponseBody ?? false,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    shouldCapture: options.shouldCapture ?? (() => true),
    getUserId: options.getUserId ?? (context => context.userId),
    getUserContext: options.getUserContext ?? (() => undefined),
    getSessionId: options.getSessionId ?? (() => ''),
    getRoute: options.getRoute ?? (context => context.route),
    getRequestKind: options.getRequestKind ?? inferHttpRequestKind,
    getAttributes: options.getAttributes ?? (() => ({})),
    graphql: resolveGraphqlCaptureOptions(options.graphql),
    redaction: {
        fieldNames: options.redaction?.fieldNames ?? [],
        fieldPatterns: options.redaction?.fieldPatterns ?? [],
        redactedValue: options.redaction?.redactedValue ?? DEFAULT_REDACTED_VALUE,
    },
    metrics: {
        enabled: options.metrics?.enabled ?? true,
        latencyBucketsMs: options.metrics?.latencyBucketsMs ?? [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    },
})

export const resolveAutoInstrumentFetchOptions = (
    option: CaptureRequestResponseOptions['autoInstrumentFetch'],
): InstrumentedFetchOptions | undefined => {
    if (option === false) {
        return undefined
    }

    if (option === true || option === undefined) {
        return {}
    }

    return option
}

export const resolveAutoInstrumentHttpOptions = (
    option: CaptureRequestResponseOptions['autoInstrumentHttp'],
): NodeHttpInstrumentationOptions | undefined => {
    if (option === false) return undefined

    return option === true || option === undefined ? {} : option
}
