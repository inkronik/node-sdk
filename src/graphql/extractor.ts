import { createRequire } from 'node:module'
import type { DocumentNode, OperationDefinitionNode } from 'graphql'
import type {
    CapturedGraphqlRequest,
    ExtractGraphqlRequestInput,
    GraphqlCaptureOptions,
    GraphqlEnvelope,
    GraphqlExecutionResult,
    GraphqlOperationType,
    GraphqlRuntime,
    ParsedGraphqlEnvelope,
    ResolvedGraphqlCaptureOptions,
} from './types.js'
import { truncateUtf8 } from '../utils.js'

const require = createRequire(process.argv[1] ?? `${process.cwd()}/package.json`)
const GRAPHQL_NAME_PATTERN = /^[_A-Za-z][_0-9A-Za-z]*$/u

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

const getGraphqlRuntime = (): GraphqlRuntime | undefined => {
    const runtime = (() => {
        try {
            return require('graphql') as GraphqlRuntime
        } catch {
            return undefined
        }
    })()

    return runtime
}

const isPersistedQuery = (extensions: unknown): boolean => {
    if (!isRecord(extensions)) {
        return false
    }

    return isRecord(extensions.persistedQuery)
}

const isGraphqlEnvelope = (value: unknown): value is GraphqlEnvelope => {
    if (!isRecord(value)) {
        return false
    }

    const hasDocument = typeof value.query === 'string' && value.query.trim().length > 0
    const hasPersistedOperation = isPersistedQuery(value.extensions)

    return hasDocument || hasPersistedOperation
}

const getBoundedOperationName = ({ maxLength, value }: { readonly maxLength: number; readonly value: unknown }): string | undefined => {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        return undefined
    }

    return GRAPHQL_NAME_PATTERN.test(value) ? value : undefined
}

const parseGraphqlEnvelope = ({
    envelope,
    maxOperationNameLength,
    runtime,
}: {
    readonly envelope: GraphqlEnvelope
    readonly maxOperationNameLength: number
    readonly runtime: GraphqlRuntime
}): ParsedGraphqlEnvelope | undefined => {
    if (typeof envelope.query !== 'string') {
        return undefined
    }

    const document = runtime.parse(envelope.query)
    const requestedOperationName = getBoundedOperationName({ maxLength: maxOperationNameLength, value: envelope.operationName })
    const operation = runtime.getOperationAST(document, requestedOperationName)

    return operation === null ? undefined : { document, operation }
}

const sanitizeGraphqlDocument = ({
    document,
    maxBytes,
    runtime,
}: {
    readonly document: DocumentNode
    readonly maxBytes: number
    readonly runtime: GraphqlRuntime
}): string => {
    const sanitized = runtime.visit(document, {
        IntValue: () => ({ kind: 'IntValue', value: '0' }),
        FloatValue: () => ({ kind: 'FloatValue', value: '0' }),
        StringValue: () => ({ block: false, kind: 'StringValue', value: '[REDACTED]' }),
        BooleanValue: () => ({ kind: 'BooleanValue', value: false }),
        EnumValue: () => ({ kind: 'EnumValue', value: 'REDACTED' }),
    })

    return truncateUtf8({ maxBytes, value: runtime.print(sanitized) })
}

const toOperationType = (operation: OperationDefinitionNode): GraphqlOperationType => operation.operation

const extractSingleGraphqlRequest = ({
    envelope,
    options,
    runtime,
}: {
    readonly envelope: GraphqlEnvelope
    readonly options: ResolvedGraphqlCaptureOptions
    readonly runtime: GraphqlRuntime | undefined
}): CapturedGraphqlRequest | undefined => {
    const persisted = isPersistedQuery(envelope.extensions)
    const explicitName = getBoundedOperationName({ maxLength: options.maxOperationNameLength, value: envelope.operationName })

    if (typeof envelope.query !== 'string') {
        if (!persisted) {
            return undefined
        }

        return {
            ...(explicitName === undefined ? {} : { operationName: explicitName }),
            operationType: 'unknown',
            persisted: true,
        }
    }

    if (runtime === undefined) {
        return explicitName === undefined ? undefined : { operationName: explicitName, operationType: 'unknown', persisted }
    }

    const parsed = parseGraphqlEnvelope({ envelope, maxOperationNameLength: options.maxOperationNameLength, runtime })

    if (parsed === undefined) {
        return undefined
    }

    const parsedName = getBoundedOperationName({ maxLength: options.maxOperationNameLength, value: parsed.operation.name?.value })
    const document =
        options.captureDocument === 'sanitized'
            ? sanitizeGraphqlDocument({ document: parsed.document, maxBytes: options.maxDocumentBytes, runtime })
            : undefined

    return {
        ...(document === undefined ? {} : { document }),
        ...(parsedName === undefined ? {} : { operationName: parsedName }),
        operationType: toOperationType(parsed.operation),
        persisted,
    }
}

export const resolveGraphqlCaptureOptions = (options: GraphqlCaptureOptions = {}): ResolvedGraphqlCaptureOptions => ({
    captureDocument: options.captureDocument ?? 'none',
    enabled: options.enabled ?? true,
    maxDocumentBytes: options.maxDocumentBytes ?? 4_096,
    maxOperationNameLength: options.maxOperationNameLength ?? 128,
})

export const extractGraphqlRequest = ({ body, options }: ExtractGraphqlRequestInput): CapturedGraphqlRequest | undefined => {
    if (!options.enabled) {
        return undefined
    }

    if (Array.isArray(body)) {
        try {
            const envelopes = body.filter(isGraphqlEnvelope)

            if (envelopes.length !== body.length || envelopes.length === 0) {
                return undefined
            }

            const runtime = getGraphqlRuntime()
            const operations = envelopes.map(envelope => extractSingleGraphqlRequest({ envelope, options, runtime }))

            return operations.every(operation => operation !== undefined)
                ? { batchCount: envelopes.length, operationType: 'unknown', persisted: envelopes.every(item => isPersistedQuery(item.extensions)) }
                : undefined
        } catch {
            return undefined
        }
    }

    if (!isGraphqlEnvelope(body)) {
        return undefined
    }

    try {
        return extractSingleGraphqlRequest({ envelope: body, options, runtime: getGraphqlRuntime() })
    } catch {
        return undefined
    }
}

const countExecutionErrors = (value: unknown): number => {
    if (!isRecord(value)) {
        return 0
    }

    const result = value as GraphqlExecutionResult

    return Array.isArray(result.errors) ? result.errors.length : 0
}

export const getGraphqlErrorCount = (value: unknown): number => {
    if (typeof value === 'string') {
        const parsed = (() => {
            try {
                return JSON.parse(value) as unknown
            } catch {
                return undefined
            }
        })()

        return getGraphqlErrorCount(parsed)
    }

    return Array.isArray(value)
        ? (value as ReadonlyArray<unknown>).reduce<number>((total, result) => total + countExecutionErrors(result), 0)
        : countExecutionErrors(value)
}
