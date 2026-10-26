import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mode = process.argv[2]

assert.ok(mode === 'cjs' || mode === 'esm', 'Expected runtime mode: cjs or esm')

process.env.NEXT_RUNTIME = 'nodejs'

const load = specifier => (mode === 'cjs' ? Promise.resolve(require(specifier)) : import(specifier))
const [next, root, api] = await Promise.all([load('@inkronik/node-sdk/next'), load('@inkronik/node-sdk'), load('@opentelemetry/api')])
const { context, propagation, ROOT_CONTEXT, trace } = api
const requests = []
const options = {
    env: {
        INKRONIK_COLLECTOR_URL: 'http://collector.test',
        INKRONIK_INGEST_API_KEY: 'ik_test_next_provider',
        INKRONIK_SERVICE_NAME: 'next-provider-fixture',
    },
    fetchImpl: async (_input, init) => {
        assert.equal(typeof init?.body, 'string')
        const request = JSON.parse(init.body)
        requests.push(request)
        return Response.json({ accepted: request.signals.length, application_id: 'next-provider-fixture', organisation_id: 'test' }, { status: 202 })
    },
    flushIntervalMs: 60_000,
    instrumentations: { bullMQ: false, fetch: false, http: false, pg: false, postgres: false, runtimeMetrics: false },
}
const incomingTraceId = '1234567890abcdef1234567890abcdef'
const incomingSpanId = '1234567890abcdef'

try {
    await Promise.all([next.registerInkronikNext(options), next.registerInkronikNext(options)])

    const parentContext = propagation.extract(ROOT_CONTEXT, {
        baggage: 'fixture-tenant=example',
        traceparent: `00-${incomingTraceId}-${incomingSpanId}-01`,
    })
    const tracer = trace.getTracer('inkronik-next-provider-fixture')
    let rootSpanId

    await context.with(parentContext, () =>
        tracer.startActiveSpan('migration-root', async span => {
            rootSpanId = span.spanContext().spanId
            span.setAttribute('http.request.method', 'GET')
            span.setAttribute('next.span_type', 'BaseServer.handleRequest')
            span.setAttribute('url.full', 'https://app.test/orders?token=private')
            span.setAttribute('simple.tags', ['first', 'second'])
            span.setAttribute('complex.value', { token: 'private' })
            await new Promise(resolve => setTimeout(resolve, 1))
            assert.equal(trace.getActiveSpan()?.spanContext().spanId, rootSpanId, `${mode} lost active context across an async boundary`)
            assert.equal(propagation.getBaggage(context.active())?.getEntry('fixture-tenant')?.value, 'example')

            await tracer.startActiveSpan('migration-child', async child => {
                await Promise.resolve()
                assert.equal(trace.getActiveSpan()?.spanContext().spanId, child.spanContext().spanId)
                const carrier = {}
                propagation.inject(context.active(), carrier)
                assert.equal(carrier.traceparent, `00-${incomingTraceId}-${child.spanContext().spanId}-01`)
                assert.equal(carrier.baggage, 'fixture-tenant=example')
                child.end()
            })

            assert.equal(trace.getActiveSpan()?.spanContext().spanId, rootSpanId)
            span.end()
        }),
    )

    const client = root.getDefaultInkronikClient()
    assert.ok(client)
    await client.flush()

    const spans = requests.flatMap(request => request.signals).filter(signal => signal.signal_type === 'span')
    const parent = spans.filter(signal => signal.payload.operation_name === 'migration-root')
    const child = spans.find(signal => signal.payload.operation_name === 'migration-child')
    assert.equal(parent.length, 1, `${mode} registered duplicate providers or failed to export the request`)
    assert.ok(child, `${mode} did not export the child span`)
    assert.equal(parent[0].payload.trace_id, incomingTraceId)
    assert.equal(parent[0].payload.parent_span_id, incomingSpanId)
    assert.equal(parent[0].payload.service_name, 'next-provider-fixture')
    assert.equal(parent[0].payload.span_attributes['url.full'], '/orders')
    assert.equal(parent[0].payload.span_attributes['simple.tags'], 'first,second')
    assert.equal(parent[0].payload.span_attributes['complex.value'], undefined)
    assert.equal(child.payload.trace_id, incomingTraceId)
    assert.equal(child.payload.parent_span_id, rootSpanId)
    assert.equal(trace.getActiveSpan(), undefined)
} finally {
    await next.shutdownInkronikNext()
    trace.disable()
    propagation.disable()
    context.disable()
}
