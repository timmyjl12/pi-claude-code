# Fix: permanent "Package Updates Available" banner (pi 1.3.0 / 1.4.0)

## Symptom
With the Windows patch applied to the pi-claude-code checkout (HEAD = `39262cd`,
branch `fix/windows-cmd-ps1-launch` tracking `fork/...`), pi shows on every startup:

```
Package Updates Available
 Package updates are available. Run pi update --extensions
 Packages:
 - github.com/earendil-works/pi-claude-code
```

Running the suggested `pi update --extensions` would reconcile the checkout back to
upstream `main` and **wipe the Windows patch**.

## Root cause
`gitHasAvailableUpdate(installedPath)` in pi's package manager compares
`git rev-parse HEAD` to the remote tip **by SHA only**:

- `getGitUpstreamRef()` only handles upstreams that start with `origin/`. Our
  checkout tracks `fork/fix/windows-cmd-ps1-launch`, so it returns `undefined`.
- `getRemoteGitHead()` then falls back to `git ls-remote origin HEAD` — the tip of
  upstream `main` (`70abb65`).
- `39262cd !== 70abb65` → "update available", even though we are strictly **ahead**
  of upstream. The check has no notion of ancestry, only equality.

## Fix (applied to the bundled CLI)
In `getRemoteGitHead`, after the upstream-ref branch and before the network
`ls-remote origin HEAD` fallback:

1. Resolve the local `refs/remotes/origin/HEAD` (`getGitOriginHeadRef`).
2. If `git merge-base --is-ancestor <origin/HEAD> HEAD` succeeds (we are
   ahead-of/equal-to upstream), return `HEAD` as `remoteHead` →
   `localHead === remoteHead` → no banner.

Real updates still flag: a genuine update requires upstream to advance past HEAD,
which changes the remote ref — and the ancestor check then fails and we fall
through to the network `ls-remote` path anyway.

Patched files:
- `~/.pi/agent/install/releases/1.4.0/.../dist/bundle/chunks/chunk-MM3LKT73.js`
- `~/.pi/agent/install/releases/1.3.0/.../dist/bundle/chunks/chunk-66G7ITPS.js`

## Reapply after a pi upgrade
A pi upgrade replaces `dist/bundle/chunks/*.js` and wipes this patch. Re-run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\timmy\.pi\patches\reapply-package-update-ancestor-check.ps1
```

The script is idempotent (skips already-patched chunks, `node --check`s every file
it touches) and scans every release under `~/.pi/agent/install/releases`.

## Upstream
Worth filing against `earendil-works/pi-coding-agent`: `gitHasAvailableUpdate`
should treat "local HEAD is ahead of the tracked remote ref" as up-to-date, not
as an available update.
