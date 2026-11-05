import assert from 'node:assert/strict'
import { test } from 'node:test'
import { statusBarFor } from '../lib/status-bar.mjs'

const account = (overrides) => ({ label: 'Work', active: true, daysLeft: 200, expiry: 'ok', ...overrides })

test('no active account shows the default login', () => {
  const item = statusBarFor({ drift: false, accounts: [account({ active: false })] })
  assert.equal(item.text, 'Claude: default login')
  assert.equal(item.tone, 'neutral')
})

test('active account is shown by label', () => {
  const item = statusBarFor({ drift: false, accounts: [account()] })
  assert.deepEqual([item.id, item.text, item.tone], ['account', 'Claude: Work', 'neutral'])
})

test('a token close to expiry warns and an expired one is danger', () => {
  assert.equal(statusBarFor({ drift: false, accounts: [account({ expiry: 'soon', daysLeft: 5 })] }).tone, 'warning')
  const expired = statusBarFor({ drift: false, accounts: [account({ expiry: 'expired', daysLeft: -2 })] })
  assert.equal(expired.tone, 'danger')
  assert.match(expired.tooltip, /expired 2d ago/)
})

test('drift warns even when the token is fine', () => {
  assert.equal(statusBarFor({ drift: true, accounts: [account()] }).tone, 'warning')
})

test('a long label is shortened', () => {
  const item = statusBarFor({ drift: false, accounts: [account({ label: 'x'.repeat(60) })] })
  assert.ok(item.text.length <= 'Claude: '.length + 24)
  assert.ok(item.text.endsWith('…'))
})
