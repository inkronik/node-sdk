import type { DocumentNode, ExecutionResult, OperationDefinitionNode } from 'graphql'

export type GraphqlCaptureDocumentMode = 'none' | 'sanitized'

export interface GraphqlCaptureOptions {
    readonly captureDocument?: GraphqlCaptureDocumentMode
    readonly enabled?: boolean
    readonly maxDocumentBytes?: number
    readonly maxOperationNameLength?: number
}

export interface ResolvedGraphqlCaptureOptions {
    readonly captureDocument: GraphqlCaptureDocumentMode
    readonly enabled: boolean
    readonly maxDocumentBytes: number
    readonly maxOperationNameLength: number
}

export type GraphqlOperationType = 'mutation' | 'query' | 'subscription' | 'unknown'

export interface CapturedGraphqlRequest {
    readonly batchCount?: number
    readonly document?: string
    readonly operationName?: string
    readonly operationType: GraphqlOperationType
    readonly persisted: boolean
}

export interface ExtractGraphqlRequestInput {
    readonly body: unknown
    readonly options: ResolvedGraphqlCaptureOptions
}

export interface GraphqlEnvelope {
    readonly extensions?: unknown
    readonly operationName?: unknown
    readonly query?: unknown
    readonly variables?: unknown
}

export interface ParsedGraphqlEnvelope {
    readonly document: DocumentNode
    readonly operation: OperationDefinitionNode
}

export interface GraphqlRuntime {
    readonly getOperationAST: (document: DocumentNode, operationName?: string) => OperationDefinitionNode | null
    readonly parse: (source: string) => DocumentNode
    readonly print: (document: DocumentNode) => string
    readonly visit: (document: DocumentNode, visitor: Readonly<Record<string, () => unknown>>) => DocumentNode
}

export type GraphqlExecutionResult = Pick<ExecutionResult, 'errors'>
