// Orca plugin worker. "Manage Accounts…" serves the account manager page and
// opens it as a tab in Orca's built-in browser, styled with Orca's own theme;
// the other commands switch accounts straight from the palette or a keybinding.
import { openUrl } from './lib/open-in-orca.mjs'
import { syncPanel } from './lib/panel.mjs'
import { ensureManagerServer } from './lib/server-process.mjs'
import {
  EXPIRY_WARNING_DAYS,
  accountRow,
  describeAccount,
  status,
  useAccount,
  useNext,
  useNone
} from './lib/store.mjs'

const SLOT_COUNT = 5

export default function activate(orca) {
  const notify = (title, body) =>
    orca.host.call('notifications.show', { title, body: body?.slice(0, 1000) }).catch((error) => {
      orca.log(`notification failed: ${error?.message ?? error}`)
    })

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
      await syncPanel(orca.log)
      return { ok: true, ...result }
    } catch (error) {
      const message = error?.message ?? String(error)
      orca.log(`${label} failed: ${message}`)
      await notify(`Claude account: ${label} failed`, message)
      return { ok: false, error: message }
    }
  }

  // Catch up with changes made while the worker was not running.
  void syncPanel(orca.log)

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

  orca.commands.register('next', run('switch', async () => announceSwitch(await useNext())))

  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    orca.commands.register(
      `slot-${slot}`,
      run(`slot ${slot}`, async () => announceSwitch(await useAccount(String(slot))))
    )
  }

  orca.commands.register(
    'off',
    run('turn off', async () => {
      await useNone()
      return announceSwitch(null)
    })
  )

  orca.commands.register(
    'show',
    run('show', async () => {
      const snapshot = await status()
      if (!snapshot.accounts.length) {
        await notify('Claude accounts', 'None yet. Open "Claude Account: Manage Accounts…" to add one.')
        return {}
      }
      const lines = snapshot.accounts.map(accountRow)
      if (snapshot.drift) lines.push('⚠ settings.json token differs from the active account')
      await notify(`Claude account: ${snapshot.active?.label ?? 'default login'}`, lines.join('\n'))
      return {}
    })
  )

  // Warn once per worker start about tokens close to their one-year expiry.
  status()
    .then((snapshot) => {
      const expiring = snapshot.accounts.filter((account) => account.daysLeft <= EXPIRY_WARNING_DAYS)
      if (expiring.length) {
        return notify(
          'Claude tokens expiring',
          `${expiring.map(describeAccount).join(', ')}. Renew in Manage Accounts → Update token.`
        )
      }
    })
    .catch((error) => orca.log(`expiry check failed: ${error?.message ?? error}`))
}
