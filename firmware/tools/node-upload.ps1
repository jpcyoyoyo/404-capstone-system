<#
.SYNOPSIS
  Uploads new firmware to a sensing node over Wi-Fi (fallback if the Arduino IDE's network port
  does not show, or does not ask for the password).

.DESCRIPTION
  1. In the Arduino IDE, with the right board selected (NodeMCU 1.0 for Node A, ESP32 Dev Module
     for Node B): Sketch > Export Compiled Binary. The .bin lands in greenhouse_node\build\.
  2. Run this script with the node's address. It asks for the node's OTA password (typed hidden),
     picks the newest exported .bin for that board, and sends it with the board package's espota tool.
  The board type is taken from the .bin's build folder: ESP8266 nodes listen on port 8266, ESP32 on
  3232, so a .bin for the wrong board finds no listener instead of being written.
  Windows may ask to allow python3 / espota through the firewall: allow it on this network, because
  the node connects back to the laptop to fetch the file.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\firmware\tools\node-upload.ps1 -Node gh-node-a.local -Board esp8266
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\firmware\tools\node-upload.ps1 -Node 192.168.1.24 -Board esp32
#>
param(
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][ValidateSet("esp8266", "esp32")][string]$Board,
  [string]$Bin = ""
)
$ErrorActionPreference = "Stop"
$sketch = Join-Path $PSScriptRoot "..\greenhouse_node"
$pkgs = Join-Path $env:LOCALAPPDATA "Arduino15\packages"

if (-not $Bin) {
  $f = Get-ChildItem -Path (Join-Path $sketch "build") -Recurse -Filter "greenhouse_node.ino.bin" -ErrorAction SilentlyContinue |
       Where-Object { $_.DirectoryName -match ("\\" + $Board + "\." + $Board + "\.") } |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $f) { Write-Host "No exported $Board .bin found. In the Arduino IDE: Sketch > Export Compiled Binary." -ForegroundColor Red; exit 1 }
  $Bin = $f.FullName
}
Write-Host "Firmware: $Bin ($((Get-Item $Bin).LastWriteTime))"

if ($Board -eq "esp8266") {
  $espota = Get-ChildItem "$pkgs\esp8266\hardware\esp8266\*\tools\espota.py" | Sort-Object FullName -Descending | Select-Object -First 1
  $py = Get-ChildItem "$pkgs\esp8266\tools\python3\*\python3.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $espota -or -not $py) { Write-Host "ESP8266 board package not found under $pkgs." -ForegroundColor Red; exit 1 }
  $exe = $py.FullName; $pre = @("-I", $espota.FullName); $port = 8266
} else {
  $espota = Get-ChildItem "$pkgs\esp32\hardware\esp32\*\tools\espota.exe" | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $espota) { Write-Host "ESP32 board package not found under $pkgs." -ForegroundColor Red; exit 1 }
  $exe = $espota.FullName; $pre = @("-r"); $port = 3232
}

$sec = Read-Host -AsSecureString "OTA password for $Node"
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  & $exe @pre -i $Node -p $port "--auth=$pw" -f $Bin
  $code = $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  $pw = $null
}
if ($code -eq 0) { Write-Host "Upload finished; the node restarts on the new firmware." -ForegroundColor Green }
else { Write-Host "Upload failed (exit $code). Check the password, the firewall prompt, and that the node is online." -ForegroundColor Red }
exit $code
