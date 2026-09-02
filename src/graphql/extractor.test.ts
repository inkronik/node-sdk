import { describe, expect, test } from 'bun:test'
import { extractGraphqlRequest, getGraphqlErrorCount, resolveGraphqlCaptureOptions } from './extractor.js'

const defaultOptions = resolveGraphqlCaptureOptions()

describe('GraphQL request extraction', () => {
    test('extracts a named operation without retaining its document by default', () => {
        const result = extractGraphqlRequest({
            body: {
                operationName: 'GetOrder',
                query: 'query GetOrder($id: ID!) { order(id: $id) { id } }',
                variables: { id: 'order-secret' },
            },
            options: defaultOptions,
        })

        expect(result).toEqual({ operationName: 'GetOrder', operationType: 'query', persisted: false })
    })

    test('sanitizes literals, defaults, directives, and comments in an opt-in document', () => {
        const result = extractGraphqlRequest({
            body: {
                operationName: 'UpdateOrder',
                query: `
                    # developer-only comment
                    mutation UpdateOrder($limit: Int = 25) {
                        updateOrder(email: "private@example.com", priority: HIGH, enabled: true)
                            @include(if: true) { id }
                    }
                `,
            },
            options: resolveGraphqlCaptureOptions({ captureDocument: 'sanitized' }),
        })

        expect(result).toMatchObject({ operationName: 'UpdateOrder', operationType: 'mutation', persisted: false })
        expect(result?.document).toContain('mutation UpdateOrder($limit: Int = 0)')
        expect(result?.document).toContain('email: "[REDACTED]"')
        expect(result?.document).toContain('priority: REDACTED')
        expect(result?.document).not.toContain('private@example.com')
        expect(result?.document).not.toContain('developer-only comment')
        expect(result?.document).not.toContain('25')
    })

    test('supports anonymous, persisted, and batched operation fallbacks', () => {
        expect(
            extractGraphqlRequest({
                body: { query: 'mutation { cancelOrder(id: "secret") { id } }' },
                options: defaultOptions,
            }),
        ).toEqual({ operationType: 'mutation', persisted: false })

        expect(
            extractGraphqlRequest({
                body: { extensions: { persistedQuery: { sha256Hash: 'not-retained' } } },
                options: defaultOptions,
            }),
        ).toEqual({ operationType: 'unknown', persisted: true })

        expect(
            extractGraphqlRequest({
                body: [
                    { operationName: 'Orders', query: 'query Orders { orders { id } }' },
                    { operationName: 'Viewer', query: 'query Viewer { viewer { id } }' },
                ],
                options: defaultOptions,
            }),
        ).toEqual({ batchCount: 2, operationType: 'unknown', persisted: false })
    })

    test('fails closed for malformed, ambiguous, and overlong operations', () => {
        expect(extractGraphqlRequest({ body: { query: 'not graphql {' }, options: defaultOptions })).toBeUndefined()
        expect(
            extractGraphqlRequest({
                body: [{ operationName: 'Valid', query: 'query Valid { viewer { id } }' }, { query: 'not graphql {' }],
                options: defaultOptions,
            }),
        ).toBeUndefined()
        expect(
            extractGraphqlRequest({
                body: { query: 'query One { one } query Two { two }' },
                options: defaultOptions,
            }),
        ).toBeUndefined()
        expect(
            extractGraphqlRequest({
                body: { operationName: 'A'.repeat(129), query: `query ${'A'.repeat(129)} { viewer { id } }` },
                options: defaultOptions,
            }),
        ).toMatchObject({ operationType: 'query' })
    })
})

describe('GraphQL response errors', () => {
    test('counts errors in single, serialized, and batched responses', () => {
        expect(getGraphqlErrorCount({ data: null, errors: [{ message: 'one' }] })).toBe(1)
        expect(getGraphqlErrorCount('{"data":null,"errors":[{},{}]}')).toBe(2)
        expect(getGraphqlErrorCount([{ errors: [{}] }, { data: { ok: true } }])).toBe(1)
        expect(getGraphqlErrorCount('not-json')).toBe(0)
    })
})
