// Opens a URL as a tab in Orca's built-in browser via the public `orca` CLI,
// falling back to the default browser when Orca can't take it (no worktree
// open, runtime unreachable, CLI missing).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openExternal, orcaCliCandidates } from './platform.mjs'

const execFileAsync = promisify(execFile)

function runOrca(cli, args) {
  // orca.cmd on Windows is a batch file, which needs a shell. With a shell
  // Node joins file and args unquoted, so quote the path (it may contain
  // spaces: C:\Users\John Smith\…); our arguments have no shell metacharacters
  // (127.0.0.1:port/base64url-secret/, ids, flags).
  const batch = cli.endsWith('.cmd')
  return execFileAsync(batch ? `"${cli}"` : cli, [...args, '--json'], {
    timeout: 15_000,
    windowsHide: true,
    shell: batch
  })
}

/** Page id of a tab in the active worktree already showing `url`, if any. */
async function findOpenTab(cli, url) {
  try {
    const { stdout } = await runOrca(cli, ['tab', 'list', '--worktree', 'active'])
    const tabs = JSON.parse(stdout)?.result?.tabs ?? []
    return tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(url))?.browserPageId ?? null
  } catch {
    return null
  }
}

/**
 * Shows `url` in Orca: switches to a tab that already has it (one tab per
 * worktree, which is also the tab Orca mobile shows), otherwise opens one.
 * Returns where it ended up: 'orca' or 'browser'.
 */
export async function openUrl(url, log = () => {}) {
  for (const cli of orcaCliCandidates()) {
    try {
      const pageId = await findOpenTab(cli, url)
      if (pageId) {
        await runOrca(cli, ['tab', 'switch', '--page', pageId, '--worktree', 'active', '--focus'])
      } else {
        await runOrca(cli, ['tab', 'create', '--url', url])
      }
      return 'orca'
    } catch (error) {
      log(`orca tab via ${cli} failed: ${error?.stderr?.trim() || error?.message}`)
    }
  }
  await openExternal(url)
  return 'browser'
}
