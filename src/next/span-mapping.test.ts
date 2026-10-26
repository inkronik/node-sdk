import { describe, expect, test } from 'bun:test'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { ReadableSpan } from '@opentelemetry/sdk-trace'
import { MAX_ATTRIBUTE_COUNT, MAX_ATTRIBUTE_VALUE_LENGTH } from './constants.js'
import { mapReadableSpan, serializeAttributes } from './span-mapping.js'

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

describe('serializeAttributes', () => {
    test('preserves simple OpenTelemetry values using the string attribute protocol', () => {
        expect(
            serializeAttributes({
                attributes: {
                    boolean: true,
                    booleans: [true, false],
                    number: 42,
                    numbers: [1, 2, 3],
                    string: 'ok',
                    strings: ['a', null, undefined, 'b'],
                },
            }),
        ).toEqual({ boolean: 'true', booleans: 'true,false', number: '42', numbers: '1,2,3', string: 'ok', strings: 'a,,,b' })
    })

    test('drops complex and unsupported values without invoking object coercion', () => {
        const recursive = {
            get self(): unknown {
                return recursive
            },
        }
        const unsupported = {
            arrayOfObjects: [{ token: 'private' }],
            bigint: 1n,
            bytes: new Uint8Array([1, 2]),
            function: () => 'private',
            mixedArray: ['ok', 1],
            nestedArray: [['private']],
            null: null,
            object: {
                toString: () => {
                    throw new Error('Attribute coercion must not run')
                },
            },
            recursive,
            symbol: Symbol('private'),
            undefined,
        }

        expect(serializeAttributes({ attributes: { ...unsupported, valid: 'ok' } })).toEqual({ valid: 'ok' })
    })

    test('keeps query removal and bounds after unsupported attributes are dropped', () => {
        const mapped = serializeAttributes({
            attributes: {
                'url.query': 'token=secret',
                'url.full': 'https://shop.example/orders?token=secret',
                unsupported: { secret: true },
                long: 'x'.repeat(MAX_ATTRIBUTE_VALUE_LENGTH + 1),
                ...Object.fromEntries(Array.from({ length: MAX_ATTRIBUTE_COUNT + 1 }, (_, index) => [`attribute.${index}`, index])),
            },
        })

        expect(mapped['url.query']).toBeUndefined()
        expect(mapped.unsupported).toBeUndefined()
        expect(mapped['url.full']).toBe('/orders')
        expect(mapped.long).toHaveLength(MAX_ATTRIBUTE_VALUE_LENGTH)
        expect(Object.keys(mapped)).toHaveLength(MAX_ATTRIBUTE_COUNT)
    })
})
