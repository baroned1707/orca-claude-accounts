// Everything that differs between macOS, Windows and Linux: where Orca keeps
// its data and resources, how to open a URL and how to show a notification.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const PLATFORM = process.platform
export const HOME = process.env.HOME || process.env.USERPROFILE || homedir()

/** Orca's Electron userData folder (settings, profiles, installed plugins). */
export function orcaDataDir() {
  if (PLATFORM === 'darwin') return join(HOME, 'Library', 'Application Support', 'orca')
  if (PLATFORM === 'win32') return join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'orca')
  return join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'orca')
}

/** Folders holding Orca's app.asar, most specific first. */
export function orcaResourceDirs() {
  const dirs = []
  // Inside Orca the plugin worker runs on Orca's own Electron binary.
  const macApp = process.execPath.match(/^(.*\.app\/Contents)\//)?.[1]
  if (macApp) dirs.push(join(macApp, 'Resources'))
  else if (process.versions.electron) dirs.push(join(dirname(process.execPath), 'resources'))
  if (PLATFORM === 'darwin') {
    dirs.push('/Applications/Orca.app/Contents/Resources', join(HOME, 'Applications/Orca.app/Contents/Resources'))
  } else if (PLATFORM === 'win32') {
    const local = process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local')
    dirs.push(join(local, 'Programs', 'Orca', 'resources'), join(local, 'Programs', 'orca', 'resources'))
  } else {
    dirs.push('/opt/Orca/resources', '/opt/orca/resources', '/usr/lib/orca/resources', '/usr/share/orca/resources')
  }
  return [...new Set(dirs)]
}

/** The public `orca` CLI, bundled in Orca's resources, then PATH. */
export function orcaCliCandidates() {
  const name = PLATFORM === 'win32' ? 'orca.cmd' : 'orca'
  return [...orcaResourceDirs().map((dir) => join(dir, 'bin', name)).filter((path) => existsSync(path)), name]
}

const run = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()))
  )

/** Opens a URL in the default browser. */
export function openExternal(url) {
  if (PLATFORM === 'darwin') return run('/usr/bin/open', [url])
  // rundll32 avoids cmd.exe, whose `start` would re-parse the URL's & characters.
  if (PLATFORM === 'win32') return run('rundll32', ['url.dll,FileProtocolHandler', url])
  return run('xdg-open', [url])
}

/** Best-effort desktop notification; strings are passed as arguments, never as script. */
export function notifyDesktop(title, body) {
  const ignore = () => {}
  if (PLATFORM === 'darwin') {
    run('/usr/bin/osascript', [
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e',
      'end run',
      title,
      body
    ]).catch(ignore)
  } else if (PLATFORM === 'linux') {
    run('notify-send', ['--app-name=Claude Accounts', title, body]).catch(ignore)
  }
  // Windows: no dependency-free toast; the manager page shows its own message.
}
