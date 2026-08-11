export type MemoryBenchmarkDetails = Readonly<Record<string, number | string>>

export interface MemoryBenchmarkResult {
    readonly afterGc: NodeJS.MemoryUsage
    readonly afterOperation: NodeJS.MemoryUsage
    readonly afterSetup: NodeJS.MemoryUsage
    readonly before: NodeJS.MemoryUsage
    readonly details: MemoryBenchmarkDetails
    readonly elapsedMs: number
    readonly scenario: string
}

export interface MeasureMemoryInput<T> {
    readonly operation: (input: T) => MemoryBenchmarkDetails
    readonly scenario: string
    readonly setup: () => T
}
