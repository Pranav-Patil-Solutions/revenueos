# RevenueOS — Windows uninstall (RVOS-003 P4)
#
#   powershell -ExecutionPolicy Bypass -File install\windows\uninstall.ps1
#
# ============================ WINDOWS-UNVERIFIED ============================
# Authored on macOS, never executed on Windows. See setup.ps1.
# ===========================================================================
#
# Removes the scheduled tasks and the launcher. DELIBERATELY LEAVES `data\`
# alone — it holds the client's books, their uploaded ledger photos and their
# backups. An uninstaller that deletes accounting records because someone was
# tidying up is a disaster with a progress bar. Removing the books is a
# separate, manual, deliberate act.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$AppRoot  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$DataDir  = Join-Path $AppRoot "data"
$TaskApp  = "RevenueOS"
$TaskBack = "RevenueOS Backup"

foreach ($task in @($TaskApp, $TaskBack)) {
  $existing = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    Write-Host "Removed scheduled task '$task'" -ForegroundColor Green
  } else {
    Write-Host "No scheduled task '$task'" -ForegroundColor Yellow
  }
}

$startCmd = Join-Path $AppRoot "start-revenueos.bat"
if (Test-Path $startCmd) {
  Remove-Item $startCmd -Force
  Write-Host "Removed launcher" -ForegroundColor Green
}

Write-Host @"

RevenueOS will no longer start automatically.

YOUR BOOKS HAVE NOT BEEN TOUCHED. They are still in:

    $DataDir

That folder holds the ledger database, the uploaded ledger photos and every
backup. Copy it somewhere safe before you delete anything, and check the copy
opens — see: npm run restore -- --list
"@
