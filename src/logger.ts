import type { InkronikClient } from './client.js'
import type { LoggerRecord } from './types.js'

export interface InkronikLogger {
    readonly trace: (message: string, attributes?: Record<string, string>) => void
    readonly debug: (message: string, attributes?: Record<string, string>) => void
    readonly info: (message: string, attributes?: Record<string, string>) => void
    readonly warn: (message: string, attributes?: Record<string, string>) => void
    readonly error: (message: string, attributes?: Record<string, string>, error?: unknown) => void
    readonly fatal: (message: string, attributes?: Record<string, string>, error?: unknown) => void
}

export const createInkronikLogger = (client: InkronikClient): InkronikLogger => {
    const log = (record: LoggerRecord): void => client.captureLoggerRecord(record)

    return {
        trace: (message, attributes) => log({ level: 'trace', message, attributes }),
        debug: (message, attributes) => log({ level: 'debug', message, attributes }),
        info: (message, attributes) => log({ level: 'info', message, attributes }),
        warn: (message, attributes) => log({ level: 'warn', message, attributes }),
        error: (message, attributes, error) => log({ level: 'error', message, attributes, error }),
        fatal: (message, attributes, error) => log({ level: 'fatal', message, attributes, error }),
    }
}
