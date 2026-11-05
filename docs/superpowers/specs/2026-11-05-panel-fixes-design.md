# Panel and worker follow-up fixes — design

Status: approved by the owner on 2026-11-05. Follow-up to
`2026-11-05-live-panel-remote-design.md`; applies to branch `feat/live-panel`.

## Scope

Three fixes found while reviewing the branch. Nothing else changes; `lib/store.mjs` is not touched.

Left out on purpose: re-publishing the status bar on a timer (Orca prunes a plugin's overrides
and restarts its worker when the plugin is re-enabled, per the Orca source, so it is not needed),
and the README's pinned `v0.12.0` and old screenshots (done at release, from a real Orca).

## Fix 1 — read the keychain only when the token in `settings.json` changed

Problem: `watchFiles` calls one `onChange` for both `accounts.json` and `settings.json`. Every
write to `settings.json` (Claude Code writes it when settings change; the owner's file was last
written about 30 minutes before this spec) runs `status()`, which spawns the keychain tool.

Design:
- `main.mjs` uses two watchers. `accounts.json` → `publisher.refresh()` as before.
  `settings.json` → a gate that refreshes only when the token value in the file changed.
- New `lib/token-change-gate.mjs`: `createTokenChangeGate({ read, onChange })` returns an async
  `check()`. It compares `read()` with the previous result. The first call only records a
  baseline. `read` is `store.readActiveToken` (reads the file, never the keychain).
- If `read` throws (unparsable file), the state is the marker `'unreadable'`; `onChange` runs once
  when the state changes to or from it, not on repeated failures, so drift and file errors still
  surface.
- The token value is compared in memory only: never logged, never stored.

Assumption: the only thing in `settings.json` that `status()` uses is the token (for `drift`).
If `status()` ever reads more from that file, the gate must widen.

Tests: unchanged token → no call; changed, appeared or removed token → one call; read error → one
call then none while it keeps failing; error → valid → one call; first `check()` records a baseline.

## Fix 2 — a click is not lost after a deferred redraw

Problem: while a text field has focus, a push is stored and drawn on `focusout`. Pressing a button
fires `mousedown`, which blurs the field; the redraw (timer 0) can replace the button before
`mouseup`, so the click is lost.

Design (`panel.html`):
- Track `pointerIsDown` with capture-phase `pointerdown` (true) and `pointerup`/`pointercancel`
  (false) listeners on `document`.
- On `focusout` while `pointerIsDown`, do not schedule the redraw. When the pointer is released,
  schedule it with `setTimeout(0)`, which runs after the `click` of the same press.
- Keyboard focus changes (Tab) redraw as before. `dirty`, and "actions the user just took render at
  once", are unchanged.

Tests: static (the script has the `pointerdown` and `pointerup` handlers) and a real-mouse run in
Chromium against the real `panel.html` with a fake `window.orca`: type, receive a push (deferred),
press and release the Add button with a pause between mousedown and mouseup; `accounts.add` must be
requested. The same run must fail on the current panel first.

## Fix 3 — the worker test never reads the real `~/.claude`

Problem: `test/worker.test.ts` sets `CLAUDE_ACCOUNTS_ROOT` per test and removes it in `finally`,
while `activate` starts background work (first refresh, expiry check) that can still be running; it
then resolves paths from the real home.

Design: create one temp folder and set `CLAUDE_ACCOUNTS_ROOT` once at the top of the file; remove
both in `after()` from `node:test` once every test is done. Drop the per-test `withEmptyStore`.

Test: while the worker is running, `store.claudeSettingsPath()` and `store.configDir()` are inside
the temp folder.

## Out of scope / unverified

- Touch devices: the pointer handling is checked with a mouse in Chromium only; real touch is part of
  the on-device verification (plan Task 10).
