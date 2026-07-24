import { describe, expect, test } from 'bun:test'
import { lastValueFrom, Observable, of } from 'rxjs'
import { type CallHandler, type ExecutionContext } from '@nestjs/common'
import { InkronikClient } from '../client.js'
import type { HttpLikeRequest, HttpLikeResponse } from '../types.js'
import { InkronikNestInterceptor } from './interceptor.js'

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
            new Response(JSON.stringify({ accepted: 1, organisation_id: '101', application_id: 'application-nest' }), {
                status: 202,
                headers: { 'content-type': 'application/json' },
            }),
        )
    }) as typeof fetch

    const client = new InkronikClient({
        collectorUrl: 'http://collector:4000',
        ingestApiKey: 'ik_live_prefix_secret',
        applicationId: 'application-nest',
        serviceName: 'orders-api',
        fetchImpl,
        flushIntervalMs: 60_000,
    })

    return { client, requests }
}

const createRequest = (): HttpLikeRequest => ({
    method: 'POST',
    originalUrl: '/orders',
    route: { path: '/orders' },
    headers: {},
    query: {},
    body: { sku: 'sku_123' },
})

const createResponse = () => {
    const headers: Record<string, string> = {}
    const response: TestResponse = {
        statusCode: 201,
        getHeaders: () => headers,
        setHeader: (name, value) => {
            // Test response header state is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            headers[name] = value
        },
    }

    return { headers, response }
}

const createExecutionContext = ({
    request,
    response,
}: {
    readonly request: HttpLikeRequest
    readonly response: HttpLikeResponse
}): ExecutionContext =>
    ({
        switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => response,
        }),
    }) as ExecutionContext

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
                    readonly span_id?: string
                    readonly trace_id?: string
                    readonly value?: number
                    readonly request_body?: string
                    readonly response_headers?: Record<string, string>
                    readonly response_body?: string
                }
            }>
        }
    ).signals
}

describe('InkronikNestInterceptor', () => {
    test('excludes SSE requests before setting response headers or creating telemetry', async () => {
        const { client, requests } = createTestClient()
        const request = {
            ...createRequest(),
            originalUrl: '/events',
            route: { path: '/events' },
            headers: { Accept: 'application/json, text/event-stream; charset=utf-8' },
        }
        const { response } = createResponse()
        const headersSentResponse: TestResponse = {
            ...response,
            setHeader: () => {
                throw new Error('Cannot set headers after they are sent to the client')
            },
        }
        const interceptor = new InkronikNestInterceptor(client)
        const next: CallHandler = { handle: () => of({ data: 'ping' }) }

        const result = await lastValueFrom(interceptor.intercept(createExecutionContext({ request, response: headersSentResponse }), next))
        await client.shutdown()

        expect(result).toEqual({ data: 'ping' })
        expect(requests).toHaveLength(0)
    })

    test('emits server span, metrics, and request response capture by default', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { headers, response } = createResponse()
        const interceptor = new InkronikNestInterceptor(client)
        const next: CallHandler = { handle: () => of({ ok: true }) }

        response.setHeader('content-type', 'application/json')
        await lastValueFrom(interceptor.intercept(createExecutionContext({ request, response }), next))
        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)
        const capture = signals.find(signal => signal.signal_type === 'request_response_capture')

        expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u)
        expect(signals.map(signal => signal.signal_type)).toEqual(['span', 'metric', 'metric', 'metric', 'metric', 'request_response_capture'])
        expect(signals[0]?.payload.http_route).toBe('/orders')
        expect(capture?.payload.request_body).toBe('{"sku":"sku_123"}')
        expect(capture?.payload.response_headers).toEqual({
            'content-type': 'application/json',
            'inkronik-response-body-mode': 'sample',
            'inkronik-response-body-type': 'object',
        })
        expect(capture?.payload.response_body).toBe('{"ok":true}')
        expect(signals.find(signal => signal.payload.metric_name === 'http.server.request.size')?.payload.value).toBe(17)
        expect(signals.find(signal => signal.payload.metric_name === 'http.server.response.size')?.payload.value).toBe(11)
    })

    test('captures successful response bodies when raw response capture is enabled', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { response } = createResponse()
        const interceptor = new InkronikNestInterceptor(client, {
            captureResponseBody: true,
        })
        const next: CallHandler = { handle: () => of({ ok: true }) }

        await lastValueFrom(interceptor.intercept(createExecutionContext({ request, response }), next))
        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)
        const capture = signals.find(signal => signal.signal_type === 'request_response_capture')

        expect(capture?.payload.response_body).toBe('{"ok":true}')
    })

    test('captures error response bodies by default', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { response } = createResponse()
        const errorResponse = { ...response, statusCode: 500 }
        const interceptor = new InkronikNestInterceptor(client)
        const next: CallHandler = { handle: () => of({ ok: false }) }

        await lastValueFrom(interceptor.intercept(createExecutionContext({ request, response: errorResponse }), next))
        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)
        const capture = signals.find(signal => signal.signal_type === 'request_response_capture')

        expect(capture?.payload.response_body).toBe('{"ok":false}')
    })

    test('respects explicit request response capture opt-out', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { response } = createResponse()
        const interceptor = new InkronikNestInterceptor(client, {
            captureRequestResponse: false,
        })
        const next: CallHandler = { handle: () => of({ ok: true }) }

        await lastValueFrom(interceptor.intercept(createExecutionContext({ request, response }), next))
        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)

        expect(signals.map(signal => signal.signal_type)).toEqual(['span', 'metric', 'metric', 'metric', 'metric'])
    })

    test('correlates logs emitted while handling request with the server span', async () => {
        const { client, requests } = createTestClient()
        const request = createRequest()
        const { response } = createResponse()
        const interceptor = new InkronikNestInterceptor(client)
        const next: CallHandler = {
            handle: () =>
                new Observable(subscriber => {
                    client.captureLoggerRecord({ level: 'info', message: 'handler log' })
                    subscriber.next({ ok: true })
                    subscriber.complete()
                }),
        }

        await lastValueFrom(interceptor.intercept(createExecutionContext({ request, response }), next))
        await client.shutdown()

        const signals = getSignals(requests[0] as SentRequest)
        const log = signals.find(signal => signal.signal_type === 'log')
        const span = signals.find(signal => signal.signal_type === 'span')

        expect(log?.payload.trace_id).toBe(span?.payload.trace_id)
        expect(log?.payload.span_id).toBe(span?.payload.span_id)
    })

    test('excludes matching requests before creating telemetry', async () => {
        const { client, requests } = createTestClient()
        const request = { ...createRequest(), originalUrl: '/health', route: { path: '/health' } }
        const { headers, response } = createResponse()
        const interceptor = new InkronikNestInterceptor(client, {
            exclude: currentRequest => currentRequest.originalUrl === '/health',
        })
        const next: CallHandler = { handle: () => of({ status: 'ok' }) }

        await lastValueFrom(interceptor.intercept(createExecutionContext({ request, response }), next))
        await client.shutdown()

        expect(requests).toHaveLength(0)
        expect(headers.traceparent).toBeUndefined()
    })
})
