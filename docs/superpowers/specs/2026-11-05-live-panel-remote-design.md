# Live panel for every Orca client — design

Status: draft for owner review. Not implemented.

## Goal

Make the Claude Accounts sidebar panel the one UI that works on desktop, Orca mobile, the browser
client (`orca serve`) and a desktop paired to a remote Orca server, driven by the plugin worker
instead of a rewritten `panel.html`. Then see whether the localhost manager page can be removed, and
whether the chosen account can reach Claude running on SSH/WSL workspaces.

## Decisions made by the owner

- Remote clients can **view and switch** accounts. Adding or updating a token is **desktop only**.

## Sub-projects, in order

1. Live panel and UI/UX redesign (this spec's main body).
2. Remove the manager page, only after (1) reaches feature parity and is confirmed on a phone.
3. Per-launch account for SSH/WSL agents, behind a spike. Runs in parallel with (1) once the owner
   names a host to test on.

## Verified facts (source)

- Plugin workers run on the computer that has the plugin; a paired client is served by that
  server's plugins (Orca `settings.mdx` "Plugins"; `plugin-host-api.md` "Hooks").
- Components panels do not run in browser clients; HTML panels do, in a sandboxed iframe where
  scripts and styles must be inline (`plugin-declarative-ui.md` "Isolation";
  `plugin-authoring.md` "Files and assets"). So the panel stays HTML.
- A panel reaches its worker with `plugin.request` (input up to 64 KiB, answer up to 1 MiB, 30 s
  default timeout) and hears pushes via `orca.panels.post` (`plugin-authoring.md`).
- `orca.shell` and `orca.files` are undefined and `orca.host.has` answers false in browser clients
  (`plugin-authoring.md` "Frames").
- Plugin frames have `alert`/`confirm`/`prompt` disabled (`plugin-isolated-frames.md`).
- `lib/store.mjs` already exports every operation the worker needs: `status`, `useAccount`,
  `useNext`, `useNone`, `addAccount`, `updateToken`, `renameAccount`, `removeAccount`,
  `checkAccounts`, `refreshUsage`.
- The token reaches Claude Code through the `env` block of `~/.claude/settings.json`
  (`lib/store.mjs`, `TOKEN_ENV_KEY`).
- `agent.launch.before` runs on the desktop before the spawn is sent to its host (SSH, WSL, daemon)
  and merges `env` into the spawn; on Windows it also adds the keys to `WSLENV`
  (Orca `spawn-agent-launch-plugin-hook.ts`). It does not run for restores, resumes, or a `claude`
  typed by hand.
- Orca 1.4.249 copies changed top-level keys of `~/.claude/settings.json` (including `env`) into
  its managed Claude accounts (PR #38219). Using the plugin and Orca's managed accounts together
  can therefore leak this token into those profiles. This is an inference from the PR text.

## Not verified (must be tested before relying on them)

- Whether Orca mobile renders the plugin's HTML panel. The repo says it does (commit 44ade4a);
  Orca's mobile source shows no plugin-panel handling. Test on a phone.
- Whether `plugin.request` and `orca.panels.post` work from a panel in the browser client, on mobile
  and on a paired desktop.
- Whether Orca logs `plugin.request` inputs (a token typed on desktop passes through one).
- Whether `env` added by the launch hook reaches an SSH shell.

## Design: sub-project 1

**Worker.** Thin handlers over `lib/store.mjs`; no new business logic.

| Handler | Calls | Allowed from remote |
| --- | --- | --- |
| `accounts.list` | `status()` mapped to the panel snapshot | yes |
| `accounts.use`, `accounts.useNone` | `useAccount`, `useNone` | yes |
| `accounts.check`, `accounts.usage` | `checkAccounts`, `refreshUsage` | yes |
| `accounts.add`, `accounts.updateToken` | `addAccount`, `updateToken` | no (desktop only) |
| `accounts.rename`, `accounts.remove` | `renameAccount`, `removeAccount` | no (desktop only) |

Rename and remove are desktop-only because the owner's rule covers token entry and these are the
other mutating operations; change this if the owner wants them remote.

The snapshot reuses the field mapping now in `renderPanelHtml` (slot, label, active,
tokenUpdatedAt, usage). Tokens never appear in any reply.

**Desktop-only is a UI rule, not a security boundary.** A handler cannot see which client asked, so
the panel hides the desktop-only controls when `orca.host.has('shell.openExternal')` is false. The
panel is the plugin's own code and the same person owns every client, so this is acceptable; it must
not be described as access control.

**Freshness.** The worker watches the config directory with `fs.watch` plus a slow timer fallback
and calls `orca.panels.post('accounts.changed', snapshot)`. The panel also reloads when it opens.
CLI and manager-page changes therefore show up without rewriting any file. Rejected: polling from the
panel (wastes host-call budget, whose limit is not documented) and keeping the `panel.html`
rewrite (does not work for Git installs and needs three call sites).

**Writes.** The worker serializes its own writes in one promise queue. `lib/store.mjs` writes
atomically (temp file and rename) but has no cross-process lock, so a CLI write and a worker write at
the same moment can lose one update. This already exists between the CLI and the manager page; the
live panel adds one more writer. Recorded as a risk, not fixed here.

**Panel UI.** One HTML file, inline script and style, Orca colors from `--orca-*` variables, no
`confirm()` (inline confirm row for destructive actions).

- Header card: active account, token age with expiry badge, 5-hour and 7-day usage bars.
- Account rows: large Use button, per-row usage, expiry tone. Desktop adds a menu with Rename,
  Update token, Remove, and an Add form with a password-type token field.
- Footer: "Use default login".
- Errors appear on the row that caused them. One column on a phone, two on a tablet.

**Status bar (desktop only).** Shows the active label; tone `warning` within 14 days of expiry.
Pressing it runs `show` (a notification). It must not switch accounts: an accidental press would
change the account for every session.

**Manifest.** Format 2, `execution: "trusted-worker"`, `engines.orca: ">=1.4.248"`, `context`
renamed to `when` (format 2 rejects `context`; verified with `orca plugin validate`), add
`statusBarItems`, `$schema`. Decide separately whether to drop `publisher` (it does not match the
repository owner `baroned1707`).

## Design: sub-project 2

Remove `lib/server.mjs`, `lib/server-process.mjs`, `bin/manager-server.mjs`, `ui/manager.html`,
`lib/open-in-orca.mjs` and the CLI `ui` command (about 1,500 lines) only when the panel covers add,
rename, update token, remove, check and usage, and the owner has used it on a phone. Gate, not date.

## Design: sub-project 3 (spike first)

1. In a throwaway plugin, hook `agent.launch.before`, add one harmless `env` variable, launch an
   agent on a real SSH or WSL workspace, and check the variable in the remote shell.
2. If it arrives: add an opt-in setting that injects `CLAUDE_CODE_OAUTH_TOKEN` for Orca-launched
   agents; keep the `settings.json` mechanism. Note that already-running sessions and hand-typed
   `claude` are not covered, and that the token is visible in that process environment.
3. If it does not arrive: document the limit in the README and stop.

## Testing

- Worker handlers: `mountWorker` from `orca/testing` (Node, no Orca).
- Panel: `orca plugin check`, and `orca plugin shot --width` at phone and desktop widths.
- Phone, browser client and paired desktop: manual, by the owner. These are the unverified items.

## Open questions

- Which host (SSH or WSL) for the spike.
- Keep or drop `publisher`.
- Whether the owner uses Orca's managed Claude accounts at the same time.
