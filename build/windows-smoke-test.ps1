<#
.SYNOPSIS
  End-to-end execution test for the Bill Jennings Coach package on Windows.

.DESCRIPTION
  Proves the things that cannot be tested from macOS:
    * the coach.cmd shim is actually executed by cmd.exe
    * PATHEXT resolution finds claude.cmd
    * the user PATH is written to the registry and visible to a fresh process
    * the skills entry is a junction and needs no elevation
    * install -> verify -> re-install (idempotent) -> uninstall all behave

  WHAT THIS TOUCHES ON THIS MACHINE:
    * installs Coach into $env:USERPROFILE\.claude-bill-career-coach
      (or -CoachHome if given)
    * creates %LOCALAPPDATA%\Programs\bill-coach\bin and adds it to your USER PATH
    * both are removed again by the uninstall step at the end
  The original user PATH is captured up front and restored if anything fails.

  Run it on a CI runner or a spare machine if you would rather not touch a
  working install. Requires Node >= 24.0.0 (SQLite FTS5). Installs Claude Code via npm if it
  is missing (skip with -NoClaudeInstall).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File windows-smoke-test.ps1 -ZipPath .\Bill-Jennings-Coach--1.1.1.zip
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ZipPath,
  [string]$CoachHome,
  [switch]$NoClaudeInstall,
  [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'
$script:Failures = 0
$script:Total = 0

function Check([bool]$Condition, [string]$Label, [string]$Detail = '') {
  $script:Total++
  if ($Condition) {
    Write-Host ("  ok   {0}" -f $Label) -ForegroundColor Green
  } else {
    $script:Failures++
    Write-Host ("  FAIL {0}" -f $Label) -ForegroundColor Red
    if ($Detail) { Write-Host ("       {0}" -f $Detail) -ForegroundColor DarkGray }
  }
}

function Section([string]$Name) { Write-Host "`n== $Name ==" -ForegroundColor Cyan }

# Capture the user PATH so a mid-run failure is recoverable.
$OriginalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
Write-Host "captured original user PATH ($($OriginalUserPath.Length) chars)"

$work = Join-Path $env:TEMP ("bill-smoke-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
$pkg = Join-Path $work 'package'

function Restore-Path {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($current -ne $OriginalUserPath) {
    [Environment]::SetEnvironmentVariable('Path', $OriginalUserPath, 'User')
    Write-Host 'restored original user PATH' -ForegroundColor Yellow
  }
}

try {
  # ---------------------------------------------------------------- preflight
  Section 'Preflight'
  $nodeV = (& node --version) -replace '^v', ''
  Check ([version]$nodeV -ge [version]'24.0.0') "node >= 24.0.0 (found $nodeV)"

  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude -and -not $NoClaudeInstall) {
    Write-Host '  installing Claude Code (npm i -g @anthropic-ai/claude-code)...'
    & npm install -g @anthropic-ai/claude-code 2>&1 | Out-Null
    $claude = Get-Command claude -ErrorAction SilentlyContinue
  }
  Check ($null -ne $claude) 'claude is on PATH'
  if ($claude) {
    # The installer must resolve claude via PATHEXT; on Windows it is a .cmd/.ps1 shim.
    Check ($claude.Source -match '\.(cmd|exe|bat|ps1)$') "claude resolves to an executable extension ($([IO.Path]::GetExtension($claude.Source)))"
  }

  # ---------------------------------------------------------------- extract
  Section 'Extract'
  Expand-Archive -Path $ZipPath -DestinationPath $work -Force
  Check (Test-Path (Join-Path $pkg 'manifest.json')) 'package extracted with manifest.json'
  Check (Test-Path (Join-Path $pkg 'install\install.mjs')) 'installer present'

  if ($CoachHome) {
    $env:BILL_COACH_HOME = $CoachHome
    New-Item -ItemType Directory -Path $CoachHome -Force | Out-Null
    Write-Host "  using BILL_COACH_HOME=$CoachHome"
  }
  $home_ = if ($CoachHome) { $CoachHome } else { $env:USERPROFILE }
  $profileDir = Join-Path $home_ '.claude-bill-career-coach'

  # ---------------------------------------------------------------- install
  Section 'Install'
  Push-Location $pkg
  # stdout only: the installer contract is one line on stdout, and Node writes
  # deprecation warnings to stderr which would otherwise pollute the comparison.
  $installOut = (& node install\install.mjs 2>$null | Out-String).Trim()
  $installErr = ""
  Pop-Location
  Write-Host "  installer said: $installOut"
  Check ($installOut -eq 'installed') 'installer printed "installed"' $installOut

  # ---------------------------------------------------------------- layout
  Section 'Installed layout'
  Check (Test-Path $profileDir) "sealed profile exists ($profileDir)"
  Check (Test-Path (Join-Path $profileDir 'settings.json')) 'settings.json rendered'
  Check (Test-Path (Join-Path $profileDir 'mcp\coach-mcp.json')) 'sealed MCP config rendered'

  $pluginDir = Join-Path $profileDir 'plugins\data\bill-career-coach-skills-dir'
  Check (Test-Path (Join-Path $pluginDir 'runtime\server.mjs')) 'runtime installed'
  Check (Test-Path (Join-Path $pluginDir 'library\library.sqlite')) 'library installed'
  Check (Test-Path (Join-Path $pluginDir 'state\coach.sqlite')) 'state installed'

  # The skills entry must be a junction: a directory symlink would have needed elevation.
  $skillsEntry = Join-Path $profileDir 'skills\bill-career-coach'
  $item = Get-Item $skillsEntry -Force -ErrorAction SilentlyContinue
  Check ($null -ne $item) 'skills entry exists'
  if ($item) {
    Check ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) 'skills entry is a reparse point (junction)'
    Check ($item.LinkType -eq 'Junction') "link type is Junction (got '$($item.LinkType)')"
    Check (Test-Path (Join-Path $skillsEntry 'runtime\server.mjs')) 'junction is traversable'
  }

  # ---------------------------------------------------------------- launcher
  Section 'Launcher + PATH'
  # The installer picks the first writable PATH dir ahead of claude and only
  # falls back to its own LOCALAPPDATA dir, so discover where it landed.
  $freshPathEarly = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $shim = $null
  foreach ($d in ($freshPathEarly -split ';' | Where-Object { $_ })) {
    $c = Join-Path $d 'coach.cmd'
    if (Test-Path $c) { $shim = $c; break }
  }
  if (-not $shim) { $shim = Join-Path (Join-Path $env:LOCALAPPDATA 'Programs\bill-coach\bin') 'coach.cmd' }
  $binDir = Split-Path $shim -Parent
  $script = Join-Path $binDir 'coach.mjs'
  Check (Test-Path $shim) "coach.cmd written ($shim)"
  Check (Test-Path $script) 'coach.mjs written beside the shim'
  if (Test-Path $shim) {
    $shimText = Get-Content $shim -Raw
    Check ($shimText -match '@echo off') 'shim is a cmd batch file'
    Check ($shimText -match '%~dp0coach\.mjs') 'shim references its sibling script'
  }

  # The PATH change must be persisted to the registry, not just this process.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $onUserPath = $userPath -split ';' | Where-Object { $_ -and (Test-Path $_) -and ((Resolve-Path $_).Path -eq (Resolve-Path $binDir).Path) }
  $onMachinePath = ([Environment]::GetEnvironmentVariable('Path','Machine') -split ';') | Where-Object { $_ -and (Test-Path $_) -and ((Resolve-Path $_).Path -eq (Resolve-Path $binDir).Path) }
  # The installer only writes PATH when it had to use its own fallback dir; if it
  # reused a directory already on PATH there is nothing to persist.
  Check ($onUserPath -or $onMachinePath) 'launcher dir is on the persisted PATH' "binDir=$binDir"
  Check ($userPath.Length -gt 0 -and $userPath -eq ([Environment]::GetEnvironmentVariable('Path','User'))) 'user PATH readable and non-empty'
  # setx would have truncated a long PATH at 1024 chars; prove nothing was lost.
  Check ($userPath.Length -ge $OriginalUserPath.Length) `
    "user PATH not truncated (was $($OriginalUserPath.Length), now $($userPath.Length))"

  # A genuinely fresh process must see `coach` — this is what a new window does.
  $freshPath = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $found = & powershell -NoProfile -Command "`$env:PATH='$freshPath'; (Get-Command coach -ErrorAction SilentlyContinue).Source"
  Check ([string]::IsNullOrWhiteSpace($found) -eq $false) "a fresh process resolves 'coach' ($found)"

  # ---------------------------------------------------------------- shim runs
  Section 'Shim execution (cmd.exe -> node -> launcher)'
  # Point the launcher at an empty home so it fails its own existence checks
  # instead of trying to open an interactive Claude session. Reaching that
  # message proves cmd.exe ran the shim and node ran coach.mjs.
  $emptyHome = Join-Path $work 'empty-home'
  New-Item -ItemType Directory -Path $emptyHome -Force | Out-Null
  $probePath = "$binDir;$env:PATH"
  $probe = & cmd /c "set `"BILL_COACH_HOME=$emptyHome`" && set `"PATH=$probePath`" && coach 2>&1"
  $probeText = ($probe | Out-String)
  Check ($probeText -match 'not found at') 'shim executed and reached the launcher gate' $probeText.Trim()
  Check ($probeText -match 'bill-coach:') 'launcher emitted its own error prefix'

  # ---------------------------------------------------------------- verify
  Section 'verify-install.mjs'
  Push-Location $pkg
  # verify-install checks that `coach` is reachable as a command, which only a
  # terminal opened AFTER the install sees. Simulate that instead of inheriting
  # this process's pre-install environment.
  $savedPath = $env:PATH
  $env:PATH = "$binDir;$env:PATH"
  $verifyOut = (& node install\verify-install.mjs 2>&1 | Out-String).Trim()
  $env:PATH = $savedPath
  Pop-Location
  Write-Host "  verifier said: $verifyOut"
  Check ($verifyOut -like 'ok*') 'verify-install reported ok' $verifyOut

  # ---------------------------------------------------------------- session
  # Model-free full session: reads, an FTS5 query, a durable write, then a server
  # restart to prove the write survived. This is where Windows file locking bites.
  Section 'Coaching session (model-free)'
  $sessionScript = Join-Path $PSScriptRoot 'session-test.mjs'
  if (Test-Path $sessionScript) {
    $sessionOut = (& node $sessionScript $pkg 2>&1 | Out-String)
    Write-Host $sessionOut
    Check ($sessionOut -match 'SESSION TESTS PASSED') 'full coaching session passed' `
      (($sessionOut -split "`n" | Where-Object { $_ -match 'FAIL' }) -join '; ')
  } else {
    Write-Host "  (session-test.mjs not found next to this script; skipping)" -ForegroundColor Yellow
  }

  # ---------------------------------------------------------------- idempotent
  Section 'Re-run (idempotency)'
  Push-Location $pkg
  $again = (& node install\install.mjs 2>&1 | Out-String).Trim()
  Pop-Location
  Write-Host "  installer said: $again"
  Check ($again -eq 'already current') 'second install reports "already current"' $again

  # ---------------------------------------------------------------- uninstall
  Section 'Uninstall'
  Push-Location $pkg
  $unOut = (& node install\uninstall.mjs 2>&1 | Out-String).Trim()
  Pop-Location
  Write-Host "  uninstaller said: $unOut"
  Check ($unOut -like 'uninstalled*') 'uninstall succeeded' $unOut
  Check (-not (Test-Path $shim)) 'coach.cmd removed'
  Check (-not (Test-Path $script)) 'coach.mjs removed'
  $afterPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  Check (-not ($afterPath -split ';' | Where-Object { $_ -eq $binDir })) 'launcher dir removed from USER PATH'
  Check (Test-Path (Join-Path $pluginDir 'state\coach.sqlite')) 'memory preserved by uninstall'
  Check (Test-Path (Join-Path $profileDir 'workspace')) 'workspace preserved by uninstall'

  # ---------------------------------------------------------------- repair
  # Reinstalling after an uninstall is what Bill actually does. Before 1.2.4 the
  # preserved version marker made the installer report "already current" over a
  # profile whose code and configuration had just been deleted, leaving a launcher
  # that could not start and no way out except destroying his memory.
  Section 'Repair (reinstall over preserved memory)'
  Push-Location $pkg
  $repairOut = (& node install\install.mjs 2>$null | Out-String).Trim()
  Pop-Location
  Write-Host "  installer said: $repairOut"
  Check ($repairOut -like 'repaired*') 'reinstall after uninstall reports "repaired"' $repairOut
  Check ($repairOut -like '*memory preserved*') 'repair kept the existing memory' $repairOut
  Check (Test-Path (Join-Path $profileDir 'settings.json')) 'settings.json restored'
  Check (Test-Path (Join-Path $profileDir 'mcp\coach-mcp.json')) 'sealed MCP config restored'
  Check (Test-Path (Join-Path $pluginDir 'runtime\server.mjs')) 'runtime restored'
  $repairedEntry = Get-Item $skillsEntry -ErrorAction SilentlyContinue
  Check ($null -ne $repairedEntry) 'skills entry restored'
  if ($repairedEntry) {
    Check ($repairedEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) 'restored skills entry is a junction'
    Check (Test-Path (Join-Path $skillsEntry 'runtime\server.mjs')) 'restored junction is traversable'
  }
  Check (Test-Path $shim) 'coach.cmd reinstated'
  # Same as the first verify: `coach` is only reachable from a window opened after
  # the install, so simulate that rather than inheriting this process's PATH.
  $savedPath2 = $env:PATH
  $env:PATH = "$binDir;$env:PATH"
  $repairVerify = (& node (Join-Path $pkg 'install\verify-install.mjs') 2>$null | Out-String).Trim()
  $env:PATH = $savedPath2
  Write-Host "  verify-install said: $repairVerify"
  Check ($repairVerify -like 'ok*') 'verify-install reports ok after repair' $repairVerify

  # ---------------------------------------------------------------- teardown
  Section 'Teardown (purge)'
  Push-Location $pkg
  $purgeOut = (& node install\uninstall.mjs --purge-data --confirm 'delete bill coach memory' 2>$null | Out-String).Trim()
  Pop-Location
  $purgeLine = ($purgeOut -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim()
  Write-Host "  uninstaller said: $purgeLine"
  Check ($purgeLine -eq 'purged') 'purge removed everything' $purgeOut
  Check (-not (Test-Path $profileDir)) 'sealed profile directory gone'
}
catch {
  Write-Host "`nUNCAUGHT ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  $script:Failures++
}
finally {
  Restore-Path
  if (-not $KeepArtifacts) {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "artifacts kept at $work"
  }
}

Write-Host ''
if ($script:Failures -eq 0) {
  Write-Host "WINDOWS SMOKE TEST PASSED ($script:Total checks)" -ForegroundColor Green
  exit 0
} else {
  Write-Host "WINDOWS SMOKE TEST FAILED: $script:Failures of $script:Total checks" -ForegroundColor Red
  exit 1
}
