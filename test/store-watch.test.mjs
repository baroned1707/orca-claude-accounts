import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
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

test('a missing folder does not throw, stays quiet, and is noticed once it exists', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'store-watch-'))
  const dir = join(parent, 'later')
  let hits = 0
  const watcher = watchFiles({
    targets: [{ dir, names: ['accounts.json'] }],
    onChange: () => hits++,
    debounceMs: 10,
    intervalMs: 30
  })
  try {
    await delay(250)
    assert.equal(hits, 0, 'nothing exists yet, so nothing changed')

    await mkdir(dir)
    await writeFile(join(dir, 'accounts.json'), '{}')
    await until(() => hits > 0)
  } finally {
    watcher.close()
    await rm(parent, { recursive: true, force: true })
  }
})

test('the interval stays quiet while the files do not change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-watch-'))
  await writeFile(join(dir, 'accounts.json'), '{}')
  await delay(150) // let the OS finish reporting the write above before watching
  let hits = 0
  const watcher = watchFiles({ targets: [{ dir, names: ['accounts.json'] }], onChange: () => hits++, debounceMs: 10, intervalMs: 30 })
  try {
    await delay(400)
    assert.equal(hits, 0)
  } finally {
    watcher.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the interval notices a file that disappears', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-watch-'))
  await writeFile(join(dir, 'accounts.json'), '{}')
  let hits = 0
  const watcher = watchFiles({ targets: [{ dir, names: ['accounts.json'] }], onChange: () => hits++, debounceMs: 10, intervalMs: 30 })
  try {
    await delay(100)
    await rm(join(dir, 'accounts.json'))
    await until(() => hits > 0)
  } finally {
    watcher.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a symlinked file changed through its real folder is noticed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'store-watch-'))
  const linkDir = join(root, 'link')
  const realDir = join(root, 'real')
  await mkdir(linkDir)
  await mkdir(realDir)
  await writeFile(join(realDir, 'settings.json'), '{}')
  await symlink(join(realDir, 'settings.json'), join(linkDir, 'settings.json'))
  await delay(150) // let the OS finish reporting the setup above before watching
  let hits = 0
  const watcher = watchFiles({ targets: [{ dir: linkDir, names: ['settings.json'] }], onChange: () => hits++, debounceMs: 10, intervalMs: 30 })
  try {
    await delay(100)
    assert.equal(hits, 0)
    await writeFile(join(realDir, 'settings.json'), '{"env":{"changed":true}}')
    await until(() => hits > 0)
  } finally {
    watcher.close()
    await rm(root, { recursive: true, force: true })
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
