param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference='Stop'
$probeConfig=Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'windows-native-probe.cs')
$probeExit=[RoastDuckNativeProbe]::Run($probeConfig.node,[string[]]$probeConfig.arguments,$probeConfig.directory,$probeConfig.evidence)
exit $probeExit
