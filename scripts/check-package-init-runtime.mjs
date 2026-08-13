import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mode = process.argv[2]

assert.ok(mode === 'cjs' || mode === 'esm', 'Expected runtime mode: cjs or esm')

const load = specifier => (mode === 'cjs' ? Promise.resolve(require(specifier)) : import(specifier))
const pg = require('pg')
const originalClientQuery = pg.Client.prototype.query
const originalFetch = globalThis.fetch
const fetchImpl = async () =>
    new Response(JSON.stringify({ accepted: 0, application_id: 'application-init', organisation_id: 'organisation-init' }), {
        headers: { 'content-type': 'application/json' },
        status: 202,
    })

process.env.INKRONIK_APPLICATION_ID = 'application-init'
process.env.INKRONIK_COLLECTOR_URL = 'http://collector.test'
process.env.INKRONIK_INGEST_API_KEY = 'ik_test_secret'
process.env.INKRONIK_SERVICE_NAME = 'init-runtime'
globalThis.fetch = fetchImpl

try {
    await load('@inkronik/node-sdk/init')

    const [auto, root] = await Promise.all([load('@inkronik/node-sdk/auto'), load('@inkronik/node-sdk')])

    assert.ok(root.getDefaultInkronikClient(), `${mode} init did not initialize the default client`)
    assert.notEqual(globalThis.fetch, fetchImpl, `${mode} init did not instrument global fetch`)
    assert.notEqual(pg.Client.prototype.query, originalClientQuery, `${mode} init did not instrument pg`)

    await auto.shutdownInkronik()

    assert.equal(globalThis.fetch, fetchImpl, `${mode} shutdown did not restore global fetch`)
    assert.equal(pg.Client.prototype.query, originalClientQuery, `${mode} shutdown did not restore pg`)
} finally {
    globalThis.fetch = originalFetch
    pg.Client.prototype.query = originalClientQuery
}
