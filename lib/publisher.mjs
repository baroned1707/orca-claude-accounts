// Reads the snapshot and publishes it only when something other than its
// timestamp and sequence number changed, so file-watch noise never reaches the
// panel or status bar.
//
// Reads never overlap: a request that arrives while one is running waits and is
// answered by exactly one more read after it (any number of requests share it).
// So an older, slower read cannot publish after a newer one.
export function createChangePublisher({ read, publish, log = () => {} }) {
  let lastKey = null
  let running = false
  let waiting = null // { promise, resolve } for the one follow-up read

  async function once() {
    try {
      const snapshot = await read()
      const key = JSON.stringify({ ...snapshot, generatedAt: null, seq: null })
      if (key === lastKey) return false
      lastKey = key
      await publish(snapshot)
      return true
    } catch (error) {
      log(`refresh failed: ${error?.message ?? error}`)
      return false
    }
  }

  // `once` never rejects, so this loop always reaches `running = false`.
  async function drain() {
    while (waiting) {
      const batch = waiting
      waiting = null
      batch.resolve(await once())
    }
    running = false
  }

  return {
    refresh() {
      if (running) {
        if (!waiting) {
          waiting = {}
          waiting.promise = new Promise((resolve) => (waiting.resolve = resolve))
        }
        return waiting.promise
      }
      running = true
      const first = once()
      void first.then(drain)
      return first
    }
  }
}
