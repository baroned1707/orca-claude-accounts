// Local web UI for the account manager, opened as a tab in Orca's built-in
// browser. Orca plugin panels cannot exchange data with the worker (panel CSP
// is connect-src 'none'), so the worker serves the page itself.
//
// Exposure is kept minimal: bound to 127.0.0.1 only, every route lives under a
// random 256-bit path secret, the Host header must match (DNS rebinding),
// writes need a custom header + JSON body (no cross-site form posts), and the
// API never returns a token — it only accepts them.
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKEND_LABELS } from './secrets.mjs'
import { appFontFamilyValue, pageThemeCss, readOrcaAppearance } from './orca-theme.mjs'
import {
  addAccount,
  sameOrgNote,
  checkAccounts,
  refreshUsage,
  expiryNote,
  removeAccount,
  renameAccount,
  status,
  updateToken,
  useAccount,
  useNone
} from './store.mjs'

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'manager.html')
const BODY_MAX_BYTES = 16 * 1024
// An open page pings every minute (even in a background tab), so this only
// ends a server nobody is looking at. Long enough that the address still works
// when you pick up your phone later.
const IDLE_SHUTDOWN_MS = 12 * 60 * 60 * 1000
const WRITE_HEADER = 'x-claude-accounts'

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function snapshot() {
  const [state, appearance] = await Promise.all([status(), readOrcaAppearance()])
  return {
    appearance: { theme: appearance.theme, appFontFamily: await appFontFamilyValue(appearance) },
    drift: state.drift,
    activeId: state.active?.id ?? null,
    accounts: state.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      slot: account.slot,
      active: account.active,
      daysLeft: account.daysLeft,
      expiry: expiryNote(account),
      addedAt: account.addedAt,
      tokenUpdatedAt: account.tokenUpdatedAt,
      lastCheck: account.lastCheck,
      email: account.email,
      orgId: account.orgId,
      usage: account.usage,
      storage: account.secretBackend ?? null,
      storageLabel: BACKEND_LABELS[account.secretBackend] ?? null
    }))
  }
}

/** Write routes. Each returns a short message; the page re-reads state after. */
function writeRoutes(onSwitch) {
  const str = (value, name) => {
    if (typeof value !== 'string') throw new HttpError(400, `${name} is required`)
    return value
  }
  return {
    add: async ({ label, token, activate }) => {
      const account = await addAccount(str(label, 'label'), str(token, 'token'))
      const note = sameOrgNote(account)
      if (activate) {
        await useAccount(account.id)
        await onSwitch(account)
        return `Added and switched to "${account.label}".${note ? ` Note: ${note}.` : ''}`
      }
      return `Added "${account.label}".${note ? ` Note: ${note}.` : ''}`
    },
    switch: async ({ id }) => {
      const account = await useAccount(str(id, 'id'))
      await onSwitch(account)
      return `Switched to "${account.label}". Running and new Claude Code sessions use it.`
    },
    off: async () => {
      await useNone()
      await onSwitch(null)
      return 'Token removed. Claude Code falls back to its /login session.'
    },
    rename: async ({ id, label }) => {
      const account = await renameAccount(str(id, 'id'), str(label, 'label'))
      return `Renamed to "${account.label}".`
    },
    token: async ({ id, token }) => {
      const account = await updateToken(str(id, 'id'), str(token, 'token'))
      return `Updated the token of "${account.label}".`
    },
    check: async ({ id }) => {
      const checked = await checkAccounts(id === undefined ? undefined : str(id, 'id'))
      const bad = checked.filter((account) => account.lastCheck.state !== 'valid')
      if (!bad.length) return checked.length === 1 ? `"${checked[0].label}" is valid.` : `All ${checked.length} tokens are valid.`
      return bad.map((account) => `"${account.label}": ${account.lastCheck.state} (${account.lastCheck.message})`).join(' · ')
    },
    usage: async ({ id }) => {
      const read = await refreshUsage(id === undefined ? undefined : str(id, 'id'))
      const failed = read.filter((account) => !account.usage.ok)
      if (!failed.length) return read.length === 1 ? `Usage of "${read[0].label}" updated.` : `Usage of ${read.length} accounts updated.`
      return failed.map((account) => `"${account.label}": ${account.usage.error}`).join(' · ')
    },
    remove: async ({ id }) => {
      const account = await removeAccount(str(id, 'id'))
      return `Removed "${account.label}".`
    }
  }
}

async function readJsonBody(request) {
  if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'expected application/json')
  }
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_MAX_BYTES) throw new HttpError(413, 'request too large')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error()
    return body
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
}

/**
 * Starts the server (once) and returns its URL. `onSwitch(account|null)` lets
 * the worker announce switches with an Orca notification; `onChange()` runs
 * after every successful write.
 */
export function createManagerServer({
  onSwitch = async () => {},
  onChange = async () => {},
  onStop = () => {},
  log = () => {},
  keepAlive = false,
  // Reused across restarts so an open tab or a typed address keeps working.
  port: preferredPort = 0,
  secret: preferredSecret = null
} = {}) {
  // 96 bits: plenty behind the Host check and custom-header rule, and short
  // enough to type into a phone's address bar.
  const secret = preferredSecret && /^[A-Za-z0-9_-]{16,64}$/.test(preferredSecret) ? preferredSecret : randomBytes(12).toString('base64url')
  const routes = writeRoutes(onSwitch)
  let server = null
  let url = null
  let idleTimer = null

  const touch = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => stop(), IDLE_SHUTDOWN_MS)
    if (!keepAlive) idleTimer.unref?.()
  }

  const send = (response, statusCode, type, body) => {
    response.writeHead(statusCode, { ...SECURITY_HEADERS, 'Content-Type': type })
    response.end(body)
  }
  const sendJson = (response, statusCode, value) =>
    send(response, statusCode, 'application/json; charset=utf-8', JSON.stringify(value))

  async function handle(request, response) {
    const { port } = server.address()
    if (request.headers.host !== `127.0.0.1:${port}`) throw new HttpError(421, 'wrong host')
    const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname
    const prefix = `/${secret}/`
    if (!path.startsWith(prefix) && path !== `/${secret}`) throw new HttpError(404, 'not found')
    touch()
    const route = path === `/${secret}` ? '' : path.slice(prefix.length)

    if (request.method === 'GET' && route === '') {
      const [appearance, theme] = await Promise.all([readOrcaAppearance(), pageThemeCss(log)])
      // Function replacers: the CSS contains `$` sequences String.replace would expand.
      const html = (await readFile(UI_PATH, 'utf8'))
        .replace('/*__ORCA_TOKENS__*/', () => theme.css.replace(/<\/style/gi, '<\\/style'))
        .replace('__ORCA_THEME_SOURCE__', () => theme.source.replace(/[<>&"]/g, ''))
        .replace('__ORCA_THEME__', () => appearance.theme)
      return send(response, 200, 'text/html; charset=utf-8', html)
    }
    if (request.method === 'GET' && route === 'api/ping') {
      return sendJson(response, 200, { ok: true })
    }
    if (request.method === 'GET' && route === 'api/state') {
      return sendJson(response, 200, await snapshot())
    }
    if (request.method === 'POST' && route.startsWith('api/')) {
      if (request.headers[WRITE_HEADER] !== '1') throw new HttpError(403, 'missing request header')
      const action = routes[route.slice('api/'.length)]
      if (!action) throw new HttpError(404, 'unknown action')
      const message = await action(await readJsonBody(request))
      await onChange()
      return sendJson(response, 200, { ok: true, message, state: await snapshot() })
    }
    throw new HttpError(404, 'not found')
  }

  async function start() {
    if (url) return url
    server = createServer((request, response) => {
      handle(request, response).catch((error) => {
        const statusCode = error instanceof HttpError ? error.status : 400
        if (!(error instanceof HttpError)) log(`request failed: ${error?.message ?? error}`)
        sendJson(response, statusCode, { ok: false, error: error?.message ?? String(error) })
      })
    })
    const listen = (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
    try {
      await listen(preferredPort)
    } catch (error) {
      // The remembered port is taken: take any free one (the address changes).
      if (!preferredPort || error.code !== 'EADDRINUSE') throw error
      await listen(0)
    }
    // The worker stays alive through its IPC channel; only the CLI needs the
    // server itself to hold the process open.
    if (!keepAlive) server.unref()
    url = `http://127.0.0.1:${server.address().port}/${secret}/`
    touch()
    return url
  }

  function stop() {
    clearTimeout(idleTimer)
    server?.close()
    server = null
    url = null
    onStop()
  }

  return { start, stop }
}
