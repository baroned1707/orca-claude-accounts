#!/usr/bin/env node
// Detached account manager server (started by lib/server-process.mjs). Exits
// on its own after 30 minutes without requests; the open page polls, so it
// stays up while the tab is open.
import { readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { syncPanel } from '../lib/panel.mjs'
import { notifyDesktop } from '../lib/platform.mjs'
import { codeFingerprint, serverStatePath } from '../lib/server-process.mjs'
import { createManagerServer } from '../lib/server.mjs'

const log = (message) => console.error(`${new Date().toISOString()} ${message}`)

// Orca's notification API belongs to the plugin worker; this process uses the
// desktop's own (macOS, Linux; on Windows the page's message is enough).
const notify = notifyDesktop

const server = createManagerServer({
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
const statePath = serverStatePath()
await writeFile(statePath, JSON.stringify({ pid: process.pid, url, code: await codeFingerprint() }), { mode: 0o600 })
const cleanup = () => {
  try {
    // A newer server may have replaced the state file; only remove our own.
    if (JSON.parse(readFileSync(statePath, 'utf8')).pid !== process.pid) return
    rmSync(statePath)
  } catch {
    // already gone
  }
}
process.on('exit', cleanup)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0))
log(`listening (pid ${process.pid})`)
