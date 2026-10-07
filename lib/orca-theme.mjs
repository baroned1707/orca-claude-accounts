// Mirrors the installed Orca's look in the account manager page. Nothing about
// the design system is copied into this plugin: the theme tokens are read from
// the CSS bundle inside the running Orca's app.asar (the same stylesheet Orca's
// renderer uses to compute the tokens it injects into plugin panels), and the
// theme/font choice comes from the user's Orca settings.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { orcaDataDir, orcaResourceDirs } from './platform.mjs'

const execFileAsync = promisify(execFile)

// Inside Orca the worker runs on Electron (ELECTRON_RUN_AS_NODE), whose `fs`
// presents app.asar as a virtual directory. `original-fs` is Electron's
// unpatched fs, so the archive reads as the plain file the reader below expects.
const rawFs = process.versions.electron
  ? createRequire(import.meta.url)('original-fs').promises
  : await import('node:fs/promises')
const ORCA_DATA_DIR = orcaDataDir()

// ---------- locating the installed Orca ----------

export function findOrcaResources() {
  return orcaResourceDirs().find((dir) => existsSync(join(dir, 'app.asar'))) ?? null
}

// ---------- minimal asar reader (read-only) ----------
// Layout: [pickle: u32 4][u32 headerSize][pickle: u32][u32 jsonSize][json…] then file data.

async function openAsar(path_) {
  const handle = await rawFs.open(path_, 'r')
  const prefix = Buffer.alloc(16)
  await handle.read(prefix, 0, 16, 0)
  const headerSize = prefix.readUInt32LE(4)
  const jsonSize = prefix.readUInt32LE(12)
  const json = Buffer.alloc(jsonSize)
  await handle.read(json, 0, jsonSize, 16)
  const header = JSON.parse(json.toString('utf8'))
  const dataOffset = 8 + headerSize

  const entry = (path) =>
    path
      .split('/')
      .filter(Boolean)
      .reduce((node, part) => node?.files?.[part], header)

  return {
    list(dir) {
      return Object.entries(entry(dir)?.files ?? {})
        .filter(([, node]) => !node.files)
        .map(([name]) => `${dir}/${name}`)
    },
    async read(path) {
      const node = entry(path)
      if (!node || node.files) throw new Error(`${path} not found in asar`)
      if (node.unpacked) return readFile(`${path_}.unpacked/${path}`, 'utf8')
      const buffer = Buffer.alloc(node.size)
      await handle.read(buffer, 0, node.size, dataOffset + Number(node.offset))
      return buffer.toString('utf8')
    },
    close: () => handle.close()
  }
}

// ---------- extracting the theme tokens ----------

const THEME_SELECTORS = new Set([':root', '.dark'])
const KEPT_AT_RULES = /^@(layer|supports|media)\b/

/**
 * Pulls every custom-property declaration on `:root` / `.dark` out of a
 * stylesheet, keeping their enclosing @layer/@supports/@media wrappers so the
 * browser resolves them exactly as Orca's renderer does (var() chains,
 * color-mix fallbacks, layer order). Returns CSS text.
 */
export function extractThemeCss(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  const stack = [] // { prelude, hasChildren }
  let text = ''
  let quote = null

  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (quote) {
      text += ch
      if (ch === '\\') text += css[++i] ?? ''
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '\\') {
      // Escapes appear outside strings too, e.g. Tailwind's `.content-\[\'\'\]`.
      text += ch + (css[++i] ?? '')
    } else if (ch === '"' || ch === "'") {
      quote = ch
      text += ch
    } else if (ch === '{') {
      if (stack.length) stack[stack.length - 1].hasChildren = true
      stack.push({ prelude: text.trim(), hasChildren: false })
      text = ''
    } else if (ch === '}') {
      const block = stack.pop()
      if (block && !block.hasChildren) {
        const rule = themeRule(block.prelude, text, stack)
        if (rule) out.push(rule)
      }
      text = ''
    } else if (ch === ';' && !stack.length) {
      // Top-level statements: keep layer order declarations (`@layer a,b;`).
      const statement = text.trim()
      if (/^@layer\b/.test(statement)) out.push(`${statement};`)
      text = ''
    } else {
      text += ch
    }
  }
  return out.join('\n')
}

function themeRule(selector, body, wrappers) {
  const selectors = selector
    .split(',')
    .map((part) => part.trim())
    .filter((part) => THEME_SELECTORS.has(part))
  if (!selectors.length || wrappers.some((wrapper) => !KEPT_AT_RULES.test(wrapper.prelude))) return null
  const declarations = splitDeclarations(body).filter((declaration) => declaration.startsWith('--'))
  if (!declarations.length) return null
  let rule = `${selectors.join(',')}{${declarations.join(';')}}`
  for (let i = wrappers.length - 1; i >= 0; i--) rule = `${wrappers[i].prelude}{${rule}}`
  return rule
}

function splitDeclarations(body) {
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      if (ch === '\\') current += ch + (body[++i] ?? '')
      else {
        if (ch === quote) quote = null
        current += ch
      }
      continue
    }
    if (ch === '\\') {
      current += ch + (body[++i] ?? '')
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ';' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/** Token names Orca promises to plugin panels, read from the installed build. */
async function readPanelTokenAllowlist(resources) {
  try {
    const source = await readFile(join(resources, 'app.asar.unpacked/out/shared/plugins/plugin-panel-shell.js'), 'utf8')
    const list = source.match(/PANEL_DESIGN_TOKEN_ALLOWLIST\s*=\s*\[([^\]]*)\]/)?.[1] ?? ''
    return [...list.matchAll(/['"`](--[\w-]+)['"`]/g)].map((match) => match[1])
  } catch {
    return []
  }
}

let designCache = { key: null, value: null }

/**
 * `{ css, version, allowlist, missing }` from the installed Orca, or null when
 * Orca can't be found or read. Cached until the app bundle changes (update).
 */
export async function loadOrcaDesignSystem() {
  const resources = findOrcaResources()
  if (!resources) return null
  const asarPath = join(resources, 'app.asar')
  const { mtimeMs } = await rawFs.stat(asarPath)
  const key = `${asarPath}:${mtimeMs}`
  if (designCache.key === key) return designCache.value

  const asar = await openAsar(asarPath)
  try {
    const version = JSON.parse(await asar.read('package.json')).version ?? 'unknown'
    let css = ''
    for (const path of asar.list('out/renderer/assets').filter((file) => file.endsWith('.css'))) {
      const content = await asar.read(path)
      // The app stylesheet is the one that defines the base theme on :root.
      if (/(^|[{}])\s*:root\s*\{[^}]*--background\s*:/.test(content)) css += extractThemeCss(content) + '\n'
    }
    if (!css) return null
    const allowlist = await readPanelTokenAllowlist(resources)
    const missing = allowlist.filter((token) => !css.includes(`${token}:`))
    const value = { css, version, allowlist, missing }
    designCache = { key, value }
    return value
  } finally {
    await asar.close()
  }
}

// ---------- the user's Orca appearance settings ----------

async function activeProfileId() {
  try {
    const index = JSON.parse(await readFile(join(ORCA_DATA_DIR, 'orca-profile-index.json'), 'utf8'))
    return typeof index.activeProfileId === 'string' ? index.activeProfileId : 'local-default'
  } catch {
    return 'local-default'
  }
}

let appearanceCache = { key: null, value: null }

// Current Orca keeps settings in the profile's SQLite store; older builds wrote
// them to orca-data.json (which current builds leave behind, stale).
const SETTINGS_QUERY = "select payload from profile_state_documents where domain = 'settings'"

// The sqlite3 CLI ships with macOS and most Linux distributions; Windows gets
// Node's built-in SQLite (Orca's Electron bundles a recent Node).
async function querySettingsPayload(db) {
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-readonly', db, SETTINGS_QUERY], {
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    })
    return stdout
  } catch (cliError) {
    // Only a missing CLI falls through to node:sqlite; a real failure (locked,
    // corrupt) is the error worth reporting.
    if (cliError.code !== 'ENOENT') throw cliError
    let sqlite
    try {
      sqlite = await import('node:sqlite')
    } catch {
      throw cliError
    }
    const database = new sqlite.DatabaseSync(db, { readOnly: true })
    try {
      return database.prepare(SETTINGS_QUERY).get()?.payload ?? ''
    } finally {
      database.close()
    }
  }
}

async function readSettingsFromProfileDb(profileDir) {
  const stdout = await querySettingsPayload(join(profileDir, 'profile-state.db'))
  if (!stdout.trim()) throw new Error('no settings document')
  const payload = JSON.parse(stdout)
  return payload.settings ?? payload
}

async function readSettingsFromLegacyJson(profileDir) {
  return JSON.parse(await readFile(join(profileDir, 'orca-data.json'), 'utf8')).settings ?? {}
}

const mtime = (path) => stat(path).then((info) => info.mtimeMs, () => 0)

/**
 * `{ theme: 'dark' | 'light' | 'system', appFontFamily }` from Orca's settings.
 * Cached until the store changes on disk: the page polls this every few seconds.
 */
export async function readOrcaAppearance() {
  const profileDir = join(ORCA_DATA_DIR, 'profiles', await activeProfileId())
  const db = join(profileDir, 'profile-state.db')
  // WAL mode: recent writes land in the -wal file before checkpointing.
  const key = `${profileDir}:${await mtime(db)}:${await mtime(`${db}-wal`)}`
  if (appearanceCache.key === key) return appearanceCache.value

  let settings = null
  for (const read of [readSettingsFromProfileDb, readSettingsFromLegacyJson]) {
    try {
      settings = await read(profileDir)
      break
    } catch {
      // try the next source
    }
  }
  const family = typeof settings?.appFontFamily === 'string' ? settings.appFontFamily.trim() : ''
  const value = {
    theme: ['dark', 'light', 'system'].includes(settings?.theme) ? settings.theme : 'system',
    // Font names come from user settings; strip anything that could break out of a CSS value.
    appFontFamily: family ? family.replace(/[^\w \-.]/g, '') : null
  }
  appearanceCache = { key, value }
  return value
}

// ---------- what the page receives ----------

/** Used only when the Orca install can't be read: neutral system colors, so
 *  the page stays legible without pretending to be Orca's palette. */
const SYSTEM_FALLBACK_CSS = `:root{--background:Canvas;--foreground:CanvasText;--card:Canvas;--card-foreground:CanvasText;--popover:Canvas;--popover-foreground:CanvasText;--primary:CanvasText;--primary-foreground:Canvas;--secondary:color-mix(in srgb,CanvasText 6%,Canvas);--secondary-foreground:CanvasText;--muted:color-mix(in srgb,CanvasText 6%,Canvas);--muted-foreground:GrayText;--accent:color-mix(in srgb,CanvasText 8%,Canvas);--accent-foreground:CanvasText;--destructive:#d92d20;--destructive-foreground:#fff;--border:color-mix(in srgb,CanvasText 12%,Canvas);--input:color-mix(in srgb,CanvasText 15%,Canvas);--ring:GrayText;--radius:.625rem;--font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace}`

/** Theme CSS for the page: the installed Orca's tokens, or the system fallback. */
export async function pageThemeCss(log = () => {}) {
  try {
    const design = await loadOrcaDesignSystem()
    if (design) {
      if (design.missing.length) log(`Orca ${design.version} lacks panel tokens: ${design.missing.join(', ')}`)
      return { css: design.css, source: `Orca ${design.version}` }
    }
  } catch (error) {
    log(`reading Orca's design tokens failed: ${error?.message ?? error}`)
  }
  return { css: SYSTEM_FALLBACK_CSS, source: 'system colors (Orca install not readable)' }
}

/**
 * Value for `--app-font-family`, built the way Orca's renderer does it: the
 * user's font first, then Orca's own default stack (read from the install).
 */
export async function appFontFamilyValue(appearance) {
  if (!appearance.appFontFamily) return null
  const design = await loadOrcaDesignSystem().catch(() => null)
  const defaultStack = design?.css.match(/--app-font-family:([^;}]+)/)?.[1]?.trim() ?? 'system-ui, sans-serif'
  return `"${appearance.appFontFamily}", ${defaultStack}`
}
