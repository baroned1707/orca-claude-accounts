import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAccountsApi, publicMessage } from '../lib/accounts-api.mjs'
import { createWriteQueue } from '../lib/write-queue.mjs'

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

test('a command queued on the same queue waits behind an in-flight panel write', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const store = fakeStore({ gate })
  const serial = createWriteQueue()
  const api = createAccountsApi(store, { serial })
  const panelWrite = api['accounts.use']({ id: 'acct-1' })
  // main.mjs queues the store-calling part of a command exactly like this.
  const command = serial(() => store.useNext())
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(store.calls, ['useAccount:start'], 'the command must wait for the panel write')
  release()
  await Promise.all([panelWrite, command])
  assert.deepEqual(store.calls, ['useAccount:start', 'useAccount:acct-1', 'useNext:start', 'useNext:'])
})

test('publicMessage keeps the messages the store writes on purpose', () => {
  const allowed = [
    'label cannot be empty',
    'label is longer than 80 characters',
    'that does not look like a `claude setup-token` token (expected sk-ant-oat01-…)',
    'this token is already saved as "Work"',
    'token rejected by Anthropic: invalid bearer token',
    'no account in slot 7 (2 configured)',
    'unknown account "acct-missing"',
    'several accounts are labeled "Work"; use the slot number',
    'no stored token for "Work"; update its token',
    'no accounts yet; add one first'
  ]
  for (const text of allowed) assert.equal(publicMessage(new Error(text)), text)
})

test('publicMessage hides the home folder in the settings.json message', () => {
  const error = new Error('/Users/jane/.claude/settings.json is not valid JSON; fix it before switching accounts')
  assert.equal(publicMessage(error), '~/.claude/settings.json is not valid JSON; fix it before switching accounts')
  const windows = new Error('C:\\Users\\jane\\.claude\\settings.json is not valid JSON; fix it before switching accounts')
  assert.equal(publicMessage(windows), '~/.claude/settings.json is not valid JSON; fix it before switching accounts')
})

test('publicMessage replaces everything else and never echoes it', () => {
  const generic = 'Something went wrong. Details are in the plugin log.'
  const leaking = [
    "EACCES: permission denied, open '/Users/jane/.config/claude-accounts/accounts.json'",
    'could not store the token in the macOS Keychain: security: SecKeychainItemCreateFromContent failed',
    'boom sk-ant-oat01-secret',
    'unknown account "sk-ant-oat01-secret"',
    'unknown account "x"\n/Users/jane/.claude',
    'Unexpected token } in JSON at position 4',
    'label cannot be empty and also /Users/jane'
  ]
  for (const text of leaking) {
    const result = publicMessage(new Error(text))
    assert.equal(result, generic, text)
    assert.ok(!/jane|secret|Keychain|EACCES/.test(result))
  }
  assert.equal(publicMessage(undefined), generic)
  assert.equal(publicMessage('a string'), generic)
})

test('a failing handler rejects with the public message and logs the original', async () => {
  const store = fakeStore()
  store.renameAccount = async () => {
    throw new Error("EACCES: permission denied, open '/Users/jane/.config/accounts.json'")
  }
  const logged = []
  const api = createAccountsApi(store, { log: (line) => logged.push(line) })
  await assert.rejects(
    api['accounts.rename']({ id: 'acct-1', label: 'X' }),
    (error) => {
      assert.equal(error.message, 'Something went wrong. Details are in the plugin log.')
      assert.equal(error.cause, undefined)
      return true
    }
  )
  assert.equal(logged.length, 1)
  assert.match(logged[0], /EACCES.*\/Users\/jane/)
  store.status = async () => {
    throw new Error('/Users/jane/.claude/settings.json is not valid JSON; fix it before switching accounts')
  }
  await assert.rejects(api['accounts.list'](), (error) => !error.message.includes('jane'))
})
