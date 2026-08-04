import type { AsyncLocalStorage } from 'node:async_hooks'
import type { InkronikClient } from './client.js'
import type { TelemetryContext, TraceContext } from './types.js'

export interface AutoInstrumentationRuntimeState {
    client: InkronikClient | null
    restoreBullMQ: (() => void) | null
    restoreFetch: (() => void) | null
    restorePg: (() => void) | null
    restorePostgres: (() => void) | null
}

export interface InkronikRuntimeState {
    readonly autoInstrumentation: AutoInstrumentationRuntimeState
    defaultClient: InkronikClient | null
    readonly traceStorage: AsyncLocalStorage<TraceContext | TelemetryContext>
}
