import type { LoggerService } from '@nestjs/common'
import type { InkronikClient } from '../client'

export interface InkronikNestLoggerOptions {
    readonly client: InkronikClient
    readonly consoleLogger?: LoggerService
}
