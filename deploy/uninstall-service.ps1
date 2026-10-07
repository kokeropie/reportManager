# Removes the Report Server Windows service. Does not delete the app, .env, reports\ or the database.
param(
  [Parameter(Mandatory = $true)][string]$NssmPath,
  [string]$ServiceName = 'ReportServer'
)
$ErrorActionPreference = 'Stop'
& $NssmPath stop $ServiceName
& $NssmPath remove $ServiceName confirm
