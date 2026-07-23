import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { initInkronik, shutdownInkronik } from './auto.js'
import { runWithTraceContext } from './trace-context.js'

describe('initInkronik', () => {
    test('instruments a static postgres import when the agent is preloaded', async () => {
        const fixturesDirectory = join(import.meta.dir, 'fixtures')
        const subprocess = Bun.spawn(
            [
                process.execPath,
                '--preload',
                join(fixturesDirectory, 'postgres-preload.ts'),
                join(fixturesDirectory, 'postgres-static-application.ts'),
            ],
            { stderr: 'pipe', stdout: 'pipe' },
        )
        const [exitCode, stderr, stdout] = await Promise.all([
            subprocess.exited,
            new Response(subprocess.stderr).text(),
            new Response(subprocess.stdout).text(),
        ])

        expect(stderr).toBe('')
        expect(exitCode).toBe(0)
        const body = JSON.parse(stdout) as {
            readonly signals: Array<{
                readonly signal_type: string
                readonly payload: {
                    readonly span_attributes?: Record<string, string>
                    readonly span_category?: string
                }
            }>
        }
        const span = body.signals.find(signal => signal.signal_type === 'span')

        expect(span?.payload).toMatchObject({ span_category: 'database' })
        expect(span?.payload.span_attributes).toMatchObject({
            'db.name': 'static_fixture',
            'db.operation': 'SELECT',
            'db.statement': 'SELECT id FROM account WHERE email = ?',
        })
    })

    test('initializes the default agent and instruments global fetch', async () => {
        const originalFetch = globalThis.fetch
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

            return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        }) as typeof fetch

        // Global patching is the behavior under test.
        // eslint-disable-next-line functional/immutable-data
        globalThis.fetch = fetchImpl

        try {
            const client = initInkronik({
                env: {
                    INKRONIK_COLLECTOR_URL: 'http://collector:4000',
                    INKRONIK_INGEST_API_KEY: 'ik_live_prefix_secret',
                    INKRONIK_APPLICATION_ID: 'application-regression',
                    INKRONIK_SERVICE_NAME: 'orders-api',
                },
                instrumentations: { runtimeMetrics: false },
            })

            expect(globalThis.fetch).not.toBe(fetchImpl)

            await runWithTraceContext(
                {
                    traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    spanId: 'bbbbbbbbbbbbbbbb',
                    parentSpanId: '',
                },
                () => fetch('https://payments.example.com/v1/charges'),
            )

            await client.shutdown()

            expect(globalThis.fetch).toBe(fetchImpl)
            expect(requests[0]?.traceparent).toMatch(/^00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-[0-9a-f]{16}-01$/u)
        } finally {
            await shutdownInkronik()
            // Restore the real process global for the rest of the suite.
            // eslint-disable-next-line functional/immutable-data
            globalThis.fetch = originalFetch
        }
    })

    test('automatically instruments postgres-js loaded after the agent', async () => {
        const requests: Array<{ readonly input: RequestInfo | URL; readonly init?: RequestInit }> = []
        const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
            // Test spy state is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            requests.push({ input, init })

            return Promise.resolve(
                new Response(JSON.stringify({ accepted: 1, organisation_id: '101', application_id: 'application-regression' }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                }),
            )
        }) as typeof fetch
        const queryState: { query?: Promise<ReadonlyArray<ReadonlyArray<string>>> & { values: () => unknown } } = {}
        const query = Object.assign(Promise.resolve([['account_123']]), {
            values: () => queryState.query,
        })
        // Test double state intentionally points fluent modifiers back to the same query.
        // eslint-disable-next-line functional/immutable-data
        queryState.query = query

        try {
            const client = initInkronik({
                env: {
                    INKRONIK_COLLECTOR_URL: 'http://collector:4000',
                    INKRONIK_INGEST_API_KEY: 'ik_live_prefix_secret',
                    INKRONIK_APPLICATION_ID: 'application-regression',
                    INKRONIK_SERVICE_NAME: 'orders-api',
                },
                fetchImpl,
                flushIntervalMs: 60_000,
                instrumentations: { bullMQ: false, fetch: false, postgres: true, runtimeMetrics: false },
            })
            const { default: postgres } = await import('postgres')
            const sql = postgres('postgres://postgres:postgres@localhost:5432/orders', { max: 0 })

            expect(Reflect.get(sql, Symbol.for('inkronik.instrumentedPostgres'))).toBe(true)
            expect(client.instrumentPostgres({ sql })).toBe(sql)
            expect(Reflect.set(sql, 'unsafe', () => query)).toBe(true)

            const result = await runWithTraceContext(
                {
                    traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                    spanId: 'bbbbbbbbbbbbbbbb',
                    parentSpanId: '',
                },
                () => sql.unsafe('SELECT id FROM account WHERE email = $1', ['demo@codemask.com']).values() as unknown,
            )

            expect(result as unknown).toEqual([['account_123']])
            await sql.end()
            await shutdownInkronik()

            const request = requests[0] as { readonly init?: RequestInit }

            if (typeof request.init?.body !== 'string') {
                throw new Error('Expected collector request body')
            }

            const body = JSON.parse(request.init.body) as {
                readonly signals: Array<{
                    readonly signal_type: string
                    readonly payload: {
                        readonly peer_service?: string
                        readonly span_attributes?: Record<string, string>
                        readonly span_category?: string
                    }
                }>
            }
            const span = body.signals.find(signal => signal.signal_type === 'span')

            expect(span?.payload).toMatchObject({
                peer_service: 'postgres',
                span_category: 'database',
            })
            expect(span?.payload.span_attributes).toMatchObject({
                'db.name': 'orders',
                'db.operation': 'SELECT',
                'db.statement': 'SELECT id FROM account WHERE email = ?',
            })

            initInkronik({
                env: {
                    INKRONIK_COLLECTOR_URL: 'http://collector:4000',
                    INKRONIK_INGEST_API_KEY: 'ik_live_prefix_secret',
                    INKRONIK_APPLICATION_ID: 'application-regression',
                    INKRONIK_SERVICE_NAME: 'orders-api',
                },
                fetchImpl,
                instrumentations: { bullMQ: false, fetch: false, postgres: false, runtimeMetrics: false },
            })

            const uninstrumentedSql = postgres({ max: 0 })

            expect(Reflect.get(uninstrumentedSql, Symbol.for('inkronik.instrumentedPostgres'))).toBeUndefined()
            await uninstrumentedSql.end()
        } finally {
            await shutdownInkronik()
        }
    })
})
