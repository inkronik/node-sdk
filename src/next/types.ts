import type { Attributes, Context, HrTime, Span } from '@opentelemetry/api'
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { InkronikClient } from '../client.js'
import type { CaptureSpanInput, InitInkronikOptions } from '../types.js'

export interface RegisterInkronikNextOptions extends InitInkronikOptions {
    readonly captureNextFetchSpans?: boolean
}

export interface NextRequestErrorRequest {
    readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>
    readonly method: string
    readonly path: string
}

export type NextRouterKind = 'App Router' | 'Pages Router'
export type NextRouteKind = 'action' | 'middleware' | 'proxy' | 'render' | 'route'

export interface NextRequestErrorContext {
    readonly renderSource?: 'react-server-components' | 'react-server-components-payload' | 'server-rendering'
    readonly renderType?: 'dynamic' | 'dynamic-resume'
    readonly revalidateReason?: 'on-demand' | 'stale'
    readonly routePath: string
    readonly routeType: NextRouteKind
    readonly routerKind: NextRouterKind
}

export type NextRequestErrorHandler = (error: unknown, request: NextRequestErrorRequest, context: NextRequestErrorContext) => void | Promise<void>

export interface InkronikNextSpanProcessorOptions {
    readonly captureNextFetchSpans?: boolean
    readonly client: InkronikClient
    readonly collectorUrl: string
}

export interface MappedNextSpan {
    readonly input: CaptureSpanInput
    readonly isRootServerSpan: boolean
}

export interface NextRegistration {
    readonly client: InkronikClient
    readonly provider: NodeTracerProvider
    readonly restoreTraceContextResolver: () => void
}

export interface NextRuntimeState {
    registration: NextRegistration | null
    registrationPromise: Promise<NextRegistration> | null
}

export interface MapReadableSpanInput {
    readonly captureNextFetchSpans: boolean
    readonly collectorUrl: string
    readonly span: ReadableSpan
}

export interface SerializeAttributesInput {
    readonly attributes: Attributes
}

export interface ResolveSpanStatusInput {
    readonly httpStatusCode: number
    readonly span: ReadableSpan
}

export interface ResolveSpanCategoryInput {
    readonly attributes: Record<string, string>
    readonly spanType: string
}

export interface HrTimeRangeInput {
    readonly duration: HrTime
    readonly startTime: HrTime
}

export interface InkronikNextSpanProcessorContract extends SpanProcessor {
    onStart(span: Span, parentContext: Context): void
}
