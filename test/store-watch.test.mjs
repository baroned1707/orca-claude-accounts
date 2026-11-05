import assert from 'node:assert/strict'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { watchFiles } from '../lib/store-watch.mjs'

async function until(check, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await delay(20)
  }
  assert.fail('condition not met in time')
}

test('fires when a watched file is replaced and ignores other files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-watch-'))
  let hits = 0
  const watcher = watchFiles({ targets: [{ dir, names: ['accounts.json'] }], onChange: () => hits++, debounceMs: 20 })
  try {
    await writeFile(join(dir, 'other.txt'), 'x')
    await delay(200)
    assert.equal(hits, 0, 'an unrelated file must not trigger')

    await writeFile(join(dir, 'accounts.json.1.tmp'), '{}')
    await rename(join(dir, 'accounts.json.1.tmp'), join(dir, 'accounts.json'))
    await until(() => hits > 0)
  } finally {
    watcher.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a burst of writes is reported once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-watch-'))
  let hits = 0
  const watcher = watchFiles({ targets: [{ dir, names: ['accounts.json'] }], onChange: () => hits++, debounceMs: 100 })
  try {
    for (let i = 0; i < 5; i++) await writeFile(join(dir, 'accounts.json'), String(i))
    await delay(400)
    assert.equal(hits, 1)
  } finally {
    watcher.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing folder does not throw and the interval still fires', async () => {
  let hits = 0
  const watcher = watchFiles({
    targets: [{ dir: join(tmpdir(), 'store-watch-does-not-exist'), names: ['accounts.json'] }],
    onChange: () => hits++,
    intervalMs: 30
  })
  try {
    await until(() => hits > 0)
  } finally {
    watcher.close()
  }
})

test('close stops further events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-watch-'))
  let hits = 0
  const watcher = watchFiles({ targets: [{ dir, names: ['accounts.json'] }], onChange: () => hits++, debounceMs: 20 })
  watcher.close()
  await writeFile(join(dir, 'accounts.json'), '{}')
  await delay(200)
  assert.equal(hits, 0)
  await rm(dir, { recursive: true, force: true })
})
