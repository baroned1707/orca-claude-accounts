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
