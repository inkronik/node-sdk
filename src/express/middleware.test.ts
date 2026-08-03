import { describe, expect, test } from 'bun:test'
import { InkronikClient } from '../client.js'
import type { HttpLikeRequest, HttpLikeResponse } from '../types.js'
import { createInkronikExpressMiddleware } from './middleware.js'

interface SentRequest {
    readonly init?: RequestInit
}

type TestResponse = HttpLikeResponse & {
    readonly setHeader: (name: string, value: string) => void
}

const createTestClient = () => {
    const requests: Array<SentRequest> = []
    const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) => {
        // Test spy state is intentionally mutable.
        // eslint-disable-next-line functional/immutable-data
        requests.push({ init })

        return Promise.resolve(
            new Response(JSON.stringify({ accepted: 1, organisation_id: '101', application_id: 'application-express' }), {
                status: 202,
                headers: { 'content-type': 'application/json' },
            }),
        )
    }) as typeof fetch

    const client = new InkronikClient({
        collectorUrl: 'http://collector:4000',
        ingestApiKey: 'ik_live_prefix_secret',
        applicationId: 'application-express',
        serviceName: 'orders-api',
        fetchImpl,
        flushIntervalMs: 60_000,
    })

    return { client, requests }
}

const createRequest = (): HttpLikeRequest => ({
    method: 'GET',
    originalUrl: '/orders/123?include=items',
    route: { path: '/orders/:id' },
    headers: {},
    query: { include: 'items' },
    body: { include: 'items' },
})

const createResponse = () => {
    const headers: Record<string, string> = {}
    const response: TestResponse = {
        statusCode: 200,
        getHeaders: () => headers,
        setHeader: (name, value) => {
            // Test response header state is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            headers[name] = value
        },
        write: () => true,
        end: () => undefined,
    }

    return { headers, response }
}

const getSignals = (request: SentRequest) => {
    if (typeof request.init?.body !== 'string') {
        throw new Error('Expected fetch body')
    }

    return (
        JSON.parse(request.init.body) as {
            readonly signals: Array<{
                readonly signal_type: string
                readonly payload: {
                    readonly http_route?: string
                    readonly metric_name?: string
                    readonly metric_attributes?: Record<string, string>
                    readonly event_attributes?: Record<string, string>
                    readonly event_level?: string
                    readonly user_id?: string
                    readonly trace_id?: string
                    readonly span_id?: string
                    readonly value?: number
                    readonly request_body?: string
                    readonly response_headers?: Record<string, string>
                    readonly response_body?: string
                    readonly span_attributes?: Record<string, string>
                }
            }>
        }
    ).signals
}

describe('createInkronikExpressMiddleware', () => {
    test('emits server span, metrics, and request response capture by default', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { headers, response } = createResponse()
        const nextCalls: Array<unknown> = []
        const middleware = createInkronikExpressMiddleware({ client })

        response.setHeader('content-type', 'application/json')
        middleware(request, response, error => {
            // Test spy state is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            nextCalls.push(error)
        })
        response.end?.()

        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)
        const capture = signals.find(signal => signal.signal_type === 'request_response_capture')

        expect(nextCalls).toHaveLength(1)
        expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u)
        expect(signals.map(signal => signal.signal_type)).toEqual(['span', 'metric', 'metric', 'metric', 'metric', 'request_response_capture'])
        expect(signals[0]?.payload.http_route).toBe('/orders/:id')
        expect(capture?.payload.request_body).toBe('{"include":"items"}')
        expect(capture?.payload.response_headers).toEqual({ 'content-type': 'application/json' })
        expect(capture?.payload.response_body).toBe('')
        expect(signals.find(signal => signal.payload.metric_name === 'http.server.request.size')?.payload.value).toBe(19)
        expect(signals.find(signal => signal.payload.metric_name === 'http.server.response.size')?.payload.value).toBe(0)
    })

    test('uses request user id by default when the framework attaches authenticated user context', async () => {
        const { client, requests } = createTestClient()
        const request = { ...createRequest(), user: { id: 'user_123', email: 'user@example.com' } }
        const { response } = createResponse()
        const middleware = createInkronikExpressMiddleware({ client })

        middleware(request, response, () => undefined)
        response.end?.()

        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)

        expect(signals[0]?.payload.span_attributes).toMatchObject({ 'user.id': 'user_123' })
    })

    test('inherits lazily resolved request user and trace context for events', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { response } = createResponse()
        const middleware = createInkronikExpressMiddleware({
            client,
            options: {
                getUserContext: currentRequest => {
                    const user = currentRequest.user as { readonly id?: string; readonly role?: string } | undefined

                    return user?.id === undefined ? undefined : { id: user.id, attributes: { role: user.role ?? '' } }
                },
            },
        })

        middleware(request, response, () => {
            // Express authentication middleware populates request.user after tracing middleware has started.
            Reflect.set(request, 'user', { id: 'user_456', role: 'admin' })
            client.event({ name: 'admin_action', category: 'audit', level: 'warning' })
        })
        response.end?.()
        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)
        const event = signals.find(signal => signal.signal_type === 'event')
        const span = signals.find(signal => signal.signal_type === 'span')

        expect(event?.payload).toMatchObject({
            event_level: 'warning',
            user_id: 'user_456',
            event_attributes: { 'user.role': 'admin' },
        })
        expect(event?.payload.trace_id).toBe(span?.payload.trace_id)
        expect(event?.payload.span_id).toMatch(/^[0-9a-f]{16}$/u)
    })

    test('uses current account uuid when Fastify request stores authenticated account context', async () => {
        const { client, requests } = createTestClient()
        const request = { ...createRequest(), currentAccount: { id: 42, uuid: 'account_123' } }
        const { response } = createResponse()
        const middleware = createInkronikExpressMiddleware({ client })

        middleware(request, response, () => undefined)
        response.end?.()

        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)

        expect(signals[0]?.payload.span_attributes).toMatchObject({ 'user.id': 'account_123' })
    })

    test('captures successful response body chunks when raw response capture is enabled', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { response } = createResponse()
        const middleware = createInkronikExpressMiddleware({
            client,
            options: {
                captureResponseBody: true,
            },
        })

        middleware(request, response, () => undefined)
        response.write?.('hello')
        response.end?.(' world')

        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)
        const capture = signals.find(signal => signal.signal_type === 'request_response_capture')

        expect(signals.map(signal => signal.signal_type)).toEqual(['span', 'metric', 'metric', 'metric', 'metric', 'request_response_capture'])
        expect(capture?.payload.request_body).toBe('{"include":"items"}')
        expect(capture?.payload.response_body).toBe('hello world')
        expect(signals.find(signal => signal.payload.metric_name === 'http.server.response.size')?.payload.value).toBe(11)
    })

    test('captures successful response body sample by default', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { response } = createResponse()
        const middleware = createInkronikExpressMiddleware({
            client,
            options: {
                redaction: {
                    fieldNames: ['operatorSecret'],
                },
            },
        })

        response.setHeader('content-type', 'application/json')
        middleware(request, response, () => undefined)
        response.end?.(
            '{"items":[{"id":"operator_123","name":"Alice Longname","enabled":true,"token":"known-secret","operatorSecret":"custom-secret"},{"id":"operator_456","name":"Bob","enabled":false}],"total":2}',
        )

        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)
        const capture = signals.find(signal => signal.signal_type === 'request_response_capture')

        expect(capture?.payload.response_headers).toEqual({
            'content-type': 'application/json',
            'inkronik-response-body-mode': 'sample',
            'inkronik-response-body-type': 'object',
        })
        expect(capture?.payload.response_body).toBe(
            '{"items":[{"id":"opera...r_123","name":"Alice...gname","enabled":true,"token":"[REDACTED]","operatorSecret":"[REDACTED]"},"..."],"total":2}',
        )
    })

    test('captures error response body chunks by default', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { response } = createResponse()
        const errorResponse = { ...response, statusCode: 500 }
        const middleware = createInkronikExpressMiddleware({ client })

        middleware(request, errorResponse, () => undefined)
        errorResponse.write?.('failed')
        errorResponse.end?.(' request')

        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)
        const capture = signals.find(signal => signal.signal_type === 'request_response_capture')

        expect(capture?.payload.response_body).toBe('failed request')
        expect(signals.find(signal => signal.payload.metric_name === 'http.server.response.size')?.payload.value).toBe(14)
    })

    test('respects explicit request response capture opt-out', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { response } = createResponse()
        const middleware = createInkronikExpressMiddleware({
            client,
            options: {
                captureRequestResponse: false,
            },
        })

        middleware(request, response, () => undefined)
        response.write?.('hello')
        response.end?.(' world')

        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)

        expect(signals.map(signal => signal.signal_type)).toEqual(['span', 'metric', 'metric', 'metric', 'metric'])
    })

    test('normalizes fallback routes by stripping query strings and uuid segments', async () => {
        const { client, requests } = createTestClient()
        const request = {
            ...createRequest(),
            originalUrl: '/recordings/ad50e58d-8c7a-46ca-85d0-292e0bb8a7d7?limit=10&offset=0',
            route: undefined,
        }
        const { response } = createResponse()
        const middleware = createInkronikExpressMiddleware({ client })

        middleware(request, response, () => undefined)
        response.end?.()

        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)

        expect(signals[0]?.payload.http_route).toBe('/recordings/:id')
    })

    test('infers SSE responses and skips duration histograms', async () => {
        const { client, requests } = createTestClient()
        const request = { ...createRequest(), headers: { accept: 'text/event-stream' }, originalUrl: '/events', route: { path: '/events' } }
        const { headers, response } = createResponse()
        const middleware = createInkronikExpressMiddleware({ client })

        middleware(request, response, () => undefined)
        // Test response header state is intentionally mutable.
        // eslint-disable-next-line functional/immutable-data
        headers['content-type'] = 'text/event-stream'
        response.end?.()

        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)

        expect(signals.map(signal => signal.signal_type)).toEqual(['span', 'metric', 'metric', 'metric', 'request_response_capture'])
        expect(signals[0]?.payload.span_attributes).toMatchObject({
            'http.request.accept': 'text/event-stream',
            'http.response.content_type': 'text/event-stream',
            'inkronik.request_kind': 'sse',
        })
        expect(signals.map(signal => signal.payload.metric_name).filter(Boolean)).toEqual([
            'http.server.requests',
            'http.server.request.size',
            'http.server.response.size',
        ])
        expect(signals[1]?.payload.metric_attributes).toMatchObject({ 'inkronik.request_kind': 'sse' })
    })

    test('excludes matching requests before wrapping the response', async () => {
        const { client, requests } = createTestClient()
        const request = { ...createRequest(), originalUrl: '/health', route: { path: '/health' } }
        const { headers, response } = createResponse()
        const originalEnd = response.end
        const nextCalls: Array<unknown> = []
        const middleware = createInkronikExpressMiddleware({
            client,
            options: {
                exclude: currentRequest => currentRequest.originalUrl === '/health',
            },
        })

        middleware(request, response, error => {
            // Test spy state is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            nextCalls.push(error)
        })
        response.end?.()
        await client.shutdown()

        expect(nextCalls).toHaveLength(1)
        expect(requests).toHaveLength(0)
        expect(response.end).toBe(originalEnd)
        expect(headers.traceparent).toBeUndefined()
    })
})
