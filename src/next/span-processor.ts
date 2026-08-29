import type { Context, Span } from '@opentelemetry/api'
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { DEFAULT_HTTP_DURATION_BUCKETS_MS } from './constants.js'
import { mapReadableSpan } from './span-mapping.js'
import type { InkronikNextSpanProcessorContract, InkronikNextSpanProcessorOptions, MappedNextSpan } from './types.js'

const emitHttpMetrics = ({
    client,
    input,
}: {
    readonly client: InkronikNextSpanProcessorOptions['client']
    readonly input: MappedNextSpan['input']
}): void => {
    const attributes = {
        method: input.httpMethod ?? '',
        route: input.httpRoute ?? '',
        status_code: String(input.httpStatusCode ?? 0),
    }

    client.sum({ attributes, name: 'http.server.requests', unit: 'requests', value: 1 })
    client.histogram({
        attributes,
        buckets: DEFAULT_HTTP_DURATION_BUCKETS_MS,
        name: 'http.server.duration',
        unit: 'ms',
        value: input.durationUs / 1_000,
    })

    if ((input.httpStatusCode ?? 0) < 500) {
        return
    }

    client.sum({ attributes, name: 'http.server.errors', unit: 'errors', value: 1 })
}

export class InkronikNextSpanProcessor implements InkronikNextSpanProcessorContract {
    readonly #captureNextFetchSpans: boolean
    readonly #client: InkronikNextSpanProcessorOptions['client']
    readonly #collectorUrl: string

    constructor({ captureNextFetchSpans = false, client, collectorUrl }: InkronikNextSpanProcessorOptions) {
        this.#captureNextFetchSpans = captureNextFetchSpans
        this.#client = client
        this.#collectorUrl = collectorUrl
    }

    onStart(span: Span, parentContext: Context): void {
        void span
        void parentContext
    }

    onEnd(span: ReadableSpan): void {
        const mapped = mapReadableSpan({
            captureNextFetchSpans: this.#captureNextFetchSpans,
            collectorUrl: this.#collectorUrl,
            span,
        })

        if (mapped === null) {
            return
        }

        this.#client.captureSpan(mapped.input)

        if (!mapped.isRootServerSpan) {
            return
        }

        emitHttpMetrics({ client: this.#client, input: mapped.input })
        void this.#client.flush().catch(() => undefined)
    }

    forceFlush(): Promise<void> {
        return this.#client.flush().then(() => undefined)
    }

    shutdown(): Promise<void> {
        return this.forceFlush()
    }
}
