import process from 'node:process'
import { spawn, type ChildProcess } from 'node:child_process'
import { Socket } from 'node:net'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const MIN_NODE_VERSION: [number, number, number] = [26, 4, 0]
const DEFAULT_PORT = 3000
const DEFAULT_READY_TIMEOUT_MS = 45_000
const READY_CHECK_INTERVAL_MS = 500
const READY_CHECK_TIMEOUT_MS = 1000

interface ManagedServer {
  process: ChildProcess | null
  started: boolean
  logs: string[]
}

interface TcpEndpoint {
  host: string
  port: number
}

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

function assertCompatibleNodeVersion(): void {
  const nodeVersion = parseNodeVersion(process.version)

  if (isAtLeastVersion(nodeVersion, MIN_NODE_VERSION)) {
    return
  }

  console.error(`OpenTUI local dev mode requires Node.js 26.4.0+ with experimental FFI.

Current Node.js: ${process.version}

Use a compatible runtime, then run:

  pnpm npmx-tui`)
  process.exit(1)
}

function getPnpmCommand(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function getApiBaseUrl(port: number, explicitBaseUrl?: string): string {
  return explicitBaseUrl ?? process.env.NPMX_API_BASE_URL ?? `http://127.0.0.1:${port}`
}

function getTcpEndpoint(apiBaseUrl: string): TcpEndpoint {
  const url = new URL(apiBaseUrl)
  const port = Number.parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10)

  return {
    host: url.hostname,
    port,
  }
}

function isLocalEndpoint(endpoint: TcpEndpoint): boolean {
  return endpoint.host === 'localhost' || endpoint.host === '127.0.0.1' || endpoint.host === '::1'
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function isServerReachable(apiBaseUrl: string): Promise<boolean> {
  const { host, port } = getTcpEndpoint(apiBaseUrl)

  return new Promise(resolve => {
    const socket = new Socket()
    const finish = (reachable: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(reachable)
    }

    socket.setTimeout(READY_CHECK_TIMEOUT_MS)
    socket.once('connect', () => {
      finish(true)
    })
    socket.once('timeout', () => {
      finish(false)
    })
    socket.once('error', () => {
      finish(false)
    })
    socket.connect(port, host)
  })
}

function captureLogs(child: ChildProcess, logs: string[]): void {
  const append = (chunk: Buffer): void => {
    const lines = chunk.toString('utf8').split(/\r?\n/).filter(Boolean)
    logs.push(...lines)

    if (logs.length > 80) {
      logs.splice(0, logs.length - 80)
    }
  }

  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
}

function formatServerLogs(logs: string[]): string {
  return logs.length > 0 ? `\n\nRecent server logs:\n${logs.join('\n')}` : ''
}

async function waitForReachableServer(
  apiBaseUrl: string,
  server: ManagedServer,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now()
  let serverExitCode: number | null = null

  server.process?.once('exit', code => {
    serverExitCode = code ?? 0
  })

  while (Date.now() - startedAt < timeoutMs) {
    if (await isServerReachable(apiBaseUrl)) {
      return
    }

    if (serverExitCode !== null) {
      throw new Error(
        `npmx dev server exited before opening ${apiBaseUrl} with code ${serverExitCode}.${formatServerLogs(server.logs)}`,
      )
    }

    await wait(READY_CHECK_INTERVAL_MS)
  }

  throw new Error(
    `Timed out waiting for npmx dev server at ${apiBaseUrl}.${formatServerLogs(server.logs)}`,
  )
}

async function ensureLocalServer(
  repoRoot: string,
  apiBaseUrl: string,
  endpoint: TcpEndpoint,
  timeoutMs: number,
): Promise<ManagedServer> {
  if (await isServerReachable(apiBaseUrl)) {
    return {
      process: null,
      started: false,
      logs: [],
    }
  }

  if (!isLocalEndpoint(endpoint)) {
    throw new Error(
      `API server at ${apiBaseUrl} is not reachable. Local dev mode only starts npmx automatically for localhost or 127.0.0.1 URLs.`,
    )
  }

  const child = spawn(getPnpmCommand(), ['dev', '--port', String(endpoint.port)], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const server: ManagedServer = {
    process: child,
    started: true,
    logs: [],
  }

  captureLogs(child, server.logs)
  await waitForReachableServer(apiBaseUrl, server, timeoutMs)

  return server
}

function killProcess(child: ChildProcess | null): void {
  if (!child?.pid || child.killed) {
    return
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGTERM')
      return
    }
  } catch {
    // Fall through to killing the direct child process.
  }

  child.kill('SIGTERM')
}

function runTui(tuiRoot: string, apiBaseUrl: string): Promise<number> {
  const child = spawn(process.execPath, ['--experimental-ffi', 'src/cli.ts'], {
    cwd: tuiRoot,
    env: {
      ...process.env,
      NPMX_API_BASE_URL: apiBaseUrl,
    },
    stdio: 'inherit',
  })

  return new Promise((resolve, reject) => {
    child.once('exit', code => {
      resolve(code ?? 0)
    })
    child.once('error', reject)
  })
}

async function main(): Promise<void> {
  assertCompatibleNodeVersion()

  const { values } = parseArgs({
    options: {
      'port': {
        type: 'string',
        short: 'p',
      },
      'api-base-url': {
        type: 'string',
      },
      'ready-timeout': {
        type: 'string',
      },
    },
  })

  const port = Number.parseInt(values.port ?? String(DEFAULT_PORT), 10) || DEFAULT_PORT
  const readyTimeoutMs =
    Number.parseInt(values['ready-timeout'] ?? String(DEFAULT_READY_TIMEOUT_MS), 10) ||
    DEFAULT_READY_TIMEOUT_MS
  const apiBaseUrl = getApiBaseUrl(port, values['api-base-url'])
  const endpoint = getTcpEndpoint(apiBaseUrl)
  const tuiRoot = fileURLToPath(new URL('..', import.meta.url))
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
  let server: ManagedServer | null = null

  const cleanup = (): void => {
    if (server?.started) {
      killProcess(server.process)
    }
  }

  process.once('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })

  try {
    server = await ensureLocalServer(repoRoot, apiBaseUrl, endpoint, readyTimeoutMs)
    const exitCode = await runTui(tuiRoot, apiBaseUrl)

    cleanup()
    process.exit(exitCode)
  } catch (error) {
    cleanup()
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

await main()
