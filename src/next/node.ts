import { isSpanContextValid, trace } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { initInkronik, shutdownInkronik } from '../auto.js'
import { setExternalTraceContextResolver } from '../trace-context.js'
import type { RegisterInkronikNextOptions, NextRegistration, NextRequestErrorContext, NextRequestErrorRequest, NextRuntimeState } from './types.js'
import { InkronikNextSpanProcessor } from './span-processor.js'

const NEXT_STATE_SYMBOL = Symbol.for('@inkronik/node-sdk/next/runtime-state')

const createRuntimeState = (): NextRuntimeState => ({ registration: null, registrationPromise: null })

const getRuntimeState = (): NextRuntimeState => {
    const globalState = globalThis as typeof globalThis & { [NEXT_STATE_SYMBOL]?: NextRuntimeState }

    if (globalState[NEXT_STATE_SYMBOL] !== undefined) {
        return globalState[NEXT_STATE_SYMBOL]
    }

    const state = createRuntimeState()
    // Next.js can evaluate instrumentation modules more than once in development; one global state prevents duplicate providers.
    // eslint-disable-next-line functional/immutable-data
    globalState[NEXT_STATE_SYMBOL] = state
    return state
}

const resolveEnvironment = (options: RegisterInkronikNextOptions): Readonly<Record<string, string | undefined>> => options.env ?? process.env

const resolveCollectorUrl = (options: RegisterInkronikNextOptions): string =>
    resolveEnvironment(options).INKRONIK_COLLECTOR_URL ?? 'https://collector.inkronik.com'

const createRegistration = (options: RegisterInkronikNextOptions): NextRegistration => {
    const environment = resolveEnvironment(options)
    const client = initInkronik(options)
    const processor = new InkronikNextSpanProcessor({
        captureNextFetchSpans: options.captureNextFetchSpans,
        client,
        collectorUrl: resolveCollectorUrl(options),
    })
    const resourceAttributes = {
        [ATTR_SERVICE_NAME]: options.serviceName ?? environment.INKRONIK_SERVICE_NAME ?? 'nextjs-app',
        ...(options.serviceVersion === undefined && environment.INKRONIK_SERVICE_VERSION === undefined
            ? {}
            : { [ATTR_SERVICE_VERSION]: options.serviceVersion ?? environment.INKRONIK_SERVICE_VERSION }),
    }
    const provider = new NodeTracerProvider({
        resource: resourceFromAttributes(resourceAttributes),
        spanProcessors: [processor],
    })

    provider.register()
    const restoreTraceContextResolver = setExternalTraceContextResolver(() => {
        const context = trace.getActiveSpan()?.spanContext()

        if (context === undefined || !isSpanContextValid(context)) {
            return undefined
        }

        return { parentSpanId: '', spanId: context.spanId, traceId: context.traceId }
    })

    return { client, provider, restoreTraceContextResolver }
}

export const registerInkronikNextNode = (options: RegisterInkronikNextOptions = {}): Promise<void> => {
    const state = getRuntimeState()

    if (state.registration !== null) {
        return Promise.resolve()
    }

    if (state.registrationPromise !== null) {
        return state.registrationPromise.then(() => undefined)
    }

    const registrationPromise = Promise.resolve().then(() => createRegistration(options))
    // The promise is shared process state because Next.js may call register concurrently in development.
    // eslint-disable-next-line functional/immutable-data
    state.registrationPromise = registrationPromise

    return registrationPromise
        .then(registration => {
            // Registration lifecycle state must retain the provider for flush and shutdown.
            // eslint-disable-next-line functional/immutable-data
            state.registration = registration
        })
        .finally(() => {
            // The settled promise must not retain a second reference to the provider.
            // eslint-disable-next-line functional/immutable-data
            state.registrationPromise = null
        })
}

export const captureNextRequestError = async (error: unknown, request: NextRequestErrorRequest, context: NextRequestErrorContext): Promise<void> => {
    const registration = getRuntimeState().registration

    if (registration === null) {
        return
    }

    registration.client.captureError(error, {
        attributes: {
            'http.request.method': request.method,
            'http.route': context.routePath,
            'next.route_type': context.routeType,
            'next.router_kind': context.routerKind,
            'url.path': request.path,
        },
        category: 'nextjs.request',
        message: error instanceof Error ? error.message : 'Unhandled Next.js request error',
        name: 'nextjs.request.error',
    })
    await registration.client.flush()
}

export const shutdownInkronikNextNode = async (): Promise<void> => {
    const state = getRuntimeState()
    const registration = state.registration ?? (await state.registrationPromise)

    if (registration === null) {
        return
    }

    registration.restoreTraceContextResolver()
    await registration.provider.shutdown().catch(() => undefined)
    await shutdownInkronik()
    // Shutdown releases the process-level integration state.
    // eslint-disable-next-line functional/immutable-data
    state.registration = null
    // eslint-disable-next-line functional/immutable-data
    state.registrationPromise = null
}

export { InkronikNextSpanProcessor }
