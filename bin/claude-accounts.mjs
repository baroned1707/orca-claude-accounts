#!/usr/bin/env node
// CLI companion to the Orca plugin: same store, usable from any terminal.
import { createInterface } from 'node:readline'
import { openUrl } from '../lib/open-in-orca.mjs'
import { syncPanel } from '../lib/panel.mjs'
import { BACKEND_LABELS } from '../lib/secrets.mjs'
import { ensureManagerServer } from '../lib/server-process.mjs'
import {
  accountRow,
  addAccount,
  sameOrgNote,
  checkAccounts,
  refreshUsage,
  removeAccount,
  renameAccount,
  status,
  updateToken,
  useAccount,
  useNext,
  useNone
} from '../lib/store.mjs'

const USAGE = `claude-accounts — switch Claude Code between setup-token accounts

  claude-accounts                    list accounts (● = in use)
  claude-accounts ui                 open the account manager (Orca tab, else browser)
  claude-accounts add <label>        add an account; paste its \`claude setup-token\` token
  claude-accounts use <slot|label>   switch
  claude-accounts next               switch to the next account
  claude-accounts usage [slot|label] show 5-hour / 7-day usage (one tiny request per account)
  claude-accounts check [slot|label] check tokens with Anthropic (all when omitted; uses no quota)
  claude-accounts token <slot|label> replace an account's token
  claude-accounts label <slot|label> <new label>
  claude-accounts rm <slot|label>    delete an account and its stored token
  claude-accounts off                remove the token; Claude Code falls back to /login

Token input: hidden prompt, or pipe it: pbpaste | claude-accounts add "Work"`

async function readToken() {
  if (!process.stdin.isTTY) {
    let data = ''
    for await (const chunk of process.stdin) data += chunk
    return data
  }
  // Hidden prompt: mute echo so the token never lands in the scrollback.
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  let muted = false
  rl._writeToOutput = (text) => {
    if (!muted) process.stdout.write(text)
  }
  return new Promise((resolve) => {
    rl.question('Paste token (sk-ant-oat01-…): ', (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    muted = true
  })
}

async function printList() {
  const snapshot = await status()
  if (!snapshot.accounts.length) {
    console.log('No accounts yet. Add one with: claude-accounts add "<label>"')
    return
  }
  for (const account of snapshot.accounts) console.log(accountRow(account))
  if (!snapshot.active) console.log('(no token in use: Claude Code uses its /login session)')
  if (snapshot.drift) {
    console.log('⚠ ~/.claude/settings.json holds a different token than the active account.')
  }
}

const switched = (account) =>
  console.log(`Switched to "${account.label}". Running and new Claude Code sessions use it.`)

function need(value, usage) {
  if (!value) throw new Error(`usage: ${usage}`)
  return value
}

async function main([command, arg, ...rest]) {
  switch (command) {
    case undefined:
    case 'list':
    case 'ls':
      return printList()
    case 'ui': {
      const where = await openUrl(await ensureManagerServer())
      console.log(`Account manager opened in ${where === 'orca' ? 'an Orca tab' : 'your browser'}.`)
      return
    }
    case 'add': {
      const label = need([arg, ...rest].join(' ').trim(), 'claude-accounts add <label>')
      const account = await addAccount(label, await readToken())
      const note = sameOrgNote(account)
      if (note) console.log(`Note: ${note}.`)
      console.log(`Added "${account.label}" (token stored in the ${BACKEND_LABELS[account.secretBackend] ?? account.secretBackend}). Switch with: claude-accounts use ${(await status()).accounts.length}`)
      return
    }
    case 'use':
      return switched(await useAccount(need([arg, ...rest].join(' '), 'claude-accounts use <slot|label>')))
    case 'next':
      return switched(await useNext())
    case 'usage': {
      const ref = [arg, ...rest].join(' ').trim()
      const time = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '?')
      for (const account of await refreshUsage(ref || undefined)) {
        const u = account.usage
        if (!u.ok) {
          console.log(`${account.label}: ${u.error}`)
          continue
        }
        const win = (w) => (w ? `${String(w.percent).padStart(5)}% (resets ${time(w.resetsAt)})` : '   n/a')
        const flag = u.status === 'rejected' ? '  ⛔ limit reached' : ''
        console.log(`${account.label.padEnd(22)} 5h ${win(u.fiveHour)}   7d ${win(u.sevenDay)}${flag}`)
      }
      return
    }
    case 'check': {
      const ref = [arg, ...rest].join(' ').trim()
      for (const account of await checkAccounts(ref || undefined)) {
        const who = account.email ?? (account.orgId ? `org ${account.orgId.slice(0, 8)}… (email unknown)` : 'account unknown')
        console.log(`${account.lastCheck.state.padEnd(8)} ${account.label} — ${who} — ${account.lastCheck.message}`)
      }
      return
    }
    case 'token': {
      const ref = need([arg, ...rest].join(' '), 'claude-accounts token <slot|label>')
      const account = await updateToken(ref, await readToken())
      console.log(`Updated the token of "${account.label}".`)
      return
    }
    case 'label':
    case 'rename': {
      const label = rest.join(' ')
      need(arg && label, 'claude-accounts label <slot|label> <new label>')
      const account = await renameAccount(arg, label)
      console.log(`Label is now "${account.label}".`)
      return
    }
    case 'off':
      await useNone()
      console.log('Token removed; Claude Code falls back to its /login session.')
      return
    case 'rm':
    case 'remove': {
      const account = await removeAccount(need([arg, ...rest].join(' '), 'claude-accounts rm <slot|label>'))
      console.log(`Removed "${account.label}".`)
      return
    }
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE)
      return
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`)
  }
}

const READ_ONLY = new Set([undefined, 'list', 'ls', 'ui', 'help', '-h', '--help'])

main(process.argv.slice(2))
  // Mutations refresh the Orca sidebar panel too.
  .then(() => (READ_ONLY.has(process.argv[2]) ? null : syncPanel((message) => console.error(message))))
  .catch((error) => {
    console.error(`claude-accounts: ${error.message}`)
    process.exit(1)
  })
