# Claude Accounts — Orca plugin

Switch [Claude Code](https://code.claude.com) between several Claude accounts from
inside [Orca](https://github.com/stablyai/orca). Each account uses a one-year token
from `claude setup-token` ([docs](https://code.claude.com/docs/en/authentication)).

- **Add, label, update, remove and switch** accounts; the account in use is highlighted.
- **Token check** with Anthropic before saving (uses no quota).
- **Usage per account**: 5-hour and 7-day usage with reset times, shown by default.
- **Sidebar panel**, **command palette** commands and **shortcuts** in Orca, plus a CLI.
- Tokens live in the **macOS Keychain**, never in the plugin folder.

> Experimental: built on Orca's plugin API v1 (Orca 1.4.x), which is itself experimental.

## Requirements

- macOS (uses the Keychain, `osascript` and `sqlite3`)
- [Orca](https://github.com/stablyai/orca) 1.4 or newer
- Claude Code, and a Claude subscription per account
- Node.js 18+ only if you want the `claude-accounts` CLI

## Install

```sh
git clone https://github.com/baroned1707/orca-claude-accounts.git
cd orca-claude-accounts
npm link        # optional: adds the `claude-accounts` CLI to your PATH
```

In Orca: **Settings → Plugins → Developer plugin paths** → add the cloned folder,
enable **Claude Accounts** and accept its capability (notifications).

The plugin is loaded from a developer path on purpose: the sidebar panel is
refreshed by rewriting `panel.html` in the plugin folder (see [Sidebar panel](#sidebar-panel)).

## Use it

| Where | How |
| --- | --- |
| Shortcut | `⌘⇧M` opens **Manage accounts**, `⌘⇧J` switches to the next account |
| Sidebar | `⌘L` opens the right sidebar → **bot** icon → **Claude Accounts** |
| Command palette | `⌘J` → type `Claude Account` |

`⌘⇧M` is also Orca's default for *New markdown tab*. If it opens a markdown tab,
change one of the two in **Settings → Shortcuts**.

### Add an account

1. Sign in to claude.ai with the account in your browser.
2. Run `claude setup-token` and copy the `sk-ant-oat01-…` token.
3. `⌘⇧M` → **Add account** → give it a label (e.g. "Work – me@company.com") and paste the token.

The token is checked with Anthropic first: a rejected token is never saved, and a
second token for an account that is already in the list is refused (use
**Update token** on that account instead).

## How switching works

Switching writes the account's token to `env.CLAUDE_CODE_OAUTH_TOKEN` in
`~/.claude/settings.json`. Claude Code reads that file at start-up **and reloads it
while running**, so:

- new `claude` sessions use the selected account, from Orca or any terminal;
- **running sessions switch too** — their next request goes to the new account
  (verified with Claude Code 2.1.292);
- all sessions share one account at a time (they share `~/.claude/settings.json`).

**Use default login** removes the token, and Claude Code goes back to your `/login` session.

## Where data is stored

| Location | Contents |
| --- | --- |
| macOS Keychain, service `orca-claude-accounts` | every account's token |
| `~/.claude/settings.json` → `env.CLAUDE_CODE_OAUTH_TOKEN` | the token of the account in use (plain text, file mode 600) |
| `~/.config/orca-claude-accounts/accounts.json` | labels, dates, last check, usage — no tokens |
| `~/.config/orca-claude-accounts/server.json` | URL of the running manager page (mode 600) |

Tokens are passed to `security` on stdin, so they never appear in `ps`.

## Manage accounts page

`⌘⇧M` opens the manager as a tab in Orca's built-in browser. Per account:
**Switch**, **Refresh usage**, **Check token**, **Edit label**, **Update token**, **Remove**.

- **Usage** shows by default: the page reads it when opened and every 5 minutes
  while visible (only when the last reading is older than 5 minutes).
  setup-token tokens can't call Anthropic's usage API (it needs the
  `user:profile` scope), so each reading sends the smallest model request (Haiku,
  1 output token) and reads the `anthropic-ratelimit-unified-*` headers — the same
  numbers Claude Code uses. Each reading spends a tiny amount of the account's usage.
- **Token check** lists models (`GET /v1/models`): it needs a working token but runs
  no model, so it uses no quota.
- **Email**: setup-token tokens can't read the profile either. The plugin records
  each token's organization id and shows the email when that organization matches
  an account signed in on this Mac with `/login` (Claude Code or Orca); otherwise
  it shows the organization id.
- **Theme**: the page has no colors of its own. It reads the design tokens from the
  installed Orca (`Orca.app/Contents/Resources/app.asar`) and follows your Orca
  theme and font.

Orca panels can't exchange data with a plugin's worker (panel CSP is
`connect-src 'none'`), so the page is served by a small local server running as its
own process (`bin/manager-server.mjs`): it binds to `127.0.0.1` under a random
256-bit URL secret, checks the `Host` header, accepts only JSON writes with a custom
header, never returns tokens, and exits after 30 minutes without requests.

## Sidebar panel

Shows the account in use, every account with expiry and last usage, and the
shortcuts. It is read-only: Orca gives panels no way to receive data or run plugin
commands, so `panel.html` is regenerated from `ui/panel.template.html` whenever
the accounts change, and Orca reloads it. It contains labels, dates and usage —
never tokens or emails.

## CLI

```sh
claude-accounts                        # list (● = in use) with last usage
claude-accounts ui                     # open the manager page
claude-accounts add "Work – me@co.com" # paste the token at the hidden prompt (or: pbpaste | …)
claude-accounts use 2                  # switch by slot or label
claude-accounts next | off
claude-accounts usage [slot]           # 5-hour / 7-day usage
claude-accounts check [slot]           # validate tokens (no quota)
claude-accounts token 2                # replace a token
claude-accounts label 2 "New label"
claude-accounts rm 2
```

## Notes

- Setup tokens are inference-only: features that need a full login (e.g. Remote
  Control) don't work while a token is active.
- Don't also pick a managed Claude account in Orca's own account switcher: Orca then
  points Claude Code at a different config dir and this token is ignored.
- Remove any `CLAUDE_CODE_OAUTH_TOKEN` exported in your shell profile.
- Orca asks you to approve the plugin again whenever its shortcuts change.
- A notification warns when a token is within 14 days of its one-year expiry
  (counted from when it was added or last updated).

## License

[MIT](LICENSE)
