// Orca plugin worker. Commands switch accounts from the palette or a keybinding;
// the sidebar panel (panel.html) asks this worker for everything it shows and
// does, so it works on desktop, Orca mobile and the browser client alike. The
// worker also pushes changes to open panels and keeps the status bar item current.
// "Manage Accounts…" still opens the full manager page (removed in a later release).
import { dirname } from 'node:path'
import { createAccountsApi } from './lib/accounts-api.mjs'
import { openUrl } from './lib/open-in-orca.mjs'
import { createChangePublisher } from './lib/publisher.mjs'
import { ensureManagerServer } from './lib/server-process.mjs'
import { readSnapshot } from './lib/snapshot.mjs'
import { statusBarFor } from './lib/status-bar.mjs'
import { watchFiles } from './lib/store-watch.mjs'
import * as store from './lib/store.mjs'
import { createTokenChangeGate } from './lib/token-change-gate.mjs'
import { createWriteQueue } from './lib/write-queue.mjs'

const SLOT_COUNT = 5

let watchers = []

export default function activate(orca) {
  const notify = (title, body) =>
    orca.host.call('notifications.show', { title, body: body?.slice(0, 1000) }).catch((error) => {
      orca.log(`notification failed: ${error?.message ?? error}`)
    })

  // Older Orca (or a client without a status bar) lacks the method: skip it.
  const updateStatusBar = (snapshot) => {
    if (!orca.host.has('statusBar.update')) return Promise.resolve()
    return orca.host.call('statusBar.update', statusBarFor(snapshot)).catch((error) => {
      orca.log(`status bar update failed: ${error?.message ?? error}`)
    })
  }

  const publisher = createChangePublisher({
    read: () => readSnapshot(store),
    publish: async (snapshot) => {
      try {
        orca.panels.post('accounts.changed', snapshot)
      } catch (error) {
        orca.log(`panel push failed: ${error?.message ?? error}`)
      }
      await updateStatusBar(snapshot)
    },
    log: orca.log
  })

  // One queue for everything that writes the store: panel handlers and the
  // switching commands below, so a slow panel write cannot be undone by a command.
  const serial = createWriteQueue()

  // Panel requests. Each handler returns the fresh snapshot.
  const api = createAccountsApi(store, { onChange: () => void publisher.refresh(), serial, log: orca.log })
  for (const [name, handler] of Object.entries(api)) {
    orca.panels.handle(name, (input) => handler(input))
  }

  const announceSwitch = async (account) => {
    if (account) {
      await notify(
        `Claude account → ${account.label}`,
        'Running and new Claude Code sessions now use this account.'
      )
    } else {
      await notify('Claude account → default login', 'Token removed; Claude Code falls back to /login.')
    }
    return { active: account?.label ?? null }
  }

  // Every command reports through a notification: the palette shows nothing
  // for a command's return value.
  const run = (label, action) => async () => {
    try {
      const result = await action()
      await publisher.refresh()
      return { ok: true, ...result }
    } catch (error) {
      const message = error?.message ?? String(error)
      orca.log(`${label} failed: ${message}`)
      await notify(`Claude account: ${label} failed`, message)
      return { ok: false, error: message }
    }
  }

  // Catch up with changes made while the worker was not running, then follow the
  // store (the CLI and the manager page write to it too). A change to settings.json
  // refreshes only when its token changed, because a refresh reads the Keychain.
  void publisher.refresh()
  const gate = createTokenChangeGate({
    read: () => store.readActiveToken(),
    onChange: () => publisher.refresh()
  })
  void gate.check() // baseline: the token as it is now
  for (const watcher of watchers) watcher.close()
  watchers = [
    watchFiles({
      targets: [{ dir: store.configDir(), names: ['accounts.json'] }],
      onChange: () => void publisher.refresh()
    }),
    watchFiles({
      targets: [{ dir: dirname(store.claudeSettingsPath()), names: ['settings.json'] }],
      onChange: () => void gate.check()
    })
  ]

  orca.commands.register(
    'manage',
    run('manage', async () => {
      const url = await ensureManagerServer(orca.log)
      const where = await openUrl(url, orca.log)
      if (where === 'browser') {
        await notify('Claude Accounts opened in your browser', 'Orca could not open a tab (is a worktree open?).')
      }
      return { openedIn: where }
    })
  )

  orca.commands.register('next', run('switch', async () => announceSwitch(await serial(() => store.useNext()))))

  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    orca.commands.register(
      `slot-${slot}`,
      run(`slot ${slot}`, async () => announceSwitch(await serial(() => store.useAccount(String(slot)))))
    )
  }

  orca.commands.register(
    'off',
    run('turn off', async () => {
      await serial(() => store.useNone())
      return announceSwitch(null)
    })
  )

  orca.commands.register(
    'show',
    run('show', async () => {
      const snapshot = await store.status()
      if (!snapshot.accounts.length) {
        await notify('Claude accounts', 'None yet. Open the Claude Accounts panel to add one.')
        return {}
      }
      const lines = snapshot.accounts.map(store.accountRow)
      if (snapshot.drift) lines.push('⚠ settings.json token differs from the active account')
      await notify(`Claude account: ${snapshot.active?.label ?? 'default login'}`, lines.join('\n'))
      return {}
    })
  )

  // Warn once per worker start about tokens close to their one-year expiry.
  store
    .status()
    .then((snapshot) => {
      const expiring = snapshot.accounts.filter((account) => account.daysLeft <= store.EXPIRY_WARNING_DAYS)
      if (expiring.length) {
        return notify(
          'Claude tokens expiring',
          `${expiring.map(store.describeAccount).join(', ')}. Renew in the Claude Accounts panel → Update token.`
        )
      }
    })
    .catch((error) => orca.log(`expiry check failed: ${error?.message ?? error}`))
}

export function deactivate() {
  for (const watcher of watchers) watcher.close()
  watchers = []
}
