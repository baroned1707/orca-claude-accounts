// What the Orca status bar item shows for a snapshot (see contributes.statusBarItems).
const MAX_LABEL = 24

export const STATUS_BAR_ID = 'account'

export function statusBarFor(snapshot) {
  const active = snapshot.accounts.find((account) => account.active)
  if (!active) {
    return { id: STATUS_BAR_ID, text: 'Claude: default login', tone: 'neutral', tooltip: 'No Claude token in use' }
  }
  const label = active.label.length > MAX_LABEL ? `${active.label.slice(0, MAX_LABEL - 1)}…` : active.label
  let tone = 'neutral'
  let note = `${active.daysLeft}d left on this token`
  if (active.expiry === 'expired') {
    tone = 'danger'
    note = `token expired ${-active.daysLeft}d ago`
  } else if (active.expiry === 'soon') {
    tone = 'warning'
    note = `token expires in ${active.daysLeft}d`
  } else if (snapshot.drift) {
    tone = 'warning'
    note = 'settings.json holds a different token'
  }
  return { id: STATUS_BAR_ID, text: `Claude: ${label}`, tone, tooltip: `${active.label} — ${note}` }
}
