# Live Panel for Every Orca Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rewritten `panel.html` with a panel that asks the plugin worker for everything it shows and does, so it works on desktop, Orca mobile and the browser client; add a status bar item; move the manifest to format 2.

**Architecture:** `lib/store.mjs` stays the single source of truth. A thin worker layer (`lib/accounts-api.mjs`) exposes store operations as panel handlers (`orca.panels.handle`), serializes writes, and returns a token-free snapshot (`lib/snapshot.mjs`). The worker watches the store files (`lib/store-watch.mjs`) and pushes changes to open panels and the status bar through a de-duplicating publisher (`lib/publisher.mjs`). `panel.html` is one self-contained file that calls `orca.plugin.request` and listens for `accounts.changed`.

**Tech Stack:** Node 18+ ES modules, `node:test`, Orca plugin host API 1.3 (`plugin.request`, `orca.panels.handle/post`, `statusBar.update`), `orca plugin test/validate/shot`.

**Spec:** `docs/superpowers/specs/2026-11-05-live-panel-remote-design.md`. This plan covers sub-project 1 only. Sub-project 2 (remove the manager page) starts after Task 10 passes on a phone; sub-project 3 (SSH/WSL spike) has its own plan once the owner names a host.

**Conventions**
- Commit messages are English; each ends with the `Co-Authored-By` trailer shown in the commit steps.
- Run all commands from the repository root.
- Every module in Tasks 1–6 and the manifest in Task 8 was run against `orca plugin test .` and `orca plugin validate .` in a scratch copy before being written here. Task 6's panel was also exercised in a browser with a fake `window.orca`.
- Tests never touch the real accounts or Keychain: unit tests use a fake store, the worker test points `CLAUDE_ACCOUNTS_ROOT` at an empty temp folder.

## File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `lib/snapshot.mjs` | create | Turn `status()` into the token-free data the panel and status bar use |
| `lib/accounts-api.mjs` | create | Panel handlers over the store; serialized writes |
| `lib/publisher.mjs` | create | Publish a snapshot only when it changed |
| `lib/status-bar.mjs` | create | Status bar item text and tone for a snapshot |
| `lib/store-watch.mjs` | create | Debounced file watching with a timer fallback |
| `main.mjs` | rewrite | Register handlers, watcher, publisher, commands |
| `panel.html` | rewrite | The panel UI (static file, no generated data) |
| `orca-plugin.json` | rewrite | Manifest format 2, status bar item |
| `lib/panel.mjs`, `ui/panel.template.html` | delete | The old `panel.html` rewrite mechanism |
| `bin/claude-accounts.mjs`, `bin/manager-server.mjs` | modify | Stop calling `syncPanel` |
| `test/*.test.mjs`, `test/worker.test.ts` | create | Tests |
| `README.md`, `package.json`, `.gitignore` | modify | Docs, version, ignores |

---

### Task 0: Branch and baseline

**Files:** none

- [ ] **Step 1: Create a branch**

```bash
git switch -c feat/live-panel
```

- [ ] **Step 2: Confirm the baseline validates**

Run: `orca plugin validate .`
Expected: first line ends with `orca-plugin.json: ok`.

- [ ] **Step 3: Create the test folder**

```bash
mkdir -p test
```

---

### Task 1: Token-free snapshot

**Files:**
- Create: `lib/snapshot.mjs`
- Test: `test/snapshot.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/snapshot.test.mjs`:

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toPanelSnapshot } from '../lib/snapshot.mjs'

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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/snapshot.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/snapshot.mjs`.

- [ ] **Step 3: Write the implementation**

Create `lib/snapshot.mjs`:

```js
// Turns the store's status() into what the sidebar panel may see: labels, dates,
// expiry and usage. Never a token, an email or an organization id.
import { EXPIRY_WARNING_DAYS } from './store.mjs'

function expiryOf(daysLeft) {
  if (daysLeft < 0) return 'expired'
  return daysLeft <= EXPIRY_WARNING_DAYS ? 'soon' : 'ok'
}

export function toPanelSnapshot(status) {
  return {
    generatedAt: new Date().toISOString(),
    drift: Boolean(status.drift),
    accounts: status.accounts.map((account) => ({
      // The id is stable across removals; a slot number is not.
      id: account.id,
      slot: account.slot,
      label: account.label,
      active: Boolean(account.active),
      tokenUpdatedAt: account.tokenUpdatedAt,
      daysLeft: account.daysLeft,
      expiry: expiryOf(account.daysLeft),
      checkState: account.lastCheck?.state ?? null,
      usage: account.usage?.ok
        ? {
            at: account.usage.at,
            fiveHour: account.usage.fiveHour ?? null,
            sevenDay: account.usage.sevenDay ?? null,
            status: account.usage.status ?? null
          }
        : null
    }))
  }
}

export async function readSnapshot(store) {
  return toPanelSnapshot(await store.status())
}
```

- [ ] **Step 4: Run the test**

Run: `node --test test/snapshot.test.mjs`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Commit**

```bash
git add lib/snapshot.mjs test/snapshot.test.mjs
git commit -m "feat: add token-free account snapshot" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Panel handlers over the store

**Files:**
- Create: `lib/accounts-api.mjs`
- Test: `test/accounts-api.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/accounts-api.test.mjs`:

```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAccountsApi } from '../lib/accounts-api.mjs'

function fakeStore({ gate } = {}) {
  const calls = []
  const record = (name) => async (...args) => {
    calls.push(`${name}:start`)
    if (gate && name === 'useAccount') await gate
    calls.push(`${name}:${args.join(',')}`)
  }
  return {
    calls,
    status: async () => ({
      drift: false,
      accounts: [{ id: 'acct-1', slot: 1, label: 'Work', active: true, tokenUpdatedAt: '2026-01-01T00:00:00.000Z', daysLeft: 100 }]
    }),
    useAccount: record('useAccount'),
    useNext: record('useNext'),
    useNone: record('useNone'),
    checkAccounts: record('checkAccounts'),
    refreshUsage: record('refreshUsage'),
    addAccount: record('addAccount'),
    updateToken: record('updateToken'),
    renameAccount: record('renameAccount'),
    removeAccount: record('removeAccount')
  }
}

test('list returns the snapshot without writing', async () => {
  const store = fakeStore()
  const snapshot = await createAccountsApi(store)['accounts.list']()
  assert.equal(snapshot.accounts[0].label, 'Work')
  assert.deepEqual(store.calls, [])
})

test('use passes the account id and returns a fresh snapshot', async () => {
  const store = fakeStore()
  const seen = []
  const api = createAccountsApi(store, { onChange: (snapshot) => seen.push(snapshot) })
  const snapshot = await api['accounts.use']({ id: 'acct-1' })
  assert.deepEqual(store.calls, ['useAccount:start', 'useAccount:acct-1'])
  assert.equal(snapshot.accounts[0].active, true)
  assert.equal(seen.length, 1)
})

test('add, rename, update, remove and check reach the store with their arguments', async () => {
  const store = fakeStore()
  const api = createAccountsApi(store)
  await api['accounts.add']({ label: 'New', token: 'sk-ant-oat01-abc' })
  await api['accounts.rename']({ id: 'acct-1', label: 'Renamed' })
  await api['accounts.updateToken']({ id: 'acct-1', token: 'sk-ant-oat01-def' })
  await api['accounts.check']({ id: 'acct-1' })
  await api['accounts.usage']({})
  await api['accounts.remove']({ id: 'acct-1' })
  assert.deepEqual(
    store.calls.filter((call) => !call.endsWith(':start')),
    [
      'addAccount:New,sk-ant-oat01-abc',
      'renameAccount:acct-1,Renamed',
      'updateToken:acct-1,sk-ant-oat01-def',
      'checkAccounts:acct-1',
      'refreshUsage:',
      'removeAccount:acct-1'
    ]
  )
})

test('writes run one at a time', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const store = fakeStore({ gate })
  const api = createAccountsApi(store)
  const first = api['accounts.use']({ id: 'acct-1' })
  const second = api['accounts.rename']({ id: 'acct-1', label: 'X' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(store.calls, ['useAccount:start'], 'rename must wait for use to finish')
  release()
  await Promise.all([first, second])
  assert.deepEqual(store.calls, ['useAccount:start', 'useAccount:acct-1', 'renameAccount:start', 'renameAccount:acct-1,X'])
})

test('a failed write rejects but does not block the next one', async () => {
  const store = fakeStore()
  store.useAccount = async () => {
    throw new Error('no stored token')
  }
  const api = createAccountsApi(store)
  await assert.rejects(api['accounts.use']({ id: 'acct-1' }), /no stored token/)
  await api['accounts.rename']({ id: 'acct-1', label: 'Y' })
  assert.ok(store.calls.includes('renameAccount:acct-1,Y'))
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/accounts-api.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/accounts-api.mjs`.

- [ ] **Step 3: Write the implementation**

Create `lib/accounts-api.mjs`:

```js
// What the sidebar panel may ask the worker to do. Every handler returns the fresh
// snapshot, so the panel redraws at once. Writes run one at a time so two panels
// (or a panel and a command) cannot interleave their read-modify-write cycles.
//
// `store` is lib/store.mjs; tests pass a fake. Accounts are addressed by id, not
// slot, because a slot number shifts when another client removes an account.
import { readSnapshot } from './snapshot.mjs'

export function createAccountsApi(store, { onChange = () => {} } = {}) {
  let queue = Promise.resolve()
  const serial = (work) => {
    const run = queue.then(work)
    queue = run.catch(() => {})
    return run
  }

  const mutate = (work) => async (input = {}) => {
    await serial(() => work(input))
    const fresh = await readSnapshot(store)
    onChange(fresh)
    return fresh
  }

  return {
    'accounts.list': () => readSnapshot(store),
    'accounts.use': mutate(({ id }) => store.useAccount(id)),
    'accounts.useNone': mutate(() => store.useNone()),
    'accounts.check': mutate(({ id }) => store.checkAccounts(id)),
    'accounts.usage': mutate(({ id }) => store.refreshUsage(id)),
    'accounts.add': mutate(({ label, token }) => store.addAccount(label, token)),
    'accounts.updateToken': mutate(({ id, token }) => store.updateToken(id, token)),
    'accounts.rename': mutate(({ id, label }) => store.renameAccount(id, label)),
    'accounts.remove': mutate(({ id }) => store.removeAccount(id))
  }
}
```

- [ ] **Step 4: Run the test**

Run: `node --test test/accounts-api.test.mjs`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Commit**

```bash
git add lib/accounts-api.mjs test/accounts-api.test.mjs
git commit -m "feat: add panel handlers over the account store" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Change publisher and status bar text

**Files:**
- Create: `lib/publisher.mjs`, `lib/status-bar.mjs`
- Test: `test/publisher.test.mjs`, `test/status-bar.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/publisher.test.mjs`:

```js
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
```

Create `test/status-bar.test.mjs`:

```js
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test test/publisher.test.mjs test/status-bar.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Write the implementations**

Create `lib/publisher.mjs`:

```js
// Reads the snapshot and publishes it only when something other than its
// timestamp changed, so file-watch noise never reaches the panel or status bar.
export function createChangePublisher({ read, publish, log = () => {} }) {
  let lastKey = null
  return {
    async refresh() {
      try {
        const snapshot = await read()
        const key = JSON.stringify({ ...snapshot, generatedAt: null })
        if (key === lastKey) return false
        lastKey = key
        await publish(snapshot)
        return true
      } catch (error) {
        log(`refresh failed: ${error?.message ?? error}`)
        return false
      }
    }
  }
}
```

Create `lib/status-bar.mjs`:

```js
// What the Orca status bar item shows for a snapshot (see contributes.statusBarItems).
const MAX_LABEL = 24

export const STATUS_BAR_ID = 'account'

export function statusBarFor(snapshot) {
  const active = snapshot.accounts.find((account) => account.active)
  if (!active) {
    return { id: STATUS_BAR_ID, text: 'Claude: default login', tone: 'neutral', tooltip: 'No Claude token in use' }
  }
  const label = active.label.length > MAX_LABEL ? `${active.label.slice(0, MAX_LABEL - 1)}…` : active.label
  let tone = 'neutral'
  let note = `${active.daysLeft}d left on this token`
  if (active.expiry === 'expired') {
    tone = 'danger'
    note = `token expired ${-active.daysLeft}d ago`
  } else if (active.expiry === 'soon') {
    tone = 'warning'
    note = `token expires in ${active.daysLeft}d`
  } else if (snapshot.drift) {
    tone = 'warning'
    note = 'settings.json holds a different token'
  }
  return { id: STATUS_BAR_ID, text: `Claude: ${label}`, tone, tooltip: `${active.label} — ${note}` }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/publisher.test.mjs test/status-bar.test.mjs`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Commit**

```bash
git add lib/publisher.mjs lib/status-bar.mjs test/publisher.test.mjs test/status-bar.test.mjs
git commit -m "feat: add change publisher and status bar text" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Store file watcher

**Files:**
- Create: `lib/store-watch.mjs`
- Test: `test/store-watch.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/store-watch.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/store-watch.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/store-watch.mjs`.

- [ ] **Step 3: Write the implementation**

Create `lib/store-watch.mjs`:

```js
// Calls `onChange` (debounced) when one of the named files changes, and every
// `intervalMs` as a safety net for folders where fs.watch misses events (network
// drives, a folder that does not exist yet). The store writes by renaming a temp
// file over the target, which fs.watch reports under the target's name.
import { watch } from 'node:fs'

export function watchFiles({ targets, onChange, debounceMs = 200, intervalMs = 60_000 }) {
  let timer = null
  const trigger = () => {
    clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  }

  const watchers = []
  for (const { dir, names } of targets) {
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (!filename || names.includes(String(filename))) trigger()
      })
      watcher.on('error', () => {})
      watchers.push(watcher)
    } catch {
      // The folder is missing: the interval still covers it.
    }
  }

  const interval = setInterval(onChange, intervalMs)
  interval.unref?.()

  return {
    close() {
      clearTimeout(timer)
      clearInterval(interval)
      for (const watcher of watchers) watcher.close()
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `node --test test/store-watch.test.mjs`
Expected: `# pass 4`, `# fail 0`.

- [ ] **Commit**

```bash
git add lib/store-watch.mjs test/store-watch.test.mjs
git commit -m "feat: add debounced store file watcher" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the worker

**Files:**
- Rewrite: `main.mjs`
- Test: `test/worker.test.ts`

The commands keep their ids and behavior. New: panel handlers, a store watcher, a publisher that pushes `accounts.changed` and updates the status bar. `syncPanel` is gone from this file.

- [ ] **Step 1: Write the failing worker test**

Create `test/worker.test.ts`. It runs the real `main.mjs` under Orca's `mountWorker` with an empty temp store:

```ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `orca plugin test .`
Expected: the two worker tests FAIL (the current `main.mjs` registers no `accounts.list` handler); the unit tests from Tasks 1–4 pass.

The old `main.mjs` still runs `syncPanel`, which rewrites `panel.html` in the repository. If `git status` then shows `panel.html` modified, run `git checkout panel.html`; Task 6 replaces that file anyway.

- [ ] **Step 3: Replace `main.mjs`**

Overwrite `main.mjs` with:

```js
// Orca plugin worker. Commands switch accounts from the palette or a keybinding;
// the sidebar panel (panel.html) asks this worker for everything it shows and
// does, so it works on desktop, Orca mobile and the browser client alike. The
// worker also pushes changes to open panels and keeps the status bar item current.
// "Manage Accounts…" still opens the full manager page (removed in a later release).
import { dirname } from 'node:path'
import { createAccountsApi } from './lib/accounts-api.mjs'
import { openUrl } from './lib/open-in-orca.mjs'
import { createChangePublisher } from './lib/publisher.mjs'
import { ensureManagerServer } from './lib/server-process.mjs'
import { readSnapshot } from './lib/snapshot.mjs'
import { statusBarFor } from './lib/status-bar.mjs'
import { watchFiles } from './lib/store-watch.mjs'
import * as store from './lib/store.mjs'

const SLOT_COUNT = 5

let watcher = null

export default function activate(orca) {
  const notify = (title, body) =>
    orca.host.call('notifications.show', { title, body: body?.slice(0, 1000) }).catch((error) => {
      orca.log(`notification failed: ${error?.message ?? error}`)
    })

  // Older Orca (or a client without a status bar) lacks the method: skip it.
  const updateStatusBar = (snapshot) => {
    if (!orca.host.has('statusBar.update')) return Promise.resolve()
    return orca.host.call('statusBar.update', statusBarFor(snapshot)).catch((error) => {
      orca.log(`status bar update failed: ${error?.message ?? error}`)
    })
  }

  const publisher = createChangePublisher({
    read: () => readSnapshot(store),
    publish: async (snapshot) => {
      try {
        orca.panels.post('accounts.changed', snapshot)
      } catch (error) {
        orca.log(`panel push failed: ${error?.message ?? error}`)
      }
      await updateStatusBar(snapshot)
    },
    log: orca.log
  })

  // Panel requests. Each handler returns the fresh snapshot.
  const api = createAccountsApi(store, { onChange: () => void publisher.refresh() })
  for (const [name, handler] of Object.entries(api)) {
    orca.panels.handle(name, (input) => handler(input))
  }

  const announceSwitch = async (account) => {
    if (account) {
      await notify(
        `Claude account → ${account.label}`,
        'Running and new Claude Code sessions now use this account.'
      )
    } else {
      await notify('Claude account → default login', 'Token removed; Claude Code falls back to /login.')
    }
    return { active: account?.label ?? null }
  }

  // Every command reports through a notification: the palette shows nothing
  // for a command's return value.
  const run = (label, action) => async () => {
    try {
      const result = await action()
      await publisher.refresh()
      return { ok: true, ...result }
    } catch (error) {
      const message = error?.message ?? String(error)
      orca.log(`${label} failed: ${message}`)
      await notify(`Claude account: ${label} failed`, message)
      return { ok: false, error: message }
    }
  }

  // Catch up with changes made while the worker was not running, then follow the
  // store (the CLI and the manager page write to it too).
  void publisher.refresh()
  watcher?.close()
  watcher = watchFiles({
    targets: [
      { dir: store.configDir(), names: ['accounts.json'] },
      { dir: dirname(store.claudeSettingsPath()), names: ['settings.json'] }
    ],
    onChange: () => void publisher.refresh()
  })

  orca.commands.register(
    'manage',
    run('manage', async () => {
      const url = await ensureManagerServer(orca.log)
      const where = await openUrl(url, orca.log)
      if (where === 'browser') {
        await notify('Claude Accounts opened in your browser', 'Orca could not open a tab (is a worktree open?).')
      }
      return { openedIn: where }
    })
  )

  orca.commands.register('next', run('switch', async () => announceSwitch(await store.useNext())))

  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    orca.commands.register(
      `slot-${slot}`,
      run(`slot ${slot}`, async () => announceSwitch(await store.useAccount(String(slot))))
    )
  }

  orca.commands.register(
    'off',
    run('turn off', async () => {
      await store.useNone()
      return announceSwitch(null)
    })
  )

  orca.commands.register(
    'show',
    run('show', async () => {
      const snapshot = await store.status()
      if (!snapshot.accounts.length) {
        await notify('Claude accounts', 'None yet. Open the Claude Accounts panel to add one.')
        return {}
      }
      const lines = snapshot.accounts.map(store.accountRow)
      if (snapshot.drift) lines.push('⚠ settings.json token differs from the active account')
      await notify(`Claude account: ${snapshot.active?.label ?? 'default login'}`, lines.join('\n'))
      return {}
    })
  )

  // Warn once per worker start about tokens close to their one-year expiry.
  store
    .status()
    .then((snapshot) => {
      const expiring = snapshot.accounts.filter((account) => account.daysLeft <= store.EXPIRY_WARNING_DAYS)
      if (expiring.length) {
        return notify(
          'Claude tokens expiring',
          `${expiring.map(store.describeAccount).join(', ')}. Renew in the Claude Accounts panel → Update token.`
        )
      }
    })
    .catch((error) => orca.log(`expiry check failed: ${error?.message ?? error}`))
}

export function deactivate() {
  watcher?.close()
  watcher = null
}
```

- [ ] **Step 4: Run all tests**

Run: `orca plugin test .`
Expected: `# pass 22`, `# fail 0`, `6 test file(s) passed (node)`. (`orca plugin test .` also runs the `.mjs` tests.)

- [ ] **Commit**

```bash
git add main.mjs test/worker.test.ts
git commit -m "feat: serve the panel from the worker and push changes" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The panel

**Files:**
- Rewrite: `panel.html`
- Test: `test/panel.test.mjs`

`panel.html` becomes a hand-written static file. Rules it must keep, and the test enforces: one inline script, nothing loaded from outside (the browser client loads it as one sandboxed document), no `innerHTML`, and every handler it calls exists in the worker.

Behavior to know when changing it:
- Controls that enter or change tokens, rename or remove appear only when `orca.host.has('shell.openExternal')` is true (desktop). This hides controls; it is not access control.
- The DOM is rebuilt on every change; focus, selection and typed text are restored from `drafts`, so a push while typing does not lose input.
- No `confirm()`: Orca disables dialogs in plugin frames, so Remove shows an inline confirmation.

- [ ] **Step 1: Write the failing test**

Create `test/panel.test.mjs`:

```js
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test test/panel.test.mjs`
Expected: tests 4 and 5 FAIL (the current `panel.html` calls no `accounts.*` handler and does not listen for `accounts.changed`); tests 1–3 may pass.

- [ ] **Step 3: Replace `panel.html`**

Overwrite `panel.html` with:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Claude Accounts</title>
    <style>
      /* Everything is inline: Orca's browser client loads this file as one sandboxed
         document that cannot fetch other files. Colors come from Orca's frame variables. */
      :root {
        --bg: var(--orca-background, var(--background, Canvas));
        --fg: var(--orca-foreground, var(--foreground, CanvasText));
        --card: var(--orca-card, var(--card-bg, transparent));
        --muted: var(--orca-muted, rgba(128, 128, 128, 0.15));
        --muted-fg: var(--orca-muted-foreground, var(--muted-foreground, GrayText));
        --border: var(--orca-border, rgba(128, 128, 128, 0.35));
        --primary: var(--orca-primary, Highlight);
        --primary-fg: var(--orca-primary-foreground, HighlightText);
        --accent: var(--orca-accent, rgba(128, 128, 128, 0.12));
        --danger: var(--orca-destructive, #d33);
        --radius: var(--orca-radius, 8px);
      }
      * {
        box-sizing: border-box;
      }
      [hidden] {
        display: none !important;
      }
      html,
      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        line-height: 1.45;
        -webkit-font-smoothing: antialiased;
      }
      body {
        padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right))
          max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
        overflow-x: hidden;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted-fg);
      }
      .alert {
        margin-bottom: 10px;
        padding: 8px 10px;
        border-radius: calc(var(--radius) - 2px);
        border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
        color: var(--danger);
      }
      .current {
        margin-bottom: 10px;
        padding: 10px 11px;
        border: 1px solid var(--border);
        border-radius: var(--radius);
        background: var(--card);
      }
      .current .k {
        font-size: 11px;
        color: var(--muted-fg);
      }
      .current .v {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-top: 2px;
        font-size: 13px;
        font-weight: 600;
        word-break: break-word;
      }
      .dot {
        width: 7px;
        height: 7px;
        flex: none;
        border-radius: 50%;
        background: var(--muted-fg);
      }
      .dot.on {
        background: var(--primary);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 25%, transparent);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 10px;
      }
      .btn {
        min-height: 28px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: calc(var(--radius) - 2px);
        background: transparent;
        color: var(--fg);
        font: inherit;
        font-weight: 500;
        cursor: pointer;
      }
      .btn:hover:not(:disabled) {
        background: var(--accent);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .btn.primary {
        border-color: transparent;
        background: var(--primary);
        color: var(--primary-fg);
      }
      .btn.danger {
        border-color: color-mix(in srgb, var(--danger) 50%, transparent);
        color: var(--danger);
      }
      .btn.icon {
        min-width: 28px;
        padding: 0;
      }
      .list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
        gap: 8px 10px;
      }
      .row {
        position: relative;
        padding: 8px 9px;
        border: 1px solid transparent;
        border-radius: calc(var(--radius) - 2px);
      }
      .row.active {
        background: var(--accent);
        border-color: var(--border);
      }
      .row-main {
        display: flex;
        align-items: flex-start;
        gap: 9px;
      }
      .slot {
        width: 18px;
        height: 18px;
        flex: none;
        display: grid;
        place-items: center;
        margin-top: 1px;
        border-radius: 5px;
        border: 1px solid var(--border);
        color: var(--muted-fg);
        font: 600 10px ui-monospace, Menlo, monospace;
      }
      .row.active .slot {
        background: var(--primary);
        border-color: var(--primary);
        color: var(--primary-fg);
      }
      .info {
        min-width: 0;
        flex: 1;
      }
      .label {
        font-weight: 500;
        word-break: break-word;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 3px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        height: 17px;
        padding: 0 6px;
        border-radius: 999px;
        border: 1px solid var(--border);
        color: var(--muted-fg);
        font-size: 10.5px;
        font-weight: 500;
        white-space: nowrap;
      }
      .badge.inuse {
        border-color: transparent;
        background: var(--primary);
        color: var(--primary-fg);
      }
      .badge.warn,
      .badge.bad {
        color: var(--danger);
        border-color: color-mix(in srgb, var(--danger) 45%, transparent);
      }
      .badge.bad {
        background: color-mix(in srgb, var(--danger) 12%, transparent);
      }
      .usage {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 6px;
      }
      .mini-head {
        display: flex;
        justify-content: space-between;
        font-size: 10.5px;
        color: var(--muted-fg);
      }
      .mini-pct {
        font-weight: 600;
        color: var(--fg);
        font-variant-numeric: tabular-nums;
      }
      .mini-pct.high,
      .mini-pct.full {
        color: var(--danger);
      }
      .mini-track {
        height: 4px;
        margin-top: 2px;
        border-radius: 999px;
        background: var(--muted);
        overflow: hidden;
      }
      .mini-fill {
        height: 100%;
        background: var(--primary);
      }
      .mini-fill.high {
        background: color-mix(in srgb, var(--danger) 60%, var(--primary));
      }
      .mini-fill.full {
        background: var(--danger);
      }
      .form {
        display: grid;
        gap: 6px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--border);
      }
      .form .actions,
      .menu {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 8px;
      }
      .form .actions {
        margin-top: 0;
      }
      input {
        width: 100%;
        min-height: 28px;
        padding: 0 8px;
        border: 1px solid var(--border);
        border-radius: calc(var(--radius) - 2px);
        background: var(--bg);
        color: var(--fg);
        font: inherit;
      }
      .hint,
      .note,
      .empty {
        color: var(--muted-fg);
      }
      .empty {
        padding: 10px 2px;
      }
      .error {
        margin-top: 6px;
        color: var(--danger);
        word-break: break-word;
      }
      .add {
        margin-top: 12px;
        padding: 10px 11px;
        border: 1px dashed var(--border);
        border-radius: var(--radius);
      }
      .stamp {
        margin-top: 12px;
        font-size: 10.5px;
        color: var(--muted-fg);
      }
      @media (max-width: 250px) {
        .usage {
          grid-template-columns: 1fr;
          gap: 4px;
        }
      }
      /* Touch screens (Orca mobile, tablets): larger text and hit areas. */
      @media (hover: none) and (pointer: coarse) {
        html,
        body {
          font-size: 14px;
        }
        .btn,
        input {
          min-height: 40px;
        }
        .btn.icon {
          min-width: 40px;
        }
        .row {
          padding: 11px 10px;
        }
        .badge {
          height: 20px;
          font-size: 11.5px;
        }
        .mini-head {
          font-size: 12px;
        }
        .mini-track {
          height: 6px;
        }
      }
    </style>
  </head>
  <body>
    <h1>Claude Accounts</h1>
    <div id="app"></div>

    <script>
      ;(function () {
        'use strict'
        var api = window.orca
        var ready = !!(api && api.plugin && api.plugin.request)
        // Token entry and destructive edits are desktop only. Orca leaves orca.shell
        // out of browser clients and Orca mobile, so asking for it tells them apart.
        // This hides controls; it is not access control (the worker cannot see who asked).
        var canEdit = !!(ready && api.host && api.host.has && api.host.has('shell.openExternal'))

        var snapshot = null
        var pending = {} // key -> true while a request for that key is running
        var errors = {} // key -> last error message
        var drafts = {} // input id -> text typed so far
        var openForm = null // { id, kind } with kind menu | rename | token | remove
        var addOpen = false

        function h(tag, props, kids) {
          var node = document.createElement(tag)
          Object.keys(props || {}).forEach(function (key) {
            var value = props[key]
            if (key === 'class') node.className = value
            else if (key === 'text') node.textContent = value
            else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value)
            else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value)
          })
          ;(kids || []).forEach(function (kid) {
            if (kid) node.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid)
          })
          return node
        }

        function message(error) {
          return (error && error.message) || 'Something went wrong'
        }

        // Runs one request. Resolves true on success. The reply is the fresh snapshot.
        function call(name, input, key, timeoutMs) {
          pending[key] = true
          delete errors[key]
          render()
          return api.plugin
            .request(name, input || {}, { timeoutMs: timeoutMs || 30000 })
            .then(function (fresh) {
              snapshot = fresh
              return true
            })
            .catch(function (error) {
              errors[key] = message(error)
              return false
            })
            .then(function (ok) {
              delete pending[key]
              render()
              return ok
            })
        }

        function load() {
          return api.plugin
            .request('accounts.list', {}, { timeoutMs: 15000 })
            .then(function (fresh) {
              snapshot = fresh
              delete errors.load
            })
            .catch(function (error) {
              errors.load = message(error)
            })
            .then(render)
        }

        function input(id, props) {
          var node = h('input', Object.assign({ id: id, autocomplete: 'off', spellcheck: 'false' }, props))
          node.value = drafts[id] || ''
          node.addEventListener('input', function () {
            drafts[id] = node.value
          })
          return node
        }

        function badge(text, cls) {
          return h('span', { class: 'badge' + (cls ? ' ' + cls : ''), text: text })
        }

        function expiryBadge(account) {
          if (account.expiry === 'expired') return badge('expired ' + -account.daysLeft + 'd ago', 'bad')
          if (account.expiry === 'soon') return badge('expires in ' + account.daysLeft + 'd', 'warn')
          return badge(account.daysLeft + 'd left')
        }

        function mini(name, win) {
          var level = !win ? '' : win.percent >= 100 || win.status === 'rejected' ? ' full' : win.percent >= 80 ? ' high' : ''
          var fill = h('div', { class: 'mini-fill' + level })
          fill.style.width = (win ? Math.min(win.percent, 100) : 0) + '%'
          return h('div', {}, [
            h('div', { class: 'mini-head' }, [
              h('span', { text: name }),
              h('span', { class: 'mini-pct' + level, text: win ? win.percent + '%' : '—' })
            ]),
            h('div', { class: 'mini-track' }, [fill])
          ])
        }

        function usageView(usage) {
          var box = h('div', { class: 'usage' }, [mini('5h', usage.fiveHour), mini('7d', usage.sevenDay)])
          box.title = 'Usage read ' + new Date(usage.at).toLocaleString()
          return box
        }

        function closeForm() {
          openForm = null
          render()
        }

        function formFor(account) {
          var key = account.id
          var busy = !!pending[key]
          var kind = openForm.kind
          if (kind === 'menu') {
            return h('div', { class: 'menu' }, [
              h('button', { class: 'btn', text: 'Rename', onclick: function () { openForm = { id: key, kind: 'rename' }; render() } }),
              h('button', { class: 'btn', text: 'Update token', onclick: function () { openForm = { id: key, kind: 'token' }; render() } }),
              h('button', { class: 'btn danger', text: 'Remove', onclick: function () { openForm = { id: key, kind: 'remove' }; render() } })
            ])
          }
          if (kind === 'rename') {
            var labelId = 'rename-' + key
            if (drafts[labelId] === undefined) drafts[labelId] = account.label
            return h('div', { class: 'form' }, [
              input(labelId, { 'aria-label': 'New label', maxlength: '80' }),
              h('div', { class: 'actions' }, [
                h('button', {
                  class: 'btn primary', text: 'Save', disabled: busy,
                  onclick: function () {
                    call('accounts.rename', { id: key, label: drafts[labelId] }, key).then(function (ok) {
                      if (ok) { delete drafts[labelId]; openForm = null; render() }
                    })
                  }
                }),
                h('button', { class: 'btn', text: 'Cancel', onclick: function () { delete drafts[labelId]; closeForm() } })
              ])
            ])
          }
          if (kind === 'token') {
            var tokenId = 'token-' + key
            return h('div', { class: 'form' }, [
              input(tokenId, { type: 'password', placeholder: 'sk-ant-oat01-…', 'aria-label': 'New token' }),
              h('div', { class: 'hint', text: 'Run `claude setup-token`, then paste the result. It stays on this computer.' }),
              h('div', { class: 'actions' }, [
                h('button', {
                  class: 'btn primary', text: busy ? 'Checking…' : 'Save token', disabled: busy,
                  onclick: function () {
                    call('accounts.updateToken', { id: key, token: drafts[tokenId] }, key, 60000).then(function (ok) {
                      if (ok) { delete drafts[tokenId]; openForm = null; render() }
                    })
                  }
                }),
                h('button', { class: 'btn', text: 'Cancel', onclick: function () { delete drafts[tokenId]; closeForm() } })
              ])
            ])
          }
          // remove
          return h('div', { class: 'form' }, [
            h('div', { text: 'Remove “' + account.label + '”? Its token is deleted from this computer.' }),
            h('div', { class: 'actions' }, [
              h('button', {
                class: 'btn danger', text: 'Remove', disabled: busy,
                onclick: function () {
                  call('accounts.remove', { id: key }, key).then(function (ok) { if (ok) { openForm = null; render() } })
                }
              }),
              h('button', { class: 'btn', text: 'Cancel', onclick: closeForm })
            ])
          ])
        }

        function rowView(account) {
          var key = account.id
          var busy = !!pending[key]
          var meta = []
          meta.push(expiryBadge(account))
          if (account.checkState === 'invalid') meta.push(badge('token rejected', 'bad'))

          var side = [
            h('button', {
              class: 'btn' + (account.active ? '' : ' primary'),
              text: account.active ? 'In use' : 'Use',
              disabled: account.active || busy,
              onclick: function () { call('accounts.use', { id: key }, key) }
            })
          ]
          if (canEdit) {
            side.push(
              h('button', {
                class: 'btn icon', text: '⋯', 'aria-label': 'More for ' + account.label,
                onclick: function () {
                  openForm = openForm && openForm.id === key ? null : { id: key, kind: 'menu' }
                  render()
                }
              })
            )
          }

          var info = h('div', { class: 'info' }, [
            h('div', { class: 'label', text: account.label }),
            h('div', { class: 'meta' }, meta)
          ])
          if (account.usage) info.appendChild(usageView(account.usage))

          var row = h('div', { class: 'row' + (account.active ? ' active' : '') }, [
            h('div', { class: 'row-main' }, [
              h('div', { class: 'slot', text: String(account.slot) }),
              info,
              h('div', { class: 'meta' }, side)
            ])
          ])
          if (errors[key]) row.appendChild(h('div', { class: 'error', text: errors[key] }))
          if (canEdit && openForm && openForm.id === key) row.appendChild(formFor(account))
          return row
        }

        function addView() {
          var busy = !!pending.add
          if (!addOpen) {
            return h('div', { class: 'toolbar' }, [
              h('button', { class: 'btn', text: 'Add account', onclick: function () { addOpen = true; render() } })
            ])
          }
          return h('div', { class: 'add' }, [
            h('div', { class: 'form', style: 'border-top:0;margin-top:0;padding-top:0' }, [
              input('add-label', { placeholder: 'Label, e.g. Work – me@company.com', 'aria-label': 'Label', maxlength: '80' }),
              input('add-token', { type: 'password', placeholder: 'sk-ant-oat01-…', 'aria-label': 'Token' }),
              h('div', { class: 'hint', text: 'Run `claude setup-token`, then paste the result. It stays on this computer.' }),
              errors.add ? h('div', { class: 'error', text: errors.add }) : null,
              h('div', { class: 'actions' }, [
                h('button', {
                  class: 'btn primary', text: busy ? 'Checking…' : 'Add', disabled: busy,
                  onclick: function () {
                    call('accounts.add', { label: drafts['add-label'], token: drafts['add-token'] }, 'add', 60000).then(function (ok) {
                      if (ok) { delete drafts['add-label']; delete drafts['add-token']; addOpen = false; render() }
                    })
                  }
                }),
                h('button', {
                  class: 'btn', text: 'Cancel',
                  onclick: function () { delete drafts['add-label']; delete drafts['add-token']; delete errors.add; addOpen = false; render() }
                })
              ])
            ])
          ])
        }

        function render() {
          var app = document.getElementById('app')
          var focused = document.activeElement
          var restore = focused && focused.id ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null
          app.textContent = ''

          if (!ready) {
            app.appendChild(h('div', { class: 'empty', text: 'Open this panel inside Orca.' }))
            return
          }
          if (!snapshot) {
            if (errors.load) {
              app.appendChild(h('div', { class: 'alert', text: 'Cannot reach the plugin: ' + errors.load }))
              app.appendChild(h('button', { class: 'btn', text: 'Retry', onclick: load }))
            } else {
              app.appendChild(h('div', { class: 'empty', text: 'Loading…' }))
            }
            return
          }

          var active = snapshot.accounts.filter(function (a) { return a.active })[0]
          if (snapshot.drift) {
            app.appendChild(h('div', { class: 'alert', text: '~/.claude/settings.json holds a different token than the account in use.' }))
          }
          app.appendChild(
            h('div', { class: 'current' }, [
              h('div', { class: 'k', text: 'In use' }),
              h('div', { class: 'v' }, [
                h('span', { class: 'dot' + (active ? ' on' : '') }),
                h('span', { text: active ? active.label : 'Default login (no token)' })
              ])
            ])
          )

          var busy = !!pending.toolbar
          var none = !snapshot.accounts.length
          app.appendChild(
            h('div', { class: 'toolbar' }, [
              h('button', {
                class: 'btn', text: 'Default login', disabled: busy || !active,
                onclick: function () { call('accounts.useNone', {}, 'toolbar') }
              }),
              h('button', {
                class: 'btn', text: busy ? 'Working…' : 'Refresh usage', disabled: busy || none,
                onclick: function () { call('accounts.usage', {}, 'toolbar', 60000) }
              }),
              h('button', {
                class: 'btn', text: 'Check tokens', disabled: busy || none,
                onclick: function () { call('accounts.check', {}, 'toolbar', 60000) }
              })
            ])
          )
          if (errors.toolbar) app.appendChild(h('div', { class: 'error', text: errors.toolbar }))

          if (none) {
            app.appendChild(
              h('div', { class: 'empty', text: canEdit ? 'No accounts yet.' : 'No accounts yet. Add one on your computer.' })
            )
          } else {
            app.appendChild(h('div', { class: 'list' }, snapshot.accounts.map(rowView)))
          }
          if (canEdit) app.appendChild(addView())
          else if (!none) app.appendChild(h('div', { class: 'note stamp', text: 'Adding or editing tokens is done on your computer.' }))

          app.appendChild(h('div', { class: 'stamp', text: 'Updated ' + new Date(snapshot.generatedAt).toLocaleTimeString() }))

          if (restore) {
            var again = document.getElementById(restore.id)
            if (again) {
              again.focus()
              try { again.setSelectionRange(restore.start, restore.end) } catch (_) {}
            }
          }
        }

        render()
        if (ready) {
          api.plugin.on('accounts.changed', function (fresh) {
            snapshot = fresh
            delete errors.load
            render()
          })
          document.addEventListener('visibilitychange', function () {
            if (!document.hidden) load()
          })
          load()
        }
      })()
    </script>
  </body>
</html>
```

- [ ] **Step 4: Run the test**

Run: `node --test test/panel.test.mjs`
Expected: `# pass 5`, `# fail 0`.

- [ ] **Commit**

```bash
git add panel.html test/panel.test.mjs
git commit -m "feat: panel that asks the worker for data and actions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Remove the old panel rewrite

**Files:**
- Delete: `lib/panel.mjs`, `ui/panel.template.html`
- Modify: `bin/claude-accounts.mjs`, `bin/manager-server.mjs`, `lib/server-process.mjs`, `lib/server.mjs`, `.gitignore`

- [ ] **Step 1: Delete the generator and its template**

```bash
git rm lib/panel.mjs ui/panel.template.html
```

- [ ] **Step 2: `bin/claude-accounts.mjs` — remove the import**

Delete this line near the top:

```js
import { syncPanel } from '../lib/panel.mjs'
```

- [ ] **Step 3: `bin/claude-accounts.mjs` — remove the post-command sync**

Replace

```js
const READ_ONLY = new Set([undefined, 'list', 'ls', 'ui', 'help', '-h', '--help'])

main(process.argv.slice(2))
  // Mutations refresh the Orca sidebar panel too.
  .then(() => (READ_ONLY.has(process.argv[2]) ? null : syncPanel((message) => console.error(message))))
  .catch((error) => {
    console.error(`claude-accounts: ${error.message}`)
    process.exit(1)
  })
```

with

```js
main(process.argv.slice(2)).catch((error) => {
  console.error(`claude-accounts: ${error.message}`)
  process.exit(1)
})
```

(The worker's file watcher now notices CLI changes by itself.)

- [ ] **Step 4: `bin/manager-server.mjs` — remove the three uses**

Delete the import line `import { syncPanel } from '../lib/panel.mjs'`.
Delete the option line `  onChange: () => syncPanel(log),`.
Delete the last two lines:

```js
// The sidebar panel shows this address for Orca mobile.
await syncPanel(log)
```

- [ ] **Step 5: Fix two comments that describe the old mechanism**

In `lib/server-process.mjs`, replace

```js
// workers when idle (5 min) and whenever a developer plugin's files change —
// including the panel.html rewrite after each edit — so a server living inside
// the worker would drop the open page mid-use ("Failed to fetch").
```

with

```js
// workers when idle (5 min) and whenever a developer plugin's files change, so a
// server living inside the worker would drop the open page mid-use ("Failed to fetch").
```

In `lib/server.mjs`, replace

```js
// Local web UI for the account manager, opened as a tab in Orca's built-in
// browser. Orca plugin panels cannot exchange data with the worker (panel CSP
// is connect-src 'none'), so the worker serves the page itself.
```

with

```js
// Local web UI for the account manager, opened as a tab in Orca's built-in
// browser. It serves the full management page from its own process; the sidebar
// panel talks to the worker through Orca instead (see main.mjs).
```

- [ ] **Step 6: `.gitignore` — drop the temp pattern, add the brainstorm folder**

Replace the line `.panel.*.tmp` with `.superpowers/`.

- [ ] **Step 7: Verify nothing still refers to the removed code**

Run: `grep -rn "syncPanel\|lib/panel.mjs\|panel.template\|isMutablePluginRoot" --include='*.mjs' --include='*.ts' --include='*.json' --include='*.html' . | grep -v node_modules`
Expected: no output.

Run: `node --check bin/claude-accounts.mjs && node --check bin/manager-server.mjs && echo syntax-ok`
Expected: `syntax-ok`.

Run: `orca plugin test .`
Expected: all tests pass.

- [ ] **Commit**

```bash
git add -A
git commit -m "refactor: drop the panel.html rewrite mechanism" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Manifest format 2 and the status bar item

**Files:**
- Rewrite: `orca-plugin.json`

What changes: `manifestVersion` 2 with `execution: "trusted-worker"`; `engines.orca` `>=1.4.248` (status bar items and hooks need it); each command's `context` becomes `when` (format 2 rejects `context` — verified: `contributes.commands[0]: unknown key "context"`); `contributes.statusBarItems`; `$schema`; version 0.13.0. `publisher` stays `baroned` so the install key does not change; whether to drop it is the owner's decision (it differs from the repository owner `baroned1707`).

- [ ] **Step 1: Replace `orca-plugin.json`**

```json
{
  "$schema": "https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json",
  "manifestVersion": 2,
  "execution": "trusted-worker",
  "id": "claude-accounts",
  "publisher": "baroned",
  "name": "Claude Accounts",
  "version": "0.13.0",
  "description": "Add, label, update, remove and switch Claude Code accounts (one-year `claude setup-token` tokens kept in your system secret store), with token checks and per-account usage. The sidebar panel works on desktop, Orca mobile and the browser client.",
  "author": {
    "name": "Nguyễn Duy Khương",
    "url": "https://github.com/baroned1707"
  },
  "repository": "https://github.com/baroned1707/orca-claude-accounts",
  "engines": {
    "orca": ">=1.4.248"
  },
  "pluginApi": 1,
  "main": "main.mjs",
  "contributes": {
    "panels": [
      {
        "id": "accounts",
        "title": "Claude Accounts",
        "icon": "bot",
        "entry": "panel.html"
      }
    ],
    "statusBarItems": [
      {
        "id": "account",
        "text": "Claude",
        "icon": "bot",
        "tooltip": "Claude account in use",
        "command": "show"
      }
    ],
    "commands": [
      { "id": "manage", "title": "Claude Account: Manage Accounts…", "when": "global" },
      { "id": "next", "title": "Claude Account: Switch to Next", "when": "global" },
      { "id": "show", "title": "Claude Account: Show Accounts", "when": "global" },
      { "id": "slot-1", "title": "Claude Account: Use Slot 1", "when": "global" },
      { "id": "slot-2", "title": "Claude Account: Use Slot 2", "when": "global" },
      { "id": "slot-3", "title": "Claude Account: Use Slot 3", "when": "global" },
      { "id": "slot-4", "title": "Claude Account: Use Slot 4", "when": "global" },
      { "id": "slot-5", "title": "Claude Account: Use Slot 5", "when": "global" },
      { "id": "off", "title": "Claude Account: Use Default Login (no token)", "when": "global" }
    ],
    "keybindings": [
      { "command": "manage", "key": "Mod+Shift+M", "when": "global" },
      { "command": "next", "key": "Mod+Alt+N", "when": "global" }
    ]
  },
  "capabilities": [{ "kind": "notifications:show" }]
}
```

- [ ] **Step 2: Validate**

Run: `orca plugin validate .`
Expected: first line ends with `orca-plugin.json: ok`, the summary lists `adds statusBarItems: Claude`, and no error lines.

- [ ] **Commit**

```bash
git add orca-plugin.json
git commit -m "feat: manifest format 2 with a status bar item" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs and version

**Files:**
- Modify: `README.md`, `package.json`

- [ ] **Step 1: `package.json`**

Set `"version": "0.13.0"` and add a test script, so the file reads:

```json
{
  "name": "orca-claude-accounts",
  "version": "0.13.0",
  "private": true,
  "description": "Orca plugin + CLI to switch Claude Code between setup-token accounts",
  "type": "module",
  "scripts": {
    "test": "orca plugin test ."
  },
  "bin": {
    "claude-accounts": "bin/claude-accounts.mjs"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/baroned1707/orca-claude-accounts.git"
  }
}
```

- [ ] **Step 2: README — requirements**

Replace `**1.4 or newer**` with `**1.4.248 or newer**`.

- [ ] **Step 3: README — Option B no longer special**

Replace the heading `### Option B — developer path (live sidebar panel, easy updates)` with `### Option B — developer path (easy updates)`.
Delete the line `Option B is needed for a sidebar panel that updates live (see [step 7](#7-the-sidebar-panel)).`

- [ ] **Step 4: README — section 7**

Replace the paragraph that starts `It shows the account in use, every account with its token age and last usage, and` through `a note pointing to the Manage page instead of shortcuts.` with:

```md
It shows the account in use, every account with its token age, expiry and last usage,
and switches the account with one press. On the desktop app the **⋯** menu next to an
account renames it, updates its token or removes it, and **Add account** adds one. The
panel follows changes made from the command palette, the CLI or the Manage page.

A status bar item shows the account in use and turns yellow when its token is close to
expiry; pressing it lists your accounts.

**On Orca mobile and tablets** the panel adapts: larger text and touch-sized rows,
two columns on wide screens and safe-area padding.
```

- [ ] **Step 5: README — section 7b**

Replace the whole section from `## 7b. Use it from your phone (Orca mobile)` up to (not including) `## 8. Command line (optional)` with:

```md
## 7b. Use it from your phone or another computer

The sidebar panel works wherever Orca shows plugin panels: Orca mobile, the browser
client (`orca serve`) and a desktop paired to an Orca server. It lists accounts,
switches the account in use, refreshes usage and checks tokens. Adding an account,
changing a token, renaming and removing are done in the desktop app, so a token is not
typed on a remote client.

The full Manage page (`⌘⇧M`) still exists and, if you open its browser tab on your
phone, still accepts tokens there. The panel replaces it in the next release.

<img src="docs/images/sidebar-panel-mobile.png" alt="Sidebar panel on a phone" width="300">
```

- [ ] **Step 6: README — security notes**

Replace

```md
- **Manage page** — plugin panels can't exchange data with the plugin, so the page
  is served by a small local server running as its own process: bound to
```

with

```md
- **Sidebar panel** — asks the plugin worker through Orca (`plugin.request`); replies
  hold labels, dates, expiry and usage only, never tokens, emails or organization ids.
  A token typed in the desktop panel travels to the worker through Orca's plugin bridge
  and is not returned.
- **Manage page** — a small local server running as its own process: bound to
```

- [ ] **Step 7: Check the docs still point at real things**

Run: `grep -n "read-only\|panel.html\|Use it from Orca mobile\|rewriting" README.md`
Expected: no output.

- [ ] **Commit**

```bash
git add README.md package.json
git commit -m "docs: describe the live panel; bump to 0.13.0" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Verify in Orca, on a phone and in the browser client

The unit tests cannot show how Orca renders the panel or whether remote clients can call the worker. This task decides whether sub-project 2 may start. Record each result in the spec's "Not verified" section.

- [ ] **Step 1: Load the plugin in Orca**

```bash
orca plugin dev reload .
```

If it prints an `--approve <fingerprint>` command (new status bar item, changed panel), run exactly that command. Then confirm: `orca plugin dev list` shows `baroned.claude-accounts` enabled, and `orca plugin logs baroned.claude-accounts` has no error lines.

- [ ] **Step 2: Desktop — screenshots**

```bash
orca plugin shot baroned.claude-accounts --width 340 --out docs/images/sidebar-panel.png
orca plugin shot baroned.claude-accounts --width 340 --theme dark --out .orca/shots/panel-dark.png
```

Expected: the panel in Orca's theme (colors come from `--orca-*`), account list, toolbar, Add account. Look at both images. If colors are wrong, check that Orca exposes `--orca-background` in this build before changing CSS.

- [ ] **Step 3: Desktop — behavior**

In the desktop panel: press **Use** on another account and confirm the status bar item changes and `~/.claude/settings.json` has the new token (`grep -c CLAUDE_CODE_OAUTH_TOKEN ~/.claude/settings.json` prints `1`). Run `claude-accounts use 1` in a terminal and confirm the panel follows within a few seconds without reopening. Rename an account, then remove a throwaway one through the inline confirmation.

- [ ] **Step 4: Token never logged**

Add a throwaway account through the panel, then run `orca plugin logs baroned.claude-accounts` and search the output for the token's first 12 characters.
Expected: no match. If it appears, stop: Orca logs `plugin.request` inputs, and the Add and Update token forms must move to the CLI until that is solved. Record the result in the spec.

- [ ] **Step 5: Orca mobile**

On the phone, open the worktree and the **Claude Accounts** panel.
Expected: accounts list, **Use** switches the account, **no** Add account, ⋯ or token fields. Record whether Orca mobile renders the panel at all, and whether it updates when you switch from the desktop (this tests `orca.panels.post`).

- [ ] **Step 6: Browser client**

Start Orca's browser client (`orca serve --help` shows how), open it in a browser, open the panel.
Expected: same as the phone. Record the result.

- [ ] **Step 7: Paired desktop**

If a second desktop paired to this Orca server is available, open the panel there. Record whether it appears and works; if you have none, record "not tested".

- [ ] **Step 8: Decide**

If steps 5 and 6 both work, sub-project 2 (remove the Manage page) can be planned. If either fails, write down the failing call and error code in the spec, and keep the Manage page.

- [ ] **Step 9: Commit the screenshot and the recorded results**

```bash
git add docs/images/sidebar-panel.png docs/superpowers/specs/2026-11-05-live-panel-remote-design.md
git commit -m "docs: panel screenshot and remote verification results" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Not in this plan

- Removing the Manage page, `server.mjs`, `manager-server.mjs`, `manager.html` (sub-project 2).
- Applying the account to Claude on SSH/WSL workspaces (sub-project 3).
- A cross-process lock for `accounts.json`. The worker serializes its own writes; the CLI and the Manage page still write independently (recorded in the spec as a risk).
- Dropping `publisher` from the manifest.
