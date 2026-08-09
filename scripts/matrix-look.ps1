# Visual-only Matrix rain. Does NOT run any workers — just paints the console, then exits.
param([int]$Seconds = 3)

$ErrorActionPreference = "SilentlyContinue"
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $Host.UI.RawUI.BackgroundColor = "Black"
  $Host.UI.RawUI.ForegroundColor = "Green"
  [Console]::CursorVisible = $false
} catch {}

try {
  Add-Type -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetConsoleMode(IntPtr hConsoleHandle, int mode);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out int mode);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr GetStdHandle(int nStdHandle);
"@ -Name MatrixVis -Namespace VS -ErrorAction SilentlyContinue
  $hwnd = [VS.MatrixVis]::GetStdHandle(-11)
  $mode = 0
  if ([VS.MatrixVis]::GetConsoleMode($hwnd, [ref]$mode)) {
    [void][VS.MatrixVis]::SetConsoleMode($hwnd, ($mode -bor 0x0004))
  }
} catch {}

Clear-Host

$pool = New-Object System.Collections.Generic.List[char]
foreach ($c in [char[]]"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ@#$%&*=+/<>:;?") { [void]$pool.Add($c) }
foreach ($code in 0xFF66..0xFF9D) { [void]$pool.Add([char]$code) }
function RChar { $pool[(Get-Random -Maximum $pool.Count)] }

try {
  $W = [Math]::Max(40, [Console]::WindowWidth)
  $H = [Math]::Max(12, [Console]::WindowHeight - 1)
} catch { $W = 80; $H = 24 }

$heads  = New-Object int[] $W
$speeds = New-Object int[] $W
$lens   = New-Object int[] $W
$glyphs = New-Object 'char[,]' $H, $W
$age    = New-Object 'int[,]' $H, $W

for ($x = 0; $x -lt $W; $x++) {
  $heads[$x]  = Get-Random -Maximum $H
  $speeds[$x] = Get-Random -Minimum 1 -Maximum 3
  $lens[$x]   = Get-Random -Minimum ([Math]::Max(8, [int]($H * 0.45))) -Maximum ([Math]::Max(12, $H))
  for ($y = 0; $y -lt $H; $y++) { $glyphs[$y, $x] = [char]" "; $age[$y, $x] = 0 }
}

$ESC = [char]27
$until = (Get-Date).AddSeconds([Math]::Max(1, $Seconds))

while ((Get-Date) -lt $until) {
  for ($x = 0; $x -lt $W; $x++) {
    for ($y = 0; $y -lt $H; $y++) {
      if ($age[$y, $x] -gt 0 -and (Get-Random -Maximum 7) -eq 0) { $glyphs[$y, $x] = (RChar) }
    }
    $heads[$x] += $speeds[$x]
    $headY = $heads[$x]
    for ($s = 0; $s -lt $speeds[$x]; $s++) {
      $yy = $headY - $s
      if ($yy -ge 0 -and $yy -lt $H) { $glyphs[$yy, $x] = (RChar); $age[$yy, $x] = 3 }
    }
    for ($d = 1; $d -lt $lens[$x]; $d++) {
      $yy = $headY - $d
      if ($yy -lt 0 -or $yy -ge $H) { continue }
      if ($age[$yy, $x] -eq 0) { $glyphs[$yy, $x] = (RChar) }
      $age[$yy, $x] = $(if ($d -lt [Math]::Max(2, [int]($lens[$x] * 0.35))) { 2 } else { 1 })
    }
    $clearY = $headY - $lens[$x]
    if ($clearY -ge 0 -and $clearY -lt $H) { $age[$clearY, $x] = 0; $glyphs[$clearY, $x] = [char]" " }
    if (($heads[$x] - $lens[$x]) -gt $H) {
      $heads[$x] = -(Get-Random -Maximum 15)
      $speeds[$x] = Get-Random -Minimum 1 -Maximum 3
      $lens[$x] = Get-Random -Minimum ([Math]::Max(8, [int]($H * 0.45))) -Maximum ([Math]::Max(12, $H))
    }
  }

  $sb = New-Object System.Text.StringBuilder (($W + 24) * $H)
  [void]$sb.Append("$ESC[H")
  for ($y = 0; $y -lt $H; $y++) {
    for ($x = 0; $x -lt $W; $x++) {
      $a = $age[$y, $x]
      if ($a -le 0) { [void]$sb.Append("$ESC[40m "); continue }
      if ($a -ge 3) { [void]$sb.Append("$ESC[97;40m") }
      elseif ($a -eq 2) { [void]$sb.Append("$ESC[38;2;0;255;70;40m") }
      else { [void]$sb.Append("$ESC[38;2;0;100;25;40m") }
      [void]$sb.Append($glyphs[$y, $x])
    }
    if ($y -lt ($H - 1)) { [void]$sb.Append("`n") }
  }
  [void]$sb.Append("$ESC[0m")
  try { [Console]::Write($sb.ToString()) } catch {}
  Start-Sleep -Milliseconds 25
}

try {
  [Console]::Write("$ESC[0m")
  [Console]::CursorVisible = $true
  Clear-Host
} catch {}
exit 0
