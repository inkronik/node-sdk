import 'reflect-metadata'
import { describe, expect, test } from 'bun:test'
import { InkronikClient } from '../client.js'
import { setDefaultInkronikClient } from '../env.js'
import type { IngestTelemetrySignal } from '../protocol/types.js'
import { InkronikSpan } from './span.js'

describe('InkronikSpan', () => {
    test('wraps a method with the default client and preserves method metadata', async () => {
        const telemetryState: { body?: string } = {}
        const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
            // Test collector state is intentionally mutable.
            // eslint-disable-next-line functional/immutable-data
            telemetryState.body = typeof init?.body === 'string' ? init.body : undefined

            return Promise.resolve(
                new Response(JSON.stringify({ accepted: 2, organisation_id: '101', application_id: 'application-regression' }), {
                    status: 202,
                    headers: { 'content-type': 'application/json' },
                }),
            )
        }) as typeof fetch
        const client = setDefaultInkronikClient(
            new InkronikClient({
                collectorUrl: 'http://collector:4000',
                ingestApiKey: 'ik_live_prefix_secret',
                serviceName: 'billing-worker',
                fetchImpl,
                flushIntervalMs: 60_000,
            }),
        )
        const worker = {
            prefix: 'billing',
            reconcile(suffix: string): Promise<string> {
                client.captureLoggerRecord({ level: 'info', message: 'Running decorated cron' })

                return Promise.resolve(`${this.prefix}.${suffix}`)
            },
        }
        const descriptor = Object.getOwnPropertyDescriptor(worker, 'reconcile')
        const originalMethod: unknown = descriptor?.value

        if (descriptor === undefined || typeof originalMethod !== 'function') {
            throw new Error('Expected reconcile method descriptor')
        }

        Reflect.defineMetadata('schedule.cron', '0 * * * *', originalMethod)
        const decoratedDescriptor = InkronikSpan({
            name: 'billing.reconcile',
            category: 'scheduled',
        })(worker, 'reconcile', descriptor)

        // Applying a method decorator replaces the property descriptor by design.
        // eslint-disable-next-line functional/immutable-data
        Object.defineProperty(worker, 'reconcile', decoratedDescriptor ?? descriptor)

        const decoratedMethod: unknown = Object.getOwnPropertyDescriptor(worker, 'reconcile')?.value

        if (typeof decoratedMethod !== 'function') {
            throw new Error('Expected decorated reconcile method')
        }

        expect(Reflect.getOwnMetadata('schedule.cron', decoratedMethod)).toBe('0 * * * *')
        expect(await worker.reconcile('complete')).toBe('billing.complete')
        await client.shutdown()

        if (telemetryState.body === undefined) {
            throw new Error('Expected collector request body')
        }

        const signals = (JSON.parse(telemetryState.body) as { readonly signals: ReadonlyArray<IngestTelemetrySignal> }).signals
        const span = signals.find(signal => signal.signal_type === 'span')
        const log = signals.find(signal => signal.signal_type === 'log')

        expect(span?.payload).toMatchObject({
            operation_name: 'billing.reconcile',
            span_kind: 'internal',
            span_category: 'scheduled',
            status_code: 'ok',
        })
        expect(log?.payload).toMatchObject({
            trace_id: span?.payload.trace_id,
            span_id: span?.payload.span_id,
        })
    })
})
