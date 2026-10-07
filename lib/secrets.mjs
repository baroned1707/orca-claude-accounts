// Token storage, per platform. Every backend receives the token on stdin (or
// writes it itself), so a token never shows up in another process's argv.
//
//   macos-keychain   macOS login Keychain (`security`)
//   windows-dpapi    file encrypted with DPAPI for the current Windows user
//   secret-service   Linux Secret Service: GNOME Keyring, KWallet… (`secret-tool`)
//   file             plain file, mode 600 — Linux without a keyring only
//
// Each account records the backend that holds its token, so reads always go to
// the right place even if the default changes.
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PLATFORM } from './platform.mjs'

export const SERVICE = 'orca-claude-accounts'

export const BACKEND_LABELS = {
  'macos-keychain': 'macOS Keychain',
  'windows-dpapi': 'Windows (DPAPI-encrypted file)',
  'secret-service': 'system keyring (Secret Service)',
  file: 'plain file (no keyring available)'
}

/** Runs a command, feeding `input` on stdin; resolves stdout, rejects on failure. */
function exec(file, args, { input = '', env, failOnStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: env ?? process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 && !(failOnStderr && stderr.trim())
        ? resolve(stdout)
        : reject(new Error(stderr.trim() || `${file} exited with code ${code}`))
    )
    child.stdin.end(input)
  })
}

// ---------- macOS Keychain ----------

const quote = (value) => `"${value.replace(/(["\\])/g, '\\$1')}"`

const keychain = {
  async set(id, label, token) {
    // `security -i` reads the command from stdin, keeping the token out of argv.
    const command = `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(id)} -l ${quote(`Claude Code (${label})`)} -w ${quote(token)}\n`
    // `security -i` exits 0 even when the write fails; failures only reach stderr.
    await exec('security', ['-i'], { input: command, failOnStderr: true })
  },
  async get(id) {
    return (await exec('security', ['find-generic-password', '-s', SERVICE, '-a', id, '-w'])).trim()
  },
  async delete(id) {
    await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', id]).catch(() => {})
  }
}

// ---------- Windows DPAPI ----------

// ConvertFrom-SecureString without -Key encrypts with DPAPI for the current
// user: only this Windows account on this machine can decrypt the file. The
// script is fixed text; the token comes on stdin and the path in an env var.
const PS_SET = `$ErrorActionPreference='Stop'
$t=[Console]::In.ReadToEnd()
$s=ConvertTo-SecureString -String $t -AsPlainText -Force
[IO.File]::WriteAllText($env:CA_TOKEN_FILE,(ConvertFrom-SecureString -SecureString $s))`
const PS_GET = `$ErrorActionPreference='Stop'
$s=ConvertTo-SecureString -String ([IO.File]::ReadAllText($env:CA_TOKEN_FILE))
$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}`

const powershell = (script, file, input) =>
  exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    input,
    env: { ...process.env, CA_TOKEN_FILE: file }
  })

function dpapi(dir) {
  const fileFor = (id) => join(dir, `${id}.dpapi`)
  return {
    async set(id, _label, token) {
      await mkdir(dir, { recursive: true })
      await powershell(PS_SET, fileFor(id), token)
    },
    async get(id) {
      return (await powershell(PS_GET, fileFor(id), '')).trim()
    },
    async delete(id) {
      await rm(fileFor(id), { force: true })
    }
  }
}

// ---------- Linux Secret Service ----------

const secretService = {
  async set(id, label, token) {
    // `secret-tool store` reads the secret from stdin.
    await exec('secret-tool', ['store', `--label=Claude Code (${label})`, 'service', SERVICE, 'account', id], {
      input: token
    })
  },
  async get(id) {
    const token = (await exec('secret-tool', ['lookup', 'service', SERVICE, 'account', id])).trim()
    if (!token) throw new Error('not found in the keyring')
    return token
  },
  async delete(id) {
    await exec('secret-tool', ['clear', 'service', SERVICE, 'account', id]).catch(() => {})
  }
}

// ---------- plain file (last resort) ----------

function plainFile(dir) {
  const fileFor = (id) => join(dir, id)
  return {
    async set(id, _label, token) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(fileFor(id), token, { mode: 0o600 })
    },
    async get(id) {
      return (await readFile(fileFor(id), 'utf8')).trim()
    },
    async delete(id) {
      await rm(fileFor(id), { force: true })
    }
  }
}

// ---------- selection ----------

/** Token storage rooted at `dir` (used by the file-based backends). */
export function createSecrets(dir) {
  const backends = {
    'macos-keychain': keychain,
    'windows-dpapi': dpapi(join(dir, 'tokens')),
    'secret-service': secretService,
    file: plainFile(join(dir, 'tokens'))
  }
  const forced = () => process.env.CLAUDE_ACCOUNTS_SECRET_BACKEND || null
  const preferred = () =>
    forced() ?? (PLATFORM === 'darwin' ? 'macos-keychain' : PLATFORM === 'win32' ? 'windows-dpapi' : 'secret-service')
  const backend = (name) => {
    const found = backends[name]
    if (!found) throw new Error(`unknown token storage "${name}"`)
    return found
  }

  return {
    /** Stores a token; returns the backend name to record on the account. */
    async set(id, label, token, current) {
      const name = current ?? preferred()
      try {
        await backend(name).set(id, label, token)
        return name
      } catch (error) {
        // Linux without a running keyring (servers, WSL, minimal desktops).
        if (name === 'secret-service' && !forced()) {
          await backend('file').set(id, label, token)
          return 'file'
        }
        throw new Error(`could not store the token in the ${BACKEND_LABELS[name] ?? name}: ${error.message}`)
      }
    },
    async get(id, name) {
      return backend(name ?? preferred()).get(id)
    },
    async delete(id, name) {
      await backend(name ?? preferred()).delete(id)
    }
  }
}
