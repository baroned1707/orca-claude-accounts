// Tells the caller when the token written in settings.json changed, so the Keychain
// is read only for a real change and not for every write to that file.
// The token is compared in memory only: it is never logged or put in an error.

// A symbol, so no token value can ever equal it.
const UNREADABLE = Symbol('unreadable')

/**
 * `read` resolves to the token (a string) or null; it may throw when the file cannot be read.
 * `check()` compares with the previous look and calls `onChange` once when it differs.
 * The first `check()` only records a baseline. An unreadable file is its own state, so a
 * file that keeps failing does not call `onChange` again.
 */
export function createTokenChangeGate({ read, onChange }) {
  let known = false
  let previous = null

  return {
    async check() {
      let current
      try {
        current = (await read()) ?? null
      } catch {
        current = UNREADABLE
      }
      const changed = known && current !== previous
      known = true
      previous = current
      if (!changed) return
      try {
        await onChange()
      } catch {
        // Callers use `void check()`: a failed refresh must not become an unhandled rejection.
      }
    }
  }
}
