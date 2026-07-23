import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { getDatabaseOperation, normalizeDatabaseStatement } from './database'
import { getCurrentTraceContext } from './trace-context'
import type {
    DatabaseInstrumentationOptions,
    PgAutoInstrumentationClient,
    PgConstructor,
    PgModule,
    PgQueryCallback,
    PgQueryMethod,
    PgQueryTarget,
    StartPgAutoInstrumentationInput,
} from './types'

const PG_MODULE_NAME = 'pg'
const INKRONIK_ORIGINAL_PG_QUERY = Symbol.for('inkronik.originalPgQuery')
const pgQuerySuppressionStorage = new AsyncLocalStorage<boolean>()
const require = createRequire(import.meta.url)

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => typeof value === 'object' && value !== null

const isPgConstructor = (value: unknown): value is PgConstructor =>
    typeof value === 'function' &&
    isRecord(Reflect.get(value, 'prototype')) &&
    typeof Reflect.get(Reflect.get(value, 'prototype'), 'query') === 'function'

const resolvePgModule = (value: unknown): PgModule | undefined => {
    if (!isRecord(value)) {
        return undefined
    }

    const directModule = value as PgModule

    if (isPgConstructor(directModule.Client) || isPgConstructor(directModule.Pool)) {
        return directModule
    }

    return isRecord(directModule.default) ? resolvePgModule(directModule.default) : undefined
}

const loadPgModule = (): PgModule | undefined => {
    try {
        return resolvePgModule(require(PG_MODULE_NAME) as unknown)
    } catch {
        return undefined
    }
}

const getQueryStatement = (query: unknown): string => {
    if (typeof query === 'string') {
        return query
    }

    if (!isRecord(query)) {
        return 'pg query'
    }

    return typeof query.text === 'string' ? query.text : 'pg query'
}

const getDatabaseName = ({
    options,
    target,
}: {
    readonly options: DatabaseInstrumentationOptions
    readonly target: PgQueryTarget
}): string | undefined => options.databaseName ?? target.database ?? target.options?.database

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === 'object' || typeof value === 'function') && value !== null && typeof Reflect.get(value, 'then') === 'function'

const isEventEmitterLike = (
    value: unknown,
): value is { once(event: string, listener: (...argumentsList: ReadonlyArray<unknown>) => void): unknown } =>
    (typeof value === 'object' || typeof value === 'function') && value !== null && typeof Reflect.get(value, 'once') === 'function'

const resolveOriginalQuery = (query: PgQueryMethod): PgQueryMethod => {
    const original = Reflect.get(query, INKRONIK_ORIGINAL_PG_QUERY)

    return typeof original === 'function' ? (original as PgQueryMethod) : query
}

const attachCompletion = ({ capture, result }: { readonly capture: (error?: unknown) => void; readonly result: unknown }): void => {
    const captureSuccess = capture.bind(undefined, undefined)

    if (isPromiseLike(result)) {
        void Promise.resolve(result).then(captureSuccess, capture)

        return
    }

    if (!isEventEmitterLike(result)) {
        return
    }

    // Query objects expose EventEmitter completion events; listeners are the driver's supported external API.
    result.once('end', captureSuccess)
    result.once('error', capture)
}

const createQueryWrapper = ({
    client,
    kind,
    options,
    originalQuery,
}: {
    readonly client: PgAutoInstrumentationClient
    readonly kind: 'client' | 'pool'
    readonly options: DatabaseInstrumentationOptions
    readonly originalQuery: PgQueryMethod
}): PgQueryMethod => {
    // pg query overloads are positional and variadic by design.
    // eslint-disable-next-line functional/functional-parameters
    const wrapper = function (this: PgQueryTarget, ...argumentsList: ReadonlyArray<unknown>): unknown {
        if (kind === 'client' && pgQuerySuppressionStorage.getStore() === true) {
            return Reflect.apply(originalQuery, this, argumentsList)
        }

        const parentContext = getCurrentTraceContext()

        if (parentContext === undefined) {
            return Reflect.apply(originalQuery, this, argumentsList)
        }

        const statement = getQueryStatement(argumentsList[0])
        const preparedStatement =
            options.captureStatement === false ? '' : normalizeDatabaseStatement({ maxLength: options.maxStatementLength, statement })

        if (options.shouldTrace?.(preparedStatement) === false) {
            return Reflect.apply(originalQuery, this, argumentsList)
        }

        const startedAt = performance.now()
        const state: { captured: boolean } = { captured: false }
        const capture = (error?: unknown): void => {
            if (state.captured) {
                return
            }

            // Completion can arrive through a callback, promise, or Query event and must be recorded once.
            // eslint-disable-next-line functional/immutable-data
            state.captured = true
            client.captureDatabaseQuery({
                databaseName: getDatabaseName({ options, target: this }),
                durationMs: performance.now() - startedAt,
                error,
                operation: getDatabaseOperation(preparedStatement),
                parentContext,
                peerService: options.peerService ?? 'postgres',
                statement: preparedStatement,
                system: options.system,
            })
        }
        const callback = argumentsList.at(-1)
        const hasCallback = typeof callback === 'function'
        const wrappedCallback: PgQueryCallback = (error, result) => {
            capture(error)

            return pgQuerySuppressionStorage.run(false, () => Reflect.apply(callback as PgQueryCallback, undefined, [error, result]))
        }
        const nextArguments = hasCallback ? [...argumentsList.slice(0, -1), wrappedCallback] : argumentsList

        try {
            const result =
                kind === 'pool'
                    ? pgQuerySuppressionStorage.run(true, () => Reflect.apply(originalQuery, this, nextArguments))
                    : Reflect.apply(originalQuery, this, nextArguments)

            if (!hasCallback) {
                attachCompletion({ capture, result })
            }

            return result
        } catch (error) {
            capture(error)
            throw error
        }
    } as PgQueryMethod

    // Function metadata is required to make instrumentation idempotent across bundled client copies.
    // eslint-disable-next-line functional/immutable-data
    Object.defineProperty(wrapper, INKRONIK_ORIGINAL_PG_QUERY, {
        configurable: false,
        enumerable: false,
        value: originalQuery,
        writable: false,
    })

    return wrapper
}

const instrumentPgConstructor = ({
    client,
    constructor,
    kind,
    options,
}: {
    readonly client: PgAutoInstrumentationClient
    readonly constructor: PgConstructor | undefined
    readonly kind: 'client' | 'pool'
    readonly options: DatabaseInstrumentationOptions
}): (() => void) | null => {
    if (constructor === undefined) {
        return null
    }

    const prototype = constructor.prototype
    const currentQuery = prototype.query

    if (typeof currentQuery !== 'function') {
        return null
    }

    const ownDescriptor = Object.getOwnPropertyDescriptor(prototype, 'query')
    const originalQuery = resolveOriginalQuery(currentQuery)
    const wrapper = createQueryWrapper({ client, kind, options, originalQuery })

    // pg exposes query on mutable driver prototypes; prototype patching is required for transparent TypeORM coverage.
    // eslint-disable-next-line functional/immutable-data
    Object.defineProperty(prototype, 'query', {
        configurable: true,
        enumerable: ownDescriptor?.enumerable ?? false,
        value: wrapper,
        writable: true,
    })

    return () => {
        if (prototype.query !== wrapper) {
            return
        }

        if (ownDescriptor === undefined) {
            // Pool.query can be inherited from pg-pool, so cleanup must restore inheritance rather than create an own property.
            Reflect.deleteProperty(prototype, 'query')

            return
        }

        // Restore the exact descriptor that existed before instrumentation.
        // eslint-disable-next-line functional/immutable-data
        Object.defineProperty(prototype, 'query', ownDescriptor)
    }
}

export const startPgAutoInstrumentation = ({ client, module, options }: StartPgAutoInstrumentationInput): (() => void) => {
    const pgModule = module ?? loadPgModule()

    if (pgModule === undefined) {
        return () => undefined
    }

    const restoreClient = instrumentPgConstructor({ client, constructor: pgModule.Client, kind: 'client', options })
    const restorePool = instrumentPgConstructor({ client, constructor: pgModule.Pool, kind: 'pool', options })

    return () => {
        restorePool?.()
        restoreClient?.()
    }
}
