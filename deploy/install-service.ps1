# Installs Report Server as a Windows service with NSSM (https://nssm.cc).
# Run from an elevated PowerShell. Works on PowerShell 3.0 (Windows Server 2012).
#
#   .\deploy\install-service.ps1 -NssmPath C:\tools\nssm\nssm.exe
#   .\deploy\install-service.ps1 -NssmPath C:\tools\nssm\nssm.exe -SqlServerService MSSQLSERVER -Port 3000
#
# Not yet run on a real server. Read it once before using it.
param(
  [Parameter(Mandatory = $true)][string]$NssmPath,
  [string]$ServiceName = 'ReportServer',
  [string]$AppDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$NodePath = '',
  [int]$Port = 3000,
  [string]$SqlServerService = ''   # set when the app database is on this same machine, so we start after it
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $NssmPath)) { throw "nssm.exe not found at $NssmPath" }
if (-not $NodePath) { $NodePath = [string]@(Get-Command node.exe -ErrorAction Stop)[0].Source }
$NssmPath = ([string]$NssmPath).Trim()
$NodePath = ([string]$NodePath).Trim()
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) { throw "node.exe not found (got '$NodePath'). Pass -NodePath C:\path\to\node.exe" }
Write-Host "NSSM: $NssmPath"; Write-Host "Node: $NodePath"; Write-Host "App:  $AppDir"
if (-not (Test-Path (Join-Path $AppDir '.env'))) { throw "No .env in $AppDir. Copy .env.example to .env and fill it in first." }
if (-not (Test-Path (Join-Path $AppDir 'node_modules'))) { throw "No node_modules in $AppDir. Run: npm ci --omit=dev" }

$nodeVersion = & $NodePath -v
Write-Host "Using Node $nodeVersion at $NodePath"

$logDir = Join-Path $AppDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

& $NssmPath install $ServiceName $NodePath 'server.js'
& $NssmPath set $ServiceName AppDirectory $AppDir
& $NssmPath set $ServiceName DisplayName 'Report Server'
& $NssmPath set $ServiceName Description 'SSRS-style RDL report viewer'
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath set $ServiceName AppStdout (Join-Path $logDir 'out.log')
& $NssmPath set $ServiceName AppStderr (Join-Path $logDir 'error.log')
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateOnline 1
& $NssmPath set $ServiceName AppRotateBytes 10485760
# Restart on failure, with a short pause so a bad config does not spin the CPU
& $NssmPath set $ServiceName AppExit Default Restart
& $NssmPath set $ServiceName AppRestartDelay 5000
& $NssmPath set $ServiceName AppThrottle 10000
if ($SqlServerService) { & $NssmPath set $ServiceName DependOnService $SqlServerService }

# Allow the web port on the local network
$ruleName = "$ServiceName (TCP $Port)"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Domain,Private | Out-Null
  Write-Host "Firewall rule added for TCP $Port (Domain and Private profiles)"
}

& $NssmPath start $ServiceName
Start-Sleep -Seconds 4
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/healthz"
  Write-Host "Health check: $($r.StatusCode) $($r.Content)"
} catch {
  Write-Warning "Health check failed. Look at $logDir\error.log"
}
