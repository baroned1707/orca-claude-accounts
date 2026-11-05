import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from '../main.mjs'

// An empty store in a temp folder: the worker never touches the real accounts or Keychain.
async function withEmptyStore<T>(body: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'claude-accounts-test-'))
  process.env.CLAUDE_ACCOUNTS_ROOT = root
  try {
    return await body()
  } finally {
    delete process.env.CLAUDE_ACCOUNTS_ROOT
    await rm(root, { recursive: true, force: true })
  }
}

test('the panel can list accounts and the worker updates the status bar', () =>
  withEmptyStore(async () => {
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
  }))

test('an unknown account id is reported to the panel, not swallowed', () =>
  withEmptyStore(async () => {
    const worker = await mountWorker(main, { host: mockHost({ results: { 'statusBar.update': { ok: true } } }) })
    await assert.rejects(worker.request('accounts.use', { id: 'acct-missing' }), /unknown account/)
    await worker.deactivate()
  }))
