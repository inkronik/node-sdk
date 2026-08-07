import type { InkronikClient } from '../client.js'
import { redactCapturedBody } from '../capture-redaction.js'
import type { CaptureRequestResponseOptions, HttpLikeNext, HttpLikeRequest, HttpLikeResponse } from '../types.js'
import {
    buildCaptureContext,
    buildRequestTelemetryContext,
    getBodyChunkSizeBytes,
    getHttpContentLength,
    getRequestBody,
    getRequestBodySizeBytes,
    getRequestTraceContext,
    getSerializedHttpBodySample,
    getSerializedResponseBodyType,
    hasCapturedHttpExchange,
    isErrorStatusCode,
    markHttpExchangeCaptured,
    resolveAutoInstrumentFetchOptions,
    resolveCapturedResponseHeaders,
    resolveCaptureOptions,
    stringifyHttpBodySample,
    toBodyChunk,
} from '../http-utils.js'
import { runWithTraceContext, toTraceparent } from '../trace-context.js'
import { truncateUtf8 } from '../utils.js'

export const createInkronikExpressMiddleware = ({
    client,
    options = {},
}: {
    readonly client: InkronikClient
    readonly options?: CaptureRequestResponseOptions
}) => {
    const fetchOptions = resolveAutoInstrumentFetchOptions(options.autoInstrumentFetch)

    if (options.enabled !== false && fetchOptions !== undefined) {
        client.instrumentGlobalFetch(fetchOptions)
    }

    return (request: HttpLikeRequest, response: HttpLikeResponse, next: HttpLikeNext): void => {
        const captureOptions = resolveCaptureOptions(options)

        if (!captureOptions.enabled) {
            next()
            return
        }

        if (captureOptions.exclude(request)) {
            next()
            return
        }

        const startedAt = performance.now()
        const traceContext = getRequestTraceContext(request)
        const telemetryContext = buildRequestTelemetryContext({ options: captureOptions, request, response, traceContext })
        const responseBody = { value: '' }
        const responseSizeBytes = { value: 0 }
        const originalWrite = response.write
        const originalEnd = response.end

        if (originalWrite !== undefined) {
            // eslint-disable-next-line functional/immutable-data
            response.write = (chunk?: unknown, encoding?: unknown, callback?: unknown): boolean => {
                // eslint-disable-next-line functional/immutable-data
                responseSizeBytes.value += getBodyChunkSizeBytes(chunk)

                // eslint-disable-next-line functional/immutable-data
                responseBody.value = truncateUtf8({
                    maxBytes: captureOptions.maxBodyBytes,
                    value: `${responseBody.value}${toBodyChunk(chunk)}`,
                })

                return originalWrite.call(response, chunk, encoding, callback)
            }
        }

        if (originalEnd !== undefined) {
            // eslint-disable-next-line functional/immutable-data
            response.end = (chunk?: unknown, encoding?: unknown, callback?: unknown): unknown => {
                // eslint-disable-next-line functional/immutable-data
                responseSizeBytes.value += getBodyChunkSizeBytes(chunk)

                // eslint-disable-next-line functional/immutable-data
                responseBody.value = truncateUtf8({
                    maxBytes: captureOptions.maxBodyBytes,
                    value: `${responseBody.value}${toBodyChunk(chunk)}`,
                })

                const result = originalEnd.call(response, chunk, encoding, callback)
                const context = buildCaptureContext({ request, response })

                if (!hasCapturedHttpExchange(request) && captureOptions.shouldCapture(context)) {
                    const route = captureOptions.getRoute(context)
                    const responseBodyType = getSerializedResponseBodyType(responseBody.value)
                    const shouldCaptureRawResponse = captureOptions.captureResponseBody || isErrorStatusCode(context.statusCode)
                    const responseBodySample = getSerializedHttpBodySample({ redaction: captureOptions.redaction, value: responseBody.value })
                    const bodyMode = shouldCaptureRawResponse ? 'raw' : responseBodySample === undefined ? 'none' : 'sample'

                    client.captureHttpExchange({
                        ...context,
                        route,
                        responseHeaders: resolveCapturedResponseHeaders({
                            bodyMode,
                            headers: context.responseHeaders,
                            responseBodyType,
                            shouldCaptureRawResponse,
                        }),
                        requestBody: captureOptions.captureRequestBody
                            ? getRequestBody({ maxBodyBytes: captureOptions.maxBodyBytes, redaction: captureOptions.redaction, request })
                            : '',
                        requestSizeBytes: getHttpContentLength(context.requestHeaders) ?? getRequestBodySizeBytes(request),
                        responseBody: shouldCaptureRawResponse
                            ? redactCapturedBody({
                                  maxBytes: captureOptions.maxBodyBytes,
                                  redaction: captureOptions.redaction,
                                  value: responseBody.value,
                              })
                            : stringifyHttpBodySample(responseBodySample),
                        responseSizeBytes: getHttpContentLength(context.responseHeaders) ?? responseSizeBytes.value,
                        durationMs: performance.now() - startedAt,
                        requestKind: captureOptions.getRequestKind(context),
                        captureRequestResponse: captureOptions.captureRequestResponse,
                        metrics: captureOptions.metrics,
                        traceId: traceContext.traceId,
                        parentSpanId: traceContext.parentSpanId,
                        userId: telemetryContext.resolveUser()?.id,
                        sessionId: telemetryContext.resolveSessionId(),
                        attributes: captureOptions.getAttributes(context),
                    })
                    markHttpExchangeCaptured(request)
                }

                return result
            }
        }

        const setHeader = (response as { setHeader?: (name: string, value: string) => void }).setHeader
        setHeader?.call(response, 'traceparent', toTraceparent(traceContext))
        runWithTraceContext(telemetryContext, next)
    }
}
