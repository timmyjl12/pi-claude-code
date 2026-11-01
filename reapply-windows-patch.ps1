# Reapply the Windows .cmd/.ps1 launch patch to the pi-installed pi-claude-code checkout.
# See WINDOWS-PATCH.md for background. Safe: aborts on a dirty checkout; only
# fast-forwards, or resets to the fork branch tip when the tree is clean.
[CmdletBinding()]
param(
    [string]$Checkout = "$env:USERPROFILE\.pi\agent\git\github.com\earendil-works\pi-claude-code",
    [string]$ForkUrl = "https://github.com/timmyjl12/pi-claude-code",
    [string]$Branch = "fix/windows-cmd-ps1-launch"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $Checkout ".git"))) {
    throw "Extension checkout not found at $Checkout. Is pi-claude-code installed?"
}

# Refuse to touch a dirty checkout.
if (git -C $Checkout status --porcelain) {
    throw "Checkout at $Checkout has uncommitted changes. Commit or stash them first."
}

# Make sure the fork remote exists (it did as of 2026-10, but pi manages this clone).
$remotes = git -C $Checkout remote
if ($remotes -notcontains "fork") {
    Write-Host "Adding fork remote -> $ForkUrl"
    git -C $Checkout remote add fork $ForkUrl
}

Write-Host "Fetching fork..."
git -C $Checkout fetch fork $Branch

$target = "fork/$Branch"
$head = git -C $Checkout rev-parse HEAD
$tip = git -C $Checkout rev-parse $target
if ($head -eq $tip) {
    Write-Host "Already at $Branch tip ($($tip.Substring(0,7))). Nothing to do."
    exit 0
}

# Fast-forward when the branch tip descends from HEAD (usual case right after an update wiped us).
git -C $Checkout merge-base --is-ancestor $head $tip
if ($LASTEXITCODE -eq 0) {
    git -C $Checkout merge --ff-only $target
}
else {
    # Upstream moved and the branch was rebased: checkout is clean, so a hard
    # reset to the branch tip is safe (pi reconciles this cache anyway).
    Write-Host "Branch was rebased onto newer upstream; resetting clean checkout to $target"
    git -C $Checkout reset --hard $target
}
if ($LASTEXITCODE -ne 0) { throw "Failed to move checkout to $target" }

Write-Host ""
Write-Host "Patch applied. Installed checkout is now at:"
git -C $Checkout log --oneline -1
Write-Host "Restart pi to load the patched extension."
