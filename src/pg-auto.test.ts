/* eslint-disable max-classes-per-file -- The pg test module intentionally mirrors separate Client and Pool constructors. */
import { describe, expect, test } from 'bun:test'
import { startPgAutoInstrumentation } from './pg-auto'
import { runWithTraceContext } from './trace-context'
import type { DatabaseQuerySpanInput, PgAutoInstrumentationClient, PgModule, PgQueryCallback } from './types'

const traceContext = {
    traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    spanId: 'bbbbbbbbbbbbbbbb',
    parentSpanId: '',
}

const getStatement = (query: unknown): string => {
    if (typeof query === 'string') {
        return query
    }

    if (typeof query !== 'object' || query === null || !('text' in query)) {
        return ''
    }

    return typeof query.text === 'string' ? query.text : ''
}

class FakeClient {
    readonly database = 'orders'

    // The test double mirrors pg's positional, variadic query overloads.
    // eslint-disable-next-line functional/functional-parameters
    query(this: void, query: unknown, ...argumentsList: ReadonlyArray<unknown>): unknown {
        const statement = getStatement(query)

        if (statement.includes('THROW')) {
            throw new Error('synchronous query failure')
        }

        const callback = argumentsList.at(-1)
        const error = statement.includes('FAIL') ? new Error('query failed') : undefined
        const result = { command: 'SELECT', rows: [{ id: 'account_123' }] }

        if (typeof callback === 'function') {
            queueMicrotask(() => (callback as PgQueryCallback)(error, error === undefined ? result : undefined))

            return undefined
        }

        return error === undefined ? Promise.resolve(result) : Promise.reject(error)
    }
}

class FakePool {
    readonly options = { database: 'orders_pool' }

    // The test double mirrors pg's positional, variadic query overloads.
    // eslint-disable-next-line functional/functional-parameters
    query(this: void, query: unknown, ...argumentsList: ReadonlyArray<unknown>): unknown {
        return Reflect.apply(FakeClient.prototype.query, new FakeClient(), [query, ...argumentsList])
    }
}

const pgModule: PgModule = { Client: FakeClient, Pool: FakePool }

const createCaptureClient = (): {
    readonly client: PgAutoInstrumentationClient
    readonly inputs: Array<DatabaseQuerySpanInput>
} => {
    const inputs: Array<DatabaseQuerySpanInput> = []

    return {
        client: {
            captureDatabaseQuery: input => {
                // Test spy state is intentionally mutable.
                // eslint-disable-next-line functional/immutable-data
                inputs.push(input)
            },
        },
        inputs,
    }
}

describe('startPgAutoInstrumentation', () => {
    test('captures promise queries and pg config objects without parameter values', async () => {
        const { client, inputs } = createCaptureClient()
        const restore = startPgAutoInstrumentation({ client, module: pgModule, options: {} })

        try {
            const result = await runWithTraceContext(traceContext, () =>
                new FakeClient().query({ name: 'account-by-email', text: 'SELECT id FROM account WHERE email = $1 AND version = 42' }, [
                    'secret@example.com',
                ]),
            )

            expect(result).toEqual({ command: 'SELECT', rows: [{ id: 'account_123' }] })
            expect(inputs).toHaveLength(1)
            expect(inputs[0]).toMatchObject({
                databaseName: 'orders',
                operation: 'SELECT',
                parentContext: traceContext,
                peerService: 'postgres',
                statement: 'SELECT id FROM account WHERE email = ? AND version = ?',
            })
            expect(JSON.stringify(inputs[0])).not.toContain('secret@example.com')
        } finally {
            restore()
        }
    })

    test('preserves callback results and captures callback errors', async () => {
        const { client, inputs } = createCaptureClient()
        const restore = startPgAutoInstrumentation({ client, module: pgModule, options: {} })

        try {
            const callbackResult = await runWithTraceContext(
                traceContext,
                () =>
                    new Promise<unknown>(resolve => {
                        new FakeClient().query('SELECT id FROM account', (error?: unknown, result?: unknown) => resolve({ error, result }))
                    }),
            )
            const callbackError = await runWithTraceContext(
                traceContext,
                () =>
                    new Promise<unknown>(resolve => {
                        new FakeClient().query('SELECT FAIL', (error?: unknown, result?: unknown) => resolve({ error, result }))
                    }),
            )

            expect(callbackResult).toMatchObject({ error: undefined, result: { command: 'SELECT' } })
            expect(callbackError).toMatchObject({ error: new Error('query failed'), result: undefined })
            expect(inputs).toHaveLength(2)
            expect(inputs[0]?.error).toBeUndefined()
            expect(inputs[1]?.error).toEqual(new Error('query failed'))
        } finally {
            restore()
        }
    })

    test('captures Pool.query once while suppressing its delegated Client.query span', async () => {
        const { client, inputs } = createCaptureClient()
        const restore = startPgAutoInstrumentation({ client, module: pgModule, options: {} })

        try {
            await runWithTraceContext(traceContext, () => new FakePool().query('SELECT * FROM organisation WHERE id = $1', [101]))

            expect(inputs).toHaveLength(1)
            expect(inputs[0]).toMatchObject({
                databaseName: 'orders_pool',
                operation: 'SELECT',
                statement: 'SELECT * FROM organisation WHERE id = ?',
            })
        } finally {
            restore()
        }
    })

    test('captures rejected promises and synchronous throws', async () => {
        const { client, inputs } = createCaptureClient()
        const restore = startPgAutoInstrumentation({ client, module: pgModule, options: {} })

        try {
            const rejectedQuery = runWithTraceContext(traceContext, () => new FakeClient().query('SELECT FAIL')) as Promise<unknown>
            const rejectedError = await rejectedQuery.catch((error: unknown) => error)

            expect(rejectedError).toEqual(new Error('query failed'))
            expect(() => runWithTraceContext(traceContext, () => new FakeClient().query('SELECT THROW'))).toThrow('synchronous query failure')

            expect(inputs).toHaveLength(2)
            expect(inputs[0]?.error).toEqual(new Error('query failed'))
            expect(inputs[1]?.error).toEqual(new Error('synchronous query failure'))
        } finally {
            restore()
        }
    })

    test('does not capture outside a trace or when the predicate rejects the statement', async () => {
        const { client, inputs } = createCaptureClient()
        const restore = startPgAutoInstrumentation({
            client,
            module: pgModule,
            options: { shouldTrace: statement => !statement.includes('health_check') },
        })

        try {
            await new FakeClient().query('SELECT 1')
            await runWithTraceContext(traceContext, () => new FakeClient().query('SELECT * FROM health_check'))

            expect(inputs).toHaveLength(0)
        } finally {
            restore()
        }
    })

    test('reinitializes without double wrapping and restores only its own prototype patch', async () => {
        const originalClientQuery = FakeClient.prototype.query
        const firstCapture = createCaptureClient()
        const secondCapture = createCaptureClient()
        const restoreFirst = startPgAutoInstrumentation({ client: firstCapture.client, module: pgModule, options: {} })
        const restoreSecond = startPgAutoInstrumentation({ client: secondCapture.client, module: pgModule, options: {} })

        try {
            await runWithTraceContext(traceContext, () => new FakeClient().query('SELECT 1'))

            expect(firstCapture.inputs).toHaveLength(0)
            expect(secondCapture.inputs).toHaveLength(1)

            restoreSecond()
            restoreFirst()
            expect(FakeClient.prototype.query).toBe(originalClientQuery)

            const replacement = (): string => 'replacement'
            const restore = startPgAutoInstrumentation({ client: firstCapture.client, module: pgModule, options: {} })
            // Third-party prototype replacement is intentional lifecycle behavior under test.
            // eslint-disable-next-line functional/immutable-data
            FakeClient.prototype.query = replacement
            restore()

            expect(FakeClient.prototype.query).toBe(replacement)
            // Restore the shared test double for other tests.
            // eslint-disable-next-line functional/immutable-data
            FakeClient.prototype.query = originalClientQuery
        } finally {
            restoreSecond()
            restoreFirst()
            // Restore the shared test double after an assertion failure.
            // eslint-disable-next-line functional/immutable-data
            FakeClient.prototype.query = originalClientQuery
        }
    })
})
