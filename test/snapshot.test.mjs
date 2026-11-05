import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSnapshot, toPanelSnapshot } from '../lib/snapshot.mjs'

const status = {
  drift: false,
  accounts: [
    {
      id: 'acct-aaaa1111',
      slot: 1,
      label: 'Work',
      active: true,
      tokenUpdatedAt: '2026-01-01T00:00:00.000Z',
      daysLeft: 200,
      email: 'me@example.com',
      orgId: 'org-secret',
      secretBackend: 'macos-keychain',
      lastCheck: { state: 'valid', message: 'fine', sameOrgAs: 'Home', at: '2026-01-02T00:00:00.000Z' },
      usage: {
        ok: true,
        at: '2026-01-03T00:00:00.000Z',
        fiveHour: { percent: 10 },
        sevenDay: { percent: 20 },
        status: 'allowed'
      }
    },
    {
      id: 'acct-bbbb2222',
      slot: 2,
      label: 'Home',
      active: false,
      tokenUpdatedAt: '2025-01-01T00:00:00.000Z',
      daysLeft: -3,
      lastCheck: null,
      usage: { ok: false, error: 'offline', at: '2026-01-03T00:00:00.000Z' }
    }
  ]
}

test('keeps what the panel displays', () => {
  const snapshot = toPanelSnapshot(status)
  assert.equal(snapshot.drift, false)
  assert.equal(snapshot.accounts.length, 2)
  assert.deepEqual(
    { id: snapshot.accounts[0].id, slot: snapshot.accounts[0].slot, label: snapshot.accounts[0].label, active: true },
    { id: 'acct-aaaa1111', slot: 1, label: 'Work', active: true }
  )
  assert.equal(snapshot.accounts[0].checkState, 'valid')
  assert.deepEqual(snapshot.accounts[0].usage.fiveHour, { percent: 10 })
})

test('never carries tokens, identity or storage details', () => {
  const text = JSON.stringify(toPanelSnapshot(status))
  for (const secret of ['me@example.com', 'org-secret', 'macos-keychain', 'sameOrgAs', 'sk-ant']) {
    assert.ok(!text.includes(secret), `snapshot leaks ${secret}`)
  }
})

test('classifies expiry', () => {
  const [work, home] = toPanelSnapshot(status).accounts
  assert.equal(work.expiry, 'ok')
  assert.equal(home.expiry, 'expired')
  const soon = toPanelSnapshot({ drift: false, accounts: [{ ...status.accounts[0], daysLeft: 14 }] })
  assert.equal(soon.accounts[0].expiry, 'soon')
})

test('a failed usage reading becomes null', () => {
  assert.equal(toPanelSnapshot(status).accounts[1].usage, null)
})

test('toPanelSnapshot includes the seq it is given', () => {
  assert.equal(toPanelSnapshot(status, 42).seq, 42)
})

test('seq grows with every read, even when an older read finishes last', async () => {
  const slowStore = { status: () => new Promise((resolve) => setTimeout(() => resolve(status), 40)) }
  const fastStore = { status: async () => status }
  const older = readSnapshot(slowStore)
  const newer = readSnapshot(fastStore)
  const [first, second] = await Promise.all([older, newer])
  assert.ok(second.seq > first.seq, 'seq is assigned before status() is awaited')
  const third = await readSnapshot(fastStore)
  assert.ok(third.seq > second.seq)
})

test('seq starts above the clock so it keeps growing after a worker restart', async () => {
  const before = Date.now()
  const snapshot = await readSnapshot({ status: async () => status })
  assert.ok(snapshot.seq >= before)
})
