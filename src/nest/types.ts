import type { LoggerService } from '@nestjs/common'
import type { InkronikClient } from '../client.js'

export interface InkronikNestLoggerOptions {
    readonly client: InkronikClient
    readonly consoleLogger?: LoggerService
}
