import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWriteQueue } from '../lib/write-queue.mjs'

test('jobs run one at a time, in the order they were queued', async () => {
  const serial = createWriteQueue()
  const events = []
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const first = serial(async () => {
    events.push('first:start')
    await gate
    events.push('first:end')
    return 1
  })
  const second = serial(async () => {
    events.push('second')
    return 2
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(events, ['first:start'])
  release()
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.deepEqual(events, ['first:start', 'first:end', 'second'])
})

test('a failed job rejects its caller but does not block the next one', async () => {
  const serial = createWriteQueue()
  await assert.rejects(
    serial(async () => {
      throw new Error('boom')
    }),
    /boom/
  )
  assert.equal(await serial(async () => 'next'), 'next')
})
