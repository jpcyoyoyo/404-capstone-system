<#
.SYNOPSIS
  Opens a sensing node's network log from the laptop over Wi-Fi: no USB cable, nothing to install.

.DESCRIPTION
  Connects to the node on port 23, asks for the node's OTA password (typed hidden, never stored),
  then shows everything the node prints, as in the Serial Monitor. Type a command and press Enter:
  help, status, read, soil [n], scan, reboot, quit. Ctrl+C also leaves.
  The laptop must be on the same Wi-Fi as the node, and the node's firmware must have OTA_PASS.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\firmware\tools\node-log.ps1 -Node gh-node-a.local
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\firmware\tools\node-log.ps1 -Node 192.168.1.23 -LogFile A10_soil.txt
#>
param(
  [Parameter(Mandatory = $true)][string]$Node,   # IP address, or gh-node-a.local / gh-node-b.local
  [int]$Port = 23,
  [string]$LogFile = ""                          # optional: also save the output to this text file
)

$enc = New-Object System.Text.UTF8Encoding($false)
if ($LogFile) { $LogFile = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $LogFile)) }
$client = New-Object System.Net.Sockets.TcpClient
try {
  $wait = $client.BeginConnect($Node, $Port, $null, $null)
  if (-not $wait.AsyncWaitHandle.WaitOne(5000)) { throw "no answer within 5 s" }
  $client.EndConnect($wait)
} catch {
  Write-Host "Could not reach $Node on port $Port ($($_.Exception.Message))." -ForegroundColor Red
  Write-Host "Check: the node is powered and on the same Wi-Fi as this laptop; its firmware has OTA_PASS;"
  Write-Host "try its IP address (ghctl hw watch on the Pi shows it) instead of the .local name."
  exit 1
}
$stream = $client.GetStream()
$buf = New-Object byte[] 2048
$iacSkip = 0

function Show([string]$text) {
  if (-not $text) { return }
  [Console]::Write($text)
  if ($LogFile) { [System.IO.File]::AppendAllText($LogFile, $text, $enc) }
}

# Reads whatever has arrived; drops telnet option bytes (255 + 2 bytes).
function Read-Available {
  $keep = New-Object System.Collections.Generic.List[byte]
  while ($stream.DataAvailable) {
    $n = $stream.Read($buf, 0, $buf.Length)
    for ($i = 0; $i -lt $n; $i++) {
      if ($script:iacSkip -gt 0) { $script:iacSkip--; continue }
      if ($buf[$i] -eq 255) { $script:iacSkip = 2; continue }
      $keep.Add($buf[$i])
    }
  }
  if ($keep.Count -gt 0) { return $enc.GetString($keep.ToArray()) }
  return ""
}

function Send-Line([string]$s) {
  $b = $enc.GetBytes($s + "`r`n")
  $stream.Write($b, 0, $b.Length)
}

function Wait-Text([int]$ms) {
  $all = ""
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalMilliseconds -lt $ms) {
    $t = Read-Available
    if ($t) { $all += $t; Show $t }
    Start-Sleep -Milliseconds 50
  }
  return $all
}

function Test-Closed {
  return ($client.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $client.Available -eq 0)
}

try {
  if ($LogFile) { Write-Host "Saving the output to $LogFile" }
  [void](Wait-Text 1500)                       # banner and "password:" prompt
  $ok = $false
  for ($try = 1; $try -le 3 -and -not $ok; $try++) {
    $sec = Read-Host -AsSecureString " "
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { Send-Line ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    $reply = Wait-Text 2500
    if ($reply -match "ok\. Type help") { $ok = $true }
    elseif (Test-Closed) { break }
  }
  if (-not $ok) { Write-Host "`nNot logged in." -ForegroundColor Red; exit 1 }

  Write-Host "Connected to $Node. Type a command and press Enter (help lists them); quit or Ctrl+C to leave." -ForegroundColor Green
  $line = ""
  while ($true) {
    Show (Read-Available)
    while ([Console]::KeyAvailable) {
      $k = [Console]::ReadKey($true)
      if ($k.Key -eq [ConsoleKey]::Enter) {
        [Console]::WriteLine()
        Send-Line $line
        $line = ""
      } elseif ($k.Key -eq [ConsoleKey]::Backspace) {
        if ($line.Length -gt 0) { $line = $line.Substring(0, $line.Length - 1); [Console]::Write("`b `b") }
      } elseif ([int]$k.KeyChar -ge 32) {
        $line += $k.KeyChar
        [Console]::Write($k.KeyChar)
      }
    }
    if (Test-Closed) { Show (Read-Available); Write-Host "`nThe node closed the connection." -ForegroundColor Yellow; break }
    Start-Sleep -Milliseconds 30
  }
} finally {
  $client.Close()
}
