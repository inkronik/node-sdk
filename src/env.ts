import { InkronikClient } from './client.js'
import { getInkronikRuntimeState } from './runtime-state.js'
import type { CreateInkronikClientFromEnvOptions, InkronikClientOptions } from './types.js'

const requiredEnvKeys = ['INKRONIK_COLLECTOR_URL', 'INKRONIK_INGEST_API_KEY'] as const
const runtimeState = getInkronikRuntimeState()

type RequiredEnvKey = (typeof requiredEnvKeys)[number]
type EnvKey = RequiredEnvKey | 'INKRONIK_APPLICATION_ID' | 'INKRONIK_SERVICE_VERSION' | 'INKRONIK_POD_NAME' | 'HOSTNAME' | 'KUBERNETES_SERVICE_HOST'

const readEnvValue = ({ env, key }: { readonly env: Record<string, string | undefined>; readonly key: EnvKey }): string | undefined => {
    const value = env[key]?.trim()

    return value === '' ? undefined : value
}

const readRequiredEnv = ({ env, key }: { readonly env: Record<string, string | undefined>; readonly key: RequiredEnvKey }): string => {
    const value = readEnvValue({ env, key })

    if (value === undefined) {
        throw new Error(`Missing ${key}. Set ${key} before creating the Inkronik Node client.`)
    }

    return value
}

const resolveRequiredEnv = (env: Record<string, string | undefined>) =>
    requiredEnvKeys.reduce<Record<RequiredEnvKey, string>>((values, key) => ({ ...values, [key]: readRequiredEnv({ env, key }) }), {
        INKRONIK_COLLECTOR_URL: '',
        INKRONIK_INGEST_API_KEY: '',
    })

const buildClientOptions = ({
    env,
    options,
    required,
}: {
    readonly env: Record<string, string | undefined>
    readonly options: CreateInkronikClientFromEnvOptions
    readonly required: Record<RequiredEnvKey, string>
}): InkronikClientOptions => {
    const serviceName = options.serviceName ?? env.INKRONIK_SERVICE_NAME?.trim()

    if (serviceName === undefined || serviceName === '') {
        throw new Error('Missing service name. Set INKRONIK_SERVICE_NAME or pass { serviceName } to createInkronikClientFromEnv.')
    }

    const applicationId = readEnvValue({ env, key: 'INKRONIK_APPLICATION_ID' })

    if (options.applicationIdRequired === true && applicationId === undefined) {
        throw new Error('Missing INKRONIK_APPLICATION_ID. Set it when using a legacy organisation-scoped ingest key.')
    }

    return {
        collectorUrl: required.INKRONIK_COLLECTOR_URL,
        ingestApiKey: required.INKRONIK_INGEST_API_KEY,
        applicationId,
        environment: options.environment ?? env.INKRONIK_ENVIRONMENT ?? 'production',
        serviceName,
        // Optional, unlike serviceName: an unversioned service still emits usable telemetry, it just cannot be
        // attributed to a release.
        serviceVersion: options.serviceVersion ?? readEnvValue({ env, key: 'INKRONIK_SERVICE_VERSION' }),
        podName: options.podName ?? resolvePodName(env),
        source: options.source,
        defaultAttributes: options.defaultAttributes,
        flushIntervalMs: options.flushIntervalMs,
        maxBatchSize: options.maxBatchSize,
        maxQueueSize: options.maxQueueSize,
        requestTimeoutMs: options.requestTimeoutMs,
        fetchImpl: options.fetchImpl,
        onError: options.onError,
    }
}

// Prefer an explicit INKRONIK_POD_NAME, then fall back to HOSTNAME — but only inside Kubernetes, where the
// container hostname defaults to the pod name. KUBERNETES_SERVICE_HOST is injected into every in-cluster pod, so
// its presence is a reliable "am I in k8s" signal. Off-cluster (a laptop, CI) HOSTNAME is the machine name, not a
// pod, and stamping it would mislabel telemetry with a pod that no image will ever match.
const resolvePodName = (env: Record<string, string | undefined>): string | undefined => {
    const explicit = readEnvValue({ env, key: 'INKRONIK_POD_NAME' })

    if (explicit !== undefined) {
        return explicit
    }

    return readEnvValue({ env, key: 'KUBERNETES_SERVICE_HOST' }) === undefined ? undefined : readEnvValue({ env, key: 'HOSTNAME' })
}

export const createInkronikClientFromEnv = (options: CreateInkronikClientFromEnvOptions = {}): InkronikClient => {
    const env = options.env ?? process.env
    const required = resolveRequiredEnv(env)
    const client = new InkronikClient(buildClientOptions({ env, options, required }))

    return setDefaultInkronikClient(client)
}

export const setDefaultInkronikClient = (client: InkronikClient): InkronikClient => {
    // The default client is process-level SDK state, mirroring auto-instrumentation agents.
    // eslint-disable-next-line functional/immutable-data
    runtimeState.defaultClient = client

    return client
}

export const getDefaultInkronikClient = (): InkronikClient => runtimeState.defaultClient ?? createInkronikClientFromEnv()
