import { AsyncLocalStorage } from 'node:async_hooks'
import type { InkronikRuntimeState } from './runtime-state.types.js'

const INKRONIK_RUNTIME_STATE = Symbol.for('@inkronik/node-sdk.runtime.v1')

const createRuntimeState = (): InkronikRuntimeState => ({
    autoInstrumentation: {
        client: null,
        restoreBullMQ: null,
        restoreFetch: null,
        restorePg: null,
        restorePostgres: null,
    },
    defaultClient: null,
    traceStorage: new AsyncLocalStorage(),
})

export const getInkronikRuntimeState = (): InkronikRuntimeState => {
    const existingState = Reflect.get(globalThis, INKRONIK_RUNTIME_STATE) as InkronikRuntimeState | undefined

    if (existingState !== undefined) {
        return existingState
    }

    const runtimeState = createRuntimeState()

    // The SDK intentionally owns one process-wide runtime, shared by separately bundled package entrypoints.
    // eslint-disable-next-line functional/immutable-data
    Object.defineProperty(globalThis, INKRONIK_RUNTIME_STATE, {
        configurable: false,
        enumerable: false,
        value: runtimeState,
        writable: false,
    })

    return runtimeState
}
