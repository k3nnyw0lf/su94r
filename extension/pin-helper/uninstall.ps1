# Stops the pin helper and removes its sign-in task and its copy in %USERPROFILE%\.su94r.
foreach ($name in @('su94r Mini pin helper', 'Libre Mini pin helper')) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
  Where-Object { $_.CommandLine -like '*pin-helper.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE '.su94r\pin-helper') -ErrorAction SilentlyContinue
Write-Host 'Pin helper removed.'
