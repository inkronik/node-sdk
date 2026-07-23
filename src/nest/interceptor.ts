import { Observable, tap } from 'rxjs'
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common'
import type { InkronikClient } from '../client.js'
import type { CaptureRequestResponseOptions, HttpLikeRequest, HttpLikeResponse, ResolvedCaptureRequestResponseOptions } from '../types.js'
import {
    buildCaptureContext,
    getHttpContentLength,
    getHttpBodySample,
    getRequestBody,
    getRequestBodySizeBytes,
    getRequestTraceContext,
    getResponseBodyType,
    isErrorStatusCode,
    resolveCapturedResponseHeaders,
    resolveAutoInstrumentFetchOptions,
    resolveCaptureOptions,
    stringifyHttpBodySample,
} from '../http-utils.js'
import { runWithTraceContext, toTraceparent } from '../trace-context.js'
import { safeJsonStringify, truncateUtf8, utf8ByteLength } from '../utils.js'

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

        if (this.captureOptions.exclude(request)) {
            return next.handle()
        }

        const response = http.getResponse<HttpLikeResponse>()
        const startedAt = performance.now()
        const traceContext = getRequestTraceContext(request)
        const setHeader = (response as { setHeader?: (name: string, value: string) => void }).setHeader
        setHeader?.call(response, 'traceparent', toTraceparent(traceContext))

        return new Observable(subscriber =>
            runWithTraceContext(traceContext, () =>
                next
                    .handle()
                    .pipe(
                        tap(data => {
                            const captureContext = buildCaptureContext({ request, response })

                            if (!this.captureOptions.shouldCapture(captureContext)) {
                                return
                            }

                            const route = this.captureOptions.getRoute(captureContext)
                            const serializedResponseBody = safeJsonStringify(data)
                            const responseBodyType = getResponseBodyType(data)
                            const shouldCaptureRawResponse = this.captureOptions.captureResponseBody || isErrorStatusCode(captureContext.statusCode)
                            const responseBodySample = getHttpBodySample({ redaction: this.captureOptions.redaction, value: data })
                            const bodyMode = shouldCaptureRawResponse ? 'raw' : 'sample'
                            const responseBody = truncateUtf8({
                                maxBytes: this.captureOptions.maxBodyBytes,
                                value: shouldCaptureRawResponse ? serializedResponseBody : stringifyHttpBodySample(responseBodySample),
                            })

                            this.client.captureHttpExchange({
                                ...captureContext,
                                route,
                                responseHeaders: resolveCapturedResponseHeaders({
                                    bodyMode,
                                    headers: captureContext.responseHeaders,
                                    responseBodyType,
                                    shouldCaptureRawResponse,
                                }),
                                requestBody: this.captureOptions.captureRequestBody
                                    ? getRequestBody({ maxBodyBytes: this.captureOptions.maxBodyBytes, request })
                                    : '',
                                requestSizeBytes: getHttpContentLength(captureContext.requestHeaders) ?? getRequestBodySizeBytes(request),
                                responseBody,
                                responseSizeBytes: getHttpContentLength(captureContext.responseHeaders) ?? utf8ByteLength(serializedResponseBody),
                                durationMs: performance.now() - startedAt,
                                requestKind: this.captureOptions.getRequestKind(captureContext),
                                captureRequestResponse: this.captureOptions.captureRequestResponse,
                                metrics: this.captureOptions.metrics,
                                traceId: traceContext.traceId,
                                parentSpanId: traceContext.parentSpanId,
                                userId: this.captureOptions.getUserId(captureContext),
                                sessionId: this.captureOptions.getSessionId(captureContext),
                                attributes: this.captureOptions.getAttributes(captureContext),
                            })
                        }),
                    )
                    .subscribe(subscriber),
            ),
        )
    }
}
