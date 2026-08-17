import { errorMonitor } from 'node:events'
import http, { type ClientRequest, type RequestOptions } from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import type {
    DefineNodeHttpModuleMethodInput,
    GetNodeHttpRequestUrlInput,
    InstrumentNodeHttpModuleInput,
    InstrumentNodeHttpRequestInput,
    NodeHttpArguments,
    NodeHttpGetMethod,
    NodeHttpModuleInstrumentation,
    NodeHttpCollectorRequestInput,
    NodeHttpRequestCaptureState,
    NodeHttpRequestMethod,
    StartNodeHttpAutoInstrumentationInput,
} from './internal/types.js'
import { createChildTraceContext, getCurrentTraceContext, toTraceparent } from './trace-context.js'

const INKRONIK_ORIGINAL_HTTP_REQUEST = Symbol.for('@inkronik/node-sdk.original-http-request.v1')
const INKRONIK_ORIGINAL_HTTP_GET = Symbol.for('@inkronik/node-sdk.original-http-get.v1')

const getOriginalMethod = <TMethod>(method: TMethod, marker: symbol): TMethod | undefined => {
    const original = Reflect.get(method as object, marker)

    return typeof original === 'function' ? (original as TMethod) : undefined
}

const markWrapper = <TMethod>(wrapper: TMethod, marker: symbol, original: TMethod): TMethod => {
    // Function metadata makes the process-wide patch idempotent across separately bundled SDK entrypoints.
    // eslint-disable-next-line functional/immutable-data
    Object.defineProperty(wrapper, marker, {
        configurable: false,
        enumerable: false,
        value: original,
        writable: false,
    })

    return wrapper
}

const isRequestOptions = (value: unknown): value is RequestOptions => typeof value === 'object' && value !== null && !(value instanceof URL)

const getRequestUrl = ({ argumentsList, defaultProtocol }: GetNodeHttpRequestUrlInput): URL => {
    const firstArgument = argumentsList[0]
    const baseUrl = firstArgument instanceof URL || typeof firstArgument === 'string' ? new URL(firstArgument) : undefined
    const optionsArgument = baseUrl === undefined ? firstArgument : argumentsList[1]
    const options = isRequestOptions(optionsArgument) ? optionsArgument : {}
    const protocol = options.protocol ?? baseUrl?.protocol ?? defaultProtocol
    const rawHost = options.hostname ?? options.host ?? baseUrl?.hostname ?? 'localhost'
    const host = String(rawHost)
    const normalizedHost = options.hostname !== undefined && host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    const port = options.port ?? baseUrl?.port
    const authority =
        port === undefined || port === '' || (options.hostname === undefined && host.includes(':')) ? normalizedHost : `${normalizedHost}:${port}`
    const path = options.path ?? (baseUrl === undefined ? '/' : `${baseUrl.pathname}${baseUrl.search}`)

    return URL.canParse(path) ? new URL(path) : new URL(path, `${protocol}//${authority}`)
}

const isCollectorRequest = ({ collectorUrl, url }: NodeHttpCollectorRequestInput): boolean => {
    const collectorTelemetryUrl = new URL(`${collectorUrl}/v1/telemetry`)

    return url.origin === collectorTelemetryUrl.origin && url.pathname === collectorTelemetryUrl.pathname
}

const instrumentRequest = ({ captureClientSpan, collectorUrl, options, request, url }: InstrumentNodeHttpRequestInput): void => {
    // An existing traceparent means a higher-level client or another tracer already owns this transport request.
    if (request.getHeader('traceparent') !== undefined) return

    const method = request.method.toUpperCase()
    const context = { method, url }

    if (isCollectorRequest({ collectorUrl, url }) || options.shouldTrace?.(context) === false) return

    const traceContext = createChildTraceContext(getCurrentTraceContext())
    const peerService = options.getPeerService?.(context) ?? url.host
    const startedAt = performance.now()
    const captureState: NodeHttpRequestCaptureState = { captured: false }
    const capture = (statusCode: number, error?: unknown): void => {
        if (captureState.captured) return

        // Response and error events race; the first terminal signal owns the one client span.
        // eslint-disable-next-line functional/immutable-data
        captureState.captured = true
        captureClientSpan({
            context: traceContext,
            durationMs: performance.now() - startedAt,
            error,
            method,
            peerService,
            statusCode,
            url,
        })
    }

    // ClientRequest exposes setHeader specifically for mutation before end()/write() sends the request.
    request.setHeader('traceparent', toTraceparent(traceContext))
    request.once('response', response => capture(response.statusCode ?? 0))
    // errorMonitor observes failures without consuming an otherwise-unhandled EventEmitter error.
    request.once(errorMonitor, error => capture(0, error))
}

const defineModuleMethod = ({ method, module, property }: DefineNodeHttpModuleMethodInput): void => {
    const descriptor = Object.getOwnPropertyDescriptor(module, property)

    // Patching the mutable built-in module object is required for transparent third-party-client coverage.
    // eslint-disable-next-line functional/immutable-data
    Object.defineProperty(module, property, {
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? true,
        value: method,
        writable: descriptor?.writable ?? true,
    })
}

const instrumentModule = ({
    captureClientSpan,
    collectorUrl,
    defaultProtocol,
    module,
    options,
}: InstrumentNodeHttpModuleInput): NodeHttpModuleInstrumentation | null => {
    const currentRequest = module.request

    if (getOriginalMethod(currentRequest, INKRONIK_ORIGINAL_HTTP_REQUEST) !== undefined) return null

    const originalRequest = currentRequest
    // Node's request API is intentionally overloaded and variadic; Reflect preserves every supported signature.
    const requestWrapper = markWrapper(
        // Node's overloaded external API requires a variadic forwarding boundary.
        // eslint-disable-next-line functional/functional-parameters
        function (this: unknown, ...argumentsList: NodeHttpArguments) {
            const url = getRequestUrl({ argumentsList, defaultProtocol })
            const request = Reflect.apply(originalRequest, this, argumentsList) as ClientRequest

            instrumentRequest({ captureClientSpan, collectorUrl, options, request, url })

            return request
        } as NodeHttpRequestMethod,
        INKRONIK_ORIGINAL_HTTP_REQUEST,
        originalRequest,
    )
    const originalGet = module.get
    // Node's get API is request()+end(); routing it through the request wrapper prevents a second independent span.
    const getWrapper = markWrapper(
        // Node's overloaded external API requires a variadic forwarding boundary.
        // eslint-disable-next-line functional/functional-parameters
        function (this: unknown, ...argumentsList: NodeHttpArguments) {
            const request = Reflect.apply(requestWrapper, this, argumentsList) as ClientRequest

            request.end()

            return request
        } as NodeHttpGetMethod,
        INKRONIK_ORIGINAL_HTTP_GET,
        originalGet,
    )

    defineModuleMethod({ method: requestWrapper, module, property: 'request' })
    defineModuleMethod({ method: getWrapper, module, property: 'get' })

    const restore = (): void => {
        if (module.request === requestWrapper) defineModuleMethod({ method: originalRequest, module, property: 'request' })
        if (module.get === getWrapper) defineModuleMethod({ method: originalGet, module, property: 'get' })
    }

    return { request: requestWrapper, restore }
}

export const startNodeHttpAutoInstrumentation = ({
    captureClientSpan,
    collectorUrl,
    options,
}: StartNodeHttpAutoInstrumentationInput): (() => void) | null => {
    const shared = { captureClientSpan, collectorUrl, options }
    const httpInstrumentation = instrumentModule({
        ...shared,
        defaultProtocol: 'http:',
        module: http,
    })
    const httpsInstrumentation = instrumentModule({
        ...shared,
        defaultProtocol: 'https:',
        module: https,
    })

    if (httpInstrumentation === null && httpsInstrumentation === null) return null

    syncBuiltinESMExports()

    return () => {
        httpInstrumentation?.restore()
        httpsInstrumentation?.restore()
        syncBuiltinESMExports()
    }
}
