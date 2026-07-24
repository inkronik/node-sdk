export {}

const version = Bun.argv.at(2)

if (!version) {
    throw new Error('Release version is required.')
}

const tag = version.includes('-rc.') ? 'rc' : 'latest'
const publishProcess = Bun.spawn(['npm', 'publish', '--access', 'public', '--tag', tag], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
})
const exitCode = await publishProcess.exited

if (exitCode !== 0) {
    process.exit(exitCode)
}
