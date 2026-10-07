// Keeps the sidebar panel (panel.html) in sync with the account store.
//
// Orca plugin panels cannot receive data from the worker at runtime (no
// panel-callable read API, CSP connect-src 'none'). For a plugin loaded from a
// developer path, Orca watches the folder and reloads the panel when its entry
// file changes — so whoever changes the store (worker, CLI, manager page)
// rewrites panel.html with the new snapshot. It holds labels and dates only,
// never tokens.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appFontFamilyValue, readOrcaAppearance } from './orca-theme.mjs'
import { status } from './store.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_PATH = join(PLUGIN_ROOT, 'ui', 'panel.template.html')
export const PANEL_PATH = join(PLUGIN_ROOT, 'panel.html')

/** Installed (marketplace) plugins are content-hashed and must stay byte-identical. */
export function isMutablePluginRoot(root = PLUGIN_ROOT) {
  return !root.includes(`${sep}Application Support${sep}orca${sep}plugins${sep}`)
}

export function renderPanelHtml(template, snapshot, font) {
  const data = {
    generatedAt: new Date().toISOString(),
    drift: snapshot.drift,
    font,
    accounts: snapshot.accounts.map((account) => ({
      slot: account.slot,
      label: account.label,
      active: account.active,
      tokenUpdatedAt: account.tokenUpdatedAt,
      usage: account.usage?.ok
        ? { at: account.usage.at, fiveHour: account.usage.fiveHour, sevenDay: account.usage.sevenDay, status: account.usage.status }
        : null
    }))
  }
  // `<` escaped so a label can never close the <script> element.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return template.replace('/*__PANEL_DATA__*/', () => json)
}

// Everything except the timestamp, so an unchanged store doesn't rewrite the
// file (each rewrite makes Orca reload the panel).
const comparable = (html) => html.replace(/"generatedAt":"[^"]*"/, '')

let queue = Promise.resolve()

/** Rewrites panel.html when the store changed. Never throws. Calls run one at a
 *  time so concurrent triggers (startup + a command) can't race on the file. */
export function syncPanel(log = () => {}) {
  const run = queue.then(() => writePanel(log))
  queue = run.catch(() => {})
  return run
}

async function writePanel(log) {
  if (!isMutablePluginRoot()) return false
  try {
    const [template, snapshot, appearance] = await Promise.all([
      readFile(TEMPLATE_PATH, 'utf8'),
      status(),
      readOrcaAppearance()
    ])
    const html = renderPanelHtml(template, snapshot, await appFontFamilyValue(appearance))
    const current = await readFile(PANEL_PATH, 'utf8').catch(() => '')
    if (comparable(current) === comparable(html)) return false
    const temp = join(PLUGIN_ROOT, `.panel.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temp, html)
    await rename(temp, PANEL_PATH)
    return true
  } catch (error) {
    log(`panel sync failed: ${error?.message ?? error}`)
    return false
  }
}
