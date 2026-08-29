export const NEXT_RUNTIME_NODE = 'nodejs'
export const NEXT_ROOT_SERVER_SPAN_TYPE = 'BaseServer.handleRequest'
export const NEXT_FETCH_SPAN_TYPE = 'AppRender.fetch'

export const DEFAULT_HTTP_DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000] as const

export const MAX_ATTRIBUTE_COUNT = 128
export const MAX_ATTRIBUTE_VALUE_LENGTH = 2_048
