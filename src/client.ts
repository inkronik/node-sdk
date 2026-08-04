/* eslint-disable max-lines -- Split SDK instrumentation into modules in a dedicated refactor. */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type {
    CaptureErrorOptions,
    CaptureEventSignalInput,
    CaptureHttpExchangeInput,
    CaptureMessagingSpanInput,
    BullMQJobLike,
    DatabaseQuerySpanInput,
    EmitHttpMetricsInput,
    EventInput,
    FlushResult,
    GaugeInput,
    HistogramInput,
    InkronikClientOptions,
    InstrumentPostgresInput,
    InstrumentBullMQInput,
    InstrumentBullMQProcessorInput,
    InstrumentedFetchOptions,
    InstrumentedGlobalFetch,
    LogInput,
    LoggerRecord,
    RuntimeMetricsOptions,
    SendTelemetryInput,
    SumInput,
    PostgresJsSql,
    TraceContext,
} from './types.js'
import type { IngestTelemetryRequest, IngestTelemetryResponse, IngestTelemetrySignal } from './protocol/types.js'
import { getDatabaseOperation, normalizeDatabaseStatement } from './database.js'
import { getHttpHeaderValue, resolveHttpMessageSize } from './http-utils.js'
import {
    createChildTraceContext,
    getCurrentTelemetryContext,
    getCurrentTraceContext,
    parseTraceparent,
    runWithTraceContext,
    toTraceparent,
} from './trace-context.js'
import {
    createUuid,
    getUserEventAttributes,
    mergeAttributes,
    normalizeCapturedError,
    normalizeCollectorUrl,
    nowIso,
    sortNumbers,
    toStringMap,
    truncateUtf8,
} from './utils.js'

// Distributes over the signal union so each member loses `service_version` individually. A plain
// Omit<IngestTelemetrySignal, 'service_version'> would instead collapse the union to its common keys and lose
// every payload discriminant.
type UnversionedTelemetrySignal = IngestTelemetrySignal extends unknown ? Omit<IngestTelemetrySignal, 'service_version'> : never

// The resource-attribute key the k8s agent uses for the pod name. The SDK stamps the same key so the writer can
// join an app's telemetry to the pod's deployed image.
const POD_NAME_ATTRIBUTE = 'k8s.pod'

const DEFAULT_BATCH_SIZE = 25
const DEFAULT_MAX_QUEUE_SIZE = 1000
const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_REQUEST_TIMEOUT_MS = 5000
const DEFAULT_HTTP_LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]
const DEFAULT_RUNTIME_METRICS_INTERVAL_MS = 10000
const DEFAULT_EVENT_LOOP_RESOLUTION_MS = 20
const DEFAULT_DB_STATEMENT_MAX_LENGTH = 2_000
const INKRONIK_ORIGINAL_FETCH = Symbol.for('inkronik.originalFetch')
const INKRONIK_ORIGINAL_BULLMQ_QUEUE_ADD = Symbol.for('inkronik.originalBullMQQueueAdd')
const INKRONIK_INSTRUMENTED_POSTGRES = Symbol.for('inkronik.instrumentedPostgres')
const INKRONIK_TRACE_METADATA_KEY = '__inkronik'
const DEFAULT_MESSAGING_SYSTEM = 'bullmq'
const DEFAULT_EVENT_LEVEL = 'info'
const MAX_EVENT_MESSAGE_BYTES = 4096
const emptyCapturedError = { type: '', message: '', stack: '', code: '', handled: false } as const

const severityByLevel: Record<string, { readonly number: number; readonly text: string }> = {
    trace: { number: 1, text: 'TRACE' },
    debug: { number: 5, text: 'DEBUG' },
    info: { number: 9, text: 'INFO' },
    warn: { number: 13, text: 'WARN' },
    warning: { number: 13, text: 'WARN' },
    error: { number: 17, text: 'ERROR' },
    fatal: { number: 21, text: 'FATAL' },
}

const getFetchInputUrl = (input: RequestInfo | URL): string => {
    if (input instanceof Request) {
        return input.url
    }

    if (input instanceof URL) {
        return input.toString()
    }

    return input
}

const isCollectorTelemetryRequest = ({ collectorUrl, input }: { readonly collectorUrl: string; readonly input: RequestInfo | URL }): boolean => {
    try {
        return new URL(getFetchInputUrl(input)).toString().startsWith(`${collectorUrl}/v1/telemetry`)
    } catch {
        return false
    }
}

const getTaggedSqlStatement = (strings: TemplateStringsArray): string =>
    strings.reduce((statement, segment, index) => `${statement}${segment}${index < strings.length - 1 ? '?' : ''}`, '')

const isTemplateStringsArray = (value: unknown): value is TemplateStringsArray => Array.isArray(value) && 'raw' in value

const isPromiseCallback = (value: unknown): value is (value: unknown) => unknown => typeof value === 'function'

const isFinallyCallback = (value: unknown): value is () => void => typeof value === 'function'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const getBullMQTraceparent = (job: { readonly data?: unknown }): string | undefined => {
    if (!isRecord(job.data)) {
        return undefined
    }

    const metadata = job.data[INKRONIK_TRACE_METADATA_KEY]

    return isRecord(metadata) && typeof metadata.traceparent === 'string' ? metadata.traceparent : undefined
}

const injectBullMQTraceparent = ({ data, traceparent }: { readonly data: unknown; readonly traceparent: string }): unknown => {
    if (!isRecord(data)) {
        return data
    }

    const metadata = data[INKRONIK_TRACE_METADATA_KEY]

    return {
        ...data,
        [INKRONIK_TRACE_METADATA_KEY]: {
            ...(isRecord(metadata) ? metadata : {}),
            traceparent,
        },
    }
}

const getJobId = (job: unknown): string | undefined => {
    if (!isRecord(job)) {
        return undefined
    }

    const id = job.id

    return typeof id === 'string' || typeof id === 'number' ? String(id) : undefined
}

const getJobName = (job: unknown): string | undefined => {
    if (!isRecord(job)) {
        return undefined
    }

    const name = job.name

    return typeof name === 'string' ? name : undefined
}

const getDefaultQueueName = (queue: unknown): string => {
    if (!isRecord(queue)) {
        return 'queue'
    }

    const name = queue.name

    return typeof name === 'string' && name.length > 0 ? name : 'queue'
}

export class InkronikClient {
    private readonly collectorUrl: string
    private readonly ingestApiKey: string
    private readonly applicationId: string | undefined
    private readonly environment: string
    private readonly serviceName: string
    private readonly serviceVersion: string | undefined
    private readonly podName: string | undefined
    private readonly source: string
    private readonly defaultAttributes: Record<string, string>
    private readonly maxBatchSize: number
    private readonly maxQueueSize: number
    private readonly requestTimeoutMs: number
    private readonly fetchImpl: typeof fetch
    private readonly onError: (error: Error) => void
    private readonly flushTimer: ReturnType<typeof setInterval>
    private runtimeMetricsTimer: ReturnType<typeof setInterval> | null = null
    private eventLoopMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null
    private globalFetchRestore: (() => void) | null = null
    private queue: Array<IngestTelemetrySignal> = []

    constructor(options: InkronikClientOptions) {
        this.collectorUrl = normalizeCollectorUrl(options.collectorUrl)
        this.ingestApiKey = options.ingestApiKey
        this.applicationId = options.applicationId
        this.environment = options.environment ?? 'production'
        this.serviceName = options.serviceName
        this.serviceVersion = options.serviceVersion === '' ? undefined : options.serviceVersion
        this.podName = options.podName === '' ? undefined : options.podName
        this.source = options.source ?? 'node'
        this.defaultAttributes = options.defaultAttributes ?? {}
        this.maxBatchSize = Math.max(1, options.maxBatchSize ?? DEFAULT_BATCH_SIZE)
        this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE)
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
        this.fetchImpl = options.fetchImpl ?? fetch
        this.onError = options.onError ?? (() => undefined)
        this.flushTimer = setInterval(
            () => void this.flush().catch(error => this.handleError(error)),
            options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
        )
    }

    log(input: LogInput): void {
        this.enqueue({
            signal_type: 'log',
            environment: this.environment,
            timestamp: input.timestamp ?? nowIso(),
            source: this.source,
            attributes: mergeAttributes({ defaults: this.defaultAttributes, overrides: input.attributes }),
            payload: {
                log_id: createUuid(),
                service_name: this.serviceName,
                source_type: 'application',
                severity_text: input.severityText,
                severity_number: input.severityNumber,
                message: input.message,
                trace_id: input.traceId ?? '',
                span_id: input.spanId ?? '',
                request_id: input.requestId ?? '',
                user_id: input.userId ?? '',
                logger_name: input.loggerName ?? '',
                file_ref: '',
                instance_id: '',
                pod_name: '',
                namespace: '',
                node_name: '',
                resource_attributes: input.resourceAttributes ?? {},
                log_attributes: input.attributes ?? {},
            },
        })
    }

    event(input: EventInput): void {
        this.captureEvent({ event: input, error: emptyCapturedError })
    }

    captureError(error: unknown, options: CaptureErrorOptions): void {
        this.captureEvent({
            event: {
                ...options,
                category: options.category ?? 'error',
                level: 'error',
            },
            error: normalizeCapturedError(error),
        })
    }

    gauge(input: GaugeInput): void {
        this.enqueue({
            signal_type: 'metric',
            environment: this.environment,
            timestamp: input.timestamp ?? nowIso(),
            source: this.source,
            attributes: mergeAttributes({ defaults: this.defaultAttributes, overrides: input.attributes }),
            payload: {
                metric_kind: 'gauge',
                service_name: this.serviceName,
                metric_name: input.name,
                unit: input.unit ?? '',
                value: input.value,
                resource_attributes: input.resourceAttributes ?? {},
                metric_attributes: input.attributes ?? {},
            },
        })
    }

    sum(input: SumInput): void {
        this.enqueue({
            signal_type: 'metric',
            environment: this.environment,
            timestamp: input.timestamp ?? nowIso(),
            source: this.source,
            attributes: mergeAttributes({ defaults: this.defaultAttributes, overrides: input.attributes }),
            payload: {
                metric_kind: 'sum',
                service_name: this.serviceName,
                metric_name: input.name,
                unit: input.unit ?? '',
                value: input.value,
                is_monotonic: input.isMonotonic ?? true,
                temporality: input.temporality ?? 'delta',
                resource_attributes: input.resourceAttributes ?? {},
                metric_attributes: input.attributes ?? {},
            },
        })
    }

    histogram(input: HistogramInput): void {
        const sortedBuckets = sortNumbers(input.buckets)
        const buckets = sortedBuckets.map(bucket => ({
            le: bucket,
            count: input.value <= bucket ? 1 : 0,
        }))

        this.enqueue({
            signal_type: 'metric',
            environment: this.environment,
            timestamp: input.timestamp ?? nowIso(),
            source: this.source,
            attributes: mergeAttributes({ defaults: this.defaultAttributes, overrides: input.attributes }),
            payload: {
                metric_kind: 'histogram',
                service_name: this.serviceName,
                metric_name: input.name,
                unit: input.unit ?? '',
                buckets,
                count: 1,
                sum: input.value,
                min: input.value,
                max: input.value,
                resource_attributes: input.resourceAttributes ?? {},
                metric_attributes: input.attributes ?? {},
            },
        })
    }

    captureHttpExchange(input: CaptureHttpExchangeInput): void {
        const traceContext = this.resolveTraceContext(input)
        const route = input.route.length > 0 ? input.route : input.url
        const requestKind = input.requestKind ?? 'http'
        const capturedError = input.error === undefined ? undefined : normalizeCapturedError(input.error)
        const hasError = input.statusCode >= 400 || capturedError !== undefined
        const requestAccept = getHttpHeaderValue({ headers: input.requestHeaders, name: 'accept' })
        const responseContentType = getHttpHeaderValue({ headers: input.responseHeaders, name: 'content-type' })
        const requestSizeBytes = resolveHttpMessageSize({
            body: input.requestBody,
            explicitSizeBytes: input.requestSizeBytes,
            headers: input.requestHeaders,
        })
        const responseSizeBytes = resolveHttpMessageSize({
            body: input.responseBody,
            explicitSizeBytes: input.responseSizeBytes,
            headers: input.responseHeaders,
        })
        const sizeAttributes = {
            'http.request.size': String(requestSizeBytes),
            'http.response.size': String(responseSizeBytes),
        }
        const commonAttributes = {
            ...(input.attributes ?? {}),
            ...(capturedError === undefined
                ? {}
                : {
                      'error.type': capturedError.type,
                      'error.message': capturedError.message,
                      'error.stack': capturedError.stack,
                      'error.code': capturedError.code,
                      'error.handled': String(input.errorHandled ?? false),
                  }),
            'http.method': input.method,
            'http.route': route,
            'http.status_code': String(input.statusCode),
            'inkronik.request_kind': requestKind,
            ...toStringMap({
                'http.request.accept': requestAccept,
                'http.response.content_type': responseContentType,
                'user.id': input.userId,
            }),
        }

        this.enqueue({
            signal_type: 'span',
            environment: this.environment,
            timestamp: new Date(Date.now() - input.durationMs).toISOString(),
            source: this.source,
            attributes: mergeAttributes({ defaults: this.defaultAttributes, overrides: input.attributes }),
            payload: {
                trace_id: traceContext.traceId,
                span_id: traceContext.spanId,
                parent_span_id: traceContext.parentSpanId,
                end_time: nowIso(),
                duration_us: Math.max(0, Math.round(input.durationMs * 1000)),
                service_name: this.serviceName,
                operation_name: `${input.method} ${route}`,
                span_kind: 'server',
                span_category: 'http',
                status_code: hasError ? 'error' : 'ok',
                status_message: capturedError?.message ?? '',
                has_error: hasError,
                http_method: input.method,
                http_route: route,
                http_status_code: input.statusCode,
                db_system: '',
                messaging_system: '',
                peer_service: '',
                resource_attributes: {},
                span_attributes: {
                    ...commonAttributes,
                    ...sizeAttributes,
                    'http.url': input.url,
                },
            },
        })

        if (input.metrics?.enabled !== false) {
            this.emitHttpMetrics({
                attributes: commonAttributes,
                buckets: input.metrics?.latencyBucketsMs ?? DEFAULT_HTTP_LATENCY_BUCKETS_MS,
                durationMs: input.durationMs,
                requestKind,
                requestSizeBytes,
                responseSizeBytes,
                statusCode: input.statusCode,
            })
        }

        if (input.captureRequestResponse !== true) {
            return
        }

        this.enqueue({
            signal_type: 'request_response_capture',
            environment: this.environment,
            timestamp: nowIso(),
            source: this.source,
            attributes: mergeAttributes({ defaults: this.defaultAttributes, overrides: input.attributes }),
            payload: {
                capture_id: createUuid(),
                trace_id: traceContext.traceId,
                span_id: traceContext.spanId,
                service_name: this.serviceName,
                http_method: input.method,
                http_route: route,
                http_status_code: input.statusCode,
                request_headers: input.requestHeaders,
                request_query: input.requestQuery,
                request_body: input.requestBody ?? '',
                response_headers: input.responseHeaders,
                response_body: input.responseBody ?? '',
            },
        })
    }

    captureLoggerRecord(record: LoggerRecord): void {
        const severity = severityByLevel[record.level.toLowerCase()] ?? { number: 9, text: record.level.toUpperCase() }
        const context = getCurrentTraceContext()
        const errorAttributes: Record<string, string> =
            record.error instanceof Error
                ? {
                      'error.name': record.error.name,
                      'error.message': record.error.message,
                  }
                : {}

        this.log({
            severityText: severity.text,
            severityNumber: severity.number,
            message: record.message,
            traceId: context?.traceId,
            spanId: context?.spanId,
            loggerName: 'inkronik',
            attributes: {
                ...(record.attributes ?? {}),
                ...errorAttributes,
            },
        })
    }

    startRuntimeMetrics(options: RuntimeMetricsOptions = {}): void {
        if (options.enabled === false || this.runtimeMetricsTimer !== null) {
            return
        }

        const eventLoopMonitor = monitorEventLoopDelay({ resolution: options.eventLoopResolutionMs ?? DEFAULT_EVENT_LOOP_RESOLUTION_MS })
        eventLoopMonitor.enable()
        // Timer and monitor handles are internal process state.
        // eslint-disable-next-line functional/immutable-data
        this.eventLoopMonitor = eventLoopMonitor
        // eslint-disable-next-line functional/immutable-data
        this.runtimeMetricsTimer = setInterval(() => this.emitRuntimeMetrics(), options.intervalMs ?? DEFAULT_RUNTIME_METRICS_INTERVAL_MS)
        this.emitRuntimeMetrics()
    }

    stopRuntimeMetrics(): void {
        if (this.runtimeMetricsTimer !== null) {
            clearInterval(this.runtimeMetricsTimer)
            // eslint-disable-next-line functional/immutable-data
            this.runtimeMetricsTimer = null
        }

        this.eventLoopMonitor?.disable()
        // eslint-disable-next-line functional/immutable-data
        this.eventLoopMonitor = null
    }

    instrumentFetch(options: InstrumentedFetchOptions = {}): typeof fetch {
        const fetchImpl = options.fetchImpl ?? fetch

        return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            if (options.shouldTrace?.(input) === false || isCollectorTelemetryRequest({ collectorUrl: this.collectorUrl, input })) {
                return fetchImpl(input, init)
            }

            const parent = getCurrentTraceContext()
            const context = createChildTraceContext(parent)
            const startedAt = performance.now()
            const request = new Request(input, init)
            const headers = new Headers(request.headers)
            headers.set('traceparent', toTraceparent(context))
            const tracedRequest = new Request(request, { headers })

            try {
                const response = await fetchImpl(tracedRequest)
                const requestUrl = new URL(request.url)
                this.captureClientSpan({
                    context,
                    durationMs: performance.now() - startedAt,
                    method: request.method,
                    peerService: options.getPeerService?.(input) ?? requestUrl.host,
                    statusCode: response.status,
                    url: requestUrl,
                })

                return response
            } catch (error) {
                const requestUrl = new URL(request.url)
                this.captureClientSpan({
                    context,
                    durationMs: performance.now() - startedAt,
                    method: request.method,
                    peerService: options.getPeerService?.(input) ?? requestUrl.host,
                    statusCode: 0,
                    url: requestUrl,
                    error,
                })
                throw error
            }
        }) as typeof fetch
    }

    instrumentGlobalFetch(options: InstrumentedFetchOptions = {}): () => void {
        const currentFetch = globalThis.fetch as InstrumentedGlobalFetch

        if (currentFetch[INKRONIK_ORIGINAL_FETCH] !== undefined) {
            return () => undefined
        }

        const tracedFetch = this.instrumentFetch({ ...options, fetchImpl: currentFetch }) as InstrumentedGlobalFetch
        // Marking the wrapped function avoids stacking multiple global fetch wrappers.
        // eslint-disable-next-line functional/immutable-data
        Object.defineProperty(tracedFetch, INKRONIK_ORIGINAL_FETCH, { value: currentFetch, configurable: true })
        // Patching a process global is the point of auto-instrumentation.
        // eslint-disable-next-line functional/immutable-data
        globalThis.fetch = tracedFetch

        const restore = () => {
            if (globalThis.fetch === tracedFetch) {
                // Restore the exact fetch implementation we wrapped.
                // eslint-disable-next-line functional/immutable-data
                globalThis.fetch = currentFetch
            }
        }

        // Keep the patch tied to this client lifecycle.
        // eslint-disable-next-line functional/immutable-data
        this.globalFetchRestore = restore

        return restore
    }

    captureDatabaseQuery(input: DatabaseQuerySpanInput): void {
        const parentContext = input.parentContext ?? getCurrentTraceContext()

        if (parentContext === undefined) {
            return
        }

        const context = createChildTraceContext(parentContext)
        const system = input.system ?? 'postgresql'
        const operation = input.operation ?? (input.statement === undefined ? 'QUERY' : getDatabaseOperation(input.statement))
        const peerService = input.peerService ?? system
        const hasError = input.error !== undefined

        this.enqueue({
            signal_type: 'span',
            environment: this.environment,
            timestamp: new Date(Date.now() - input.durationMs).toISOString(),
            source: this.source,
            attributes: mergeAttributes({ defaults: this.defaultAttributes, overrides: input.attributes }),
            payload: {
                trace_id: context.traceId,
                span_id: context.spanId,
                parent_span_id: context.parentSpanId,
                end_time: nowIso(),
                duration_us: Math.max(0, Math.round(input.durationMs * 1000)),
                service_name: this.serviceName,
                operation_name: `${operation} ${peerService}`,
                span_kind: 'client',
                span_category: 'database',
                status_code: hasError ? 'error' : 'ok',
                status_message: input.error instanceof Error ? input.error.message : '',
                has_error: hasError,
                http_method: '',
                http_route: '',
                http_status_code: 0,
                db_system: system,
                messaging_system: '',
                peer_service: peerService,
                resource_attributes: {},
                span_attributes: {
                    ...(input.attributes ?? {}),
                    ...toStringMap({
                        'db.name': input.databaseName,
                        'db.operation': operation,
                        'db.statement': input.statement,
                        'db.system': system,
                        error: input.error instanceof Error ? input.error.message : undefined,
                        'peer.service': peerService,
                    }),
                },
            },
        })
    }

    instrumentPostgres<TSql extends PostgresJsSql>({ sql, ...options }: InstrumentPostgresInput<TSql>): TSql {
        if (Reflect.get(sql, INKRONIK_INSTRUMENTED_POSTGRES) === true) {
            return sql
        }

        const captureStatement = options.captureStatement ?? true
        const maxStatementLength = options.maxStatementLength ?? DEFAULT_DB_STATEMENT_MAX_LENGTH
        const prepareStatement = (statement: string): string =>
            captureStatement ? normalizeDatabaseStatement({ maxLength: maxStatementLength, statement }) : ''
        const captureQuery = ({
            error,
            parentContext,
            preparedStatement,
            startedAt,
        }: {
            readonly error?: unknown
            readonly parentContext: TraceContext
            readonly preparedStatement: string
            readonly startedAt: number
        }): void => {
            this.captureDatabaseQuery({
                databaseName: options.databaseName,
                durationMs: performance.now() - startedAt,
                error,
                operation: getDatabaseOperation(preparedStatement),
                parentContext,
                peerService: options.peerService,
                statement: preparedStatement,
                system: options.system,
            })
        }
        const traceQuery = ({ query, statement }: { readonly query: unknown; readonly statement: string }): unknown => {
            const parentContext = getCurrentTraceContext()
            const preparedStatement = prepareStatement(statement)

            if (parentContext === undefined) {
                return query
            }

            if (options.shouldTrace?.(preparedStatement) === false) {
                return query
            }

            if ((typeof query !== 'object' && typeof query !== 'function') || query === null) {
                const startedAt = performance.now()

                return Promise.resolve(query).then(
                    result => {
                        captureQuery({ parentContext, preparedStatement, startedAt })

                        return result
                    },
                    error => {
                        captureQuery({ error, parentContext, preparedStatement, startedAt })
                        throw error
                    },
                )
            }

            const state: { captured: boolean; startedAt: number | null } = {
                captured: false,
                startedAt: null,
            }
            const start = (): number => {
                const startedAt = state.startedAt ?? performance.now()
                // Tracking execution timing is local query state.
                // eslint-disable-next-line functional/immutable-data
                state.startedAt = startedAt

                return startedAt
            }
            const captureOnce = (error?: unknown): void => {
                if (state.captured) {
                    return
                }

                // Tracking execution completion is local query state.
                // eslint-disable-next-line functional/immutable-data
                state.captured = true
                captureQuery({ error, parentContext, preparedStatement, startedAt: state.startedAt ?? performance.now() })
            }
            const wrapPromiseMethod =
                (property: PropertyKey, value: (...args: ReadonlyArray<unknown>) => unknown) =>
                // Promise-like methods must keep the postgres-js Query shape while tracing execution.
                // eslint-disable-next-line functional/functional-parameters
                (...args: ReadonlyArray<unknown>): unknown => {
                    start()

                    if (property === 'then') {
                        const onFulfilled = args[0]
                        const onRejected = args[1]

                        return value.call(
                            query,
                            (result: unknown) => {
                                captureOnce()

                                return isPromiseCallback(onFulfilled) ? onFulfilled(result) : result
                            },
                            (error: unknown) => {
                                captureOnce(error)

                                if (isPromiseCallback(onRejected)) {
                                    return onRejected(error)
                                }

                                throw error
                            },
                        )
                    }

                    if (property === 'catch') {
                        const onRejected = args[0]

                        return value.call(query, (error: unknown) => {
                            captureOnce(error)

                            if (isPromiseCallback(onRejected)) {
                                return onRejected(error)
                            }

                            throw error
                        })
                    }

                    const onFinally = args[0]

                    return (query as Promise<unknown>)
                        .then(
                            result => {
                                captureOnce()

                                return result
                            },
                            error => {
                                captureOnce(error)
                                throw error
                            },
                        )
                        .finally(isFinallyCallback(onFinally) ? onFinally : undefined)
                }
            const proxy = new Proxy(query, {
                get: (target, property, receiver) => {
                    const value: unknown = Reflect.get(target, property, receiver)

                    if ((property === 'then' || property === 'catch' || property === 'finally') && typeof value === 'function') {
                        return wrapPromiseMethod(property, value as (...args: ReadonlyArray<unknown>) => unknown)
                    }

                    if (property === 'execute' && typeof value === 'function') {
                        return (): unknown => {
                            start()
                            const result = Reflect.apply(value, target, []) as unknown

                            return result === target ? proxy : result
                        }
                    }

                    if (typeof value !== 'function') {
                        return value
                    }

                    // postgres-js query modifiers like values(), raw(), simple() return the same Query instance.
                    // eslint-disable-next-line functional/functional-parameters
                    return (...args: ReadonlyArray<unknown>): unknown => {
                        const result = Reflect.apply(value, target, args) as unknown

                        return result === target ? proxy : result
                    }
                },
            })

            return proxy
        }
        const wrapTransactionCallback =
            (callback: (...args: ReadonlyArray<unknown>) => unknown) =>
            // The postgres-js transaction callback receives positional values from the driver.
            // eslint-disable-next-line functional/functional-parameters
            (...args: ReadonlyArray<unknown>) =>
                callback(
                    ...args.map(argument =>
                        typeof argument === 'function' ? this.instrumentPostgres({ ...options, sql: argument as TSql }) : argument,
                    ),
                )

        return new Proxy(sql, {
            apply: (target, thisArg, args) =>
                traceQuery({
                    query: Reflect.apply(target, thisArg, args) as unknown,
                    statement: isTemplateStringsArray(args[0]) ? getTaggedSqlStatement(args[0]) : 'postgres query',
                }),
            get: (target, property, receiver) => {
                if (property === INKRONIK_INSTRUMENTED_POSTGRES) {
                    return true
                }

                const value = Reflect.get(target, property, receiver)

                if (property === 'unsafe' && typeof value === 'function') {
                    // postgres-js exposes unsafe(query, ...params).
                    // eslint-disable-next-line functional/functional-parameters
                    return (query: string, ...args: ReadonlyArray<unknown>) =>
                        traceQuery({ query: value.apply(target, [query, ...args]) as unknown, statement: query })
                }

                if (property === 'begin' && typeof value === 'function') {
                    // postgres-js begin accepts a variable argument list depending on transaction options.
                    // eslint-disable-next-line functional/functional-parameters
                    return (...args: ReadonlyArray<unknown>) => {
                        const callback = args.at(-1)
                        const transactionCallback = callback as (...args: ReadonlyArray<unknown>) => unknown
                        const nextArgs =
                            typeof callback === 'function' ? [...args.slice(0, -1), wrapTransactionCallback(transactionCallback)] : [...args]

                        return value.apply(target, nextArgs) as unknown
                    }
                }

                return typeof value === 'function' ? (value.bind(target) as unknown) : value
            },
        }) as TSql
    }

    captureMessagingSpan(input: CaptureMessagingSpanInput): void {
        const context = input.context ?? createChildTraceContext(input.parentContext ?? getCurrentTraceContext())
        const system = input.system ?? DEFAULT_MESSAGING_SYSTEM
        const operation = input.operation ?? (input.kind === 'producer' ? 'publish' : 'process')
        const peerService = input.peerService ?? input.destination
        const hasError = input.error !== undefined

        this.enqueue({
            signal_type: 'span',
            environment: this.environment,
            timestamp: new Date(Date.now() - input.durationMs).toISOString(),
            source: this.source,
            attributes: mergeAttributes({ defaults: this.defaultAttributes, overrides: input.attributes }),
            payload: {
                trace_id: context.traceId,
                span_id: context.spanId,
                parent_span_id: context.parentSpanId,
                end_time: nowIso(),
                duration_us: Math.max(0, Math.round(input.durationMs * 1000)),
                service_name: this.serviceName,
                operation_name: `${operation} ${input.destination}`,
                span_kind: input.kind,
                span_category: 'messaging',
                status_code: hasError ? 'error' : 'ok',
                status_message: input.error instanceof Error ? input.error.message : '',
                has_error: hasError,
                http_method: '',
                http_route: '',
                http_status_code: 0,
                db_system: '',
                messaging_system: system,
                peer_service: peerService,
                resource_attributes: {},
                span_attributes: {
                    ...(input.attributes ?? {}),
                    ...toStringMap({
                        error: input.error instanceof Error ? input.error.message : undefined,
                        'messaging.destination': input.destination,
                        'messaging.message.id': input.jobId,
                        'messaging.operation': operation,
                        'messaging.system': system,
                        'messaging.message.name': input.messageName,
                        'peer.service': peerService,
                    }),
                },
            },
        })
    }

    instrumentBullMQ({ Queue, ...options }: InstrumentBullMQInput): () => void {
        if (options.enabled === false) {
            return () => undefined
        }

        const originalAddCandidate = Queue.prototype.add

        if (typeof originalAddCandidate !== 'function') {
            return () => undefined
        }

        const originalAdd = originalAddCandidate as (this: unknown, name: string, data: unknown, opts?: unknown) => unknown
        const previousAdd = (Queue.prototype as Record<PropertyKey, unknown>)[INKRONIK_ORIGINAL_BULLMQ_QUEUE_ADD]

        if (typeof previousAdd === 'function') {
            return () => undefined
        }

        // Patching a queue prototype is the point of messaging auto-instrumentation.
        // eslint-disable-next-line functional/immutable-data
        Object.defineProperty(Queue.prototype, INKRONIK_ORIGINAL_BULLMQ_QUEUE_ADD, { value: originalAdd, configurable: true })

        const system = options.system ?? DEFAULT_MESSAGING_SYSTEM
        const getQueueName = options.getQueueName ?? getDefaultQueueName
        const captureMessagingSpan = (input: CaptureMessagingSpanInput): void => {
            this.captureMessagingSpan(input)
        }

        // BullMQ Queue.add uses positional arguments by design.
        const tracedAdd = function (this: unknown, name: string, data: unknown, opts?: unknown): unknown {
            const parent = getCurrentTraceContext()
            const queueName = getQueueName(this)

            if (parent === undefined || options.shouldTrace?.(queueName, name) === false) {
                return originalAdd.call(this, name, data, opts)
            }

            const context = createChildTraceContext(parent)
            const startedAt = performance.now()
            const tracedData = injectBullMQTraceparent({ data, traceparent: toTraceparent(context) })

            return Promise.resolve(originalAdd.call(this, name, tracedData, opts)).then(
                job => {
                    captureMessagingSpan({
                        context,
                        destination: queueName,
                        durationMs: performance.now() - startedAt,
                        jobId: getJobId(job),
                        kind: 'producer',
                        messageName: name,
                        system,
                    })

                    return job
                },
                error => {
                    captureMessagingSpan({
                        context,
                        destination: queueName,
                        durationMs: performance.now() - startedAt,
                        error,
                        kind: 'producer',
                        messageName: name,
                        system,
                    })
                    throw error
                },
            )
        }

        // Patching a queue prototype is the point of messaging auto-instrumentation.
        // eslint-disable-next-line functional/immutable-data
        Queue.prototype.add = tracedAdd

        return () => {
            if (Queue.prototype.add === tracedAdd) {
                // Restore the exact Queue.add implementation we wrapped.
                // eslint-disable-next-line functional/immutable-data
                Queue.prototype.add = originalAdd
            }

            // The marker belongs to the prototype patch lifecycle.
            // eslint-disable-next-line functional/immutable-data
            delete (Queue.prototype as Record<PropertyKey, unknown>)[INKRONIK_ORIGINAL_BULLMQ_QUEUE_ADD]
        }
    }

    instrumentBullMQProcessor<TJob extends BullMQJobLike, TResult>({
        processor,
        queueName,
        ...options
    }: InstrumentBullMQProcessorInput<TJob, TResult>): (...args: [TJob, string?, AbortSignal?]) => Promise<TResult> {
        const system = options.system ?? DEFAULT_MESSAGING_SYSTEM

        return (job, token, signal) => {
            const jobName = getJobName(job)

            if (options.enabled === false || options.shouldTrace?.(queueName, jobName ?? '') === false) {
                return Promise.resolve(processor(job, token, signal))
            }

            const context = parseTraceparent(getBullMQTraceparent(job)) ?? createChildTraceContext(getCurrentTraceContext())
            const startedAt = performance.now()

            return runWithTraceContext(context, () =>
                Promise.resolve()
                    .then(() => processor(job, token, signal))
                    .then(
                        result => {
                            this.captureMessagingSpan({
                                context,
                                destination: queueName,
                                durationMs: performance.now() - startedAt,
                                jobId: getJobId(job),
                                kind: 'consumer',
                                messageName: jobName,
                                system,
                            })

                            return result
                        },
                        error => {
                            this.captureMessagingSpan({
                                context,
                                destination: queueName,
                                durationMs: performance.now() - startedAt,
                                error,
                                jobId: getJobId(job),
                                kind: 'consumer',
                                messageName: jobName,
                                system,
                            })
                            throw error
                        },
                    ),
            )
        }
    }

    send(input: SendTelemetryInput): void {
        input.signals.forEach(signal => this.enqueue(signal))
    }

    async flush(): Promise<FlushResult> {
        if (this.queue.length === 0) {
            return { accepted: 0, responses: [] }
        }

        const signals = this.queue
        // eslint-disable-next-line functional/immutable-data
        this.queue = []

        const batches = this.chunk(signals)
        const results = await Promise.allSettled(batches.map(batch => this.post({ signals: batch })))
        const responses = results.flatMap(result => {
            if (result.status === 'fulfilled') {
                return [result.value]
            }

            this.handleError(result.reason)

            return []
        })
        const accepted = responses.reduce((total, response) => total + response.accepted, 0)

        return { accepted, responses }
    }

    async shutdown(): Promise<FlushResult> {
        this.stopRuntimeMetrics()
        clearInterval(this.flushTimer)
        this.globalFetchRestore?.()
        // eslint-disable-next-line functional/immutable-data
        this.globalFetchRestore = null
        return this.flush()
    }

    private captureEvent({ event: input, error }: CaptureEventSignalInput): void {
        const traceContext = getCurrentTraceContext()
        const telemetryContext = getCurrentTelemetryContext()
        const inheritedUser = telemetryContext?.resolveUser()
        const user = input.user ?? (input.userId === undefined ? inheritedUser : { id: input.userId })
        const userAttributes = getUserEventAttributes(user)
        const eventAttributes = { ...(input.attributes ?? {}), ...userAttributes }

        this.enqueue({
            signal_type: 'event',
            environment: this.environment,
            timestamp: input.timestamp ?? nowIso(),
            source: this.source,
            attributes: mergeAttributes({ defaults: this.defaultAttributes, overrides: eventAttributes }),
            payload: {
                event_id: createUuid(),
                event_name: input.name,
                event_category: input.category,
                event_level: input.level ?? DEFAULT_EVENT_LEVEL,
                message: truncateUtf8({ maxBytes: MAX_EVENT_MESSAGE_BYTES, value: input.message ?? '' }),
                service_name: this.serviceName,
                source_type: 'application',
                user_id: user?.id ?? '',
                session_id: input.sessionId ?? telemetryContext?.resolveSessionId() ?? '',
                trace_id: input.traceId ?? traceContext?.traceId ?? '',
                span_id: input.spanId ?? traceContext?.spanId ?? '',
                error_type: error.type,
                error_message: error.message,
                error_stack: error.stack,
                error_code: error.code,
                error_handled: error.handled,
                event_attributes: eventAttributes,
            },
        })
    }

    private resolveTraceContext(input: CaptureHttpExchangeInput): TraceContext {
        const current = getCurrentTraceContext()

        if (input.traceId !== undefined) {
            return {
                traceId: input.traceId,
                parentSpanId: input.parentSpanId ?? '',
                spanId:
                    current?.spanId ?? createChildTraceContext({ traceId: input.traceId, spanId: input.parentSpanId ?? '', parentSpanId: '' }).spanId,
            }
        }

        return createChildTraceContext(current)
    }

    private emitHttpMetrics({
        attributes,
        buckets,
        durationMs,
        requestKind,
        requestSizeBytes,
        responseSizeBytes,
        statusCode,
    }: EmitHttpMetricsInput): void {
        this.sum({ name: 'http.server.requests', value: 1, unit: 'requests', attributes })
        this.sum({ name: 'http.server.request.size', value: requestSizeBytes, unit: 'bytes', attributes })
        this.sum({ name: 'http.server.response.size', value: responseSizeBytes, unit: 'bytes', attributes })

        if (requestKind === 'http') {
            this.histogram({ name: 'http.server.duration', value: durationMs, unit: 'ms', buckets, attributes })
        }

        if (statusCode >= 500) {
            this.sum({ name: 'http.server.errors', value: 1, unit: 'errors', attributes })
        }
    }

    private emitRuntimeMetrics(): void {
        const memory = process.memoryUsage()
        const attributes = { runtime: 'node' }
        const eventLoopLagMs = this.eventLoopMonitor === null ? 0 : this.eventLoopMonitor.mean / 1_000_000

        this.gauge({ name: 'runtime.node.memory.rss', value: memory.rss, unit: 'bytes', attributes })
        this.gauge({ name: 'runtime.node.memory.heap_used', value: memory.heapUsed, unit: 'bytes', attributes })
        this.gauge({ name: 'runtime.node.memory.heap_total', value: memory.heapTotal, unit: 'bytes', attributes })
        this.gauge({ name: 'runtime.node.uptime', value: process.uptime(), unit: 's', attributes })
        this.gauge({ name: 'runtime.node.event_loop.lag', value: Number.isFinite(eventLoopLagMs) ? eventLoopLagMs : 0, unit: 'ms', attributes })
        this.eventLoopMonitor?.reset()
    }

    private captureClientSpan({
        context,
        durationMs,
        error,
        method,
        peerService,
        statusCode,
        url,
    }: {
        readonly context: TraceContext
        readonly durationMs: number
        readonly error?: unknown
        readonly method: string
        readonly peerService: string
        readonly statusCode: number
        readonly url: URL
    }): void {
        const hasError = statusCode >= 400 || error !== undefined

        this.enqueue({
            signal_type: 'span',
            environment: this.environment,
            timestamp: new Date(Date.now() - durationMs).toISOString(),
            source: this.source,
            attributes: this.defaultAttributes,
            payload: {
                trace_id: context.traceId,
                span_id: context.spanId,
                parent_span_id: context.parentSpanId,
                end_time: nowIso(),
                duration_us: Math.max(0, Math.round(durationMs * 1000)),
                service_name: this.serviceName,
                operation_name: `${method} ${url.host}`,
                span_kind: 'client',
                span_category: 'http',
                status_code: hasError ? 'error' : 'ok',
                status_message: error instanceof Error ? error.message : '',
                has_error: hasError,
                http_method: method,
                http_route: `${url.pathname}${url.search}`,
                http_status_code: statusCode,
                db_system: '',
                messaging_system: '',
                peer_service: peerService,
                resource_attributes: {},
                span_attributes: {
                    ...toStringMap({ error: error instanceof Error ? error.message : undefined }),
                    'http.host': url.host,
                    'http.scheme': url.protocol.replace(':', ''),
                    'http.target': `${url.pathname}${url.search}`,
                    'http.url': url.toString(),
                    'peer.service': peerService,
                },
            },
        })
    }

    // Every signal type funnels through here, so the release stamp is applied once rather than at each of the
    // ten envelope construction sites — a new signal type cannot forget it.
    //
    // The parameter drops `service_version` across every union member (callers never supply it) and the stamped
    // object is asserted back to the full signal. The assertion is needed only because TypeScript will not prove
    // that spreading one distributed member and restoring the omitted key reconstitutes that same member.
    private enqueue(unversionedSignal: UnversionedTelemetrySignal): void {
        const signal = this.withPodName({ ...unversionedSignal, service_version: this.serviceVersion ?? '' } as IngestTelemetrySignal)

        if (this.queue.length >= this.maxQueueSize) {
            this.handleError(
                new Error(`Inkronik telemetry queue is full. Dropping the oldest signal to keep the queue bounded at ${this.maxQueueSize}.`),
            )
            // eslint-disable-next-line functional/immutable-data
            this.queue = [...this.queue.slice(1), signal]
        } else {
            // eslint-disable-next-line functional/immutable-data
            this.queue = [...this.queue, signal]
        }

        if (this.queue.length >= this.maxBatchSize) {
            this.flush().catch(error => this.handleError(error))
        }
    }

    // Stamps the pod name into resource_attributes on the three signal types that carry them (log, span, metric) —
    // the only ones the deployment read model attributes to a release. Done once here so a new signal type cannot
    // forget it. An existing k8s.pod (e.g. from a caller already running in k8s) is never overwritten.
    private withPodName(signal: IngestTelemetrySignal): IngestTelemetrySignal {
        if (this.podName === undefined || (signal.signal_type !== 'log' && signal.signal_type !== 'span' && signal.signal_type !== 'metric')) {
            return signal
        }

        const resourceAttributes = signal.payload.resource_attributes

        if (Object.hasOwn(resourceAttributes, POD_NAME_ATTRIBUTE)) {
            return signal
        }

        return {
            ...signal,
            payload: { ...signal.payload, resource_attributes: { ...resourceAttributes, [POD_NAME_ATTRIBUTE]: this.podName } },
        } as IngestTelemetrySignal
    }

    private chunk(signals: ReadonlyArray<IngestTelemetrySignal>): Array<Array<IngestTelemetrySignal>> {
        return signals.reduce<Array<Array<IngestTelemetrySignal>>>((batches, signal) => {
            const lastBatch = batches.at(-1)

            if (lastBatch === undefined || lastBatch.length >= this.maxBatchSize) {
                return [...batches, [signal]]
            }

            return [...batches.slice(0, -1), [...lastBatch, signal]]
        }, [])
    }

    private async post(payload: IngestTelemetryRequest): Promise<IngestTelemetryResponse> {
        const abortController = new AbortController()
        const timeout = setTimeout(() => abortController.abort(), this.requestTimeoutMs)
        const applicationHeader: Record<string, string> = this.applicationId === undefined ? {} : { 'x-application-id': this.applicationId }

        try {
            const response = await this.fetchImpl(`${this.collectorUrl}/v1/telemetry`, {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    authorization: `Bearer ${this.ingestApiKey}`,
                    'content-type': 'application/json',
                    ...applicationHeader,
                },
                body: JSON.stringify(payload),
                signal: abortController.signal,
            })

            if (!response.ok) {
                throw new Error(`Inkronik collector rejected telemetry with HTTP ${response.status}: ${await response.text()}`)
            }

            return (await response.json()) as IngestTelemetryResponse
        } finally {
            clearTimeout(timeout)
        }
    }

    private handleError(error: unknown): void {
        try {
            this.onError(error instanceof Error ? error : new Error(String(error)))
        } catch {
            // The SDK must never throw back into host application request handling.
        }
    }
}
