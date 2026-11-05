import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAccountsApi } from '../lib/accounts-api.mjs'

function fakeStore({ gate } = {}) {
  const calls = []
  const record = (name) => async (...args) => {
    calls.push(`${name}:start`)
    if (gate && name === 'useAccount') await gate
    calls.push(`${name}:${args.join(',')}`)
  }
  return {
    calls,
    status: async () => ({
      drift: false,
      accounts: [{ id: 'acct-1', slot: 1, label: 'Work', active: true, tokenUpdatedAt: '2026-01-01T00:00:00.000Z', daysLeft: 100 }]
    }),
    useAccount: record('useAccount'),
    useNext: record('useNext'),
    useNone: record('useNone'),
    checkAccounts: record('checkAccounts'),
    refreshUsage: record('refreshUsage'),
    addAccount: record('addAccount'),
    updateToken: record('updateToken'),
    renameAccount: record('renameAccount'),
    removeAccount: record('removeAccount')
  }
}

test('list returns the snapshot without writing', async () => {
  const store = fakeStore()
  const snapshot = await createAccountsApi(store)['accounts.list']()
  assert.equal(snapshot.accounts[0].label, 'Work')
  assert.deepEqual(store.calls, [])
})

test('use passes the account id and returns a fresh snapshot', async () => {
  const store = fakeStore()
  const seen = []
  const api = createAccountsApi(store, { onChange: (snapshot) => seen.push(snapshot) })
  const snapshot = await api['accounts.use']({ id: 'acct-1' })
  assert.deepEqual(store.calls, ['useAccount:start', 'useAccount:acct-1'])
  assert.equal(snapshot.accounts[0].active, true)
  assert.equal(seen.length, 1)
})

test('add, rename, update, remove and check reach the store with their arguments', async () => {
  const store = fakeStore()
  const api = createAccountsApi(store)
  await api['accounts.add']({ label: 'New', token: 'sk-ant-oat01-abc' })
  await api['accounts.rename']({ id: 'acct-1', label: 'Renamed' })
  await api['accounts.updateToken']({ id: 'acct-1', token: 'sk-ant-oat01-def' })
  await api['accounts.check']({ id: 'acct-1' })
  await api['accounts.usage']({})
  await api['accounts.remove']({ id: 'acct-1' })
  assert.deepEqual(
    store.calls.filter((call) => !call.endsWith(':start')),
    [
      'addAccount:New,sk-ant-oat01-abc',
      'renameAccount:acct-1,Renamed',
      'updateToken:acct-1,sk-ant-oat01-def',
      'checkAccounts:acct-1',
      'refreshUsage:',
      'removeAccount:acct-1'
    ]
  )
})

test('writes run one at a time', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const store = fakeStore({ gate })
  const api = createAccountsApi(store)
  const first = api['accounts.use']({ id: 'acct-1' })
  const second = api['accounts.rename']({ id: 'acct-1', label: 'X' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(store.calls, ['useAccount:start'], 'rename must wait for use to finish')
  release()
  await Promise.all([first, second])
  assert.deepEqual(store.calls, ['useAccount:start', 'useAccount:acct-1', 'renameAccount:start', 'renameAccount:acct-1,X'])
})

test('a failed write rejects but does not block the next one', async () => {
  const store = fakeStore()
  store.useAccount = async () => {
    throw new Error('no stored token')
  }
  const api = createAccountsApi(store)
  await assert.rejects(api['accounts.use']({ id: 'acct-1' }), /no stored token/)
  await api['accounts.rename']({ id: 'acct-1', label: 'Y' })
  assert.ok(store.calls.includes('renameAccount:acct-1,Y'))
})
