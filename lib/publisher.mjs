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
