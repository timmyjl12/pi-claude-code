# Windows patch — how to reapply after a pi update

## The situation

Pi installs this extension from the **upstream** repo, because
`~/.pi/agent/settings.json` contains:

```json
"https://github.com/earendil-works/pi-claude-code"
```

`pi update --extensions` (or a pi upgrade) reconciles that checkout back to
upstream `main`, which **wipes our Windows patch** from:

```
~/.pi/agent/git/github.com/earendil-works/pi-claude-code
```

## The patch

- Branch in this fork: `fix/windows-cmd-ps1-launch`
- Commit: `39262cd44d82cb78cdff43f715eb9f6f40e4fd2b`
- Currently sits directly on top of upstream `main` (`70abb65`).
- What it does: launches Windows `.cmd`/`.bat` Claude Code shims through
  `cmd.exe` with a single cmd-escaped command line passed with
  `windowsVerbatimArguments`, runs `.ps1` shims via a noninteractive
  PowerShell host (`-EncodedCommand`, `PI_CLAUDE_CODE_POWERSHELL` override,
  `pwsh` preferred), surfaces real status diagnostics instead of a bogus
  login hint, and reads `Path`/`ComSpec` case-insensitively.

## Reapply (one command)

From this repo clone:

```powershell
.\reapply-windows-patch.ps1
```

Then **restart pi** (extensions are loaded at startup; no build step — pi
loads `src/index.ts` directly).

## Reapply (manual)

```powershell
$p = "$env:USERPROFILE\.pi\agent\git\github.com\earendil-works\pi-claude-code"
git -C $p fetch fork
git -C $p merge --ff-only fork/fix/windows-cmd-ps1-launch
```

If the fast-forward fails because upstream `main` advanced and the checkout
was reconciled past the patch's parent, rebase this fork's branch onto the
new upstream `main`, push it, then run the script again (it falls back to a
clean `reset --hard` to the branch tip — the checkout is a pi-managed cache
and must be clean for the script to touch it).

## Durable alternative (stops the wipe from happening)

Point pi at this fork pinned to the patched commit instead of upstream.
Pinned commits are never moved by pi updates. In
`~/.pi/agent/settings.json`, replace the package entry with:

```json
"git:github.com/timmyjl12/pi-claude-code@39262cd44d82cb78cdff43f715eb9f6f40e4fd2b"
```

then run `pi update --extensions` and restart pi. Trade-off: frozen at that
commit — bump the SHA manually after rebasing the patch onto newer upstream.

## Side effect while tracking upstream (banner false positive)

While this patch is applied on top of upstream `main`, pi's startup check flags
the package as having an update available every launch (it compares HEAD to the
upstream tip by SHA, with no ancestry check). Do **not** run the suggested
`pi update --extensions` — it wipes this patch. A fix for the banner is patched
into pi's bundled CLI; see `PI-UPDATE-BANNER-FIX.md` and
`C:\Users\timmy\.pi\patches\reapply-package-update-ancestor-check.ps1` (re-run
that script after any pi upgrade).
