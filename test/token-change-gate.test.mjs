import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTokenChangeGate } from '../lib/token-change-gate.mjs'

// A gate whose `read` returns the next scripted value (an Error instance is thrown).
function scripted(...values) {
  let calls = 0
  const queue = [...values]
  const gate = createTokenChangeGate({
    read: async () => {
      const value = queue.length > 1 ? queue.shift() : queue[0]
      if (value instanceof Error) throw value
      return value
    },
    onChange: () => {
      calls++
    }
  })
  return { gate, calls: () => calls }
}

test('the first check only records a baseline', async () => {
  const { gate, calls } = scripted('token-a')
  await gate.check()
  assert.equal(calls(), 0)
})

test('an unchanged token does not call onChange', async () => {
  const { gate, calls } = scripted('token-a')
  await gate.check()
  await gate.check()
  await gate.check()
  assert.equal(calls(), 0)
})

test('a changed, appeared or removed token calls onChange once each', async () => {
  const { gate, calls } = scripted(null, 'token-a', 'token-b', null)
  await gate.check() // baseline: null
  await gate.check() // appeared
  assert.equal(calls(), 1)
  await gate.check() // changed
  assert.equal(calls(), 2)
  await gate.check() // removed
  assert.equal(calls(), 3)
})

test('a read error calls onChange once, then not while it keeps failing', async () => {
  const failure = new Error('bad json')
  const { gate, calls } = scripted('token-a', failure)
  await gate.check() // baseline
  await gate.check() // valid -> unreadable
  assert.equal(calls(), 1)
  await gate.check()
  await gate.check()
  assert.equal(calls(), 1)
})

test('an error followed by a valid file calls onChange once', async () => {
  const { gate, calls } = scripted(new Error('bad json'), new Error('bad json'), 'token-a', 'token-a')
  await gate.check() // baseline: unreadable
  await gate.check() // still unreadable
  assert.equal(calls(), 0)
  await gate.check() // unreadable -> valid
  assert.equal(calls(), 1)
  await gate.check()
  assert.equal(calls(), 1)
})

test('an onChange that rejects does not make check() reject', async () => {
  const gate = createTokenChangeGate({
    read: (() => {
      const values = ['token-a', 'token-b']
      return async () => values.shift()
    })(),
    onChange: async () => {
      throw new Error('refresh failed')
    }
  })
  await gate.check()
  await assert.doesNotReject(gate.check())
})
