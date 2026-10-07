// Shared account store used by both the Orca worker (main.mjs) and the CLI
// (bin/claude-accounts.mjs). Tokens live in the macOS Keychain keyed by a
// stable account id; labels and dates live on disk. Switching writes the active
// token into the `env` block of ~/.claude/settings.json, which Claude Code
// applies to every new session.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { knownIdentities } from './identity.mjs'
import { fetchUsage } from './usage.mjs'
import { checkToken } from './validate.mjs'

const execFileAsync = promisify(execFile)

export const KEYCHAIN_SERVICE = 'orca-claude-accounts'
export const TOKEN_ENV_KEY = 'CLAUDE_CODE_OAUTH_TOKEN'
// `claude setup-token` issues tokens valid for one year.
export const TOKEN_LIFETIME_DAYS = 365
export const EXPIRY_WARNING_DAYS = 14
export const LABEL_MAX_LENGTH = 80

const DAY_MS = 24 * 60 * 60 * 1000

// CLAUDE_ACCOUNTS_ROOT exists for tests only: overriding HOME instead would
// also hide the login Keychain from `security`.
const home = () => process.env.CLAUDE_ACCOUNTS_ROOT || process.env.HOME || homedir()
export const metadataPath = () => join(home(), '.config', 'orca-claude-accounts', 'accounts.json')
export const claudeSettingsPath = () => join(home(), '.claude', 'settings.json')

export function normalizeLabel(label) {
  const clean = String(label ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
  if (!clean) throw new Error('label cannot be empty')
  if (clean.length > LABEL_MAX_LENGTH) throw new Error(`label is longer than ${LABEL_MAX_LENGTH} characters`)
  return clean
}

export function normalizeToken(token) {
  // Pasted tokens often carry stray whitespace or line breaks from the terminal.
  const clean = String(token ?? '').replace(/\s+/g, '')
  if (!/^sk-ant-oat\d+-[A-Za-z0-9_-]+$/.test(clean)) {
    throw new Error('that does not look like a `claude setup-token` token (expected sk-ant-oat01-…)')
  }
  return clean
}

// ---------- metadata ----------

export async function loadMetadata() {
  let parsed
  try {
    parsed = JSON.parse(await readFile(metadataPath(), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { active: null, accounts: [] }
    throw error
  }
  const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : []).map((account) => ({
    // v0.1 entries had only `name`; it doubled as the Keychain key.
    id: account.id ?? account.name,
    label: account.label ?? account.name,
    addedAt: account.addedAt,
    tokenUpdatedAt: account.tokenUpdatedAt ?? account.addedAt,
    // { state: 'valid' | 'invalid' | 'unknown', message, at } from the last check.
    lastCheck: account.lastCheck ?? null,
    // From the last successful check: which Claude account the token belongs to.
    orgId: account.orgId ?? null,
    email: account.email ?? null,
    // Last usage reading (see lib/usage.mjs); percentages and reset times only.
    usage: account.usage ?? null
  }))
  return { active: typeof parsed.active === 'string' ? parsed.active : null, accounts }
}

async function saveMetadata(meta) {
  await atomicWriteJson(metadataPath(), meta, 0o600)
}

export function daysLeft(account, now = Date.now()) {
  const expiresAt = Date.parse(account.tokenUpdatedAt) + TOKEN_LIFETIME_DAYS * DAY_MS
  return Math.floor((expiresAt - now) / DAY_MS)
}

/** Resolve an account by id, slot number ("2") or label (case-insensitive). */
export function findAccount(meta, ref) {
  const text = String(ref ?? '').trim()
  if (/^\d+$/.test(text)) {
    const account = meta.accounts[Number(text) - 1]
    if (!account) throw new Error(`no account in slot ${text} (${meta.accounts.length} configured)`)
    return account
  }
  const byId = meta.accounts.find((account) => account.id === text)
  if (byId) return byId
  const matches = meta.accounts.filter((account) => account.label.toLowerCase() === text.toLowerCase())
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`several accounts are labeled "${text}"; use the slot number`)
  throw new Error(`unknown account "${text}"`)
}

// ---------- keychain ----------

// Why `security -i`: the command is read from stdin, so the token never shows
// up in another process's argv (ps) the way `-w <token>` would.
function securityInteractive(command) {
  return new Promise((resolve, reject) => {
    const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 && !stderr.trim() ? resolve() : reject(new Error(stderr.trim() || `security exited ${code}`))
    )
    child.stdin.end(`${command}\n`)
  })
}

const quote = (value) => `"${value.replace(/(["\\])/g, '\\$1')}"`

async function keychainSet(id, label, token) {
  await securityInteractive(
    `add-generic-password -U -s ${quote(KEYCHAIN_SERVICE)} -a ${quote(id)} -l ${quote(`Claude Code (${label})`)} -w ${quote(token)}`
  )
}

async function keychainGet(account) {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      account.id,
      '-w'
    ])
    return stdout.trim()
  } catch {
    throw new Error(`no token in Keychain for "${account.label}"; update its token`)
  }
}

async function keychainDelete(id) {
  await execFileAsync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id]).catch(
    () => {}
  )
}

// ---------- claude settings.json ----------

async function readClaudeSettings() {
  let text
  try {
    text = await readFile(claudeSettingsPath(), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    // Never rewrite a file we could not parse: that would drop the user's settings.
    throw new Error(`${claudeSettingsPath()} is not valid JSON; fix it before switching accounts`)
  }
}

async function writeClaudeToken(token) {
  const settings = await readClaudeSettings()
  const env = { ...(settings.env ?? {}) }
  if (token) env[TOKEN_ENV_KEY] = token
  else delete env[TOKEN_ENV_KEY]
  if (Object.keys(env).length) settings.env = env
  else delete settings.env
  await atomicWriteJson(claudeSettingsPath(), settings, 0o600)
}

/** Token currently written into settings.json, or null. */
export async function readActiveToken() {
  const settings = await readClaudeSettings()
  return settings.env?.[TOKEN_ENV_KEY] ?? null
}

// ---------- operations ----------

// Tests run with fake tokens; they set this to skip the network check.
const skipCheck = () => process.env.CLAUDE_ACCOUNTS_SKIP_CHECK === '1'

/**
 * Checks a token before it is stored: a rejected token is never saved. When the
 * check can't run (offline) the token is saved and the result says 'unknown'.
 */
async function vetToken(token, meta, exceptId = null) {
  for (const other of meta.accounts) {
    if (other.id === exceptId) continue
    if ((await keychainGet(other).catch(() => null)) === token) {
      throw new Error(`this token is already saved as "${other.label}"`)
    }
  }
  if (skipCheck()) return { state: 'unknown', message: 'check skipped', at: new Date().toISOString() }
  const result = await checkToken(token)
  if (result.state === 'invalid') throw new Error(`token rejected by Anthropic: ${result.message}`)
  const sameAccount = result.orgId && meta.accounts.find((other) => other.id !== exceptId && other.orgId === result.orgId)
  if (sameAccount) {
    throw new Error(`this token belongs to the same Claude account as "${sameAccount.label}"; use Update token on it instead`)
  }
  return result
}

/** Records who the token belongs to, from a check result. */
async function applyIdentity(account, check, identities) {
  if (!check?.orgId) return
  account.orgId = check.orgId
  account.email = (identities ?? (await knownIdentities())).get(check.orgId) ?? account.email ?? null
}

export async function addAccount(label, token) {
  label = normalizeLabel(label)
  token = normalizeToken(token)
  const meta = await loadMetadata()
  const lastCheck = await vetToken(token, meta)
  const id = `acct-${randomBytes(4).toString('hex')}`
  await keychainSet(id, label, token)
  const now = new Date().toISOString()
  const account = { id, label, addedAt: now, tokenUpdatedAt: now, lastCheck }
  await applyIdentity(account, lastCheck)
  meta.accounts.push(account)
  await saveMetadata(meta)
  return account
}

export async function updateToken(ref, token) {
  token = normalizeToken(token)
  const meta = await loadMetadata()
  const account = findAccount(meta, ref)
  account.lastCheck = await vetToken(token, meta, account.id)
  await applyIdentity(account, account.lastCheck)
  await keychainSet(account.id, account.label, token)
  account.tokenUpdatedAt = new Date().toISOString()
  await saveMetadata(meta)
  // The active account's token must also reach the file Claude Code reads.
  if (meta.active === account.id) await writeClaudeToken(token)
  return account
}

export async function renameAccount(ref, label) {
  label = normalizeLabel(label)
  const meta = await loadMetadata()
  const account = findAccount(meta, ref)
  account.label = label
  await saveMetadata(meta)
  return account
}

export async function useAccount(ref) {
  const meta = await loadMetadata()
  const account = findAccount(meta, ref)
  await writeClaudeToken(await keychainGet(account))
  meta.active = account.id
  await saveMetadata(meta)
  return account
}

/** Re-checks stored tokens (one account, or all when `ref` is omitted). */
export async function checkAccounts(ref) {
  const meta = await loadMetadata()
  const targets = ref === undefined ? meta.accounts : [findAccount(meta, ref)]
  const identities = await knownIdentities()
  for (const account of targets) {
    const token = await keychainGet(account).catch(() => null)
    account.lastCheck = token
      ? await checkToken(token)
      : { state: 'invalid', message: 'no token in Keychain', at: new Date().toISOString() }
    await applyIdentity(account, account.lastCheck, identities)
  }
  await saveMetadata(meta)
  return targets
}

/** Reads usage for one account, or all when `ref` is omitted (one tiny request each). */
export async function refreshUsage(ref) {
  const meta = await loadMetadata()
  const targets = ref === undefined ? meta.accounts : [findAccount(meta, ref)]
  await Promise.all(
    targets.map(async (account) => {
      const token = await keychainGet(account).catch(() => null)
      account.usage = token
        ? await fetchUsage(token)
        : { at: new Date().toISOString(), ok: false, error: 'no token in Keychain' }
    })
  )
  await saveMetadata(meta)
  return targets
}

export async function useNext() {
  const meta = await loadMetadata()
  if (!meta.accounts.length) throw new Error('no accounts yet; add one first')
  const index = meta.accounts.findIndex((account) => account.id === meta.active)
  return useAccount(meta.accounts[(index + 1) % meta.accounts.length].id)
}

/** Remove the token from settings.json so Claude Code falls back to /login. */
export async function useNone() {
  await writeClaudeToken(null)
  const meta = await loadMetadata()
  meta.active = null
  await saveMetadata(meta)
}

export async function removeAccount(ref) {
  const account = findAccount(await loadMetadata(), ref)
  if ((await loadMetadata()).active === account.id) await useNone()
  await keychainDelete(account.id)
  const meta = await loadMetadata()
  meta.accounts = meta.accounts.filter((entry) => entry.id !== account.id)
  await saveMetadata(meta)
  return account
}

/**
 * Snapshot for display. `drift` is true when settings.json holds a token that
 * is not the active account's (edited by hand, or another tool changed it).
 */
export async function status() {
  const meta = await loadMetadata()
  const settingsToken = await readActiveToken()
  const activeAccount = meta.accounts.find((account) => account.id === meta.active) ?? null
  const expected = activeAccount ? await keychainGet(activeAccount).catch(() => null) : null
  return {
    active: activeAccount,
    drift: expected !== settingsToken,
    accounts: meta.accounts.map((account, index) => ({
      ...account,
      slot: index + 1,
      daysLeft: daysLeft(account),
      active: account.id === meta.active
    }))
  }
}

export function expiryNote(account) {
  const left = daysLeft(account)
  if (left < 0) return `token EXPIRED ${-left}d ago`
  if (left <= EXPIRY_WARNING_DAYS) return `token expires in ${left}d`
  return `${left}d left`
}

/** One-line text row for the CLI and notifications; ● marks the account in use. */
export function accountRow(account) {
  const marker = account.active ? '●' : '○'
  const usage = account.usage?.ok
    ? `   5h ${account.usage.fiveHour?.percent ?? '?'}% · 7d ${account.usage.sevenDay?.percent ?? '?'}%`
    : ''
  return `${marker}  ${account.slot}. ${account.label}   (${expiryNote(account)})${usage}${account.active ? '   ← in use' : ''}`
}

export function describeAccount(account) {
  const left = daysLeft(account)
  return left <= EXPIRY_WARNING_DAYS ? `${account.label} (${expiryNote(account)})` : account.label
}

// ---------- fs helpers ----------

async function atomicWriteJson(path, value, mode) {
  // Follow symlinks (dotfile managers) so the rename replaces the real file,
  // not the link.
  path = await realpath(path).catch(() => path)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  await rename(temp, path)
}
