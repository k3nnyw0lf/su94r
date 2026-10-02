# Sets up su94r Mini on this computer:
#   1. copies this folder path to the clipboard,
#   2. opens the browser extensions page,
#   3. installs the pin helper (keeps the glucose window on top, starts at sign-in).
# Then: turn on Developer mode, click Load unpacked, paste the path, Select Folder.

$here = $PSScriptRoot
Set-Clipboard -Value $here

$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chrome) { Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions' }
else { Start-Process 'msedge.exe' -ArgumentList 'edge://extensions' }

& (Join-Path $here 'pin-helper\install.ps1')

Write-Host ''
Write-Host 'Folder path copied. In the extensions page:'
Write-Host '  1. Turn on Developer mode (top right).'
Write-Host '  2. Click Load unpacked, press Ctrl+V in the folder box, then Select Folder.'
Write-Host '  3. Sign in to LibreLinkUp in the settings page that opens.'
