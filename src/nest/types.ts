import type { LoggerService } from '@nestjs/common'
import type { InkronikClient } from '../client.js'
import type { HttpLikeRequest, HttpLikeResponse, TelemetryContext, TraceContext } from '../types.js'

export interface InkronikNestLoggerOptions {
    readonly client: InkronikClient
    readonly consoleLogger?: LoggerService
}

export interface NestLoggerMessageInput {
    readonly message: unknown
    readonly optionalParams: ReadonlyArray<unknown>
}

export interface CaptureNestLoggerRecordInput extends NestLoggerMessageInput {
    readonly error?: Error
    readonly level: string
}

export interface ReadExceptionMemberInput {
    readonly error: unknown
    readonly name: string
}

export interface ResolveExceptionStatusCodeInput {
    readonly error: unknown
    readonly response: HttpLikeResponse
}

export interface ResolveExceptionResponseInput {
    readonly error: unknown
    readonly statusCode: number
}

export interface NestHttpSuccessOutcome {
    readonly kind: 'success'
    readonly responseBody: unknown
}

export interface NestHttpErrorOutcome {
    readonly error: unknown
    readonly kind: 'error'
}

export type NestHttpOutcome = NestHttpSuccessOutcome | NestHttpErrorOutcome

export interface CaptureNestHttpExchangeInput {
    readonly outcome: NestHttpOutcome
    readonly request: HttpLikeRequest
    readonly response: HttpLikeResponse
    readonly startedAt: number
    readonly telemetryContext: TelemetryContext
    readonly traceContext: TraceContext
}
