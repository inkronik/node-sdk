import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectDirectory = fileURLToPath(new URL('..', import.meta.url))
const consumerDirectory = await mkdtemp(join(tmpdir(), 'inkronik-node-sdk-legacy-consumer-'))
const packagePath = join(consumerDirectory, 'node_modules', '@inkronik', 'node-sdk')
const typescriptPath = join(projectDirectory, 'node_modules', 'typescript', 'bin', 'tsc')
const consumerSource = `
import { getDefaultInkronikClient, type InkronikClient } from '@inkronik/node-sdk'
import { initInkronik } from '@inkronik/node-sdk/auto'
import { createInkronikExpressMiddleware } from '@inkronik/node-sdk/express'
import { InkronikNestInterceptor } from '@inkronik/node-sdk/nest'

const client: InkronikClient = getDefaultInkronikClient()

void client
void createInkronikExpressMiddleware
void initInkronik
void InkronikNestInterceptor
`
const tsconfig = {
    compilerOptions: {
        esModuleInterop: true,
        module: 'CommonJS',
        moduleResolution: 'Node',
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: 'ES2022',
    },
    include: ['consumer.ts'],
}

try {
    await mkdir(dirname(packagePath), { recursive: true })
    await symlink(projectDirectory, packagePath, 'dir')
    await writeFile(join(consumerDirectory, 'consumer.ts'), consumerSource)
    await writeFile(join(consumerDirectory, 'tsconfig.json'), JSON.stringify(tsconfig))

    const result = spawnSync(process.execPath, [typescriptPath, '--project', join(consumerDirectory, 'tsconfig.json')], {
        cwd: consumerDirectory,
        encoding: 'utf8',
    })

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
} finally {
    await rm(consumerDirectory, { force: true, recursive: true })
}
