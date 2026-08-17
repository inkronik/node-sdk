import http, { type Server } from 'node:http'
import https from 'node:https'
import axios from 'axios'
import { afterEach, describe, expect, test } from 'bun:test'
import { InkronikClient } from './client.js'
import { createInkronikExpressMiddleware } from './express/middleware.js'
import type { IngestTelemetryRequest, IngestTelemetrySignal } from './protocol/types.js'
import { runWithTraceContext } from './trace-context.js'
import type { HttpLikeRequest, HttpLikeResponse } from './types.js'

type SpanSignal = Extract<IngestTelemetrySignal, { readonly signal_type: 'span' }>

interface ClientHarnessOptions {
    readonly collectorUrl?: string
    readonly serviceName?: string
}

const traceContext = {
    traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    spanId: 'bbbbbbbbbbbbbbbb',
    parentSpanId: '',
} as const

const activeServers = new Set<Server>()

const getTraceparentHeader = (value: string | ReadonlyArray<string> | undefined): string | undefined => {
    if (typeof value === 'string' || value === undefined) return value

    return value[0]
}

const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()

    if (address === null || typeof address === 'string') throw new Error('Expected an assigned TCP port')

    // Test resource tracking is intentionally mutable.
    // eslint-disable-next-line functional/immutable-data
    activeServers.add(server)

    return address.port
}

const closeServer = async (server: Server): Promise<void> => {
    if (!server.listening) return

    await new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error))))
    // Test resource tracking is intentionally mutable.
    // eslint-disable-next-line functional/immutable-data
    activeServers.delete(server)
}

const createClientHarness = ({ collectorUrl = 'http://collector:4000', serviceName = 'sales-service' }: ClientHarnessOptions = {}) => {
    const collectorRequests: Array<RequestInit> = []
    const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) => {
        // Test transport capture is intentionally mutable.
        // eslint-disable-next-line functional/immutable-data
        collectorRequests.push(init ?? {})

        return Promise.resolve(
            new Response(JSON.stringify({ accepted: 1, organisation_id: '101', application_id: 'application-regression' }), {
                status: 202,
                headers: { 'content-type': 'application/json' },
            }),
        )
    }) as typeof fetch
    const client = new InkronikClient({
        collectorUrl,
        ingestApiKey: 'ik_live_prefix_secret',
        applicationId: 'application-regression',
        serviceName,
        fetchImpl,
        flushIntervalMs: 60_000,
    })
    const getSignals = (): ReadonlyArray<IngestTelemetrySignal> =>
        collectorRequests.flatMap(request => {
            if (typeof request.body !== 'string') return []

            return (JSON.parse(request.body) as IngestTelemetryRequest).signals
        })

    return { client, collectorRequests, getSignals }
}

const getSpans = (signals: ReadonlyArray<IngestTelemetrySignal>): ReadonlyArray<SpanSignal> =>
    signals.filter((signal): signal is SpanSignal => signal.signal_type === 'span')

afterEach(async () => {
    await Promise.all([...activeServers].map(closeServer))
})

describe('node http auto-instrumentation', () => {
    test('captures native http.get and propagates traceparent', async () => {
        const receivedTraceparents: Array<string | undefined> = []
        const server = http.createServer((request, response) => {
            // Test request capture is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            receivedTraceparents.push(getTraceparentHeader(request.headers.traceparent))
            response.writeHead(204)
            response.end()
        })
        const port = await listen(server)
        const { client, getSignals } = createClientHarness()
        const originalHttpRequest = http.request
        const originalHttpsRequest = https.request

        try {
            client.instrumentNodeHttp()

            expect(http.request).not.toBe(originalHttpRequest)
            expect(https.request).not.toBe(originalHttpsRequest)

            await runWithTraceContext(
                traceContext,
                () =>
                    new Promise<void>((resolve, reject) => {
                        http.get(`http://127.0.0.1:${port}/internal/user?userUUID=account-1`, response => {
                            response.resume()
                            response.once('end', resolve)
                        }).once('error', reject)
                    }),
            )
            await client.shutdown()

            expect(http.request).toBe(originalHttpRequest)
            expect(https.request).toBe(originalHttpsRequest)
            expect(receivedTraceparents[0]).toMatch(/^00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-[0-9a-f]{16}-01$/u)
            const spans = getSpans(getSignals())

            expect(spans).toHaveLength(1)
            expect(spans[0]?.payload).toMatchObject({
                trace_id: traceContext.traceId,
                parent_span_id: traceContext.spanId,
                span_kind: 'client',
                span_category: 'http',
                http_method: 'GET',
                http_status_code: 204,
                peer_service: `127.0.0.1:${port}`,
            })
        } finally {
            await client.shutdown()
            await closeServer(server)
        }
    })

    test('captures Axios default http adapter without application configuration', async () => {
        const receivedTraceparents: Array<string | undefined> = []
        const server = http.createServer((request, response) => {
            // Test request capture is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            receivedTraceparents.push(getTraceparentHeader(request.headers.traceparent))
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ id: 'account-1' }))
        })
        const port = await listen(server)
        const { client, getSignals } = createClientHarness()

        try {
            client.instrumentNodeHttp()
            const response = await runWithTraceContext(traceContext, () =>
                axios.get(`http://127.0.0.1:${port}/internal/user`, { params: { userUUID: 'account-1' } }),
            )

            expect(response.data).toEqual({ id: 'account-1' })
            await client.shutdown()

            expect(receivedTraceparents[0]).toMatch(/^00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-[0-9a-f]{16}-01$/u)
            expect(getSpans(getSignals())).toHaveLength(1)
        } finally {
            await client.shutdown()
            await closeServer(server)
        }
    })

    test('captures transport errors once', async () => {
        const { client, getSignals } = createClientHarness()

        try {
            client.instrumentNodeHttp()
            await runWithTraceContext(traceContext, () => axios.get('http://127.0.0.1:9/unavailable', { timeout: 100 }).catch(() => undefined))
            await client.shutdown()

            const spans = getSpans(getSignals())

            expect(spans).toHaveLength(1)
            expect(spans[0]?.payload).toMatchObject({ has_error: true, http_status_code: 0, status_code: 'error' })
        } finally {
            await client.shutdown()
        }
    })

    test('captures each Axios redirect transport request once and propagates trace context to every hop', async () => {
        const receivedTraceparents: Array<string | undefined> = []
        const server = http.createServer((request, response) => {
            // Test request capture is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            receivedTraceparents.push(getTraceparentHeader(request.headers.traceparent))

            if (request.url === '/redirect') {
                response.writeHead(302, { location: '/final' })
                response.end()
                return
            }

            response.end('ok')
        })
        const port = await listen(server)
        const { client, getSignals } = createClientHarness()

        try {
            client.instrumentNodeHttp()
            const response = await runWithTraceContext(traceContext, () => axios.get(`http://127.0.0.1:${port}/redirect`))

            expect(response.data).toBe('ok')
            await client.shutdown()

            expect(receivedTraceparents).toHaveLength(2)
            expect(receivedTraceparents.every(value => /^00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-[0-9a-f]{16}-01$/u.test(value ?? ''))).toBe(true)
            expect(
                getSpans(getSignals())
                    .map(span => span.payload.http_status_code)
                    .sort(),
            ).toEqual([200, 302])
        } finally {
            await client.shutdown()
            await closeServer(server)
        }
    })

    test('correlates an instrumented caller client span with a downstream service server span', async () => {
        const salesHarness = createClientHarness({ serviceName: 'sales-service' })
        const userHarness = createClientHarness({ serviceName: 'user-service' })
        const userMiddleware = createInkronikExpressMiddleware({
            client: userHarness.client,
            options: {
                autoInstrumentFetch: false,
                autoInstrumentHttp: false,
                captureRequestResponse: false,
                metrics: { enabled: false },
            },
        })
        const server = http.createServer((request, response) => {
            userMiddleware(request as HttpLikeRequest, response as HttpLikeResponse, () => {
                response.end(JSON.stringify({ id: 'account-1' }))
            })
        })
        const port = await listen(server)

        try {
            salesHarness.client.instrumentNodeHttp()
            await runWithTraceContext(traceContext, () => axios.get(`http://127.0.0.1:${port}/internal/user`))
            await Promise.all([salesHarness.client.shutdown(), userHarness.client.shutdown()])

            const salesClientSpan = getSpans(salesHarness.getSignals()).find(span => span.payload.span_kind === 'client')
            const userServerSpan = getSpans(userHarness.getSignals()).find(span => span.payload.span_kind === 'server')

            expect(salesClientSpan).toBeDefined()
            expect(userServerSpan).toBeDefined()
            expect(userServerSpan?.payload.trace_id).toBe(salesClientSpan?.payload.trace_id)
            expect(userServerSpan?.payload.parent_span_id).toBe(salesClientSpan?.payload.span_id)
            expect([salesClientSpan?.payload.service_name, userServerSpan?.payload.service_name]).toEqual(['sales-service', 'user-service'])
        } finally {
            await salesHarness.client.shutdown()
            await userHarness.client.shutdown()
            await closeServer(server)
        }
    })

    test('preserves an existing traceparent and does not create a duplicate span', async () => {
        const explicitTraceparent = '00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01'
        const receivedTraceparents: Array<string | undefined> = []
        const server = http.createServer((request, response) => {
            // Test request capture is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            receivedTraceparents.push(getTraceparentHeader(request.headers.traceparent))
            response.end()
        })
        const port = await listen(server)
        const { client, getSignals } = createClientHarness()

        try {
            client.instrumentNodeHttp()
            await new Promise<void>((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/already-instrumented`, { headers: { traceparent: explicitTraceparent } }, response => {
                    response.resume()
                    response.once('end', resolve)
                }).once('error', reject)
            })
            await client.shutdown()

            expect(receivedTraceparents).toEqual([explicitTraceparent])
            expect(getSpans(getSignals())).toHaveLength(0)
        } finally {
            await client.shutdown()
            await closeServer(server)
        }
    })

    test('excludes Collector delivery from client spans', async () => {
        const server = http.createServer((_, response) => {
            response.writeHead(202)
            response.end()
        })
        const port = await listen(server)
        const { client, collectorRequests, getSignals } = createClientHarness({ collectorUrl: `http://127.0.0.1:${port}` })

        try {
            client.instrumentNodeHttp()
            await new Promise<void>((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/v1/telemetry`, response => {
                    response.resume()
                    response.once('end', resolve)
                }).once('error', reject)
            })
            await client.shutdown()

            expect(getSpans(getSignals())).toHaveLength(0)
            expect(collectorRequests).toHaveLength(0)
        } finally {
            await client.shutdown()
            await closeServer(server)
        }
    })
})
