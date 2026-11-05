import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after } from 'node:test'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from '../main.mjs'
import * as store from '../lib/store.mjs'

// One empty store in a temp folder for the whole file: the worker never touches the real
// accounts or Keychain. It is set once and removed only after every test is done, because
// `activate` starts background work (first refresh, expiry check) that can outlive a test.
const root = await mkdtemp(join(tmpdir(), 'claude-accounts-test-'))
process.env.CLAUDE_ACCOUNTS_ROOT = root

after(async () => {
  delete process.env.CLAUDE_ACCOUNTS_ROOT
  await rm(root, { recursive: true, force: true })
})

test('the panel can list accounts and the worker updates the status bar', async () => {
  const host = mockHost({ results: { 'statusBar.update': { ok: true } } })
  const worker = await mountWorker(main, { host })

  const snapshot = (await worker.request('accounts.list', {})) as { accounts: unknown[]; drift: boolean }
  assert.deepEqual(snapshot.accounts, [])

  // The first refresh published the empty store to the status bar.
  await new Promise((resolve) => setTimeout(resolve, 100))
  const updates = host.callsOf('statusBar.update')
  assert.equal(updates.length, 1)
  assert.equal((updates[0] as { text: string }).text, 'Claude: default login')

  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('an unknown account id is reported to the panel, not swallowed', async () => {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'statusBar.update': { ok: true } } }) })
  await assert.rejects(worker.request('accounts.use', { id: 'acct-missing' }), /unknown account/)
  await worker.deactivate()
})

test('while a worker runs, the store and settings.json paths are inside the temp folder', async () => {
  const worker = await mountWorker(main, { host: mockHost({ results: { 'statusBar.update': { ok: true } } }) })
  assert.ok(store.claudeSettingsPath().startsWith(root + sep), store.claudeSettingsPath())
  assert.ok(store.configDir().startsWith(root + sep), store.configDir())
  await worker.deactivate()
})

test('commands and panel writes go through one shared write queue', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../main.mjs', import.meta.url), 'utf8')
  assert.equal(source.match(/createWriteQueue\(\)/g)?.length, 1, 'one queue')
  assert.match(source, /createAccountsApi\(store, \{[^}]*serial[^}]*\}\)/)
  for (const command of ['next', 'slot', 'off']) {
    assert.match(source, new RegExp(`serial\\([^\\n]*${command === 'slot' ? 'useAccount' : command === 'next' ? 'useNext' : 'useNone'}`), `${command} is queued`)
  }
})
