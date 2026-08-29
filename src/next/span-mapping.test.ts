import { describe, expect, test } from 'bun:test'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { mapReadableSpan } from './span-mapping.js'

const createReadableSpan = (attributes: ReadableSpan['attributes']): ReadableSpan =>
    ({
        attributes,
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
        duration: [0, 25_000_000],
        ended: true,
        endTime: [1_700_000_000, 25_000_000],
        events: [],
        instrumentationScope: { name: 'next.js' },
        kind: SpanKind.SERVER,
        links: [],
        name: 'GET /orders/[id]',
        resource: resourceFromAttributes({ 'service.name': 'storefront' }),
        spanContext: () => ({
            spanId: '0123456789abcdef',
            traceFlags: 1,
            traceId: '0123456789abcdef0123456789abcdef',
        }),
        startTime: [1_700_000_000, 0],
        status: { code: SpanStatusCode.OK },
    }) as ReadableSpan

describe('mapReadableSpan', () => {
    test('maps a Next.js request span without query data', () => {
        const mapped = mapReadableSpan({
            captureNextFetchSpans: false,
            collectorUrl: 'https://collector.inkronik.com',
            span: createReadableSpan({
                'http.request.method': 'GET',
                'http.response.status_code': 200,
                'next.route': '/orders/[id]',
                'next.span_type': 'BaseServer.handleRequest',
                'url.full': 'https://shop.example/orders/123?token=secret',
            }),
        })

        expect(mapped).toMatchObject({
            input: {
                durationUs: 25_000,
                httpMethod: 'GET',
                httpRoute: '/orders/[id]',
                httpStatusCode: 200,
                kind: 'server',
                statusCode: 'ok',
            },
            isRootServerSpan: true,
        })
        expect(mapped?.input.attributes?.['url.full']).toBe('/orders/123')
    })

    test('drops the duplicate Next.js fetch span by default', () => {
        const mapped = mapReadableSpan({
            captureNextFetchSpans: false,
            collectorUrl: 'https://collector.inkronik.com',
            span: createReadableSpan({
                'next.span_type': 'AppRender.fetch',
                'url.full': 'https://api.example/orders',
            }),
        })

        expect(mapped).toBeNull()
    })

    test('drops telemetry delivery spans', () => {
        const mapped = mapReadableSpan({
            captureNextFetchSpans: true,
            collectorUrl: 'https://collector.inkronik.com/v1/telemetry',
            span: createReadableSpan({
                'http.request.method': 'POST',
                'url.full': 'https://collector.inkronik.com/v1/telemetry',
            }),
        })

        expect(mapped).toBeNull()
    })
})
