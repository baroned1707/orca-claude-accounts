// Runs jobs one at a time, in the order they were queued. A job that fails rejects
// its own caller but never blocks the jobs behind it.
export function createWriteQueue() {
  let queue = Promise.resolve()
  return function serial(work) {
    const run = queue.then(work)
    queue = run.catch(() => {})
    return run
  }
}
