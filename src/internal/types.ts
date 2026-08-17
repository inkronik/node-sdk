import type { ClientRequest } from 'node:http'
import type { InkronikClient } from '../client.js'
import type { IngestTelemetrySignal } from '../protocol/types.js'
import type {
    CaptureRequestResponseOptions,
    CapturedResponseBodyMode,
    CreateInkronikClientFromEnvOptions,
    DatabaseInstrumentationOptions,
    HttpLikeRequest,
    HttpLikeResponse,
    InitInkronikOptions,
    NodeHttpInstrumentationOptions,
    PgAutoInstrumentationClient,
    PgConstructor,
    PgQueryMethod,
    PgQueryTarget,
    ResolvedCaptureRedactionOptions,
    ResolvedLogRedactionOptions,
    TraceContext,
} from '../types.js'

export interface ErrorPropertyInput {
    readonly error: unknown
    readonly property: string
}

export interface TruncateUtf8Input {
    readonly maxBytes: number
    readonly value: string
}

export interface MergeAttributesInput {
    readonly defaults: Record<string, string>
    readonly overrides?: Record<string, string>
}

export interface NormalizeDatabaseStatementInput {
    readonly maxLength?: number
    readonly statement: string
}

export type RequiredEnvKey = 'INKRONIK_COLLECTOR_URL' | 'INKRONIK_INGEST_API_KEY'

export type EnvKey =
    RequiredEnvKey | 'INKRONIK_APPLICATION_ID' | 'INKRONIK_SERVICE_VERSION' | 'INKRONIK_POD_NAME' | 'HOSTNAME' | 'KUBERNETES_SERVICE_HOST'

export interface ReadEnvValueInput {
    readonly env: Record<string, string | undefined>
    readonly key: EnvKey
}

export interface ReadRequiredEnvInput {
    readonly env: Record<string, string | undefined>
    readonly key: RequiredEnvKey
}

export interface BuildClientOptionsInput {
    readonly env: Record<string, string | undefined>
    readonly options: CreateInkronikClientFromEnvOptions
    readonly required: Record<RequiredEnvKey, string>
}

export interface AutoInstrumentationStartInput {
    readonly client: InkronikClient
    readonly options: InitInkronikOptions
}

export interface AsyncInstrumentationState {
    active: boolean
    restore: (() => void) | null
}

export interface SeverityDefinition {
    readonly number: number
    readonly text: string
}

export type UnversionedTelemetrySignal = IngestTelemetrySignal extends unknown ? Omit<IngestTelemetrySignal, 'service_version'> : never

export interface SensitiveCaptureFieldInput {
    readonly key: string
    readonly redaction: ResolvedCaptureRedactionOptions
}

export interface RedactCapturedJsonValueInput {
    readonly depth: number
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: unknown
}

export interface RedactLogTextInput {
    readonly redaction: ResolvedLogRedactionOptions
    readonly value: string
}

export interface RedactLogAttributesInput {
    readonly attributes: Record<string, string>
    readonly redaction: ResolvedLogRedactionOptions
}

export interface GetRequestRouteInput {
    readonly request: HttpLikeRequest
    readonly url: string
}

export interface GetHttpHeaderValueInput {
    readonly headers: Record<string, string>
    readonly name: string
}

export interface ResponseBodyTypeHeadersInput {
    readonly bodyMode: CapturedResponseBodyMode
    readonly headers: Record<string, string>
    readonly responseBodyType: string
}

export interface GetResponseTypeHeadersInput {
    readonly headers: Record<string, string>
    readonly responseBodyType: string
}

export interface ResolveCapturedResponseHeadersInput extends ResponseBodyTypeHeadersInput {
    readonly shouldCaptureRawResponse: boolean
}

export interface SanitizeSampleStringInput {
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: string
}

export interface GetBoundedObjectEntriesInput {
    readonly maxEntries: number
    readonly value: Readonly<Record<string, unknown>>
}

export interface MergeObjectSamplesInput {
    readonly depth: number
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly values: ReadonlyArray<Record<string, unknown>>
}

export interface GetHttpBodySampleInput {
    readonly depth?: number
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: unknown
}

export interface GetSerializedHttpBodySampleInput {
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: string
}

export interface HasHeaderValueInput extends GetHttpHeaderValueInput {
    readonly expected: string
}

export interface GetCompleteUtf8PrefixInput {
    readonly bytes: Uint8Array
    readonly maxBytes: number
}

export interface BuildCaptureContextInput {
    readonly request: HttpLikeRequest
    readonly response: HttpLikeResponse
}

export interface BoundedUtf8Writer {
    readonly append: (value: string) => void
    readonly output: string
    readonly remainingBytes: number
    readonly stop: () => void
    readonly stopped: boolean
}

export interface CreateBoundedUtf8WriterInput {
    readonly maxBytes: number
}

export interface WriteCapturedJsonStringInput {
    readonly close: boolean
    readonly value: string
    readonly writer: BoundedUtf8Writer
}

export interface WriteRedactedStringInput {
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: string
    readonly writer: BoundedUtf8Writer
}

export interface SerializeCapturedObjectPropertyInput extends SerializeCapturedJsonValueInput {
    readonly property: string
    readonly serializedProperties: number
}

export interface SerializeCapturedJsonArrayInput extends SerializeCapturedJsonValueInput {
    readonly value: ReadonlyArray<unknown>
}

export interface SerializeCapturedJsonObjectInput extends SerializeCapturedJsonValueInput {
    readonly value: object
}

export interface SerializeCapturedJsonValueInput {
    readonly capture: boolean
    readonly depth: number
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly stack: Array<object>
    readonly value: unknown
    readonly writer: BoundedUtf8Writer
}

export interface CaptureBodyValueInput {
    readonly maxBodyBytes: number
    readonly redaction: ResolvedCaptureRedactionOptions
    readonly value: unknown
}

export interface CreateInkronikExpressMiddlewareInput {
    readonly client: InkronikClient
    readonly options?: CaptureRequestResponseOptions
}

export interface CollectorTelemetryRequestInput {
    readonly collectorUrl: string
    readonly input: RequestInfo | URL
}

export interface InjectBullMQTraceparentInput {
    readonly data: unknown
    readonly traceparent: string
}

export interface CapturePostgresQueryInput {
    readonly error?: unknown
    readonly parentContext: TraceContext
    readonly preparedStatement: string
    readonly startedAt: number
}

export interface TracePostgresQueryInput {
    readonly query: unknown
    readonly statement: string
}

export interface PostgresQueryTraceState {
    captured: boolean
    startedAt: number | null
}

export type PgQueryKind = 'client' | 'pool'

export interface GetPgDatabaseNameInput {
    readonly options: DatabaseInstrumentationOptions
    readonly target: PgQueryTarget
}

export interface PgEventEmitterLike {
    once(event: string, listener: (...argumentsList: ReadonlyArray<unknown>) => void): unknown
}

export interface AttachPgCompletionInput {
    readonly capture: (error?: unknown) => void
    readonly result: unknown
}

export interface CreatePgQueryWrapperInput {
    readonly client: PgAutoInstrumentationClient
    readonly kind: PgQueryKind
    readonly options: DatabaseInstrumentationOptions
    readonly originalQuery: PgQueryMethod
}

export interface PgQueryCaptureState {
    captured: boolean
}

export interface InstrumentPgConstructorInput {
    readonly client: PgAutoInstrumentationClient
    readonly constructor: PgConstructor | undefined
    readonly kind: PgQueryKind
    readonly options: DatabaseInstrumentationOptions
}

export interface CaptureClientSpanInput {
    readonly context: TraceContext
    readonly durationMs: number
    readonly error?: unknown
    readonly method: string
    readonly peerService: string
    readonly statusCode: number
    readonly url: URL
}

// Node's overloaded request/get boundary cannot be represented as one precise tuple without losing supported overloads.
export type NodeHttpArguments = ReadonlyArray<unknown>
export type NodeHttpRequestMethod = typeof import('node:http').request
export type NodeHttpGetMethod = typeof import('node:http').get

export interface NodeHttpModuleLike {
    readonly get: NodeHttpGetMethod
    readonly request: NodeHttpRequestMethod
}

export interface StartNodeHttpAutoInstrumentationInput {
    readonly captureClientSpan: (input: CaptureClientSpanInput) => void
    readonly collectorUrl: string
    readonly options: NodeHttpInstrumentationOptions
}

export interface InstrumentNodeHttpModuleInput extends StartNodeHttpAutoInstrumentationInput {
    readonly defaultProtocol: 'http:' | 'https:'
    readonly module: NodeHttpModuleLike
}

export interface InstrumentNodeHttpRequestInput extends StartNodeHttpAutoInstrumentationInput {
    readonly request: ClientRequest
    readonly url: URL
}

export interface GetNodeHttpRequestUrlInput {
    readonly argumentsList: NodeHttpArguments
    readonly defaultProtocol: 'http:' | 'https:'
}

export interface NodeHttpCollectorRequestInput {
    readonly collectorUrl: string
    readonly url: URL
}

export interface DefineNodeHttpModuleMethodInput {
    readonly method: NodeHttpGetMethod | NodeHttpRequestMethod
    readonly module: NodeHttpModuleLike
    readonly property: 'get' | 'request'
}

export interface NodeHttpRequestCaptureState {
    captured: boolean
}

export interface NodeHttpModuleInstrumentation {
    readonly request: NodeHttpRequestMethod
    readonly restore: () => void
}

export interface CaptureFunctionSpanInput {
    readonly attributes?: Record<string, string>
    readonly category: string
    readonly context: TraceContext
    readonly durationMs: number
    readonly error?: unknown
    readonly kind: string
    readonly name: string
    readonly resourceAttributes?: Record<string, string>
}
