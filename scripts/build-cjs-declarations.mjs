import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDirectory = fileURLToPath(new URL('..', import.meta.url))
const declarationsDirectory = join(projectDirectory, 'dist')
const cjsDeclarationsDirectory = join(declarationsDirectory, 'cjs')

const findDeclarationFiles = async directory => {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = await Promise.all(
        entries.map(entry => {
            const path = join(directory, entry.name)

            if (entry.isDirectory()) {
                return path === cjsDeclarationsDirectory ? [] : findDeclarationFiles(path)
            }

            return entry.name.endsWith('.d.ts') ? [path] : []
        }),
    )

    return files.flat()
}

const toCommonJsDeclaration = content =>
    content.replace(/(['"])(\.\.?\/[^'"]+)\.js\1/gu, (_match, quote, specifier) => `${quote}${specifier}.cjs${quote}`)

const declarationFiles = await findDeclarationFiles(declarationsDirectory)

await Promise.all(
    declarationFiles.map(async sourcePath => {
        const relativePath = relative(declarationsDirectory, sourcePath).replace(/\.d\.ts$/u, '.d.cts')
        const destinationPath = join(cjsDeclarationsDirectory, relativePath)
        const content = await readFile(sourcePath, 'utf8')

        await mkdir(dirname(destinationPath), { recursive: true })
        await writeFile(destinationPath, toCommonJsDeclaration(content))
    }),
)
