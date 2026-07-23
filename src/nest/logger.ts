/* eslint-disable functional/functional-parameters -- Nest LoggerService requires variadic method signatures. */
import { ConsoleLogger, type LoggerService, type LogLevel } from '@nestjs/common'
import type { LoggerRecord } from '../types'
import { safeJsonStringify } from '../utils'
import type { InkronikNestLoggerOptions } from './types'

const getContext = (optionalParams: ReadonlyArray<unknown>): string | undefined => {
    const lastParam = optionalParams.at(-1)

    return typeof lastParam === 'string' ? lastParam : undefined
}

const getMessageParams = (optionalParams: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
    getContext(optionalParams) === undefined ? optionalParams : optionalParams.slice(0, -1)

const formatValue = (value: unknown): string => (value instanceof Error ? value.message : safeJsonStringify(value))

const formatMessage = ({ message, optionalParams }: { readonly message: unknown; readonly optionalParams: ReadonlyArray<unknown> }): string => {
    const values = [message, ...getMessageParams(optionalParams)].map(formatValue).filter(value => value.length > 0)

    return values.join(' ')
}

const getError = ({ message, optionalParams }: { readonly message: unknown; readonly optionalParams: ReadonlyArray<unknown> }): Error | undefined => {
    if (message instanceof Error) {
        return message
    }

    return optionalParams.find(param => param instanceof Error)
}

export class InkronikNestLogger implements LoggerService {
    private readonly client: InkronikNestLoggerOptions['client']
    private readonly consoleLogger: LoggerService

    constructor(options: InkronikNestLoggerOptions) {
        this.client = options.client
        this.consoleLogger = options.consoleLogger ?? new ConsoleLogger()
    }

    log(message: unknown, ...optionalParams: ReadonlyArray<unknown>): void {
        this.consoleLogger.log(message, ...optionalParams)
        this.capture({ level: 'info', message, optionalParams })
    }

    error(message: unknown, ...optionalParams: ReadonlyArray<unknown>): void {
        this.consoleLogger.error(message, ...optionalParams)
        this.capture({ level: 'error', message, optionalParams, error: getError({ message, optionalParams }) })
    }

    warn(message: unknown, ...optionalParams: ReadonlyArray<unknown>): void {
        this.consoleLogger.warn(message, ...optionalParams)
        this.capture({ level: 'warn', message, optionalParams })
    }

    debug(message: unknown, ...optionalParams: ReadonlyArray<unknown>): void {
        this.consoleLogger.debug?.(message, ...optionalParams)
        this.capture({ level: 'debug', message, optionalParams })
    }

    verbose(message: unknown, ...optionalParams: ReadonlyArray<unknown>): void {
        this.consoleLogger.verbose?.(message, ...optionalParams)
        this.capture({ level: 'trace', message, optionalParams })
    }

    fatal(message: unknown, ...optionalParams: ReadonlyArray<unknown>): void {
        this.consoleLogger.fatal?.(message, ...optionalParams)
        this.capture({ level: 'fatal', message, optionalParams, error: getError({ message, optionalParams }) })
    }

    setLogLevels(levels: Array<LogLevel>): void {
        this.consoleLogger.setLogLevels?.(levels)
    }

    private capture({
        error,
        level,
        message,
        optionalParams,
    }: {
        readonly error?: Error
        readonly level: LoggerRecord['level']
        readonly message: unknown
        readonly optionalParams: ReadonlyArray<unknown>
    }): void {
        const context = getContext(optionalParams)
        const attributes = context === undefined ? undefined : { 'nest.context': context }

        this.client.captureLoggerRecord({
            level,
            message: formatMessage({ message, optionalParams }),
            attributes,
            error,
        })
    }
}
