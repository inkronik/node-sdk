/* eslint-disable max-lines -- Node client regression suite covers multiple public SDK surfaces together. */
import { describe, expect, test } from 'bun:test'
import { InkronikClient } from './client.js'
import { createInkronikClientFromEnv } from './env.js'
import { runWithTraceContext } from './trace-context.js'

interface PostgresJsSqlTestDouble {
    (strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>): unknown
    readonly unsafe: (query: string, ...args: ReadonlyArray<unknown>) => unknown
}

interface PostgresJsQueryTestDouble extends Promise<ReadonlyArray<Record<string, unknown>>> {
    readonly values: () => PostgresJsQueryTestDouble
}

interface FetchRequest {
    readonly input: RequestInfo | URL
    readonly init?: RequestInit
}

interface BullMQAddCall {
    readonly data: unknown
    readonly name: string
    readonly options?: unknown
}

const inkronikTraceMetadataKey = '__inkronik'

interface TelemetryFetchOptions {
    readonly accepted?: number
    readonly applicationId?: string
}

const createTelemetryFetch = ({ accepted = 1, applicationId = 'application-regression' }: TelemetryFetchOptions = {}): {
    readonly fetchImpl: typeof fetch
    readonly requests: Array<FetchRequest>
} => {
    const requests: Array<FetchRequest> = []
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
        // Test spy state is intentionally mutable.
        // eslint-disable-next-line functional/immutable-data
        requests.push({ input, init })

        return Promise.resolve(
            new Response(JSON.stringify({ accepted, organisation_id: '101', application_id: applicationId }), {
                status: 202,
                headers: { 'content-type': 'application/json' },
            }),
        )
    }) as typeof fetch

    return { fetchImpl, requests }
}

const hasPostgresQueryValues = (value: unknown): value is { readonly values: () => PostgresJsQueryTestDouble } =>
    typeof value === 'object' && value !== null && 'values' in value && typeof value.values === 'function'

describe('InkronikClient', () => {
    test('posts queued telemetry to collector with ingest key and application header', async () => {
        const { fetchImpl, requests } = createTelemetryFetch()

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000/',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
        })

        client.log({
            severityText: 'INFO',
            severityNumber: 9,
            message: 'hello',
        })

        const result = await client.shutdown()

        expect(result.accepted).toBe(1)
        expect(requests).toHaveLength(1)

        const request = requests[0] as { readonly input: RequestInfo | URL; readonly init?: RequestInit }

        if (typeof request.input !== 'string' || typeof request.init?.body !== 'string') {
            throw new Error('Expected fetch to be called with string input and body')
        }

        expect(request.input).toBe('http://collector:4000/v1/telemetry')
        expect(request.init.headers).toMatchObject({
            authorization: 'Bearer ik_live_prefix_secret',
            'x-application-id': 'application-regression',
        })

        const body = JSON.parse(request.init.body) as { readonly signals: Array<{ readonly signal_type: string }> }

        expect(body.signals).toHaveLength(1)
        expect(body.signals[0]?.signal_type).toBe('log')
    })

    test('captures http span, request sample, and route metrics with trace propagation', async () => {
        const { fetchImpl, requests } = createTelemetryFetch({ accepted: 5 })

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
        })

        client.captureHttpExchange({
            method: 'GET',
            route: '/orders/:id',
            url: '/orders/123',
            statusCode: 503,
            requestHeaders: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
            requestQuery: {},
            responseHeaders: {},
            durationMs: 42,
            captureRequestResponse: true,
            traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            parentSpanId: 'bbbbbbbbbbbbbbbb',
        })

        await client.shutdown()

        const request = requests[0] as { readonly input: RequestInfo | URL; readonly init?: RequestInit }

        if (typeof request.init?.body !== 'string') {
            throw new Error('Expected fetch body')
        }

        const body = JSON.parse(request.init.body) as {
            readonly signals: Array<{
                readonly signal_type: string
                readonly payload: {
                    readonly metric_attributes?: Record<string, string>
                    readonly metric_name?: string
                    readonly trace_id?: string
                    readonly value?: number
                }
            }>
        }

        expect(body.signals.map(signal => signal.signal_type)).toEqual([
            'span',
            'metric',
            'metric',
            'metric',
            'metric',
            'metric',
            'request_response_capture',
        ])
        expect(body.signals[0]?.payload.trace_id).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        expect(body.signals.map(signal => signal.payload.metric_name).filter(Boolean)).toEqual([
            'http.server.requests',
            'http.server.request.size',
            'http.server.response.size',
            'http.server.duration',
            'http.server.errors',
        ])
        expect(body.signals.find(signal => signal.payload.metric_name === 'http.server.request.size')?.payload.value).toBe(0)
        expect(body.signals.find(signal => signal.payload.metric_name === 'http.server.response.size')?.payload.value).toBe(0)
    })

    test('marks SSE spans and excludes them from latency histograms', async () => {
        const { fetchImpl, requests } = createTelemetryFetch({ accepted: 2 })

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
        })

        client.captureHttpExchange({
            method: 'GET',
            route: '/events',
            url: '/events',
            statusCode: 200,
            requestHeaders: { accept: 'text/event-stream' },
            requestQuery: {},
            responseHeaders: { 'content-type': 'text/event-stream' },
            durationMs: 120_000,
            requestKind: 'sse',
        })

        await client.shutdown()

        const request = requests[0] as { readonly init?: RequestInit }

        if (typeof request.init?.body !== 'string') {
            throw new Error('Expected fetch body')
        }

        const body = JSON.parse(request.init.body) as {
            readonly signals: Array<{
                readonly signal_type: string
                readonly payload: {
                    readonly metric_name?: string
                    readonly span_attributes?: Record<string, string>
                }
            }>
        }

        expect(body.signals.map(signal => signal.signal_type)).toEqual(['span', 'metric', 'metric', 'metric'])
        expect(body.signals[0]?.payload.span_attributes).toMatchObject({
            'http.request.accept': 'text/event-stream',
            'http.request.size': '0',
            'http.response.content_type': 'text/event-stream',
            'http.response.size': '0',
            'inkronik.request_kind': 'sse',
        })
        expect(body.signals.map(signal => signal.payload.metric_name).filter(Boolean)).toEqual([
            'http.server.requests',
            'http.server.request.size',
            'http.server.response.size',
        ])
    })

    test('creates a client from supported environment variables', async () => {
        const { fetchImpl, requests } = createTelemetryFetch({ applicationId: 'application-env' })

        const client = createInkronikClientFromEnv({
            env: {
                INKRONIK_COLLECTOR_URL: 'http://collector:4000/',
                INKRONIK_INGEST_API_KEY: 'ik_env_secret',
                INKRONIK_APPLICATION_ID: 'application-env',
                INKRONIK_ENVIRONMENT: 'staging',
                INKRONIK_SERVICE_NAME: 'env-service',
            },
            fetchImpl,
            flushIntervalMs: 60_000,
        })

        client.event({ name: 'startup', category: 'lifecycle' })

        const result = await client.shutdown()

        expect(result.accepted).toBe(1)

        const request = requests[0] as { readonly init?: RequestInit }

        if (typeof request.init?.body !== 'string') {
            throw new Error('Expected fetch body')
        }

        const body = JSON.parse(request.init.body) as {
            readonly signals: Array<{ readonly environment: string; readonly payload: { readonly service_name?: string } }>
        }

        expect(body.signals[0]?.environment).toBe('staging')
        expect(body.signals[0]?.payload.service_name).toBe('env-service')
    })

    const podSignals = async (options: { readonly podName?: string; readonly env?: Record<string, string | undefined> }) => {
        const { fetchImpl, requests } = createTelemetryFetch()
        const client =
            options.env === undefined
                ? new InkronikClient({
                      collectorUrl: 'http://collector:4000',
                      ingestApiKey: 'ik_live_prefix_secret',
                      serviceName: 'orders-api',
                      podName: options.podName,
                      fetchImpl,
                      flushIntervalMs: 60_000,
                  })
                : createInkronikClientFromEnv({
                      env: { INKRONIK_COLLECTOR_URL: 'http://collector:4000', INKRONIK_INGEST_API_KEY: 'ik_env_secret', ...options.env },
                      serviceName: 'orders-api',
                      fetchImpl,
                      flushIntervalMs: 60_000,
                  })

        client.log({ severityText: 'INFO', severityNumber: 9, message: 'hello' })
        client.event({ name: 'startup', category: 'lifecycle' })
        await client.shutdown()

        const body = JSON.parse((requests[0] as { readonly init: { readonly body: string } }).init.body) as {
            readonly signals: Array<{ readonly signal_type: string; readonly payload: { readonly resource_attributes?: Record<string, string> } }>
        }

        return body.signals
    }

    test('stamps the pod name as k8s.pod on log/span/metric resource attributes', async () => {
        const signals = await podSignals({ podName: 'checkout-api-7d9f' })
        const log = signals.find(signal => signal.signal_type === 'log')

        expect(log?.payload.resource_attributes?.['k8s.pod']).toBe('checkout-api-7d9f')
    })

    // Events have no resource_attributes and are not attributed to a release, so they must not be stamped.
    test('does not stamp the pod name on signal types without resource attributes', async () => {
        const signals = await podSignals({ podName: 'checkout-api-7d9f' })
        const event = signals.find(signal => signal.signal_type === 'event')

        expect(event?.payload.resource_attributes).toBeUndefined()
    })

    // In-cluster, HOSTNAME defaults to the pod name; KUBERNETES_SERVICE_HOST is the "am I in k8s" signal.
    test('derives the pod name from HOSTNAME only when running inside Kubernetes', async () => {
        const inCluster = await podSignals({
            env: { INKRONIK_SERVICE_NAME: 'orders-api', HOSTNAME: 'orders-api-abc12', KUBERNETES_SERVICE_HOST: '10.0.0.1' },
        })

        expect(inCluster.find(signal => signal.signal_type === 'log')?.payload.resource_attributes?.['k8s.pod']).toBe('orders-api-abc12')
    })

    test('does not treat HOSTNAME as a pod name off-cluster', async () => {
        const offCluster = await podSignals({ env: { INKRONIK_SERVICE_NAME: 'orders-api', HOSTNAME: 'my-laptop' } })

        expect(offCluster.find(signal => signal.signal_type === 'log')?.payload.resource_attributes?.['k8s.pod']).toBeUndefined()
    })

    test('captures outbound fetch as a child client span with trace propagation', async () => {
        const requests: Array<{ readonly input: RequestInfo | URL; readonly init?: RequestInit; readonly traceparent?: string | null }> = []
        const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : input.toString()
            // Test spy state is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            requests.push({ input, init, traceparent: input instanceof Request ? input.headers.get('traceparent') : undefined })

            if (url === 'http://collector:4000/v1/telemetry') {
                return Promise.resolve(
                    new Response(JSON.stringify({ accepted: 1, organisation_id: '101', application_id: 'application-regression' }), {
                        status: 202,
                        headers: { 'content-type': 'application/json' },
                    }),
                )
            }

            return Promise.resolve(new Response(JSON.stringify({ id: 'charge_123' }), { status: 201 }))
        }) as typeof fetch

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
        })
        const tracedFetch = client.instrumentFetch({ fetchImpl })

        await runWithTraceContext(
            {
                traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                spanId: 'bbbbbbbbbbbbbbbb',
                parentSpanId: '',
            },
            () => tracedFetch('https://payments.example.com/v1/charges?expand=customer', { method: 'POST' }),
        )

        await client.shutdown()

        const collectorRequest = requests.find(request => !(request.input instanceof Request))

        if (typeof collectorRequest?.init?.body !== 'string') {
            throw new Error('Expected collector request body')
        }

        const body = JSON.parse(collectorRequest.init.body) as {
            readonly signals: Array<{
                readonly signal_type: string
                readonly payload: {
                    readonly trace_id?: string
                    readonly span_id?: string
                    readonly parent_span_id?: string
                    readonly span_kind?: string
                    readonly http_method?: string
                    readonly http_route?: string
                    readonly http_status_code?: number
                    readonly peer_service?: string
                    readonly span_attributes?: Record<string, string>
                }
            }>
        }
        const span = body.signals.find(signal => signal.signal_type === 'span')

        expect(requests[0]?.traceparent).toBe(`00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${span?.payload.span_id}-01`)
        expect(span?.payload).toMatchObject({
            trace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            parent_span_id: 'bbbbbbbbbbbbbbbb',
            span_kind: 'client',
            http_method: 'POST',
            http_route: '/v1/charges?expand=customer',
            http_status_code: 201,
            peer_service: 'payments.example.com',
        })
        expect(span?.payload.span_attributes).toMatchObject({
            'http.host': 'payments.example.com',
            'http.scheme': 'https',
            'http.target': '/v1/charges?expand=customer',
            'http.url': 'https://payments.example.com/v1/charges?expand=customer',
        })
    })

    test('captures postgres-js queries as child database spans', async () => {
        const { fetchImpl, requests } = createTelemetryFetch({ accepted: 2 })
        const sql: PostgresJsSqlTestDouble = Object.assign(() => Promise.resolve([{ id: 'account_123' }]), {
            unsafe: () => Promise.resolve([{ ok: true }]),
        })

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
        })
        const tracedSql = client.instrumentPostgres({ databaseName: 'inkronik', peerService: 'postgres-primary', sql })

        expect(client.instrumentPostgres({ sql: tracedSql })).toBe(tracedSql)

        const tracedUnsafeSql = tracedSql.unsafe

        await runWithTraceContext(
            {
                traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                spanId: 'bbbbbbbbbbbbbbbb',
                parentSpanId: '',
            },
            async () => {
                await tracedSql`SELECT * FROM account WHERE email = ${'secret@example.com'} AND id = ${42}`
                await tracedUnsafeSql('UPDATE account SET password = $1 WHERE id = 42', ['secret'])
            },
        )

        await client.shutdown()

        const request = requests[0] as { readonly init?: RequestInit }

        if (typeof request.init?.body !== 'string') {
            throw new Error('Expected collector request body')
        }

        const body = JSON.parse(request.init.body) as {
            readonly signals: Array<{
                readonly signal_type: string
                readonly payload: {
                    readonly db_system?: string
                    readonly parent_span_id?: string
                    readonly peer_service?: string
                    readonly span_attributes?: Record<string, string>
                    readonly span_category?: string
                    readonly span_kind?: string
                    readonly trace_id?: string
                }
            }>
        }
        const spans = body.signals.filter(signal => signal.signal_type === 'span')

        expect(spans).toHaveLength(2)
        expect(spans[0]?.payload).toMatchObject({
            db_system: 'postgresql',
            parent_span_id: 'bbbbbbbbbbbbbbbb',
            peer_service: 'postgres-primary',
            span_category: 'database',
            span_kind: 'client',
            trace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })
        expect(spans[0]?.payload.span_attributes).toMatchObject({
            'db.name': 'inkronik',
            'db.operation': 'SELECT',
            'db.statement': 'SELECT * FROM account WHERE email = ? AND id = ?',
            'db.system': 'postgresql',
        })
        expect(spans[1]?.payload.span_attributes).toMatchObject({
            'db.operation': 'UPDATE',
            'db.statement': 'UPDATE account SET password = ? WHERE id = ?',
        })
    })

    test('skips postgres-js queries without active trace context', async () => {
        const { fetchImpl, requests } = createTelemetryFetch()
        const sql: PostgresJsSqlTestDouble = Object.assign(() => Promise.resolve([{ id: 'account_123' }]), {
            unsafe: () => Promise.resolve([{ ok: true }]),
        })

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
        })
        const tracedSql = client.instrumentPostgres({ databaseName: 'inkronik', peerService: 'postgres-primary', sql })

        await tracedSql`SELECT 1`
        await tracedSql.unsafe('SELECT now()')

        const result = await client.shutdown()

        expect(result.accepted).toBe(0)
        expect(requests).toHaveLength(0)
    })

    test('preserves postgres-js query modifiers for drizzle', async () => {
        const { fetchImpl, requests } = createTelemetryFetch()
        const queryState: { query?: PostgresJsQueryTestDouble } = {}
        const query = Object.assign(Promise.resolve([{ id: 'account_123' }]), {
            values: (): PostgresJsQueryTestDouble => {
                if (queryState.query === undefined) {
                    throw new Error('Expected query test double')
                }

                return queryState.query
            },
        }) satisfies PostgresJsQueryTestDouble
        // Test double state intentionally points fluent modifiers back to the same query.
        // eslint-disable-next-line functional/immutable-data
        queryState.query = query
        const sql: PostgresJsSqlTestDouble = Object.assign(() => query, {
            unsafe: () => query,
        })

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
        })
        const tracedSql = client.instrumentPostgres({ databaseName: 'inkronik', peerService: 'postgres-primary', sql })
        const result = await runWithTraceContext(
            {
                traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                spanId: 'bbbbbbbbbbbbbbbb',
                parentSpanId: '',
            },
            () => {
                const tracedQuery = tracedSql.unsafe('SELECT id FROM account WHERE email = $1', ['demo@example.com'])

                if (!hasPostgresQueryValues(tracedQuery)) {
                    throw new Error('Expected traced query to preserve values()')
                }

                return tracedQuery.values()
            },
        )

        await client.shutdown()

        expect(result).toEqual([{ id: 'account_123' }])
        expect(requests).toHaveLength(1)
    })

    test('instruments BullMQ queue add with producer spans and trace propagation', async () => {
        const { fetchImpl, requests } = createTelemetryFetch()
        const addCalls: Array<BullMQAddCall> = []

        class TestQueue {
            readonly name = 'recording-processing'

            add(name: string, data: unknown, options?: unknown) {
                // Test spy state is intentionally mutable.
                // eslint-disable-next-line functional/immutable-data
                addCalls.push({ data, name, options })

                return Promise.resolve({ id: 'recording-123', name, data })
            }
        }

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
        })
        const restore = client.instrumentBullMQ({ Queue: TestQueue })
        const queue = new TestQueue()

        await runWithTraceContext(
            {
                traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                spanId: 'bbbbbbbbbbbbbbbb',
                parentSpanId: '',
            },
            () => queue.add('process', { recordingId: 'recording-123' }, { jobId: 'recording-123' }),
        )

        restore()
        await client.shutdown()

        const request = requests[0] as { readonly init?: RequestInit }

        if (typeof request.init?.body !== 'string') {
            throw new Error('Expected collector request body')
        }

        const injectedData = addCalls[0]?.data as { readonly [inkronikTraceMetadataKey]?: { readonly traceparent?: string } }
        const body = JSON.parse(request.init.body) as {
            readonly signals: Array<{
                readonly signal_type: string
                readonly payload: {
                    readonly messaging_system?: string
                    readonly parent_span_id?: string
                    readonly span_attributes?: Record<string, string>
                    readonly span_category?: string
                    readonly span_id?: string
                    readonly span_kind?: string
                    readonly trace_id?: string
                }
            }>
        }
        const span = body.signals.find(signal => signal.signal_type === 'span')

        expect(injectedData[inkronikTraceMetadataKey]?.traceparent).toBe(`00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${span?.payload.span_id}-01`)
        expect(span?.payload).toMatchObject({
            messaging_system: 'bullmq',
            parent_span_id: 'bbbbbbbbbbbbbbbb',
            span_category: 'messaging',
            span_kind: 'producer',
            trace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })
        expect(span?.payload.span_attributes).toMatchObject({
            'messaging.destination': 'recording-processing',
            'messaging.message.id': 'recording-123',
            'messaging.message.name': 'process',
            'messaging.operation': 'publish',
            'messaging.system': 'bullmq',
        })
    })

    test('wraps BullMQ processors with consumer spans and active trace context', async () => {
        const { fetchImpl, requests } = createTelemetryFetch({ accepted: 2 })

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
        })
        const processor = client.instrumentBullMQProcessor({
            queueName: 'recording-processing',
            processor: () => {
                client.captureDatabaseQuery({
                    databaseName: 'voice_analytics',
                    durationMs: 3,
                    operation: 'SELECT',
                    peerService: 'postgres',
                    statement: 'SELECT * FROM recording WHERE uuid = ?',
                })

                return Promise.resolve('ready')
            },
        })

        const result = await processor({
            id: 'recording-123',
            name: 'process',
            data: {
                recordingId: 'recording-123',
                [inkronikTraceMetadataKey]: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
            },
        })

        await client.shutdown()

        const request = requests[0] as { readonly init?: RequestInit }

        if (typeof request.init?.body !== 'string') {
            throw new Error('Expected collector request body')
        }

        const body = JSON.parse(request.init.body) as {
            readonly signals: Array<{
                readonly signal_type: string
                readonly payload: {
                    readonly db_system?: string
                    readonly messaging_system?: string
                    readonly parent_span_id?: string
                    readonly span_attributes?: Record<string, string>
                    readonly span_category?: string
                    readonly span_id?: string
                    readonly span_kind?: string
                    readonly trace_id?: string
                }
            }>
        }
        const consumerSpan = body.signals.find(signal => signal.payload.span_category === 'messaging')
        const databaseSpan = body.signals.find(signal => signal.payload.span_category === 'database')

        expect(result).toBe('ready')
        expect(consumerSpan?.payload).toMatchObject({
            messaging_system: 'bullmq',
            parent_span_id: 'bbbbbbbbbbbbbbbb',
            span_category: 'messaging',
            span_kind: 'consumer',
            trace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })
        expect(consumerSpan?.payload.span_attributes).toMatchObject({
            'messaging.destination': 'recording-processing',
            'messaging.message.id': 'recording-123',
            'messaging.message.name': 'process',
            'messaging.operation': 'process',
            'messaging.system': 'bullmq',
        })
        expect(databaseSpan?.payload).toMatchObject({
            db_system: 'postgresql',
            parent_span_id: consumerSpan?.payload.span_id,
            span_category: 'database',
            trace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })
    })

    test('reports actionable missing environment variables', () => {
        expect(() =>
            createInkronikClientFromEnv({
                env: {
                    INKRONIK_INGEST_API_KEY: 'ik_env_secret',
                    INKRONIK_APPLICATION_ID: 'application-env',
                    INKRONIK_SERVICE_NAME: 'env-service',
                },
            }),
        ).toThrow('Missing INKRONIK_COLLECTOR_URL')

        expect(() =>
            createInkronikClientFromEnv({
                env: {
                    INKRONIK_COLLECTOR_URL: 'http://collector:4000',
                    INKRONIK_INGEST_API_KEY: 'ik_env_secret',
                    INKRONIK_APPLICATION_ID: 'application-env',
                },
            }),
        ).toThrow('Missing service name')
    })

    test('keeps flush fail-open and calls onError for collector failures', async () => {
        const errors: Array<Error> = []
        const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
            void input
            void init

            return Promise.resolve(
                new Response('collector unavailable', {
                    status: 503,
                }),
            )
        }) as typeof fetch

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
            onError: error => {
                // Test spy state is intentionally mutable.
                // eslint-disable-next-line functional/immutable-data
                errors.push(error)
            },
        })

        client.log({
            severityText: 'INFO',
            severityNumber: 9,
            message: 'hello',
        })

        const result = await client.shutdown()

        expect(result.accepted).toBe(0)
        expect(errors).toHaveLength(1)
        expect(errors[0]?.message).toContain('HTTP 503')
    })

    test('bounds the telemetry queue and drops oldest signals when overloaded', async () => {
        const requests: Array<{ readonly init?: RequestInit }> = []
        const errors: Array<Error> = []
        const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) => {
            // Test spy state is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            requests.push({ init })

            return Promise.resolve(
                new Response(JSON.stringify({ accepted: 2, organisation_id: '101', application_id: 'application-regression' }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                }),
            )
        }) as typeof fetch

        const client = new InkronikClient({
            collectorUrl: 'http://collector:4000',
            ingestApiKey: 'ik_live_prefix_secret',
            applicationId: 'application-regression',
            serviceName: 'orders-api',
            fetchImpl,
            flushIntervalMs: 60_000,
            maxBatchSize: 10,
            maxQueueSize: 2,
            onError: error => {
                // Test spy state is intentionally mutable.
                // eslint-disable-next-line functional/immutable-data
                errors.push(error)
            },
        })

        ;['first', 'second', 'third'].forEach(message =>
            client.log({
                severityText: 'INFO',
                severityNumber: 9,
                message,
            }),
        )

        await client.shutdown()

        const request = requests[0] as { readonly init?: RequestInit }

        if (typeof request.init?.body !== 'string') {
            throw new Error('Expected fetch body')
        }

        const body = JSON.parse(request.init.body) as { readonly signals: Array<{ readonly payload: { readonly message: string } }> }

        expect(errors[0]?.message).toContain('queue is full')
        expect(body.signals.map(signal => signal.payload.message)).toEqual(['second', 'third'])
    })
})
