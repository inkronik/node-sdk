import type {
    BuildRequestTelemetryContextInput,
    CaptureRequestResponseOptions,
    CapturedResponseBodyMode,
    HttpBodySample,
    HttpCaptureContext,
    HttpLikeRequest,
    HttpLikeResponse,
    HttpRequestKind,
    InstrumentedFetchOptions,
    ResolvedCaptureRequestResponseOptions,
    ResolvedCaptureRedactionOptions,
    ResolveHttpMessageSizeInput,
} from './types.js'
import { createRootTraceContext, parseTraceparent } from './trace-context.js'
import { safeJsonStringify, toStringMap, truncateUtf8, utf8ByteLength } from './utils.js'

const DEFAULT_MAX_BODY_BYTES = 16_384
const DEFAULT_MAX_BODY_SAMPLE_DEPTH = 5
const DEFAULT_MAX_BODY_SAMPLE_KEYS = 64
const DEFAULT_MAX_BODY_SAMPLE_STRING_LENGTH = 10
const DEFAULT_REDACTED_VALUE = '[REDACTED]'
const TEXT_EVENT_STREAM = 'text/event-stream'
const RESPONSE_BODY_MODE_HEADER = 'inkronik-response-body-mode'
const RESPONSE_BODY_TYPE_HEADER = 'inkronik-response-body-type'
const UUID_ROUTE_SEGMENT_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u
const NUMERIC_ROUTE_SEGMENT_PATTERN = /^[0-9]+$/u
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
const defaultRequestUserContainers: ReadonlyArray<'currentAccount' | 'user'> = ['user', 'currentAccount']
const defaultRequestUserIdFields: ReadonlyArray<string> = ['uuid', 'id', 'userId', 'user_id', 'sub', 'accountId', 'account_id']
const textSecretPattern =
    /((?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token|jwt|credential|signature|session|cookie|card[_-]?number|credit[_-]?card|cvv|cvc|ssn)\s*[:=]\s*)([^&\s,"'}]+)/gi

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

const normalizeSensitiveFieldName = (name: string): string =>
    name
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '_')
        .replaceAll(/^_+|_+$/g, '')

const isSensitiveSampleField = ({ key, redaction }: { readonly key: string; readonly redaction: ResolvedCaptureRedactionOptions }): boolean => {
    const normalizedKey = normalizeSensitiveFieldName(key)
    const sensitiveNames = [...defaultSensitiveFieldNames, ...redaction.fieldNames].map(normalizeSensitiveFieldName)

    return (
        sensitiveNames.includes(normalizedKey) ||
        defaultSensitiveFieldFragments.some(fragment => normalizedKey.includes(fragment)) ||
        redaction.fieldPatterns.some(pattern => new RegExp(pattern.source, pattern.flags).test(key))
    )
}

const normalizeRouteSegment = (segment: string): string =>
    UUID_ROUTE_SEGMENT_PATTERN.test(segment) || NUMERIC_ROUTE_SEGMENT_PATTERN.test(segment) ? ':id' : segment

export const normalizeHttpRoute = (route: string): string => stripUrlSuffix(route).split('/').map(normalizeRouteSegment).join('/')

export const getRequestMethod = (request: HttpLikeRequest): string => (request.method ?? 'GET').toUpperCase()

export const getRequestUrl = (request: HttpLikeRequest): string => request.originalUrl ?? request.url ?? ''

export const getRequestRoute = ({ request, url }: { readonly request: HttpLikeRequest; readonly url: string }): string =>
    normalizeHttpRoute(request.route?.path ?? url)

export const getRequestHeaders = (request: HttpLikeRequest): Record<string, string> => toStringMap(request.headers)

export const getRequestTraceContext = (request: HttpLikeRequest) =>
    parseTraceparent(getRequestHeaders(request).traceparent) ?? createRootTraceContext()

export const getRequestQuery = (request: HttpLikeRequest): Record<string, string> => toStringMap(request.query)

export const getResponseHeaders = (response: HttpLikeResponse): Record<string, string> => toStringMap(response.getHeaders?.())

export const getRequestUserId = (request: HttpLikeRequest): string =>
    defaultRequestUserContainers.map(container => getUserContextId(request[container])).find(userId => userId.length > 0) ?? ''

export const getHttpHeaderValue = ({ headers, name }: { readonly headers: Record<string, string>; readonly name: string }): string =>
    Object.entries(headers).find(([headerName]) => headerName.toLowerCase() === name.toLowerCase())?.[1] ?? ''

const withResponseBodyTypeHeader = ({
    bodyMode,
    headers,
    responseBodyType,
}: {
    readonly bodyMode: CapturedResponseBodyMode
    readonly headers: Record<string, string>
    readonly responseBodyType: string
}): Record<string, string> => ({
    ...headers,
    ...(bodyMode === 'none' ? {} : { [RESPONSE_BODY_MODE_HEADER]: bodyMode }),
    ...(responseBodyType === '' ? {} : { [RESPONSE_BODY_TYPE_HEADER]: responseBodyType }),
})

export const getResponseTypeHeaders = ({
    headers,
    responseBodyType,
}: {
    readonly headers: Record<string, string>
    readonly responseBodyType: string
}): Record<string, string> => {
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
}: {
    readonly bodyMode: CapturedResponseBodyMode
    readonly headers: Record<string, string>
    readonly responseBodyType: string
    readonly shouldCaptureRawResponse: boolean
}): Record<string, string> =>
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

const sanitizeSampleString = ({ redaction, value }: { readonly redaction: ResolvedCaptureRedactionOptions; readonly value: string }): string =>
    truncateSampleString(value.replaceAll(textSecretPattern, `$1${redaction.redactedValue}`))

const mergeObjectSamples = ({
    depth,
    redaction,
    values,
}: {
    readonly depth: number
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly values: ReadonlyArray<Record<string, unknown>>
}): HttpBodySample =>
    Object.fromEntries(
        Array.from(new Set(values.flatMap(value => Object.keys(value))))
            .slice(0, DEFAULT_MAX_BODY_SAMPLE_KEYS)
            .map(key => {
                const childValue = values.map(value => value[key]).find(value => value !== undefined)

                return [
                    key,
                    isSensitiveSampleField({ key, redaction })
                        ? redaction.redactedValue
                        : getHttpBodySample({ depth: depth + 1, redaction, value: childValue }),
                ]
            }),
    )

export const getHttpBodySample = ({
    depth = 0,
    redaction,
    value,
}: {
    readonly depth?: number
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: unknown
}): HttpBodySample => {
    if (depth >= DEFAULT_MAX_BODY_SAMPLE_DEPTH) {
        return getResponseBodyType(value)
    }

    if (Array.isArray(value)) {
        const objectItems = value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))

        if (objectItems.length > 0) {
            return value.length > 1
                ? [mergeObjectSamples({ depth, redaction, values: objectItems.slice(0, 5) }), '...']
                : [mergeObjectSamples({ depth, redaction, values: objectItems.slice(0, 5) })]
        }

        const firstItem = value.find(item => item !== undefined)
        const sampledItem = firstItem === undefined ? 'unknown' : getHttpBodySample({ depth: depth + 1, redaction, value: firstItem })

        return value.length > 1 ? [sampledItem, '...'] : [sampledItem]
    }

    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
            Object.entries(value)
                .slice(0, DEFAULT_MAX_BODY_SAMPLE_KEYS)
                .map(([key, childValue]) => [
                    key,
                    isSensitiveSampleField({ key, redaction })
                        ? redaction.redactedValue
                        : getHttpBodySample({ depth: depth + 1, redaction, value: childValue }),
                ]),
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

export const getSerializedHttpBodySample = ({
    redaction,
    value,
}: {
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: string
}): HttpBodySample | undefined => {
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

const hasHeaderValue = ({
    expected,
    headers,
    name,
}: {
    readonly expected: string
    readonly headers: Record<string, string>
    readonly name: string
}): boolean => getHttpHeaderValue({ headers, name }).toLowerCase().includes(expected)

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

export const getRequestBody = ({ maxBodyBytes, request }: { readonly maxBodyBytes: number; readonly request: HttpLikeRequest }): string =>
    truncateUtf8({ maxBytes: maxBodyBytes, value: safeJsonStringify(request.body) })

export const getRequestBodySizeBytes = (request: HttpLikeRequest): number => utf8ByteLength(safeJsonStringify(request.body))

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

export const resolveHttpMessageSize = ({ body = '', explicitSizeBytes, headers }: ResolveHttpMessageSizeInput): number =>
    explicitSizeBytes ?? getHttpContentLength(headers) ?? utf8ByteLength(body)

export const buildCaptureContext = ({
    request,
    response,
}: {
    readonly request: HttpLikeRequest
    readonly response: HttpLikeResponse
}): HttpCaptureContext => {
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

export const toBodyChunk = (chunk: unknown): string => {
    if (typeof chunk === 'string') {
        return chunk
    }

    if (chunk instanceof Uint8Array) {
        return new TextDecoder().decode(chunk)
    }

    return ''
}
