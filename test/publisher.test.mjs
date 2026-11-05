import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChangePublisher } from '../lib/publisher.mjs'

test('publishes the first reading, then only real changes', async () => {
  const published = []
  let reading = { generatedAt: 't1', accounts: [{ label: 'A' }] }
  const publisher = createChangePublisher({ read: async () => reading, publish: async (s) => published.push(s) })

  assert.equal(await publisher.refresh(), true)
  reading = { generatedAt: 't2', accounts: [{ label: 'A' }] }
  assert.equal(await publisher.refresh(), false, 'a new timestamp alone is not a change')
  reading = { generatedAt: 't3', accounts: [{ label: 'B' }] }
  assert.equal(await publisher.refresh(), true)
  assert.equal(published.length, 2)
})

test('a failing read is logged, not thrown, and is retried next time', async () => {
  const logs = []
  let fail = true
  const publisher = createChangePublisher({
    read: async () => {
      if (fail) throw new Error('settings.json is not valid JSON')
      return { generatedAt: 't', accounts: [] }
    },
    publish: async () => {},
    log: (line) => logs.push(line)
  })
  assert.equal(await publisher.refresh(), false)
  assert.match(logs[0], /settings\.json is not valid JSON/)
  fail = false
  assert.equal(await publisher.refresh(), true)
})
