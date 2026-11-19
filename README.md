# dsh-session-resume

Asks "pick up where you left off?" when DSH reopens, for every conversation whose last turn never finished.

## How it decides

Session logs are append-only; one `turn/start` without a later `turn/end` means the process died
mid-turn. The host half scans logs younger than 14 days and serves one summary per unfinished turn
(title, workspace, age, step number, the tool that was running, the original task, the last output).

## Behaviour

- One centred dialog per page load, one conversation at a time: handle it, the next appears, and the dialog closes after the last one (or right after a successful copy).
- "Resume" opens that conversation and pre-fills the continuation — it never sends for you.
- "Ignore" remembers the interruption timestamp; a later interruption asks again.
- The dialog closes itself once the last resumable row is handled, and shows an empty state otherwise.
- If the composer cannot be recognised the instruction is shown with a copy button; the fill is
  retried for 9 seconds and verified after a re-render.

## Liveness

A log written in the last 45 seconds counts as a running turn and stays out of the dialog. The page
re-checks every 4 seconds (up to 30 times), so right after a restart the prompt appears on its own
once that window passes — no refresh needed.

## Install

```bash
dsh plugin add "D:/Deepseek work/workplace/dsh-session-resume"
```

Then reload the page. Both manifest entries are required — `dependencies` and
`dsh.profile.bundles`; a missing bundle entry leaves the routes unregistered (the earlier 404).

Fallback without the CLI: `node install-offline.mjs` with DSH closed.

## Test

```bash
node --test --test-timeout=15000 test/host.test.mjs test/routes.test.mjs test/client.test.mjs
node test/live-roundtrip.mjs
```
