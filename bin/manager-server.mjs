#!/usr/bin/env node
// Detached account manager server (started by lib/server-process.mjs). Exits
// on its own after 12 hours without requests; an open page pings, so it
// stays up while the tab is open.
import { readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { syncPanel } from '../lib/panel.mjs'
import { notifyDesktop } from '../lib/platform.mjs'
import { codeFingerprint, serverStatePath } from '../lib/server-process.mjs'
import { createManagerServer } from '../lib/server.mjs'

const log = (message) => console.error(`${new Date().toISOString()} ${message}`)

// Orca's notification API belongs to the plugin worker; this process uses the
// desktop's own (macOS, Linux; on Windows the page's message is enough).
const notify = notifyDesktop

const statePath = serverStatePath()
let previous = {}
try {
  previous = JSON.parse(readFileSync(statePath, 'utf8'))
} catch {
  // first start
}

// v0.11.3 and older stored only the URL; take the address from it.
if (previous.url && !(previous.port && previous.secret)) {
  try {
    const old = new URL(previous.url)
    previous.port = Number(old.port)
    previous.secret = old.pathname.split('/')[1]
  } catch {
    // unreadable: start fresh
  }
}

const server = createManagerServer({
  // Same address as last time, so open tabs (also on Orca mobile) reconnect.
  port: previous.port,
  secret: previous.secret,
  keepAlive: true,
  log,
  onChange: () => syncPanel(log),
  onSwitch: async (account) =>
    notify(
      account ? `Claude account → ${account.label}` : 'Claude account → default login',
      account ? 'Running and new Claude Code sessions now use this account.' : 'Token removed; Claude Code uses /login.'
    ),
  onStop: () => process.exit(0)
})

const url = await server.start()
const { port, pathname } = new URL(url)
const state = { pid: process.pid, url, port: Number(port), secret: pathname.split('/')[1], code: await codeFingerprint() }
await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
const cleanup = () => {
  try {
    // A newer server may have replaced the state file; only touch our own.
    if (JSON.parse(readFileSync(statePath, 'utf8')).pid !== process.pid) return
    // Keep the address for the next start; only mark it as not running.
    const { pid, ...address } = state
    writeFileSync(statePath, JSON.stringify(address), { mode: 0o600 })
  } catch {
    // already gone
  }
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0))
log(`listening (pid ${process.pid})`)
// The sidebar panel shows this address for Orca mobile.
await syncPanel(log)
