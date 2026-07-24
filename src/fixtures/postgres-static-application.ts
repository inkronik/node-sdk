import postgres from 'postgres'
import { shutdownInkronik } from '../auto.js'
import { runWithTraceContext } from '../trace-context.js'

const sql = postgres('postgres://postgres:postgres@localhost:5432/static_fixture', { max: 0 })
const queryState: { query?: Promise<ReadonlyArray<ReadonlyArray<string>>> & { values: () => unknown } } = {}
const query = Object.assign(Promise.resolve([['fixture_result']]), {
    values: () => queryState.query,
})
// The fixture replaces network execution while retaining Postgres.js's fluent query shape.
// eslint-disable-next-line functional/immutable-data
queryState.query = query

if (Reflect.get(sql, Symbol.for('inkronik.instrumentedPostgres')) !== true || !Reflect.set(sql, 'unsafe', () => query)) {
    throw new Error('Expected an automatically instrumented Postgres.js client')
}

await runWithTraceContext(
    {
        traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanId: 'bbbbbbbbbbbbbbbb',
        parentSpanId: '',
    },
    () => sql.unsafe('SELECT id FROM account WHERE email = $1', ['demo@example.com']).values(),
)

await sql.end()
await shutdownInkronik()
