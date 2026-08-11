import { Observable, tap } from 'rxjs'
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common'
import { redactSerializedBody } from '../capture-redaction.js'
import type { InkronikClient } from '../client.js'
import type { CaptureRequestResponseOptions, HttpLikeRequest, HttpLikeResponse, ResolvedCaptureRequestResponseOptions } from '../types.js'
import {
    acceptsEventStream,
    buildCaptureContext,
    buildRequestTelemetryContext,
    getHttpContentLength,
    getHttpBodySample,
    getCapturedRequestBody,
    getRequestBodySizeBytes,
    getRequestTraceContext,
    getResponseBodyType,
    getResponseBodySizeBytes,
    isErrorStatusCode,
    markHttpExchangeCaptured,
    resolveCapturedResponseHeaders,
    resolveAutoInstrumentFetchOptions,
    resolveCaptureOptions,
    stringifyHttpBodySample,
} from '../http-utils.js'
import { runWithTraceContext, toTraceparent } from '../trace-context.js'
import { normalizeCapturedError, safeJsonStringify, truncateUtf8, utf8ByteLength } from '../utils.js'
import type {
    CaptureNestHttpExchangeInput,
    ReadExceptionMemberInput,
    ResolveExceptionResponseInput,
    ResolveExceptionStatusCodeInput,
} from './types.js'

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null

const readExceptionMember = ({ error, name }: ReadExceptionMemberInput): unknown => {
    if (!isRecord(error)) {
        return undefined
    }

    try {
        const member = Reflect.get(error, name) as unknown

        return typeof member === 'function' ? Reflect.apply(member, error, []) : member
    } catch {
        return undefined
    }
}

const toErrorStatusCode = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined

const resolveExceptionStatusCode = ({ error, response }: ResolveExceptionStatusCodeInput): number => {
    const exceptionResponse = readExceptionMember({ error, name: 'response' })
    const responseStatusCode = isRecord(exceptionResponse) ? exceptionResponse.statusCode : undefined
    const responseStatus = isRecord(exceptionResponse) ? exceptionResponse.status : undefined
    const candidates = [
        readExceptionMember({ error, name: 'getStatus' }),
        readExceptionMember({ error, name: 'statusCode' }),
        readExceptionMember({ error, name: 'status' }),
        responseStatusCode,
        responseStatus,
        response.statusCode,
    ]

    return candidates.map(toErrorStatusCode).find(statusCode => statusCode !== undefined) ?? 500
}

const resolveExceptionResponse = ({ error, statusCode }: ResolveExceptionResponseInput): unknown => {
    const publicResponse = readExceptionMember({ error, name: 'getResponse' }) ?? readExceptionMember({ error, name: 'response' })

    if (publicResponse !== undefined) {
        return publicResponse
    }

    const capturedError = normalizeCapturedError(error)

    return {
        statusCode,
        message: capturedError.message,
        error: capturedError.type,
    }
}

@Injectable()
export class InkronikNestInterceptor implements NestInterceptor {
    private readonly captureOptions: ResolvedCaptureRequestResponseOptions

    constructor(
        private readonly client: InkronikClient,
        options: CaptureRequestResponseOptions = {},
    ) {
        this.captureOptions = resolveCaptureOptions(options)
        const fetchOptions = resolveAutoInstrumentFetchOptions(options.autoInstrumentFetch)

        if (options.enabled !== false && fetchOptions !== undefined) {
            this.client.instrumentGlobalFetch(fetchOptions)
        }
    }

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (!this.captureOptions.enabled) {
            return next.handle()
        }

        const http = context.switchToHttp()
        const request = http.getRequest<HttpLikeRequest>()

        if (acceptsEventStream(request) || this.captureOptions.exclude(request)) {
            return next.handle()
        }

        const response = http.getResponse<HttpLikeResponse>()
        const startedAt = performance.now()
        const traceContext = getRequestTraceContext(request)
        const telemetryContext = buildRequestTelemetryContext({ options: this.captureOptions, request, response, traceContext })
        const setHeader = (response as { setHeader?: (name: string, value: string) => void }).setHeader
        setHeader?.call(response, 'traceparent', toTraceparent(traceContext))

        return new Observable(subscriber =>
            runWithTraceContext(telemetryContext, () =>
                next
                    .handle()
                    .pipe(
                        tap({
                            next: responseBody =>
                                this.captureHttpExchange({
                                    outcome: { kind: 'success', responseBody },
                                    request,
                                    response,
                                    startedAt,
                                    telemetryContext,
                                    traceContext,
                                }),
                            error: error =>
                                this.captureHttpExchange({
                                    outcome: { error, kind: 'error' },
                                    request,
                                    response,
                                    startedAt,
                                    telemetryContext,
                                    traceContext,
                                }),
                        }),
                    )
                    .subscribe(subscriber),
            ),
        )
    }

    private captureHttpExchange({ outcome, request, response, startedAt, telemetryContext, traceContext }: CaptureNestHttpExchangeInput): void {
        const isException = outcome.kind === 'error'
        const statusCode = isException ? resolveExceptionStatusCode({ error: outcome.error, response }) : (response.statusCode ?? 0)
        const responseValue = isException ? resolveExceptionResponse({ error: outcome.error, statusCode }) : outcome.responseBody
        const captureContext = { ...buildCaptureContext({ request, response }), statusCode }

        if (!this.captureOptions.shouldCapture(captureContext)) {
            return
        }

        const route = this.captureOptions.getRoute(captureContext)
        const responseBodyType = getResponseBodyType(responseValue)
        const shouldCaptureRawResponse = this.captureOptions.captureResponseBody || isErrorStatusCode(captureContext.statusCode)
        const serializedResponseBody = shouldCaptureRawResponse ? safeJsonStringify(responseValue) : ''
        const responseBodySample = getHttpBodySample({ redaction: this.captureOptions.redaction, value: responseValue })
        const bodyMode = shouldCaptureRawResponse ? 'raw' : 'sample'
        const responseBody = shouldCaptureRawResponse
            ? redactSerializedBody({
                  maxBytes: this.captureOptions.maxBodyBytes,
                  preserveRawStringSemantics: typeof responseValue === 'string',
                  redaction: this.captureOptions.redaction,
                  value: serializedResponseBody,
              })
            : truncateUtf8({ maxBytes: this.captureOptions.maxBodyBytes, value: stringifyHttpBodySample(responseBodySample) })
        const capturedRequestBody = this.captureOptions.captureRequestBody
            ? getCapturedRequestBody({ maxBodyBytes: this.captureOptions.maxBodyBytes, redaction: this.captureOptions.redaction, request })
            : undefined

        this.client.captureHttpExchange({
            ...captureContext,
            route,
            responseHeaders: resolveCapturedResponseHeaders({
                bodyMode,
                headers: captureContext.responseHeaders,
                responseBodyType,
                shouldCaptureRawResponse,
            }),
            requestBody: capturedRequestBody?.body ?? '',
            requestSizeBytes:
                getHttpContentLength(captureContext.requestHeaders) ?? capturedRequestBody?.sizeBytes ?? getRequestBodySizeBytes(request),
            responseBody,
            responseSizeBytes:
                getHttpContentLength(captureContext.responseHeaders) ??
                (shouldCaptureRawResponse ? utf8ByteLength(serializedResponseBody) : getResponseBodySizeBytes(responseValue)),
            durationMs: performance.now() - startedAt,
            requestKind: this.captureOptions.getRequestKind(captureContext),
            captureRequestResponse: this.captureOptions.captureRequestResponse,
            metrics: this.captureOptions.metrics,
            traceId: traceContext.traceId,
            parentSpanId: traceContext.parentSpanId,
            userId: telemetryContext.resolveUser()?.id,
            sessionId: telemetryContext.resolveSessionId(),
            attributes: this.captureOptions.getAttributes(captureContext),
            ...(isException ? { error: outcome.error } : {}),
        })
        markHttpExchangeCaptured(request)
    }
}
