import { readFileSync } from 'node:fs'
import type { PostgresAutoInstrumentationHook, StartPostgresAutoInstrumentationInput } from './types'

const POSTGRES_AUTO_INSTRUMENTATION_HOOK = Symbol.for('inkronik.postgresAutoInstrumentationHook')
const POSTGRES_AUTO_INSTRUMENTATION_PLUGIN = Symbol.for('inkronik.postgresAutoInstrumentationPlugin')
const POSTGRES_ESM_ENTRY_PATTERN = /\/(?:postgres@[^/]+\/node_modules\/)?postgres\/src\/index\.js$/u
const POSTGRES_DEFAULT_EXPORT = 'export default Postgres'
const POSTGRES_INSTRUMENTED_DEFAULT_EXPORT = `const InkronikPostgres = new Proxy(Postgres, {
  apply(target, thisArgument, argumentsList) {
    const sql = Reflect.apply(target, thisArgument, argumentsList)
    const instrument = globalThis[Symbol.for('inkronik.postgresAutoInstrumentationHook')]

    return typeof instrument === 'function' ? instrument(sql) : sql
  }
})

export default InkronikPostgres`

const getRuntimeState = (): Record<PropertyKey, unknown> => globalThis as unknown as Record<PropertyKey, unknown>

const registerBunPostgresPlugin = (): void => {
    const runtimeState = getRuntimeState()

    if (runtimeState[POSTGRES_AUTO_INSTRUMENTATION_PLUGIN] === true || typeof Bun === 'undefined') {
        return
    }

    try {
        Bun.plugin({
            name: 'inkronik-postgres-auto-instrumentation',
            setup: builder => {
                builder.onLoad({ filter: POSTGRES_ESM_ENTRY_PATTERN }, ({ path }) => {
                    const source = readFileSync(path, 'utf8')

                    return {
                        contents: source.replace(POSTGRES_DEFAULT_EXPORT, POSTGRES_INSTRUMENTED_DEFAULT_EXPORT),
                        loader: 'js',
                    }
                })
            },
        })
        // Runtime plugins are process-level and cannot be unregistered in Bun 1.3.
        // eslint-disable-next-line functional/immutable-data
        runtimeState[POSTGRES_AUTO_INSTRUMENTATION_PLUGIN] = true
    } catch {
        // Unsupported Bun plugin behavior must not prevent the application from starting.
    }
}

export const startPostgresAutoInstrumentation = ({ client, options }: StartPostgresAutoInstrumentationInput): (() => void) => {
    registerBunPostgresPlugin()

    const runtimeState = getRuntimeState()
    const instrument: PostgresAutoInstrumentationHook = sql => {
        const databaseName = options.databaseName ?? sql.options?.database

        try {
            return client.instrumentPostgres({
                ...options,
                databaseName,
                peerService: options.peerService ?? 'postgres',
                sql,
            })
        } catch {
            return sql
        }
    }

    // The generated Postgres.js module resolves the current process agent through this hook.
    // eslint-disable-next-line functional/immutable-data
    runtimeState[POSTGRES_AUTO_INSTRUMENTATION_HOOK] = instrument

    return () => {
        if (runtimeState[POSTGRES_AUTO_INSTRUMENTATION_HOOK] !== instrument) {
            return
        }

        // The loader plugin persists, while shutdown makes its wrapper inert.
        // eslint-disable-next-line functional/immutable-data
        delete runtimeState[POSTGRES_AUTO_INSTRUMENTATION_HOOK]
    }
}
