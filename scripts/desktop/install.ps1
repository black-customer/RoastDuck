param([string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'))

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$messages = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'messages.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$desktopPath = (Resolve-Path -LiteralPath $DesktopDirectory).Path
$shortcutPath = Join-Path $desktopPath $messages.shortcutName
$launcher = Join-Path $PSScriptRoot 'start.mjs'
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$icon = Join-Path $ProjectRoot 'assets\desktop\app.ico'
if (-not (Test-Path -LiteralPath $icon)) { throw 'Run node scripts/desktop/build-icon.mjs first.' }
$shell = New-Object -ComObject WScript.Shell
try {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ((Test-Path -LiteralPath $shortcutPath) -and -not $shortcut.Arguments.Contains($launcher)) {
        throw 'A different shortcut already uses this name; nothing was overwritten.'
    }
    $shortcut.TargetPath = $nodeCommand.Source
    $shortcut.Arguments = '"' + $launcher + '"'
    $shortcut.WorkingDirectory = $ProjectRoot
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Description = $messages.description
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    if (-not [IO.File]::Exists($shortcutPath)) { throw "Shortcut save did not create a file: $shortcutPath" }
    $saved = $shell.CreateShortcut($shortcutPath)
    if ($saved.Arguments -ne $shortcut.Arguments -or $saved.IconLocation -ne $shortcut.IconLocation) {
        throw 'Shortcut verification failed.'
    }
    Write-Output $shortcutPath
} finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
