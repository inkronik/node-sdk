import { AsyncLocalStorage } from 'node:async_hooks'
import type { TelemetryContext, TraceContext } from './types.js'
import { createSpanId, createTraceId } from './utils.js'

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u
const traceStorage = new AsyncLocalStorage<TraceContext | TelemetryContext>()

export const getCurrentTraceContext = (): TraceContext | undefined => traceStorage.getStore()

export const getCurrentTelemetryContext = (): TelemetryContext | undefined => {
    const context = traceStorage.getStore()

    return context !== undefined && 'resolveUser' in context ? context : undefined
}

export const runWithTraceContext = <T>(context: TraceContext | TelemetryContext, callback: () => T): T => traceStorage.run(context, callback)

export const parseTraceparent = (value: string | undefined): TraceContext | undefined => {
    if (value === undefined) {
        return undefined
    }

    const match = TRACEPARENT_PATTERN.exec(value.trim().toLowerCase())

    if (match === null) {
        return undefined
    }

    const traceId = match[1] as string
    const parentSpanId = match[2] as string

    return {
        traceId,
        parentSpanId,
        spanId: createSpanId(),
    }
}

export const createRootTraceContext = (): TraceContext => ({
    traceId: createTraceId(),
    spanId: createSpanId(),
    parentSpanId: '',
})

export const createChildTraceContext = (parent?: TraceContext): TraceContext => ({
    traceId: parent?.traceId ?? createTraceId(),
    parentSpanId: parent?.spanId ?? '',
    spanId: createSpanId(),
})

export const toTraceparent = (context: TraceContext): string => `00-${context.traceId}-${context.spanId}-01`
