// Runs the manager page server as its own detached process. Orca stops plugin
// workers when idle (5 min) and whenever a developer plugin's files change —
// including the panel.html rewrite after each edit — so a server living inside
// the worker would drop the open page mid-use ("Failed to fetch").
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { metadataPath } from './store.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(ROOT, 'bin', 'manager-server.mjs')
export const serverStatePath = () => join(dirname(metadataPath()), 'server.json')
const serverLogPath = () => join(dirname(metadataPath()), 'server.log')
const START_TIMEOUT_MS = 8000

/** Changes whenever the server's code changes, so an older server is replaced. */
export async function codeFingerprint() {
  const files = [ENTRY, ...(await readdir(join(ROOT, 'lib'))).filter((f) => f.endsWith('.mjs')).map((f) => join(ROOT, 'lib', f))]
  const parts = await Promise.all(files.sort().map(async (file) => `${file}:${(await stat(file)).mtimeMs}`))
  return parts.join('|')
}

async function readState() {
  try {
    return JSON.parse(await readFile(serverStatePath(), 'utf8'))
  } catch {
    return null
  }
}

async function isAlive(state) {
  if (!state?.url || !state?.pid) return false
  try {
    process.kill(state.pid, 0)
  } catch {
    return false
  }
  try {
    const response = await fetch(`${state.url}api/state`, { signal: AbortSignal.timeout(2000) })
    return response.ok
  } catch {
    return false
  }
}

/** URL of a running manager server, starting one when needed. */
export async function ensureManagerServer(log = () => {}) {
  const current = await readState()
  const fingerprint = await codeFingerprint()
  if (await isAlive(current)) {
    if (current.code === fingerprint) return current.url
    // Running older code (the plugin was updated): replace it.
    try {
      process.kill(current.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }

  await mkdir(dirname(serverLogPath()), { recursive: true })
  const logFile = await open(serverLogPath(), 'a', 0o600)
  // process.execPath is Node for the CLI and Orca's Electron (with
  // ELECTRON_RUN_AS_NODE already set) for the worker; both run the entry as Node.
  const child = spawn(process.execPath, [ENTRY], {
    detached: true,
    stdio: ['ignore', logFile.fd, logFile.fd],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  child.unref()
  await logFile.close()

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const state = await readState()
    if (state?.pid === child.pid && (await isAlive(state))) return state.url
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  log(`manager server did not start; see ${serverLogPath()}`)
  throw new Error(`the account manager did not start (log: ${serverLogPath()})`)
}
