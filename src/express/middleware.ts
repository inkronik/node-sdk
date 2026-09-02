import { redactCapturedBody } from '../capture-redaction.js'
import { extractGraphqlRequest, getGraphqlErrorCount } from '../graphql/extractor.js'
import type { CreateInkronikExpressMiddlewareInput } from '../internal/types.js'
import type { HttpLikeNext, HttpLikeRequest, HttpLikeResponse } from '../types.js'
import {
    buildCaptureContext,
    buildRequestTelemetryContext,
    appendBodyChunk,
    getBodyChunkSizeBytes,
    getCapturedRequestBody,
    getHttpContentLength,
    getRequestBodySizeBytes,
    getRequestTraceContext,
    getSerializedHttpBodySample,
    getSerializedResponseBodyType,
    hasCapturedHttpExchange,
    isErrorStatusCode,
    markHttpExchangeCaptured,
    resolveAutoInstrumentFetchOptions,
    resolveAutoInstrumentHttpOptions,
    resolveCapturedResponseHeaders,
    resolveCaptureOptions,
    stringifyHttpBodySample,
} from '../http-utils.js'
import { runWithTraceContext, toTraceparent } from '../trace-context.js'

export const createInkronikExpressMiddleware = ({ client, options = {} }: CreateInkronikExpressMiddlewareInput) => {
    const fetchOptions = resolveAutoInstrumentFetchOptions(options.autoInstrumentFetch)
    const httpOptions = resolveAutoInstrumentHttpOptions(options.autoInstrumentHttp)

    if (options.enabled !== false && fetchOptions !== undefined) {
        client.instrumentGlobalFetch(fetchOptions)
    }

    if (options.enabled !== false && httpOptions !== undefined) {
        client.instrumentNodeHttp(httpOptions)
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
        const graphql = extractGraphqlRequest({ body: request.body, options: captureOptions.graphql })
        const shouldInspectResponseBody = captureOptions.captureRequestResponse || graphql !== undefined
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
                responseBody.value = shouldInspectResponseBody
                    ? appendBodyChunk({
                          chunk,
                          maxBytes: captureOptions.maxBodyBytes,
                          value: responseBody.value,
                      })
                    : responseBody.value

                return originalWrite.call(response, chunk, encoding, callback)
            }
        }

        if (originalEnd !== undefined) {
            // eslint-disable-next-line functional/immutable-data
            response.end = (chunk?: unknown, encoding?: unknown, callback?: unknown): unknown => {
                // Restore response methods before finalization so a server-retained response cannot retain the
                // request, client, and capture closures after the exchange completes.
                if (originalWrite !== undefined) {
                    // eslint-disable-next-line functional/immutable-data
                    response.write = originalWrite
                }
                // eslint-disable-next-line functional/immutable-data
                response.end = originalEnd

                // eslint-disable-next-line functional/immutable-data
                responseSizeBytes.value += getBodyChunkSizeBytes(chunk)

                // eslint-disable-next-line functional/immutable-data
                responseBody.value = shouldInspectResponseBody
                    ? appendBodyChunk({
                          chunk,
                          maxBytes: captureOptions.maxBodyBytes,
                          value: responseBody.value,
                      })
                    : responseBody.value

                const result = originalEnd.call(response, chunk, encoding, callback)
                const context = buildCaptureContext({ request, response })

                if (!hasCapturedHttpExchange(request) && captureOptions.shouldCapture(context)) {
                    const route = captureOptions.getRoute(context)
                    const responseBodyType = getSerializedResponseBodyType(responseBody.value)
                    const shouldCaptureRawResponse = captureOptions.captureResponseBody || isErrorStatusCode(context.statusCode)
                    const responseBodySample = getSerializedHttpBodySample({ redaction: captureOptions.redaction, value: responseBody.value })
                    const bodyMode = shouldCaptureRawResponse ? 'raw' : responseBodySample === undefined ? 'none' : 'sample'
                    const capturedRequestBody = captureOptions.captureRequestBody
                        ? getCapturedRequestBody({ maxBodyBytes: captureOptions.maxBodyBytes, redaction: captureOptions.redaction, request })
                        : undefined
                    client.captureHttpExchange({
                        ...context,
                        route,
                        responseHeaders: resolveCapturedResponseHeaders({
                            bodyMode,
                            headers: context.responseHeaders,
                            responseBodyType,
                            shouldCaptureRawResponse,
                        }),
                        requestBody: capturedRequestBody?.body ?? '',
                        requestSizeBytes:
                            getHttpContentLength(context.requestHeaders) ?? capturedRequestBody?.sizeBytes ?? getRequestBodySizeBytes(request),
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
                        ...(graphql === undefined ? {} : { graphql, graphqlErrorCount: getGraphqlErrorCount(responseBody.value) }),
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
