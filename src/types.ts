import type { IngestTelemetryResponse, IngestTelemetrySignal } from './protocol/types.js'

export type EventLevel = 'info' | 'warning' | 'error'

export interface EventUserContext {
    readonly id: string
    readonly attributes?: Record<string, string>
}

export interface CapturedError {
    readonly type: string
    readonly message: string
    readonly stack: string
    readonly code: string
    readonly handled: boolean
}

export interface InkronikClientOptions {
    readonly collectorUrl: string
    readonly ingestApiKey: string
    readonly applicationId?: string
    readonly environment?: string
    readonly serviceName: string
    readonly serviceVersion?: string
    // The Kubernetes pod this client runs in. Stamped onto telemetry so the writer can derive service_version
    // from the pod's deployed image when the service does not report a version itself.
    readonly podName?: string
    readonly source?: string
    readonly defaultAttributes?: Record<string, string>
    readonly flushIntervalMs?: number
    readonly maxBatchSize?: number
    readonly maxQueueSize?: number
    readonly requestTimeoutMs?: number
    readonly fetchImpl?: typeof fetch
    readonly onError?: (error: Error) => void
}

export interface CreateInkronikClientFromEnvOptions {
    readonly applicationIdRequired?: boolean
    readonly serviceName?: string
    readonly serviceVersion?: string
    readonly podName?: string
    readonly environment?: string
    readonly source?: string
    readonly defaultAttributes?: Record<string, string>
    readonly flushIntervalMs?: number
    readonly maxBatchSize?: number
    readonly maxQueueSize?: number
    readonly requestTimeoutMs?: number
    readonly fetchImpl?: typeof fetch
    readonly onError?: (error: Error) => void
    readonly env?: Record<string, string | undefined>
}

export interface AutoInstrumentationOptions {
    readonly bullMQ?: boolean | BullMQInstrumentationOptions
    readonly fetch?: boolean | InstrumentedFetchOptions
    readonly pg?: boolean | DatabaseInstrumentationOptions
    readonly postgres?: boolean | DatabaseInstrumentationOptions
    readonly runtimeMetrics?: boolean | RuntimeMetricsOptions
}

export type InitInkronikOptions = CreateInkronikClientFromEnvOptions & {
    readonly instrumentations?: AutoInstrumentationOptions
}

export interface RuntimeMetricsOptions {
    readonly enabled?: boolean
    readonly intervalMs?: number
    readonly eventLoopResolutionMs?: number
}

export interface HttpMetricsOptions {
    readonly enabled?: boolean
    readonly latencyBucketsMs?: ReadonlyArray<number>
}

export type HttpRequestKind = 'http' | 'sse'

export type CapturedResponseBodyMode = 'none' | 'raw' | 'sample'

export type HttpBodySample = boolean | null | number | string | ReadonlyArray<HttpBodySample> | { readonly [key: string]: HttpBodySample }

export interface CaptureRedactionOptions {
    readonly fieldNames?: ReadonlyArray<string>
    readonly fieldPatterns?: ReadonlyArray<RegExp>
    readonly redactedValue?: string
}

export interface ResolvedCaptureRedactionOptions {
    readonly fieldNames: ReadonlyArray<string>
    readonly fieldPatterns: ReadonlyArray<RegExp>
    readonly redactedValue: string
}

export interface CaptureRequestResponseOptions {
    readonly enabled?: boolean
    readonly autoInstrumentFetch?: boolean | InstrumentedFetchOptions
    readonly exclude?: (request: HttpLikeRequest) => boolean
    readonly captureRequestResponse?: boolean
    readonly captureRequestBody?: boolean
    readonly captureResponseBody?: boolean
    readonly maxBodyBytes?: number
    readonly shouldCapture?: (context: HttpCaptureContext) => boolean
    readonly getUserId?: (context: HttpCaptureContext) => string
    readonly getUserContext?: (request: HttpLikeRequest) => EventUserContext | undefined
    readonly getSessionId?: (context: HttpCaptureContext) => string
    readonly getRoute?: (context: HttpCaptureContext) => string
    readonly getRequestKind?: (context: HttpCaptureContext) => HttpRequestKind
    readonly getAttributes?: (context: HttpCaptureContext) => Record<string, string>
    readonly redaction?: CaptureRedactionOptions
    readonly metrics?: HttpMetricsOptions
}

export type ResolvedCaptureRequestResponseOptions = Omit<Required<CaptureRequestResponseOptions>, 'autoInstrumentFetch' | 'metrics' | 'redaction'> & {
    readonly metrics: Required<HttpMetricsOptions>
    readonly redaction: ResolvedCaptureRedactionOptions
}

export interface HttpCaptureContext {
    readonly method: string
    readonly route: string
    readonly url: string
    readonly statusCode: number
    readonly userId: string
    readonly requestHeaders: Record<string, string>
    readonly requestQuery: Record<string, string>
    readonly responseHeaders: Record<string, string>
}

export interface CaptureHttpExchangeInput {
    readonly method: string
    readonly route: string
    readonly url: string
    readonly statusCode: number
    readonly requestHeaders: Record<string, string>
    readonly requestQuery: Record<string, string>
    readonly requestBody?: string
    readonly responseHeaders: Record<string, string>
    readonly responseBody?: string
    readonly requestSizeBytes?: number
    readonly responseSizeBytes?: number
    readonly durationMs: number
    readonly requestKind?: HttpRequestKind
    readonly captureRequestResponse?: boolean
    readonly metrics?: HttpMetricsOptions
    readonly traceId?: string
    readonly parentSpanId?: string
    readonly userId?: string
    readonly sessionId?: string
    readonly attributes?: Record<string, string>
    readonly error?: unknown
    readonly errorHandled?: boolean
}

export interface TraceContext {
    readonly traceId: string
    readonly spanId: string
    readonly parentSpanId: string
}

export interface HttpRequestInstrumentationState {
    captured: boolean
    readonly traceContext: TraceContext
}

export interface TelemetryContext extends TraceContext {
    readonly resolveUser: () => EventUserContext | undefined
    readonly resolveSessionId: () => string
}

export interface LogInput {
    readonly severityText: string
    readonly severityNumber: number
    readonly message: string
    readonly timestamp?: string
    readonly traceId?: string
    readonly spanId?: string
    readonly requestId?: string
    readonly userId?: string
    readonly loggerName?: string
    readonly attributes?: Record<string, string>
    readonly resourceAttributes?: Record<string, string>
}

export interface EventInput {
    readonly name: string
    readonly category: string
    readonly level?: EventLevel
    readonly message?: string
    readonly timestamp?: string
    readonly user?: EventUserContext
    readonly userId?: string
    readonly sessionId?: string
    readonly traceId?: string
    readonly spanId?: string
    readonly attributes?: Record<string, string>
}

export interface CaptureErrorOptions {
    readonly name: string
    readonly category?: string
    readonly message?: string
    readonly timestamp?: string
    readonly user?: EventUserContext
    readonly userId?: string
    readonly sessionId?: string
    readonly traceId?: string
    readonly spanId?: string
    readonly attributes?: Record<string, string>
}

export interface CaptureEventSignalInput {
    readonly event: EventInput
    readonly error: CapturedError
}

export interface BuildRequestTelemetryContextInput {
    readonly options: ResolvedCaptureRequestResponseOptions
    readonly request: HttpLikeRequest
    readonly response: HttpLikeResponse
    readonly traceContext: TraceContext
}

export interface GaugeInput {
    readonly name: string
    readonly value: number
    readonly unit?: string
    readonly timestamp?: string
    readonly attributes?: Record<string, string>
    readonly resourceAttributes?: Record<string, string>
}

export interface SumInput {
    readonly name: string
    readonly value: number
    readonly unit?: string
    readonly timestamp?: string
    readonly isMonotonic?: boolean
    readonly temporality?: 'delta' | 'cumulative'
    readonly attributes?: Record<string, string>
    readonly resourceAttributes?: Record<string, string>
}

export interface HistogramInput {
    readonly name: string
    readonly value: number
    readonly buckets: ReadonlyArray<number>
    readonly unit?: string
    readonly timestamp?: string
    readonly attributes?: Record<string, string>
    readonly resourceAttributes?: Record<string, string>
}

export interface EmitHttpMetricsInput {
    readonly attributes: Record<string, string>
    readonly buckets: ReadonlyArray<number>
    readonly durationMs: number
    readonly requestKind: HttpRequestKind
    readonly requestSizeBytes: number
    readonly responseSizeBytes: number
    readonly statusCode: number
}

export interface LoggerRecord {
    readonly level: string
    readonly message: string
    readonly error?: unknown
    readonly attributes?: Record<string, string>
}

export interface DatabaseQuerySpanInput {
    readonly databaseName?: string
    readonly durationMs: number
    readonly error?: unknown
    readonly operation?: string
    readonly parentContext?: TraceContext
    readonly peerService?: string
    readonly statement?: string
    readonly system?: string
    readonly attributes?: Record<string, string>
}

export type MessagingSpanKind = 'producer' | 'consumer'

export interface MessagingSpanInput {
    readonly destination: string
    readonly durationMs: number
    readonly error?: unknown
    readonly jobId?: string
    readonly messageName?: string
    readonly operation?: string
    readonly parentContext?: TraceContext
    readonly peerService?: string
    readonly system?: string
    readonly attributes?: Record<string, string>
}

export interface CaptureMessagingSpanInput extends MessagingSpanInput {
    readonly context?: TraceContext
    readonly kind: MessagingSpanKind
}

export interface BullMQInstrumentationOptions {
    readonly enabled?: boolean
    readonly getQueueName?: (queue: unknown) => string
    readonly shouldTrace?: (queueName: string, jobName: string) => boolean
    readonly system?: string
}

export interface BullMQQueueConstructor {
    readonly prototype: {
        add?: unknown
    }
}

export interface InstrumentBullMQInput extends BullMQInstrumentationOptions {
    readonly Queue: BullMQQueueConstructor
}

export interface BullMQJobLike {
    readonly id?: string | number
    readonly name?: string
    readonly data?: unknown
}

export type BullMQProcessor<TJob = BullMQJobLike, TResult = unknown> = (job: TJob, token?: string, signal?: AbortSignal) => TResult | Promise<TResult>

export interface InstrumentBullMQProcessorInput<TJob extends BullMQJobLike = BullMQJobLike, TResult = unknown> extends BullMQInstrumentationOptions {
    readonly processor: BullMQProcessor<TJob, TResult>
    readonly queueName: string
}

export interface DatabaseInstrumentationOptions {
    readonly captureStatement?: boolean
    readonly databaseName?: string
    readonly maxStatementLength?: number
    readonly peerService?: string
    readonly shouldTrace?: (statement: string) => boolean
    readonly system?: string
}

export interface PostgresJsClientOptions {
    readonly database?: string
}

export type PostgresJsSql = ((strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => unknown) & {
    readonly options?: PostgresJsClientOptions
}

export type InstrumentPostgresInput<TSql extends PostgresJsSql = PostgresJsSql> = DatabaseInstrumentationOptions & {
    readonly sql: TSql
}

export interface PostgresAutoInstrumentationClient {
    instrumentPostgres<TSql extends PostgresJsSql>(input: InstrumentPostgresInput<TSql>): TSql
}

export type PostgresAutoInstrumentationHook = (sql: PostgresJsSql) => PostgresJsSql

export interface StartPostgresAutoInstrumentationInput {
    readonly client: PostgresAutoInstrumentationClient
    readonly options: DatabaseInstrumentationOptions
}

export type PgQueryCallback = (error?: unknown, result?: unknown) => unknown

export type PgQueryMethod = (...argumentsList: ReadonlyArray<unknown>) => unknown

export interface PgQueryTarget {
    readonly database?: string
    readonly options?: {
        readonly database?: string
    }
    readonly query?: PgQueryMethod
}

export interface PgConstructor {
    readonly prototype: PgQueryTarget
}

export interface PgModule {
    readonly Client?: PgConstructor
    readonly Pool?: PgConstructor
    readonly default?: PgModule
}

export interface PgAutoInstrumentationClient {
    captureDatabaseQuery(input: DatabaseQuerySpanInput): void
}

export interface StartPgAutoInstrumentationInput {
    readonly client: PgAutoInstrumentationClient
    readonly module?: PgModule
    readonly options: DatabaseInstrumentationOptions
}

export interface InstrumentedFetchOptions {
    readonly fetchImpl?: typeof fetch
    readonly getPeerService?: (input: RequestInfo | URL) => string
    readonly shouldTrace?: (input: RequestInfo | URL) => boolean
}

export type InstrumentedGlobalFetch = typeof fetch & {
    readonly [key: symbol]: typeof fetch | undefined
}

export interface SendTelemetryInput {
    readonly signals: ReadonlyArray<IngestTelemetrySignal>
}

export interface FlushResult {
    readonly accepted: number
    readonly responses: ReadonlyArray<IngestTelemetryResponse>
}

export interface HttpLikeRequest {
    readonly method?: string
    readonly url?: string
    readonly originalUrl?: string
    readonly route?: { readonly path?: string }
    readonly headers?: Record<string, unknown>
    readonly query?: Record<string, unknown>
    readonly body?: unknown
    readonly user?: unknown
    readonly currentAccount?: unknown
}

export interface HttpLikeResponse {
    readonly statusCode?: number
    readonly getHeaders?: () => Record<string, number | string | ReadonlyArray<string> | undefined>
    write?: (chunk?: unknown, encoding?: unknown, callback?: unknown) => boolean
    end?: (chunk?: unknown, encoding?: unknown, callback?: unknown) => unknown
}

export type HttpLikeNext = (error?: unknown) => void

export interface ResolveHttpMessageSizeInput {
    readonly body?: string
    readonly explicitSizeBytes?: number
    readonly headers: Record<string, string>
}
