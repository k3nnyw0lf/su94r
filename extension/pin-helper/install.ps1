# Starts the pin helper now and every time you sign in to Windows (a per-user scheduled task).
# Run:  powershell -ExecutionPolicy Bypass -File install.ps1
# Undo: powershell -ExecutionPolicy Bypass -File uninstall.ps1
#
# The helper is copied to %USERPROFILE%\.su94r\pin-helper and runs from there, so a change
# that arrives through a synced folder never runs at sign-in by itself: run this installer
# again to take a new version. (Not AppData: some app packages redirect AppData writes, and
# Task Scheduler would then not find the script.)

$target = Join-Path $env:USERPROFILE '.su94r\pin-helper'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'pin-helper.ps1') -Destination (Join-Path $target 'pin-helper.ps1') -Force
$script = Join-Path $target 'pin-helper.ps1'

# Replace any running or older copy (including the old "Libre Mini" task) so the port is free.
foreach ($name in @('Libre Mini pin helper', 'su94r Mini pin helper')) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
  Where-Object { $_.CommandLine -like '*pin-helper.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'su94r Mini pin helper' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Keeps the su94r Mini glucose window on top when asked.' -Force | Out-Null

Start-ScheduledTask -TaskName 'su94r Mini pin helper'
Write-Host "Pin helper installed in $target and running. It starts automatically when you sign in to Windows."
