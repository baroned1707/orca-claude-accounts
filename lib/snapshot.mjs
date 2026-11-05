// Turns the store's status() into what the sidebar panel may see: labels, dates,
// expiry and usage. Never a token, an email or an organization id.
import { EXPIRY_WARNING_DAYS } from './store.mjs'

function expiryOf(daysLeft) {
  if (daysLeft < 0) return 'expired'
  return daysLeft <= EXPIRY_WARNING_DAYS ? 'soon' : 'ok'
}

export function toPanelSnapshot(status) {
  return {
    generatedAt: new Date().toISOString(),
    drift: Boolean(status.drift),
    accounts: status.accounts.map((account) => ({
      // The id is stable across removals; a slot number is not.
      id: account.id,
      slot: account.slot,
      label: account.label,
      active: Boolean(account.active),
      tokenUpdatedAt: account.tokenUpdatedAt,
      daysLeft: account.daysLeft,
      expiry: expiryOf(account.daysLeft),
      checkState: account.lastCheck?.state ?? null,
      usage: account.usage?.ok
        ? {
            at: account.usage.at,
            fiveHour: account.usage.fiveHour ?? null,
            sevenDay: account.usage.sevenDay ?? null,
            status: account.usage.status ?? null
          }
        : null
    }))
  }
}

export async function readSnapshot(store) {
  return toPanelSnapshot(await store.status())
}
