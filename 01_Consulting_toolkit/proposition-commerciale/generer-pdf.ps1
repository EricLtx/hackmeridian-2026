# Rebuilds the PDF from proposition.html (and the two SVG diagrams it references).
# Usage: powershell -ExecutionPolicy Bypass -File generer-pdf.ps1

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$html = Join-Path $here 'proposition.html'
$pdf  = Join-Path (Split-Path -Parent $here) 'proposition-commerciale-guichet-de-nuit.pdf'

$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Chrome or Edge not found.' }

# A throwaway profile keeps the headless run separate from any open browser window.
$profileDir = Join-Path $env:TEMP 'guichet-de-nuit-pdf-profile'
$uri = ([System.Uri]$html).AbsoluteUri

$browserArgs = @(
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    "--user-data-dir=`"$profileDir`"",
    "--print-to-pdf=`"$pdf`"",
    "`"$uri`""
)
Start-Process -FilePath $browser -ArgumentList $browserArgs -Wait -NoNewWindow

if (Test-Path $pdf) { Write-Output "PDF written: $pdf" } else { throw 'PDF was not produced.' }
