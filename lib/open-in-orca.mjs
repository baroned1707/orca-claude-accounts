// Opens a URL as a tab in Orca's built-in browser via the public `orca` CLI,
// falling back to the default browser when Orca can't take it (no worktree
// open, runtime unreachable, CLI missing).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function orcaCliCandidates() {
  const candidates = []
  // The plugin worker runs on Orca's own Electron binary: .../Orca.app/Contents/MacOS/Orca.
  const appContents = process.execPath.match(/^(.*\.app\/Contents)\//)?.[1]
  if (appContents) candidates.push(join(appContents, 'Resources', 'bin', 'orca'))
  candidates.push('/Applications/Orca.app/Contents/Resources/bin/orca')
  return [...new Set(candidates)].filter((path) => existsSync(path)).concat('orca')
}

/** Returns where the URL was opened: 'orca' or 'browser'. */
export async function openUrl(url, log = () => {}) {
  for (const cli of orcaCliCandidates()) {
    try {
      await execFileAsync(cli, ['tab', 'create', '--url', url, '--json'], { timeout: 15_000 })
      return 'orca'
    } catch (error) {
      log(`orca tab create via ${cli} failed: ${error?.stderr?.trim() || error?.message}`)
    }
  }
  await execFileAsync('/usr/bin/open', [url])
  return 'browser'
}
