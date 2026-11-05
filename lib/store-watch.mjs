// Calls `onChange` (debounced) when one of the named files changes. Two ways in:
//  - fs.watch on each folder, for an immediate reaction. The store writes by
//    renaming a temp file over the target, which fs.watch reports under the
//    target's name.
//  - a slow timer that covers what fs.watch misses (network drives, a folder that
//    did not exist at start, a symlinked file edited through its real folder). The
//    timer only looks at the files (stat) and reports a change when one differs
//    from the previous look; it never makes `onChange` run for nothing, because
//    `onChange` may read the Keychain.
import { watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

async function signatureOf(path) {
  try {
    // stat follows symlinks, so a link is judged by the file it points to.
    const info = await stat(path)
    return `${info.mtimeMs}:${info.size}:${info.ino}`
  } catch {
    return 'missing'
  }
}

export function watchFiles({ targets, onChange, debounceMs = 200, intervalMs = 60_000 }) {
  let closed = false
  let timer = null
  const trigger = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      // Take the new look first, so the next tick does not report this change again.
      void look(false).then(() => {
        if (!closed) onChange()
      })
    }, debounceMs)
  }

  const watchers = new Map() // dir -> FSWatcher
  const attach = () => {
    for (const { dir, names } of targets) {
      if (watchers.has(dir)) continue
      try {
        const watcher = watch(dir, (_event, filename) => {
          if (!filename || names.includes(String(filename))) trigger()
        })
        // A folder that was deleted or unmounted: drop the watcher so the next tick can attach a new one.
        watcher.on('error', () => {
          watcher.close()
          if (watchers.get(dir) === watcher) watchers.delete(dir)
        })
        watchers.set(dir, watcher)
      } catch {
        // The folder is missing: the next tick tries again.
      }
    }
  }

  const files = targets.flatMap(({ dir, names }) => names.map((name) => join(dir, name)))
  const signatures = new Map()
  let looking = Promise.resolve()
  // Looks at every file; resolves to whether any differs from the previous look.
  // The first look only sets the baseline. Looks run one after another.
  const look = (report) => {
    const run = looking.then(async () => {
      let changed = false
      const current = await Promise.all(files.map(signatureOf))
      files.forEach((file, index) => {
        if (signatures.has(file) && signatures.get(file) !== current[index]) changed = true
        signatures.set(file, current[index])
      })
      return changed && report
    })
    looking = run.catch(() => {})
    return run
  }

  attach()
  void look(false)

  const interval = setInterval(() => {
    attach()
    void look(true).then((changed) => {
      if (changed && !closed) trigger()
    })
  }, intervalMs)
  interval.unref?.()

  return {
    close() {
      closed = true
      clearTimeout(timer)
      clearInterval(interval)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    }
  }
}
