// What the sidebar panel may ask the worker to do. Every handler returns the fresh
// snapshot, so the panel redraws at once. Writes run one at a time on the queue
// passed in as `serial`, so two panels (or a panel and a worker command, which
// share that queue) cannot interleave their read-modify-write cycles. The CLI and
// the Manage page run in other processes and are not on this queue, so they can
// still race with the worker (this was already true before the panel existed).
//
// `store` is lib/store.mjs; tests pass a fake. Accounts are addressed by id, not
// slot, because a slot number shifts when another client removes an account.
import { readSnapshot } from './snapshot.mjs'
import { createWriteQueue } from './write-queue.mjs'

// Orca returns a handler's error message verbatim to the panel, which can run on a
// remote client. Only the messages the store writes on purpose may pass; anything
// else (file paths, Keychain output, system errors) stays in the plugin log.
const PUBLIC_MESSAGES = [
  /^label cannot be empty$/,
  /^label is longer than \d+ characters$/,
  /^that does not look like a `claude setup-token` token \(expected sk-ant-oat01-…\)$/,
  /^this token is already saved as ".+"$/,
  /^token rejected by Anthropic: .+$/,
  /^no account in slot \d+ \(\d+ configured\)$/,
  /^unknown account ".*"$/,
  /^several accounts are labeled ".+"; use the slot number$/,
  // The bare form is kept so a caller (or test) that throws the short text still passes.
  /^no stored token( for ".+"; update its token)?$/,
  /^no accounts yet; add one first$/
]
const SETTINGS_NOT_JSON = /^.+[\\/]settings\.json is not valid JSON; fix it before switching accounts$/
const TOKEN_SHAPE = /sk-ant-[A-Za-z0-9_-]{8,}/
export const GENERIC_MESSAGE = 'Something went wrong. Details are in the plugin log.'

export function publicMessage(error) {
  const text = typeof error?.message === 'string' ? error.message : ''
  if (TOKEN_SHAPE.test(text)) return GENERIC_MESSAGE
  if (SETTINGS_NOT_JSON.test(text)) return '~/.claude/settings.json is not valid JSON; fix it before switching accounts'
  return PUBLIC_MESSAGES.some((pattern) => pattern.test(text)) ? text : GENERIC_MESSAGE
}

export function createAccountsApi(store, { onChange = () => {}, serial = createWriteQueue(), log = () => {} } = {}) {

  const mutate = (work) => async (input = {}) => {
    await serial(() => work(input))
    const fresh = await readSnapshot(store)
    onChange(fresh)
    return fresh
  }

  // A new Error, so neither the original message nor its stack reaches the panel.
  const guarded = (handler) => async (input) => {
    try {
      return await handler(input)
    } catch (error) {
      log(`panel request failed: ${error?.message ?? error}`)
      throw new Error(publicMessage(error))
    }
  }

  const handlers = {
    'accounts.list': () => readSnapshot(store),
    'accounts.use': mutate(({ id }) => store.useAccount(id)),
    'accounts.useNone': mutate(() => store.useNone()),
    'accounts.check': mutate(({ id }) => store.checkAccounts(id)),
    'accounts.usage': mutate(({ id }) => store.refreshUsage(id)),
    'accounts.add': mutate(({ label, token }) => store.addAccount(label, token)),
    'accounts.updateToken': mutate(({ id, token }) => store.updateToken(id, token)),
    'accounts.rename': mutate(({ id, label }) => store.renameAccount(id, label)),
    'accounts.remove': mutate(({ id }) => store.removeAccount(id))
  }
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, guarded(handler)]))
}
