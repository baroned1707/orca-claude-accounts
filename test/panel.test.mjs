import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8')
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])

test('the panel has exactly one inline script and it parses', () => {
  assert.equal(scripts.length, 1)
  assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'panel.html' }))
})

test('the panel loads nothing from outside itself (browser clients cannot fetch files)', () => {
  assert.ok(!/<script[^>]*\ssrc=/i.test(html), 'no external script')
  assert.ok(!/<link[^>]*rel=["']stylesheet/i.test(html), 'no external stylesheet')
  assert.ok(!/https?:\/\//i.test(html), 'no absolute URL')
})

test('the panel never builds markup from account text', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(scripts[0]))
})

test('the panel only calls handlers the worker registers', async () => {
  const { createAccountsApi } = await import('../lib/accounts-api.mjs')
  const registered = new Set(Object.keys(createAccountsApi({})))
  // `accounts.changed` is the event the worker pushes, not a handler.
  const called = new Set(
    [...scripts[0].matchAll(/['"](accounts\.[A-Za-z]+)['"]/g)].map((match) => match[1]).filter((name) => name !== 'accounts.changed')
  )
  assert.ok(called.size > 0)
  for (const name of called) assert.ok(registered.has(name), `panel calls ${name}, which the worker does not handle`)
})

test('the panel listens for the event the worker pushes', async () => {
  const worker = await readFile(new URL('../main.mjs', import.meta.url), 'utf8')
  assert.ok(worker.includes("'accounts.changed'"))
  assert.ok(scripts[0].includes("'accounts.changed'"))
})
