<#
.SYNOPSIS
  One-command launcher for the Georgian Stremio addon + a Cloudflare quick tunnel.

.DESCRIPTION
  Starts a cloudflared quick tunnel, waits for its public https URL, then starts
  the addon with PUBLIC_URL set to that URL (required so the in-addon stream proxy
  builds correct absolute links). Prints the install URL for a browser client such
  as stredio.vercel.app and copies it to the clipboard.

  Press Ctrl+C to stop both the addon and the tunnel.

.PARAMETER Port
  Local port for the addon (default 7000).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\start.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 7000
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$cf   = $null   # cloudflared process
$node = $null   # addon process

function Write-Step($msg)  { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Err2($msg)  { Write-Host "[ERR] $msg" -ForegroundColor Red }

# --- locate cloudflared (PATH, then known install locations) ---
function Find-Cloudflared {
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    "C:\Program Files (x86)\cloudflared\cloudflared.exe",
    "C:\Program Files\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

# --- free the port if a previous addon run is still holding it ---
# Only stops a *node* process that owns the port (avoids the stale-code / EADDRINUSE
# trap). Aborts if a non-node process holds the port, so we never kill the wrong app.
function Clear-PortIfNode([int]$p) {
  $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  foreach ($conn in $conns) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.ProcessName -eq 'node') {
      Write-Step "Port $p held by an old addon (node PID $($proc.Id)) - stopping it."
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
    } else {
      throw "Port $p is in use by '$($proc.ProcessName)' (PID $($proc.Id)), not the addon. Free it or pass -Port <other>."
    }
  }
}

try {
  # 0. sanity checks
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node not found on PATH. Install Node.js first." }
  if (-not (Test-Path (Join-Path $root 'index.js')))         { throw "index.js not found in $root." }
  if (-not (Test-Path (Join-Path $root 'node_modules')))     { Write-Step "node_modules missing - running npm install..."; npm install | Out-Null }
  $cloudflared = Find-Cloudflared
  if (-not $cloudflared) { throw "cloudflared not found. Install it with:  winget install Cloudflare.cloudflared" }
  Write-Ok "cloudflared: $cloudflared"

  Clear-PortIfNode $Port

  # log files (matched by *.log in .gitignore)
  $cfOut    = Join-Path $root '.cf.out.log'
  $cfErr    = Join-Path $root '.cf.err.log'
  $addonOut = Join-Path $root '.addon.out.log'
  $addonErr = Join-Path $root '.addon.err.log'
  Remove-Item $cfOut,$cfErr,$addonOut,$addonErr -ErrorAction SilentlyContinue

  # 1. start the tunnel
  Write-Step "Starting Cloudflare tunnel -> http://localhost:$Port ..."
  $cf = Start-Process -FilePath $cloudflared `
    -ArgumentList @('tunnel','--url',"http://localhost:$Port",'--no-autoupdate') `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $cfOut -RedirectStandardError $cfErr

  # 2. wait for the public URL (cloudflared prints it to its banner)
  $tunnelUrl = $null
  $deadline = (Get-Date).AddSeconds(45)
  while (-not $tunnelUrl -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    if ($cf.HasExited) { throw "cloudflared exited early:`n$(Get-Content $cfErr -Raw -ErrorAction SilentlyContinue)" }
    $text = ((Get-Content $cfErr -Raw -ErrorAction SilentlyContinue), (Get-Content $cfOut -Raw -ErrorAction SilentlyContinue)) -join "`n"
    $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) { $tunnelUrl = $m.Value }
  }
  if (-not $tunnelUrl) { throw "Timed out waiting for the tunnel URL. See $cfErr" }
  Write-Ok "Tunnel: $tunnelUrl"

  # 3. start the addon with PUBLIC_URL pointing at the tunnel
  Write-Step "Starting addon on port $Port with PUBLIC_URL=$tunnelUrl ..."
  $env:PUBLIC_URL = $tunnelUrl
  $env:PORT = "$Port"
  $node = Start-Process -FilePath 'node' -ArgumentList 'index.js' -WorkingDirectory $root `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $addonOut -RedirectStandardError $addonErr

  # 4. wait until the manifest answers
  $up = $false
  $deadline = (Get-Date).AddSeconds(25)
  while (-not $up -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 600
    if ($node.HasExited) { throw "addon exited early:`n$(Get-Content $addonErr -Raw -ErrorAction SilentlyContinue)" }
    try {
      $resp = Invoke-WebRequest "http://localhost:$Port/manifest.json" -UseBasicParsing -TimeoutSec 3
      if ($resp.StatusCode -eq 200) { $up = $true }
    } catch { }
  }
  if (-not $up) { throw "addon did not become ready. See $addonErr" }

  $installUrl = "$tunnelUrl/manifest.json"
  try { Set-Clipboard -Value $installUrl; $copied = ' (copied to clipboard)' } catch { $copied = '' }

  Write-Host ""
  Write-Ok "Everything is running."
  Write-Host "==================================================================" -ForegroundColor DarkGray
  Write-Host "  INSTALL URL$copied :" -ForegroundColor White
  Write-Host "  $installUrl" -ForegroundColor Yellow
  Write-Host "==================================================================" -ForegroundColor DarkGray
  Write-Host "  Paste it into stredio.vercel.app -> 'Install new addon'."
  Write-Host "  Keep this window open. Press Ctrl+C to stop the addon + tunnel."
  Write-Host ""

  # 5. block until either child dies (or Ctrl+C); cleanup happens in finally
  while (-not $cf.HasExited -and -not $node.HasExited) { Start-Sleep -Seconds 2 }
  if ($node.HasExited) { Write-Err2 "addon stopped unexpectedly. See $addonErr" }
  if ($cf.HasExited)   { Write-Err2 "tunnel stopped unexpectedly. See $cfErr" }
}
finally {
  Write-Host ""
  Write-Step "Shutting down..."
  foreach ($p in @($node, $cf)) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
  Write-Ok "Stopped."
}
