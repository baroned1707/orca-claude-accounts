// Finds the email for an organization id among accounts this Mac has signed
// in with: Claude Code's own /login record and Orca's managed Claude accounts.
// setup-token tokens can't read the profile, so this is the only source.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HOME, orcaDataDir } from './platform.mjs'

const ORCA_DIR = orcaDataDir()

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function collect(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
  } else if (node && typeof node === 'object') {
    const org = node.organizationUuid ?? node.organization_uuid
    const email = node.emailAddress ?? node.email
    if (typeof org === 'string' && typeof email === 'string') out.set(org, email)
    for (const value of Object.values(node)) collect(value, out)
  }
}

async function orcaAccountFiles() {
  const { readdir } = await import('node:fs/promises')
  const files = []
  for (const dir of ['claude-accounts', 'claude-runtime-auth']) {
    try {
      const entries = await readdir(join(ORCA_DIR, dir), { recursive: true })
      for (const entry of entries) if (entry.endsWith('.json')) files.push(join(ORCA_DIR, dir, entry))
    } catch {
      // Orca not installed or never signed in
    }
  }
  return files
}

/** Map of organization id → email for every locally known Claude sign-in. */
export async function knownIdentities() {
  const out = new Map()
  for (const path of [join(HOME, '.claude.json'), ...(await orcaAccountFiles())]) {
    collect(await readJson(path), out)
  }
  return out
}
