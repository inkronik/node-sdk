import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const runtimeExports = [
    { name: '.', expectedExport: 'InkronikClient' },
    { name: './auto', expectedExport: 'initInkronik' },
    { name: './express', expectedExport: 'createInkronikExpressMiddleware' },
    { name: './nest', expectedExport: 'InkronikNestInterceptor' },
]
const toSpecifier = name => (name === '.' ? '@inkronik/node-sdk' : `@inkronik/node-sdk${name.slice(1)}`)

runtimeExports.forEach(({ expectedExport, name }) => {
    const specifier = toSpecifier(name)
    const resolvedPath = require.resolve(specifier)
    const loadedModule = require(specifier)

    assert.match(resolvedPath, /\.cjs$/u, `${specifier} did not resolve to CommonJS`)
    assert.equal(typeof loadedModule[expectedExport], 'function', `${specifier} did not expose ${expectedExport} through require()`)
})

assert.match(require.resolve('@inkronik/node-sdk/register'), /\.cjs$/u, 'register did not resolve to CommonJS')

await Promise.all(
    runtimeExports.map(async ({ expectedExport, name }) => {
        const specifier = toSpecifier(name)
        const loadedModule = await import(specifier)

        assert.equal(typeof loadedModule[expectedExport], 'function', `${specifier} did not expose ${expectedExport} through import`)
    }),
)
