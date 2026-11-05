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

export function createAccountsApi(store, { onChange = () => {}, serial = createWriteQueue() } = {}) {

  const mutate = (work) => async (input = {}) => {
    await serial(() => work(input))
    const fresh = await readSnapshot(store)
    onChange(fresh)
    return fresh
  }

  return {
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
}
