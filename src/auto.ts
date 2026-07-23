import { createInkronikClientFromEnv, setDefaultInkronikClient } from './env.js'
import type { InkronikClient } from './client.js'
import { startPgAutoInstrumentation } from './pg-auto.js'
import { startPostgresAutoInstrumentation } from './postgres-auto.js'
import type { InitInkronikOptions } from './types.js'

const BULLMQ_MODULE_NAME = 'bullmq'

const autoState: {
    client: InkronikClient | null
    restoreBullMQ: (() => void) | null
    restoreFetch: (() => void) | null
    restorePg: (() => void) | null
    restorePostgres: (() => void) | null
} = {
    client: null,
    restoreBullMQ: null,
    restoreFetch: null,
    restorePg: null,
    restorePostgres: null,
}

const resolveFetchOptions = (options: InitInkronikOptions): Parameters<InkronikClient['instrumentGlobalFetch']>[0] | false => {
    const fetchOptions = options.instrumentations?.fetch

    if (fetchOptions === false) {
        return false
    }

    return fetchOptions === true || fetchOptions === undefined ? {} : fetchOptions
}

const startRuntimeMetrics = ({ client, options }: { readonly client: InkronikClient; readonly options: InitInkronikOptions }): void => {
    const runtimeMetrics = options.instrumentations?.runtimeMetrics

    if (runtimeMetrics === false) {
        return
    }

    client.startRuntimeMetrics(runtimeMetrics === true || runtimeMetrics === undefined ? {} : runtimeMetrics)
}

const startFetchInstrumentation = ({
    client,
    options,
}: {
    readonly client: InkronikClient
    readonly options: InitInkronikOptions
}): (() => void) | null => {
    const fetchOptions = resolveFetchOptions(options)

    if (fetchOptions === false) {
        return null
    }

    return client.instrumentGlobalFetch(fetchOptions)
}

const startPostgresInstrumentation = ({
    client,
    options,
}: {
    readonly client: InkronikClient
    readonly options: InitInkronikOptions
}): (() => void) | null => {
    const postgresOptions = options.instrumentations?.postgres

    if (postgresOptions === false) {
        return null
    }

    return startPostgresAutoInstrumentation({
        client,
        options: postgresOptions === true || postgresOptions === undefined ? {} : postgresOptions,
    })
}

const startPgInstrumentation = ({
    client,
    options,
}: {
    readonly client: InkronikClient
    readonly options: InitInkronikOptions
}): (() => void) | null => {
    const pgOptions = options.instrumentations?.pg

    if (pgOptions === false) {
        return null
    }

    return startPgAutoInstrumentation({
        client,
        options: pgOptions === true || pgOptions === undefined ? {} : pgOptions,
    })
}

const startBullMQInstrumentation = ({
    client,
    options,
}: {
    readonly client: InkronikClient
    readonly options: InitInkronikOptions
}): (() => void) | null => {
    const bullMQOptions = options.instrumentations?.bullMQ

    if (bullMQOptions === false) {
        return null
    }

    const resolvedOptions = bullMQOptions === true || bullMQOptions === undefined ? {} : bullMQOptions
    const state: { restore: (() => void) | null; active: boolean } = { restore: null, active: true }

    void import(BULLMQ_MODULE_NAME)
        .then(module => {
            if (!state.active || typeof module.Queue !== 'function') {
                return
            }

            // Async optional instrumentation owns local lifecycle state.
            // eslint-disable-next-line functional/immutable-data
            state.restore = client.instrumentBullMQ({ ...resolvedOptions, Queue: module.Queue })
        })
        .catch(() => undefined)

    return () => {
        // Async optional instrumentation owns local lifecycle state.
        // eslint-disable-next-line functional/immutable-data
        state.active = false
        state.restore?.()
    }
}

export const initInkronik = (options: InitInkronikOptions = {}): InkronikClient => {
    autoState.restoreBullMQ?.()
    autoState.restoreFetch?.()
    autoState.restorePg?.()
    autoState.restorePostgres?.()

    const client = createInkronikClientFromEnv(options)
    const restoreBullMQ = startBullMQInstrumentation({ client, options })
    const restoreFetch = startFetchInstrumentation({ client, options })
    const restorePg = startPgInstrumentation({ client, options })
    const restorePostgres = startPostgresInstrumentation({ client, options })

    startRuntimeMetrics({ client, options })
    setDefaultInkronikClient(client)

    // Auto-instrumentation owns process-level SDK state.
    // eslint-disable-next-line functional/immutable-data
    autoState.client = client
    // eslint-disable-next-line functional/immutable-data
    autoState.restoreBullMQ = restoreBullMQ
    // eslint-disable-next-line functional/immutable-data
    autoState.restoreFetch = restoreFetch
    // eslint-disable-next-line functional/immutable-data
    autoState.restorePg = restorePg
    // eslint-disable-next-line functional/immutable-data
    autoState.restorePostgres = restorePostgres

    return client
}

export const shutdownInkronik = async (): Promise<void> => {
    autoState.restoreBullMQ?.()
    autoState.restoreFetch?.()
    autoState.restorePg?.()
    autoState.restorePostgres?.()

    if (autoState.client === null) {
        return
    }

    await autoState.client.shutdown()
    // Auto-instrumentation owns process-level SDK state.
    // eslint-disable-next-line functional/immutable-data
    autoState.client = null
    // eslint-disable-next-line functional/immutable-data
    autoState.restoreBullMQ = null
    // eslint-disable-next-line functional/immutable-data
    autoState.restoreFetch = null
    // eslint-disable-next-line functional/immutable-data
    autoState.restorePg = null
    // eslint-disable-next-line functional/immutable-data
    autoState.restorePostgres = null
}
