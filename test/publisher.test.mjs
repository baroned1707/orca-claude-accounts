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

test('a new seq alone is not a change', async () => {
  let reading = { seq: 1, generatedAt: 't1', accounts: [{ label: 'A' }] }
  const publisher = createChangePublisher({ read: async () => reading, publish: async () => {} })
  assert.equal(await publisher.refresh(), true)
  reading = { seq: 2, generatedAt: 't2', accounts: [{ label: 'A' }] }
  assert.equal(await publisher.refresh(), false)
})

test('overlapping refreshes read in order, so a slow older read never publishes after a newer one', async () => {
  const started = []
  const published = []
  const releases = []
  let count = 0
  const read = () => {
    const n = ++count
    started.push(n)
    return new Promise((resolve) => releases.push(() => resolve({ seq: n, generatedAt: 't', accounts: [{ label: `v${n}` }] })))
  }
  const publisher = createChangePublisher({ read, publish: async (s) => published.push(s.accounts[0].label) })

  const first = publisher.refresh()
  const second = publisher.refresh()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(started, [1], 'the second read must not start while the first is running')
  releases[0]()
  await first
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(started, [1, 2])
  releases[1]()
  await second
  assert.deepEqual(published, ['v1', 'v2'])
})

test('requests made during a refresh are coalesced into one more read', async () => {
  let reads = 0
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const publisher = createChangePublisher({
    read: async () => {
      const n = ++reads
      if (n === 1) await gate
      return { seq: n, generatedAt: 't', accounts: [{ label: `v${n}` }] }
    },
    publish: async () => {}
  })
  const calls = [publisher.refresh(), publisher.refresh(), publisher.refresh()]
  release()
  await Promise.all(calls)
  assert.equal(reads, 2)
  // Idle again: the next request starts a fresh read.
  await publisher.refresh()
  assert.equal(reads, 3)
})
