# Creates a Desktop shortcut for run-dev.bat with the custom icon.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/make-shortcut.ps1

$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Pretext Editor.lnk'

$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($lnk)

# Prefer the compiled launcher: it carries the icon embedded, so the shortcut
# and the running window both show it. Fall back to the bat if it is missing.
$exe = Join-Path $root 'Pretext-Editor.exe'
if (Test-Path $exe) {
  $s.TargetPath = $exe
  $s.IconLocation = $exe + ',0'
} else {
  $s.TargetPath = Join-Path $root 'run-dev.bat'
  $s.IconLocation = (Join-Path $root 'icon.ico') + ',0'
}
$s.WorkingDirectory = $root
$s.Description = 'Avvia il dev server di Pretext Editor (http://localhost:5190/)'
$s.Save()

Write-Output "Shortcut creato: $lnk"
