import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mode = process.argv[2]

assert.ok(mode === 'cjs' || mode === 'esm', 'Expected runtime mode: cjs or esm')

const load = specifier => (mode === 'cjs' ? Promise.resolve(require(specifier)) : import(specifier))
const [auto, nest, root, rxjs] = await Promise.all([
    load('@inkronik/node-sdk/auto'),
    load('@inkronik/node-sdk/nest'),
    load('@inkronik/node-sdk'),
    load('rxjs'),
])
const pg = require('pg')
const originalClientQuery = pg.Client.prototype.query
const collectorRequests = []
const responseHeaders = new Map()

pg.Client.prototype.query = function query() {
    return Promise.resolve({ command: 'SELECT', rows: [{ id: 'order_123' }] })
}

const fetchImpl = async (_input, init) => {
    assert.equal(typeof init?.body, 'string')
    collectorRequests.push(JSON.parse(init.body))

    return new Response(JSON.stringify({ accepted: 2, application_id: 'application-test', organisation_id: 'organisation-test' }), {
        headers: { 'content-type': 'application/json' },
        status: 202,
    })
}

const client = auto.initInkronik({
    env: {
        INKRONIK_APPLICATION_ID: 'application-test',
        INKRONIK_COLLECTOR_URL: 'http://collector.test',
        INKRONIK_INGEST_API_KEY: 'ik_test_secret',
        INKRONIK_SERVICE_NAME: 'orders-api',
    },
    fetchImpl,
    flushIntervalMs: 60_000,
    instrumentations: {
        bullMQ: false,
        fetch: false,
        pg: true,
        postgres: false,
        runtimeMetrics: false,
    },
})

try {
    assert.equal(root.getDefaultInkronikClient(), client, `${mode} entrypoints did not share the default client`)

    const interceptor = new nest.InkronikNestInterceptor(client, {
        autoInstrumentFetch: false,
        captureRequestResponse: false,
        metrics: { enabled: false },
    })
    const executionContext = {
        switchToHttp: () => ({
            getRequest: () => ({
                body: undefined,
                headers: {},
                method: 'GET',
                originalUrl: '/orders',
                query: {},
                route: { path: '/orders' },
                url: '/orders',
            }),
            getResponse: () => ({
                getHeaders: () => Object.fromEntries(responseHeaders),
                setHeader: (name, value) => responseHeaders.set(name, value),
                statusCode: 200,
            }),
        }),
    }
    const next = {
        handle: () =>
            new rxjs.Observable(subscriber => {
                void new pg.Client().query('SELECT id FROM orders WHERE id = $1', ['order_123']).then(
                    result => {
                        subscriber.next(result)
                        subscriber.complete()
                    },
                    error => subscriber.error(error),
                )
            }),
    }

    await new Promise((resolve, reject) => {
        interceptor.intercept(executionContext, next).subscribe({ complete: resolve, error: reject })
    })
    await client.flush()

    const signals = collectorRequests.flatMap(request => request.signals)
    const spans = signals.filter(signal => signal.signal_type === 'span')
    const requestSpan = spans.find(signal => signal.payload.span_kind === 'server')
    const databaseSpan = spans.find(signal => signal.payload.span_category === 'database')

    assert.ok(requestSpan, `${mode} did not capture the NestJS request span`)
    assert.ok(databaseSpan, `${mode} did not capture the pg child span`)
    assert.equal(databaseSpan.payload.trace_id, requestSpan.payload.trace_id, `${mode} did not preserve the trace across entrypoints`)
    assert.equal(databaseSpan.payload.parent_span_id, requestSpan.payload.span_id, `${mode} did not link the pg span to its request`)
    assert.match(responseHeaders.get('traceparent'), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u)
} finally {
    await auto.shutdownInkronik()
    pg.Client.prototype.query = originalClientQuery
}
