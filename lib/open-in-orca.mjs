// Opens a URL as a tab in Orca's built-in browser via the public `orca` CLI,
// falling back to the default browser when Orca can't take it (no worktree
// open, runtime unreachable, CLI missing).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openExternal, orcaCliCandidates } from './platform.mjs'

const execFileAsync = promisify(execFile)

/** Returns where the URL was opened: 'orca' or 'browser'. */
export async function openUrl(url, log = () => {}) {
  for (const cli of orcaCliCandidates()) {
    try {
      // orca.cmd on Windows is a batch file, which needs a shell. With a shell
      // Node joins file and args unquoted, so quote the path (it may contain
      // spaces: C:\Users\John Smith\…); the URL has no shell metacharacters
      // (127.0.0.1:port/base64url-secret/).
      const batch = cli.endsWith('.cmd')
      await execFileAsync(batch ? `"${cli}"` : cli, ['tab', 'create', '--url', url, '--json'], {
        timeout: 15_000,
        windowsHide: true,
        shell: batch
      })
      return 'orca'
    } catch (error) {
      log(`orca tab create via ${cli} failed: ${error?.stderr?.trim() || error?.message}`)
    }
  }
  await openExternal(url)
  return 'browser'
}
