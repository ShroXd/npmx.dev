import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MIN_NODE_VERSION: [number, number, number] = [26, 4, 0]

function parseNodeVersion(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0)

  return [major, minor, patch]
}

function isAtLeastVersion(
  actual: [number, number, number],
  minimum: [number, number, number],
): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) {
      return true
    }

    if (actual[index] < minimum[index]) {
      return false
    }
  }

  return true
}

const nodeVersion = parseNodeVersion(process.version)

if (!isAtLeastVersion(nodeVersion, MIN_NODE_VERSION)) {
  console.error(`OpenTUI dev mode requires Node.js 26.4.0+ with experimental FFI.

Current Node.js: ${process.version}

Use a compatible runtime, then run:

  pnpm npmx-tui

For a single run without watch:

  pnpm --filter npmx-tui dev:ffi`)
  process.exit(1)
}

const child = spawn(process.execPath, ['--experimental-ffi', '--watch', 'src/cli.ts'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: 'inherit',
})

child.on('exit', code => {
  process.exit(code ?? 0)
})

child.on('error', error => {
  console.error(error.message)
  process.exit(1)
})
