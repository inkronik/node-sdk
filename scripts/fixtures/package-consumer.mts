import { getDefaultInkronikClient, type InkronikClient } from '@inkronik/node-sdk'
import { initInkronik } from '@inkronik/node-sdk/auto'
import { createInkronikExpressMiddleware } from '@inkronik/node-sdk/express'
import { createInkronikNestMiddleware, InkronikNestInterceptor } from '@inkronik/node-sdk/nest'

const client: InkronikClient = getDefaultInkronikClient()

void client
void createInkronikExpressMiddleware
void initInkronik
void createInkronikNestMiddleware
void InkronikNestInterceptor
