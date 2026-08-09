# VS System — Matrix-style console boot splash (Windows)
param(
  [Parameter(Mandatory = $false)]
  [string]$Label = "BOOT"
)

$ErrorActionPreference = "SilentlyContinue"

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

try {
  $Host.UI.RawUI.BackgroundColor = "Black"
  $Host.UI.RawUI.ForegroundColor = "Green"
  $Host.UI.RawUI.WindowTitle = "VS SYSTEM — MATRIX"
} catch {}

Clear-Host

# Latin + digits + symbols + half-width Katakana (renders well in modern Windows consoles)
$pool = [System.Collections.Generic.List[string]]::new()
foreach ($c in "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$%&*=+/<>:;?".ToCharArray()) {
  [void]$pool.Add([string]$c)
}
foreach ($code in 0xFF66..0xFF9D) {
  [void]$pool.Add([string][char]$code)
}

function Get-RainChar {
  return $pool[(Get-Random -Maximum $pool.Count)]
}

try {
  $w = [Math]::Max(48, [Console]::WindowWidth)
  $h = [Math]::Max(18, [Console]::WindowHeight - 1)
} catch {
  $w = 80
  $h = 24
}

# One stream every other column (classic dense Matrix look)
$colCount = [Math]::Floor($w / 2)
if ($colCount -lt 8) { $colCount = 8 }

$heads = New-Object int[] $colCount
$speeds = New-Object int[] $colCount
$lens = New-Object int[] $colCount
for ($i = 0; $i -lt $colCount; $i++) {
  $heads[$i] = Get-Random -Maximum $h
  $speeds[$i] = Get-Random -Minimum 1 -Maximum 3
  $lens[$i] = Get-Random -Minimum 6 -Maximum ([Math]::Max(8, $h - 2))
}

$frames = 32
for ($f = 0; $f -lt $frames; $f++) {
  $sb = New-Object System.Text.StringBuilder (($w + 1) * $h)
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      if (($x % 2) -ne 0) {
        [void]$sb.Append(" ")
        continue
      }
      $ci = [Math]::Floor($x / 2)
      if ($ci -ge $colCount) {
        [void]$sb.Append(" ")
        continue
      }
      $dist = $heads[$ci] - $y
      if ($dist -ge 0 -and $dist -lt $lens[$ci]) {
        [void]$sb.Append((Get-RainChar))
      } else {
        [void]$sb.Append(" ")
      }
    }
    [void]$sb.Append("`r`n")
  }

  try { [Console]::SetCursorPosition(0, 0) } catch {}
  Write-Host -NoNewline $sb.ToString() -ForegroundColor Green

  for ($i = 0; $i -lt $colCount; $i++) {
    $heads[$i] = $heads[$i] + $speeds[$i]
    if (($heads[$i] - $lens[$i]) -gt $h) {
      $heads[$i] = Get-Random -Maximum 3
      $speeds[$i] = Get-Random -Minimum 1 -Maximum 3
      $lens[$i] = Get-Random -Minimum 6 -Maximum ([Math]::Max(8, $h - 2))
    }
  }
  Start-Sleep -Milliseconds 35
}

Clear-Host
Write-Host ""
Write-Host "  ==========================================================" -ForegroundColor DarkGreen
Write-Host "                                                              " -ForegroundColor Green
Write-Host "      V S   S Y S T E M                                       " -ForegroundColor Green
Write-Host "      >>> MATRIX BOOT SEQUENCE                                " -ForegroundColor Green
Write-Host ("      >>> MODE: {0,-44}" -f $Label.ToUpper()) -ForegroundColor Green
Write-Host "                                                              " -ForegroundColor Green
Write-Host "  ==========================================================" -ForegroundColor DarkGreen
Write-Host ""
Write-Host "  Wake up, operator..." -ForegroundColor DarkGreen
Start-Sleep -Milliseconds 450
Write-Host "  The Matrix has you..." -ForegroundColor DarkGreen
Start-Sleep -Milliseconds 450
Write-Host "  Follow the white rabbit." -ForegroundColor DarkGreen
Start-Sleep -Milliseconds 350
Write-Host ""
Write-Host "  [OK] console link established" -ForegroundColor Green
Write-Host ""
Start-Sleep -Milliseconds 250
