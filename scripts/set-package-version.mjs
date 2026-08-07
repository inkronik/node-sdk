import { readFile, writeFile } from 'node:fs/promises'

const version = process.argv.at(2)
const stableVersionPattern = /^\d+\.\d+\.\d+$/u
const prereleaseVersionPattern = /^\d+\.\d+\.\d+-rc\.\d+$/u

if (!version || (!stableVersionPattern.test(version) && !prereleaseVersionPattern.test(version))) {
    throw new Error('A stable or rc SemVer release version is required.')
}

const packageJsonPath = new URL('../package.json', import.meta.url)
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
const versionedPackageJson = {
    ...packageJson,
    version,
}

await writeFile(packageJsonPath, `${JSON.stringify(versionedPackageJson, null, 2)}\n`)
