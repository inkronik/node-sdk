import { redactSerializedBody } from '../src/capture-redaction.js'
import {
    getCapturedRequestBody,
    getHttpBodySample,
    getResponseBodySizeBytes,
    resolveCaptureOptions,
    stringifyHttpBodySample,
} from '../src/http-utils.js'
import type { HttpLikeRequest } from '../src/types.js'
import { safeJsonStringify, utf8ByteLength } from '../src/utils.js'
import type { MeasureMemoryInput, MemoryBenchmarkResult } from './memory-benchmark.types.js'

const MEBIBYTE = 1024 * 1024
const MAX_BODY_BYTES = 16_384
const options = resolveCaptureOptions()
const scenarios = [
    'baseline-30mb',
    'request-5mb',
    'request-20mb',
    'request-30mb',
    'request-object-500k',
    'request-multibyte-20mb',
    'response-sample-100k',
    'response-raw-100k',
    'concurrent-10x5mb',
] as const

const createRequest = ({ multibyte, sizeMb }: { readonly multibyte: boolean; readonly sizeMb: number }): HttpLikeRequest => {
    const character = multibyte ? '😀' : 'x'
    const characterBytes = utf8ByteLength(character)

    return { body: { payload: character.repeat(Math.floor((sizeMb * MEBIBYTE) / characterBytes)) } }
}

const createResponseRows = ({ count }: { readonly count: number }): ReadonlyArray<Readonly<Record<string, boolean | number | string>>> =>
    Array.from({ length: count }, (_, index) => ({
        amount: index / 10,
        enabled: index % 2 === 0,
        id: index,
        name: `row-${index}`,
    }))

const measureMemory = <T>({ operation, scenario, setup }: MeasureMemoryInput<T>): MemoryBenchmarkResult => {
    globalThis.gc?.()
    const before = process.memoryUsage()
    const input = setup()
    const afterSetup = process.memoryUsage()
    const startedAt = performance.now()
    const details = operation(input)
    const afterOperation = process.memoryUsage()
    const elapsedMs = performance.now() - startedAt
    globalThis.gc?.()

    return {
        afterGc: process.memoryUsage(),
        afterOperation,
        afterSetup,
        before,
        details,
        elapsedMs,
        scenario,
    }
}

const measureRequest = ({ multibyte, sizeMb }: { readonly multibyte: boolean; readonly sizeMb: number }): MemoryBenchmarkResult =>
    measureMemory({
        scenario: `request-${multibyte ? 'multibyte-' : ''}${sizeMb}mb`,
        setup: () => createRequest({ multibyte, sizeMb }),
        operation: request => {
            const captured = getCapturedRequestBody({ maxBodyBytes: MAX_BODY_BYTES, redaction: options.redaction, request })

            return {
                capturedBytes: utf8ByteLength(captured.body),
                requestSizeBytes: captured.sizeBytes,
            }
        },
    })

const runScenario = (scenario: (typeof scenarios)[number]): MemoryBenchmarkResult => {
    if (scenario === 'baseline-30mb') {
        return measureMemory({
            scenario,
            setup: () => createRequest({ multibyte: false, sizeMb: 30 }),
            operation: () => ({ inputBytes: 30 * MEBIBYTE }),
        })
    }

    if (scenario === 'request-5mb') {
        return measureRequest({ multibyte: false, sizeMb: 5 })
    }

    if (scenario === 'request-20mb') {
        return measureRequest({ multibyte: false, sizeMb: 20 })
    }

    if (scenario === 'request-30mb') {
        return measureRequest({ multibyte: false, sizeMb: 30 })
    }

    if (scenario === 'request-multibyte-20mb') {
        return measureRequest({ multibyte: true, sizeMb: 20 })
    }

    if (scenario === 'request-object-500k') {
        return measureMemory({
            scenario,
            setup: () => ({ body: { rows: createResponseRows({ count: 500_000 }) } }),
            operation: request => {
                const captured = getCapturedRequestBody({ maxBodyBytes: MAX_BODY_BYTES, redaction: options.redaction, request })

                return { capturedBytes: utf8ByteLength(captured.body), requestSizeBytes: captured.sizeBytes }
            },
        })
    }

    if (scenario === 'response-sample-100k') {
        return measureMemory({
            scenario,
            setup: () => createResponseRows({ count: 100_000 }),
            operation: response => {
                const sample = stringifyHttpBodySample(getHttpBodySample({ redaction: options.redaction, value: response }))

                return { capturedBytes: utf8ByteLength(sample), responseSizeBytes: getResponseBodySizeBytes(response) }
            },
        })
    }

    if (scenario === 'response-raw-100k') {
        return measureMemory({
            scenario,
            setup: () => createResponseRows({ count: 100_000 }),
            operation: response => {
                const serialized = safeJsonStringify(response)
                const captured = redactSerializedBody({
                    maxBytes: MAX_BODY_BYTES,
                    preserveRawStringSemantics: false,
                    redaction: options.redaction,
                    value: serialized,
                })

                return { capturedBytes: utf8ByteLength(captured), responseSizeBytes: utf8ByteLength(serialized) }
            },
        })
    }

    return measureMemory({
        scenario,
        setup: () => Array.from({ length: 10 }, () => createRequest({ multibyte: false, sizeMb: 5 })),
        operation: requests => {
            const captures = requests.map(request => getCapturedRequestBody({ maxBodyBytes: MAX_BODY_BYTES, redaction: options.redaction, request }))

            return {
                capturedBytes: captures.reduce((bytes, capture) => bytes + utf8ByteLength(capture.body), 0),
                exchanges: requests.length,
            }
        },
    })
}

const runChild = (scenarioName: string): void => {
    const scenario = scenarios.find(value => value === scenarioName)

    if (scenario === undefined) {
        throw new Error(`Unknown memory benchmark scenario: ${scenarioName}`)
    }

    process.stdout.write(`${JSON.stringify(runScenario(scenario))}\n`)
}

const runParent = async (): Promise<void> => {
    const results = await scenarios.reduce<Promise<ReadonlyArray<string>>>(async (resultsPromise, scenario) => {
        const currentResults = await resultsPromise
        const childProcess = Bun.spawn([process.execPath, '--expose-gc', import.meta.path, '--child', scenario], {
            stderr: 'inherit',
            stdout: 'pipe',
        })
        const output = await new Response(childProcess.stdout).text()
        const exitCode = await childProcess.exited

        if (exitCode !== 0) {
            throw new Error(`Memory benchmark scenario ${scenario} exited with code ${exitCode}`)
        }

        return [...currentResults, output.trim()]
    }, Promise.resolve([]))

    results.forEach(result => process.stdout.write(`${result}\n`))
}

const childArgumentIndex = process.argv.indexOf('--child')

if (childArgumentIndex >= 0) {
    runChild(process.argv[childArgumentIndex + 1] ?? '')
} else {
    await runParent()
}
