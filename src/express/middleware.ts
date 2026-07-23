import type { InkronikClient } from '../client'
import type { CaptureRequestResponseOptions, HttpLikeNext, HttpLikeRequest, HttpLikeResponse } from '../types'
import {
    buildCaptureContext,
    getBodyChunkSizeBytes,
    getHttpContentLength,
    getRequestBody,
    getRequestBodySizeBytes,
    getRequestTraceContext,
    getSerializedHttpBodySample,
    getSerializedResponseBodyType,
    isErrorStatusCode,
    resolveAutoInstrumentFetchOptions,
    resolveCapturedResponseHeaders,
    resolveCaptureOptions,
    stringifyHttpBodySample,
    toBodyChunk,
} from '../http-utils'
import { runWithTraceContext, toTraceparent } from '../trace-context'
import { truncateUtf8 } from '../utils'

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

                if (captureOptions.shouldCapture(context)) {
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
                        requestBody: captureOptions.captureRequestBody ? getRequestBody({ maxBodyBytes: captureOptions.maxBodyBytes, request }) : '',
                        requestSizeBytes: getHttpContentLength(context.requestHeaders) ?? getRequestBodySizeBytes(request),
                        responseBody: shouldCaptureRawResponse ? responseBody.value : stringifyHttpBodySample(responseBodySample),
                        responseSizeBytes: getHttpContentLength(context.responseHeaders) ?? responseSizeBytes.value,
                        durationMs: performance.now() - startedAt,
                        requestKind: captureOptions.getRequestKind(context),
                        captureRequestResponse: captureOptions.captureRequestResponse,
                        metrics: captureOptions.metrics,
                        traceId: traceContext.traceId,
                        parentSpanId: traceContext.parentSpanId,
                        userId: captureOptions.getUserId(context),
                        sessionId: captureOptions.getSessionId(context),
                        attributes: captureOptions.getAttributes(context),
                    })
                }

                return result
            }
        }

        const setHeader = (response as { setHeader?: (name: string, value: string) => void }).setHeader
        setHeader?.call(response, 'traceparent', toTraceparent(traceContext))
        runWithTraceContext(traceContext, next)
    }
}
