# One-step setup for Windows Server 2012 (PowerShell 3.0 compatible). Run from an elevated PowerShell
# inside the unzipped app folder:
#
#   powershell -ExecutionPolicy Bypass -File .\deploy\setup-windows.ps1
#
# It checks Node, creates .env with fresh secrets, optionally creates the SQL Server database,
# installs the Windows service with NSSM, checks /healthz, then removes the first-admin password from .env.
# Safe to run again: an existing .env is never overwritten.
param(
  [string]$NssmPath = '',
  [int]$Port = 3000
)
$ErrorActionPreference = 'Stop'
$AppDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $AppDir

function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Ask($prompt, $default) {
  $suffix = ''; if ($default) { $suffix = " [$default]" }
  $v = Read-Host "$prompt$suffix"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v
}
function AskSecret($prompt) {
  $s = Read-Host $prompt -AsSecureString
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}
function RandomHex($bytes) {
  $b = New-Object byte[] $bytes
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $rng.GetBytes($b)
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}
# dotenv: single quotes keep every character as typed
function EnvQuote($v) {
  if ($v -notmatch "'") { return "'$v'" }
  if ($v -notmatch '"') { return '"' + $v + '"' }
  throw 'A value contains both single and double quotes. Use a password without quotes.'
}
function WriteUtf8($path, $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false)) }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this from an elevated (Run as administrator) PowerShell.' }

# ---- 1. Node ----
Step '1/6 Checking Node.js'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js was not found.' -ForegroundColor Yellow
  Write-Host 'Install Node.js 16 (Windows 64-bit .msi) from https://nodejs.org/dist/latest-v16.x/ and run this script again.'
  Write-Host 'Node 16 is the newest version that runs on Windows Server 2012 R2.'
  exit 1
}
$ver = (& node.exe -v).Trim()
Write-Host "Found Node $ver at $($node.Source)"
$major = [int](($ver.TrimStart('v')).Split('.')[0])
if ($major -lt 16) { throw "Node $ver is too old. Install Node 16." }
if ($major -gt 16) { Write-Warning "Node $ver is newer than 16. That is fine if it runs on this server; the app is tested for 16." }

# ---- 2. Dependencies ----
Step '2/6 Checking dependencies'
if (Test-Path (Join-Path $AppDir 'node_modules\express')) {
  Write-Host 'node_modules is present (release package).'
} else {
  Write-Host 'node_modules is missing, running: npm ci --omit=dev (needs internet access to the npm registry)'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  & npm.cmd ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Use the release zip, which already contains node_modules.' }
}

# ---- 3. .env ----
Step '3/6 Configuration (.env)'
$envPath = Join-Path $AppDir '.env'
$adminUser = 'admin'
$createdEnv = $false
if (Test-Path $envPath) {
  Write-Host '.env already exists, keeping it.'
} else {
  Write-Host 'Answer a few questions. Secrets are generated for you.'
  $dbServer = Ask 'SQL Server host (where the app database lives)' 'localhost'
  $dbPort = Ask 'SQL Server port' '1433'
  $dbName = Ask 'App database name' 'ReportServer'
  $dbUser = Ask 'App database login' 'report_app'
  $dbPass = AskSecret 'App database password'
  $trust = Ask 'Trust the SQL Server certificate? (true if it is self-signed)' 'true'
  $adminUser = Ask 'First admin username' 'admin'
  $adminPass = AskSecret 'First admin password (min 8 characters)'
  if ($adminPass.Length -lt 8) { throw 'The admin password must be at least 8 characters.' }

  $tpl = Get-Content (Join-Path $AppDir '.env.example') | ForEach-Object { $_ }
  $map = @{
    'PORT' = "$Port"; 'SESSION_SECRET' = (RandomHex 48); 'ENCRYPTION_KEY' = (RandomHex 32)
    'APP_DB_SERVER' = $dbServer; 'APP_DB_PORT' = $dbPort; 'APP_DB_NAME' = $dbName
    'APP_DB_USER' = (EnvQuote $dbUser); 'APP_DB_PASSWORD' = (EnvQuote $dbPass); 'APP_DB_TRUST_CERT' = $trust
    'ADMIN_USERNAME' = $adminUser; 'ADMIN_PASSWORD' = (EnvQuote $adminPass)
  }
  $out = foreach ($line in $tpl) {
    $m = [regex]::Match($line, '^([A-Z_]+)=')
    if ($m.Success -and $map.ContainsKey($m.Groups[1].Value)) { "$($m.Groups[1].Value)=$($map[$m.Groups[1].Value])" } else { $line }
  }
  WriteUtf8 $envPath (($out -join "`r`n") + "`r`n")
  $createdEnv = $true
  Write-Host ".env written. BACK UP the ENCRYPTION_KEY line somewhere safe: without it, stored connection passwords cannot be read."

  # ---- 4. Database ----
  Step '4/6 App database'
  $sqlcmd = Get-Command sqlcmd.exe -ErrorAction SilentlyContinue
  if ($sqlcmd) {
    $go = Ask "sqlcmd found. Create database '$dbName' and login '$dbUser' now using your Windows account? (y/n)" 'n'
    if ($go -eq 'y') {
      & sqlcmd.exe -S "$dbServer,$dbPort" -E -b -i (Join-Path $AppDir 'deploy\create-database.sql') -v DbName="$dbName" LoginName="$dbUser" LoginPassword="$dbPass"
      if ($LASTEXITCODE -ne 0) { Write-Warning 'sqlcmd reported an error. Create the database by hand with deploy\create-database.sql.' }
    }
  } else {
    Write-Host 'sqlcmd was not found. Create the database yourself with deploy\create-database.sql (SSMS, SQLCMD mode).'
  }
  Read-Host 'Press Enter once the database and login exist (SQL Server must allow TCP/IP and SQL logins)' | Out-Null
}

# ---- 5. Service ----
Step '5/6 Windows service'
if (-not $NssmPath) {
  foreach ($c in @('C:\tools\nssm\nssm.exe', (Join-Path $AppDir 'deploy\nssm.exe'))) { if (Test-Path $c) { $NssmPath = $c; break } }
  if (-not $NssmPath) { $g = Get-Command nssm.exe -ErrorAction SilentlyContinue; if ($g) { $NssmPath = $g.Source } }
}
if (-not $NssmPath) {
  $dl = Ask 'NSSM (the service wrapper) was not found. Download it from nssm.cc now? (y/n)' 'y'
  if ($dl -eq 'y') {
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $zip = Join-Path $env:TEMP 'nssm-2.24.zip'
      Invoke-WebRequest -UseBasicParsing -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $tmp = Join-Path $env:TEMP 'nssm-extract'
      if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
      [IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
      $arch = 'win32'; if ([Environment]::Is64BitOperatingSystem) { $arch = 'win64' }
      New-Item -ItemType Directory -Force -Path 'C:\tools\nssm' | Out-Null
      Copy-Item (Join-Path $tmp "nssm-2.24\$arch\nssm.exe") 'C:\tools\nssm\nssm.exe' -Force
      $NssmPath = 'C:\tools\nssm\nssm.exe'
    } catch { Write-Warning "Download failed: $($_.Exception.Message)" }
  }
}
if (-not $NssmPath) {
  Write-Host 'Download NSSM from https://nssm.cc/download, put nssm.exe in C:\tools\nssm\, then run:' -ForegroundColor Yellow
  Write-Host '  .\deploy\setup-windows.ps1'
  exit 1
}
Write-Host "Using NSSM at $NssmPath"
$sqlSvc = ''
$local = Get-Service -Name 'MSSQLSERVER' -ErrorAction SilentlyContinue
if ($local) { $sqlSvc = 'MSSQLSERVER'; Write-Host 'SQL Server runs on this machine, so the service will start after it.' }
if (Get-Service -Name 'ReportServer' -ErrorAction SilentlyContinue) {
  Write-Host 'The ReportServer service already exists. Restarting it.'
  & $NssmPath restart ReportServer | Out-Null
} else {
  & (Join-Path $AppDir 'deploy\install-service.ps1') -NssmPath $NssmPath -AppDir $AppDir -NodePath $node.Source -Port $Port -SqlServerService $sqlSvc
}

# ---- 6. Health check and first-admin cleanup ----
Step '6/6 Health check'
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/healthz"; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { }
  Start-Sleep -Seconds 2
}
if ($ok) {
  Write-Host "Report Server is up: http://$($env:COMPUTERNAME):$Port" -ForegroundColor Green
  if ($createdEnv) {
    $lines = Get-Content $envPath | ForEach-Object { if ($_ -match '^ADMIN_PASSWORD=') { 'ADMIN_PASSWORD=' } else { $_ } }
    WriteUtf8 $envPath (($lines -join "`r`n") + "`r`n")
    Write-Host "The first admin '$adminUser' exists. ADMIN_PASSWORD was removed from .env."
  }
  Write-Host 'Next: sign in, add connections, upload reports. See README.md "First real run checklist".'
} else {
  Write-Warning "The service did not answer on port $Port. Read $AppDir\logs\error.log"
  exit 1
}
