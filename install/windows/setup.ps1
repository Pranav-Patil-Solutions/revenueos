# RevenueOS — Windows install (RVOS-003 P4)
#
#   powershell -ExecutionPolicy Bypass -File install\windows\setup.ps1
#
# ============================ WINDOWS-UNVERIFIED ============================
# This script was AUTHORED ON macOS and has never been executed on Windows.
# Per RVOS-003 invariant N3 it stays labelled WINDOWS-UNVERIFIED until it has
# been run end to end on the office machine, with Pranav present. Treat every
# step below as a considered proposal, not a tested procedure. The first run
# should be watched, not scheduled.
# ===========================================================================
#
# Deliberately does NOT require Administrator. It installs for the current
# user, uses a per-user Scheduled Task, and keeps everything under one folder,
# so uninstalling is deleting a folder and two tasks. Anything needing admin
# (build tools) is reported for a human to do, not silently elevated.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$AppRoot   = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$DataDir   = Join-Path $AppRoot "data"
$TaskApp   = "RevenueOS"
$TaskBack  = "RevenueOS Backup"

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   !   $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "`nSTOPPED: $msg" -ForegroundColor Red; exit 1 }

Write-Host "RevenueOS install" -ForegroundColor White
Write-Host "Folder: $AppRoot"

# ---------------------------------------------------------------- Node.js
Step "Node.js"
try { $nodeVersion = (& node --version) 2>$null }
catch { Die "Node.js is not installed. Get the LTS build from https://nodejs.org, then run this again." }
if (-not $nodeVersion) { Die "Node.js is not on PATH. Install the LTS build from https://nodejs.org." }
Ok "node $nodeVersion"

# ------------------------------------------------------------- Dependencies
# `npm ci` is deliberate: it installs the EXACT lockfile, so the office machine
# gets the same dependency tree that the tests passed against.
Step "Installing dependencies (npm ci)"
Push-Location $AppRoot
try {
  & npm ci
  if ($LASTEXITCODE -ne 0) {
    Warn "npm ci failed. The usual cause is better-sqlite3 needing to compile."
    Warn "Try: npm rebuild better-sqlite3"
    Warn "If that fails, install the Visual Studio Build Tools (C++ workload) and retry."
    Die "Dependency install failed."
  }
  Ok "dependencies installed"

  # --------------------------------------------------------------- Preflight
  # Runs BEFORE the build, so a machine that cannot work is rejected before
  # anything irreversible happens. The real logic is TypeScript and unit
  # tested; this script only reacts to its exit code.
  Step "Preflight"
  & npm run preflight
  if ($LASTEXITCODE -ne 0) { Die "Preflight found blocking problems (listed above)." }

  # ------------------------------------------------------------------ Build
  Step "Building"
  & npm run build
  if ($LASTEXITCODE -ne 0) { Die "Build failed." }
  Ok "built"

  # ------------------------------------------------------- First-run database
  Step "Data folder"
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Ok "$DataDir"
  # No database is seeded and NO default login is created. The first person to
  # open the app creates the account. A shipped admin/admin that nobody changes
  # is worse than no password, because it looks secure.

  # ---------------------------------------------------------------- Launcher
  Step "Launcher"
  $startCmd = Join-Path $AppRoot "start-revenueos.bat"
  @"
@echo off
rem Starts RevenueOS. Close this window to stop it.
cd /d "$AppRoot"
set REVENUEOS_HTTPS=
rem NOTE: binds to localhost only. P5 makes the tailnet bind an explicit opt-in.
call npm run start
"@ | Set-Content -Path $startCmd -Encoding ASCII
  Ok $startCmd

  # ----------------------------------------------------------- Scheduled tasks
  Step "Scheduled tasks"

  # Autostart at logon. Per-user, so no admin rights and no service account.
  $appAction  = New-ScheduledTaskAction -Execute $startCmd
  $appTrigger = New-ScheduledTaskTrigger -AtLogOn
  $appSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskApp -Action $appAction -Trigger $appTrigger `
      -Settings $appSettings -Description "Starts RevenueOS at sign-in." -Force | Out-Null
  Ok "'$TaskApp' runs at sign-in"

  # Nightly backup. Runs whether or not the app is up: SQLite's online backup
  # API is safe against a live writer.
  $backupAction = New-ScheduledTaskAction -Execute "cmd.exe" `
      -Argument "/c cd /d `"$AppRoot`" && npm run backup"
  $backupTrigger = New-ScheduledTaskTrigger -Daily -At 8pm
  Register-ScheduledTask -TaskName $TaskBack -Action $backupAction -Trigger $backupTrigger `
      -Description "Nightly RevenueOS backup." -Force | Out-Null
  Ok "'$TaskBack' runs nightly at 20:00"
}
finally { Pop-Location }

# ------------------------------------------------------------------ Finish
Write-Host "`nInstalled." -ForegroundColor Green
Write-Host @"

Do these four things now, in order:

  1. Start it:            $AppRoot\start-revenueos.bat
  2. Open it:             http://localhost:3322
                          The first screen creates the office's account.
                          There is no default password by design.
  3. Sign in the CLI:     claude login
                          Use the OFFICE's Claude subscription. Photo
                          extraction bills whoever is signed in here.
                          Everything else works without it.
  4. Point backups off    setx REVENUEOS_BACKUP_DIR "D:\revenueos-backups"
     this disk:           then run:  npm run backup
                          Backups default to data\backups, which does NOT
                          survive losing this machine.

Then verify the backup can actually come back:

     npm run restore -- --list

A backup nobody has restored is a rumour.

Remote access over Tailscale is NOT enabled yet (RVOS-003 P5). The app is
bound to this machine only until then.
"@
