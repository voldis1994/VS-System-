# Real Matrix digital rain — console fills with cascading green code (like the classic look).
# Optional: run a .bat worker underneath; its latest stdout line flashes inside the rain.
param(
  [string]$Worker = "",
  [string]$WorkerArg = "--worker",
  [int]$MinSeconds = 0,
  [switch]$StayOpen
)

$ErrorActionPreference = "SilentlyContinue"

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
  $Host.UI.RawUI.BackgroundColor = "Black"
  $Host.UI.RawUI.ForegroundColor = "Green"
  $Host.UI.RawUI.WindowTitle = "VS System"
  [Console]::CursorVisible = $false
} catch {}

# VT / ANSI colors (Windows 10+)
try {
  Add-Type -MemberDefinition @"
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetConsoleMode(IntPtr hConsoleHandle, int mode);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out int mode);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr GetStdHandle(int nStdHandle);
"@ -Name MatrixConsole -Namespace VS -ErrorAction SilentlyContinue
  $hwnd = [VS.MatrixConsole]::GetStdHandle(-11)
  $mode = 0
  if ([VS.MatrixConsole]::GetConsoleMode($hwnd, [ref]$mode)) {
    [void][VS.MatrixConsole]::SetConsoleMode($hwnd, ($mode -bor 0x0004))
  }
} catch {}

Clear-Host

$pool = New-Object System.Collections.Generic.List[char]
foreach ($c in [char[]]"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@#$%&*=+/<>:;?") {
  [void]$pool.Add($c)
}
foreach ($code in 0xFF66..0xFF9D) { [void]$pool.Add([char]$code) }
foreach ($c in [char[]]"ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ") {
  if (-not $pool.Contains($c)) { [void]$pool.Add($c) }
}
function RChar { return $pool[(Get-Random -Maximum $pool.Count)] }

try {
  $W = [Math]::Max(40, [Console]::WindowWidth)
  $H = [Math]::Max(12, [Console]::WindowHeight - 1)
} catch {
  $W = 80; $H = 24
}

$heads  = New-Object int[] $W
$speeds = New-Object int[] $W
$lens   = New-Object int[] $W
$glyphs = New-Object 'char[,]' $H, $W
$age    = New-Object 'int[,]' $H, $W

for ($x = 0; $x -lt $W; $x++) {
  $heads[$x]  = Get-Random -Maximum $H
  $speeds[$x] = Get-Random -Minimum 1 -Maximum 3
  $lens[$x]   = Get-Random -Minimum ([Math]::Max(5, [int]($H * 0.3))) -Maximum ([Math]::Max(9, $H))
  for ($y = 0; $y -lt $H; $y++) {
    $glyphs[$y, $x] = [char]" "
    $age[$y, $x] = 0
  }
}

$ESC = [char]27
$statusLine = ""
$statusUntil = [datetime]::MinValue
$started = Get-Date
$worker = $null
$logPath = $null
$workerExit = $null
$done = $false

if ($Worker -and (Test-Path -LiteralPath $Worker)) {
  $logPath = Join-Path $env:TEMP ("vs-matrix-" + [guid]::NewGuid().ToString("n") + ".log")
  New-Item -Path $logPath -ItemType File -Force | Out-Null

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  # cmd /c ""C:\path\file.bat" --worker > "log" 2>&1"
  $psi.Arguments = "/c \"\"$Worker\" $WorkerArg > \"$logPath\" 2>&1\""
  $psi.WorkingDirectory = Split-Path -Parent $Worker
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true

  $worker = New-Object System.Diagnostics.Process
  $worker.StartInfo = $psi
  [void]$worker.Start()
}

function Write-RainFrame([string]$status) {
  $sb = New-Object System.Text.StringBuilder (($W + 24) * $H)
  [void]$sb.Append("$ESC[H")
  $statusRow = [int][Math]::Floor($H / 2)
  $statusChars = $null
  if ($status) {
    $pad = [Math]::Max(0, [int][Math]::Floor(($W - $status.Length) / 2))
    $line = ((" " * $pad) + $status)
    if ($line.Length -gt $W) { $line = $line.Substring(0, $W) }
    $statusChars = $line.PadRight($W).ToCharArray()
  }

  for ($y = 0; $y -lt $H; $y++) {
    for ($x = 0; $x -lt $W; $x++) {
      if ($statusChars -and $y -eq $statusRow -and $statusChars[$x] -ne [char]" ") {
        [void]$sb.Append("$ESC[97;40m")
        [void]$sb.Append($statusChars[$x])
        continue
      }
      $a = $age[$y, $x]
      if ($a -le 0) {
        [void]$sb.Append("$ESC[40m ")
        continue
      }
      if ($a -ge 3) { [void]$sb.Append("$ESC[97;40m") }
      elseif ($a -eq 2) { [void]$sb.Append("$ESC[38;2;0;255;70;40m") }
      else { [void]$sb.Append("$ESC[38;2;0;100;25;40m") }
      [void]$sb.Append($glyphs[$y, $x])
    }
    if ($y -lt ($H - 1)) { [void]$sb.Append("`n") }
  }
  [void]$sb.Append("$ESC[0m")
  [Console]::Write($sb.ToString())
}

$keyExit = $false
while (-not $keyExit) {
  for ($x = 0; $x -lt $W; $x++) {
    for ($y = 0; $y -lt $H; $y++) {
      if ($age[$y, $x] -gt 0 -and (Get-Random -Maximum 7) -eq 0) {
        $glyphs[$y, $x] = (RChar)
      }
    }

    $heads[$x] = $heads[$x] + $speeds[$x]
    $headY = $heads[$x]

    for ($s = 0; $s -lt $speeds[$x]; $s++) {
      $yy = $headY - $s
      if ($yy -ge 0 -and $yy -lt $H) {
        $glyphs[$yy, $x] = (RChar)
        $age[$yy, $x] = 3
      }
    }

    for ($d = 1; $d -lt $lens[$x]; $d++) {
      $yy = $headY - $d
      if ($yy -lt 0 -or $yy -ge $H) { continue }
      if ($age[$yy, $x] -eq 0) { $glyphs[$yy, $x] = (RChar) }
      if ($d -lt [Math]::Max(2, [int]($lens[$x] * 0.35))) { $age[$yy, $x] = 2 }
      else { $age[$yy, $x] = 1 }
    }

    $clearY = $headY - $lens[$x]
    if ($clearY -ge 0 -and $clearY -lt $H) {
      $age[$clearY, $x] = 0
      $glyphs[$clearY, $x] = [char]" "
      # also clear a bit more of the tail end for cleaner streams
      $clearY2 = $clearY - 1
      if ($clearY2 -ge 0) {
        $age[$clearY2, $x] = 0
        $glyphs[$clearY2, $x] = [char]" "
      }
    }

    if (($heads[$x] - $lens[$x]) -gt $H) {
      $heads[$x] = -(Get-Random -Maximum 15)
      $speeds[$x] = Get-Random -Minimum 1 -Maximum 3
      $lens[$x] = Get-Random -Minimum ([Math]::Max(5, [int]($H * 0.3))) -Maximum ([Math]::Max(9, $H))
    }
  }

  if ($logPath -and (Test-Path -LiteralPath $logPath)) {
    try {
      # Shared read while cmd is still writing the log
      $all = Get-Content -LiteralPath $logPath -Tail 40 -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($all) {
        $last = ($all | Where-Object { $_.Trim() -ne "" } | Select-Object -Last 1)
        if ($last) {
          $clean = ($last -replace "[^\u0020-\u007E\u00A0-\u024F\uFF00-\uFFEF]", " ").Trim()
          if ($clean.Length -gt ($W - 4)) { $clean = $clean.Substring(0, $W - 4) }
          if ($clean -and $clean -ne $statusLine) {
            $statusLine = $clean
            $statusUntil = (Get-Date).AddSeconds(2.5)
          } elseif ($clean) {
            # refresh timer so long same-line statuses stay visible briefly
            if ((Get-Date) -gt $statusUntil) {
              $statusUntil = (Get-Date).AddSeconds(1.2)
              $statusLine = $clean
            }
          }
        }
      }
    } catch {}
  }

  if ($worker -and $worker.HasExited -and -not $done) {
    $done = $true
    $workerExit = $worker.ExitCode
    $statusLine = $(if ($workerExit -eq 0) { "OK" } else { "ERROR $workerExit" })
    $statusUntil = (Get-Date).AddSeconds(3)
  }

  $show = $null
  if ((Get-Date) -lt $statusUntil) { $show = $statusLine }
  try { Write-RainFrame $show } catch {}

  $elapsed = ((Get-Date) - $started).TotalSeconds

  if ([Console]::KeyAvailable) {
    $null = [Console]::ReadKey($true)
    if (-not $worker -or $worker.HasExited) { $keyExit = $true }
  }

  if ($worker) {
    if ($worker.HasExited -and $elapsed -ge $MinSeconds) {
      if (-not $StayOpen) {
        if ((Get-Date) -gt $statusUntil.AddSeconds(0.3)) { break }
      }
    }
  } else {
    if ($MinSeconds -gt 0 -and $elapsed -ge $MinSeconds) { break }
    if ($StayOpen) {
      # rain until key
    } elseif ($elapsed -ge 10) {
      break
    }
  }

  Start-Sleep -Milliseconds 30
}

if ($worker -and -not $worker.HasExited) {
  try { $worker.Kill() } catch {}
}
if ($logPath) { Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue }

try {
  [Console]::Write("$ESC[0m")
  [Console]::CursorVisible = $true
  Clear-Host
} catch {}

if ($null -ne $workerExit) { exit [int]$workerExit }
exit 0
