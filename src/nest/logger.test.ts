import { describe, expect, test } from 'bun:test'
import type { LoggerService } from '@nestjs/common'
import { InkronikClient } from '../client.js'
import { InkronikNestLogger } from './logger.js'

interface SentRequest {
    readonly init?: RequestInit
}

const silentLogger: LoggerService = {
    log: () => undefined,
    error: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
    fatal: () => undefined,
}

const createTestClient = () => {
    const requests: Array<SentRequest> = []
    const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) => {
        // Test spy state is intentionally mutable.
        // eslint-disable-next-line functional/immutable-data
        requests.push({ init })

        return Promise.resolve(
            new Response(JSON.stringify({ accepted: 2, organisation_id: '101', application_id: 'application-nest' }), {
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

const getLogPayloads = (request: SentRequest) => {
    if (typeof request.init?.body !== 'string') {
        throw new Error('Expected fetch body')
    }

    return (
        JSON.parse(request.init.body) as {
            readonly signals: Array<{
                readonly payload: {
                    readonly severity_text: string
                    readonly message: string
                    readonly log_attributes: Record<string, string>
                }
            }>
        }
    ).signals.map(signal => ({
        severityText: signal.payload.severity_text,
        message: signal.payload.message,
        attributes: signal.payload.log_attributes,
    }))
}

describe('InkronikNestLogger', () => {
    test('forwards Nest logs with levels and context', async () => {
        const { client, requests } = createTestClient()
        const logger = new InkronikNestLogger({ client, consoleLogger: silentLogger })

        logger.log('Application started', 'NestApplication')
        logger.error(new Error('Database unavailable'), 'DatabaseService')
        await client.shutdown()

        expect(getLogPayloads(requests[0] as SentRequest)).toEqual([
            {
                severityText: 'INFO',
                message: 'Application started',
                attributes: { 'nest.context': 'NestApplication' },
            },
            {
                severityText: 'ERROR',
                message: 'Database unavailable',
                attributes: {
                    'nest.context': 'DatabaseService',
                    'error.name': 'Error',
                    'error.message': 'Database unavailable',
                },
            },
        ])
    })
})
