import { initInkronik } from '../auto'

const captureTelemetry = new Proxy(fetch, {
    apply: (_target, _thisArgument, argumentsList) => {
        const requestInit = argumentsList[1]
        const body = typeof requestInit === 'object' && requestInit !== null && 'body' in requestInit ? requestInit.body : undefined

        if (typeof body === 'string') {
            process.stdout.write(body)
        }

        return Promise.resolve(
            new Response(JSON.stringify({ accepted: 1, organisation_id: '101', application_id: 'application-preload-fixture' }), {
                status: 202,
                headers: { 'content-type': 'application/json' },
            }),
        )
    },
})

initInkronik({
    env: {
        INKRONIK_COLLECTOR_URL: 'http://collector:4000',
        INKRONIK_INGEST_API_KEY: 'ik_live_fixture_secret',
        INKRONIK_APPLICATION_ID: 'application-preload-fixture',
        INKRONIK_SERVICE_NAME: 'preload-fixture',
    },
    fetchImpl: captureTelemetry,
    instrumentations: { bullMQ: false, fetch: false, runtimeMetrics: false },
})
