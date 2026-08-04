import type { LoggerService } from '@nestjs/common'
import type { InkronikClient } from '../client.js'
import type { HttpLikeRequest, HttpLikeResponse, TelemetryContext, TraceContext } from '../types.js'

export interface InkronikNestLoggerOptions {
    readonly client: InkronikClient
    readonly consoleLogger?: LoggerService
}

export type NestHttpOutcome = { readonly kind: 'success'; readonly responseBody: unknown } | { readonly error: unknown; readonly kind: 'error' }

export interface CaptureNestHttpExchangeInput {
    readonly outcome: NestHttpOutcome
    readonly request: HttpLikeRequest
    readonly response: HttpLikeResponse
    readonly startedAt: number
    readonly telemetryContext: TelemetryContext
    readonly traceContext: TraceContext
}
