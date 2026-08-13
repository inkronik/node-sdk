import { getDefaultInkronikClient } from '../env.js'
import type { CopyMethodMetadataInput, InkronikDecoratedMethod, InkronikSpanOptions, ReflectMetadataApi } from './types.js'

const copyMethodMetadata = ({ source, target }: CopyMethodMetadataInput): void => {
    const metadataApi = Reflect as ReflectMetadataApi
    const metadataKeys = metadataApi.getOwnMetadataKeys?.(source) ?? []

    metadataKeys.forEach(metadataKey => {
        const metadataValue = metadataApi.getOwnMetadata?.(metadataKey, source)
        metadataApi.defineMetadata?.(metadataKey, metadataValue, target)
    })
}

export const InkronikSpan =
    (options: InkronikSpanOptions): MethodDecorator =>
    <T>(_target: object, _propertyKey: string | symbol, descriptor: TypedPropertyDescriptor<T>): TypedPropertyDescriptor<T> => {
        const originalMethod = descriptor.value

        if (typeof originalMethod !== 'function') {
            throw new TypeError('@InkronikSpan can only decorate methods.')
        }

        const callableOriginal = originalMethod as InkronikDecoratedMethod

        // Method decorators must forward the target method's positional argument list unchanged.
        // eslint-disable-next-line functional/functional-parameters
        const tracedMethod: InkronikDecoratedMethod = function (this: unknown, ...argumentsList: ReadonlyArray<unknown>): unknown {
            return getDefaultInkronikClient().withSpan({
                ...options,
                callback: () => Reflect.apply(callableOriginal, this, argumentsList),
            })
        }

        copyMethodMetadata({ source: callableOriginal, target: tracedMethod })

        return { ...descriptor, value: tracedMethod as T }
    }
