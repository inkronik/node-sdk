import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const projectDirectory = fileURLToPath(new URL('..', import.meta.url))
const fixtureDirectory = fileURLToPath(new URL('./fixtures/next-app', import.meta.url))
const nextExecutable = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url))
const appPort = 30_000 + (process.pid % 10_000)
const collectorPayloads = []
const incomingTraceId = '1234567890abcdef1234567890abcdef'

const collector = createServer((request, response) => {
    const chunks = []

    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        collectorPayloads.push(body)
        response.writeHead(202, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ accepted: body.signals.length, application_id: 'next-fixture', organisation_id: 'test' }))
    })
})

await new Promise((resolve, reject) => {
    collector.once('error', reject)
    collector.listen(0, '127.0.0.1', resolve)
})

const collectorAddress = collector.address()

assert.ok(typeof collectorAddress === 'object' && collectorAddress !== null)

const serverOutput = []
const nextServer = spawn(process.execPath, [nextExecutable, 'start', fixtureDirectory, '--port', String(appPort)], {
    cwd: projectDirectory,
    env: {
        ...process.env,
        INKRONIK_COLLECTOR_URL: `http://127.0.0.1:${collectorAddress.port}`,
        INKRONIK_INGEST_API_KEY: 'ik_test_next_fixture',
        INKRONIK_SERVICE_NAME: 'next-fixture',
        NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
})

nextServer.stdout.on('data', chunk => serverOutput.push(chunk.toString()))
nextServer.stderr.on('data', chunk => serverOutput.push(chunk.toString()))

const waitFor = async predicate => {
    const deadline = Date.now() + 30_000

    while (Date.now() < deadline) {
        if (await predicate()) {
            return
        }

        await new Promise(resolve => setTimeout(resolve, 100))
    }

    throw new Error(`Next.js fixture timed out:\n${serverOutput.join('')}`)
}

try {
    await waitFor(() =>
        fetch(`http://127.0.0.1:${appPort}/`).then(
            response => response.ok,
            () => false,
        ),
    )
    const healthResponse = await fetch(`http://127.0.0.1:${appPort}/api/health`, {
        headers: { traceparent: `00-${incomingTraceId}-1234567890abcdef-01` },
    })
    const failureResponse = await fetch(`http://127.0.0.1:${appPort}/api/fail`)
    const edgeResponse = await fetch(`http://127.0.0.1:${appPort}/api/edge`)

    assert.equal(healthResponse.status, 200)
    assert.equal(failureResponse.status, 500)
    assert.equal(edgeResponse.status, 200)

    await waitFor(() => {
        const signals = collectorPayloads.flatMap(payload => payload.signals)
        return (
            signals.some(signal => signal.signal_type === 'span' && signal.payload.trace_id === incomingTraceId) &&
            signals.some(signal => signal.signal_type === 'event' && signal.payload.event_name === 'nextjs.request.error')
        )
    })

    const signals = collectorPayloads.flatMap(payload => payload.signals)
    const spans = signals.filter(signal => signal.signal_type === 'span')
    const serverSpan = spans.find(span => span.payload.span_kind === 'server' && span.payload.trace_id === incomingTraceId)

    assert.ok(serverSpan, 'Next.js did not emit a server span through Inkronik')
    assert.match(serverSpan.payload.trace_id, /^[0-9a-f]{32}$/u)
    assert.match(serverSpan.payload.span_id, /^[0-9a-f]{16}$/u)
    assert.equal(serverSpan.payload.service_name, 'next-fixture')
} finally {
    nextServer.kill('SIGTERM')
    await new Promise(resolve => collector.close(resolve))
}
