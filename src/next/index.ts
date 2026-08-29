import type { NextRequestErrorHandler, RegisterInkronikNextOptions } from './types.js'

const isNodeRuntime = (): boolean => process.env.NEXT_RUNTIME === 'nodejs'

export const registerInkronikNext = async (options: RegisterInkronikNextOptions = {}): Promise<void> => {
    if (!isNodeRuntime()) {
        return
    }

    const { registerInkronikNextNode } = await import('./node.js')
    await registerInkronikNextNode(options)
}

export const register = (): Promise<void> => registerInkronikNext()

export const onRequestError: NextRequestErrorHandler = async (error, request, context) => {
    if (!isNodeRuntime()) {
        return
    }

    const { captureNextRequestError } = await import('./node.js')
    await captureNextRequestError(error, request, context)
}

export const shutdownInkronikNext = async (): Promise<void> => {
    if (!isNodeRuntime()) {
        return
    }

    const { shutdownInkronikNextNode } = await import('./node.js')
    await shutdownInkronikNextNode()
}

export type * from './types.js'
