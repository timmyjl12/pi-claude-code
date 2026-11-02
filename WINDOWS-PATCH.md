# Windows patch — status and workflow

## Current setup: pi loads this clone directly

`~/.pi/agent/settings.json` points pi at the local clone, not upstream:

```json
"packages": [ "…", "D:\\dev_docs\\ai\\pi\\pi-claude-code" ]
```

Per pi's package docs, a local package is **loaded from its resolved path without
copying**, and pi never installs or modifies it. Consequences:

- `pi update --extensions` and pi upgrades **cannot wipe this patch** — nothing
  reconciles this directory to upstream.
- No reapply step is needed after updates. No `pi update` nag for this package.
- Pi reads the **working tree** live, so this clone must stay on the patched
  branch with a clean tree. Switching branches or leaving edits changes the
  running extension.

The patch is committed on the fork:

- Commit `39262cd44d82cb78cdff43f715eb9f6f40e4fd2b` — *fix: launch Windows
  .cmd/.ps1 Claude Code shims with exact arguments*
- Branch `fix/windows-cmd-ps1-launch`, merged into fork `main` as `dc17a63`
- Its parent is upstream `main` tip `70abb65` — the patch sits directly on
  current upstream, no rebase required.
- Fork `main` is pushed to `origin` (`timmyjl12/pi-claude-code`).

## What it does

Launches Windows `.cmd`/`.bat` Claude Code shims through `cmd.exe` with a single
cmd-escaped command line passed with `windowsVerbatimArguments`; runs `.ps1`
shims via a noninteractive PowerShell host (`-EncodedCommand`,
`PI_CLAUDE_CODE_POWERSHELL` override, `pwsh` preferred); surfaces real status
diagnostics instead of a bogus login hint; reads `Path`/`ComSpec`
case-insensitively.

## Updating from upstream

Keep `39262cd` on top of the new upstream tip:

```powershell
cd D:\dev_docs\ai\pi\pi-claude-code
git fetch upstream                       # remote -> https://github.com/earendil-works/pi-claude-code
git merge upstream/main                  # or: git rebase upstream/main
```

Resolve any conflicts in `src/claude-cli.ts` / `src/provider.ts` by hand, then
`git push origin main` and restart pi. If you rebased, the patch commit gets a
new SHA — update this file and the notes in `PI-UPDATE-BANNER-FIX.md`.

## Verify

```powershell
# Extension loaded? The provider is registered by this package.
pi --list-models | Select-String claude-code

# Patch present in the live tree?
Select-String .\src\claude-cli.ts -Pattern windowsVerbatimArguments
```

Tests need Node 22 (Node 26 dropped `--experimental-transform-types`; strip-only
mode rejects TS parameter properties):

```powershell
& "$env:LOCALAPPDATA\nvs\node\22.20.0\x64\node.exe" --experimental-transform-types --test "tests/*.test.ts"
```

`node_modules` in this package is only for dev/test. Host packages
(`@earendil-works/*`) also live there but pi maps them to its own bundled
copies at runtime — the same arrangement as your other local extensions, which
carry older nested copies and run fine.

## Legacy: git package tracking upstream

Only relevant if you revert the settings entry to
`https://github.com/earendil-works/pi-claude-code`. In that mode pi manages a
checkout at
`~/.pi/agent/git/github.com/earendil-works/pi-claude-code`, and
`pi update --extensions` reconciles it back to upstream `main`, wiping the
patch. Restore with:

```powershell
.\reapply-windows-patch.ps1
```

That directory still exists but is **orphaned** — pi no longer loads it. It is
safe to delete when you are sure the local package setup is staying.

While tracking upstream, pi's update check compares HEAD to the upstream tip by
SHA with no ancestry check, so it flags a false "Package Updates Available" on
every launch. The fix for that lives in pi's bundled CLI and must be reapplied
after each pi upgrade — see `PI-UPDATE-BANNER-FIX.md` and
`C:\Users\timmy\.pi\patches\reapply-package-update-ancestor-check.ps1`. It is
irrelevant to the local-package setup, where no git check runs for this package.
