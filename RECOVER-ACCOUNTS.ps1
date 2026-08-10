# VS System — recover TradingAccount rows from orphaned Docker volumes / SQL dumps.
# Called by RECOVER-ACCOUNTS.bat. Does not talk to Capital cloud.

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Write-Banner {
  Write-Host "========================================"
  Write-Host "  ATJAUNO KONTUS (probe volumes + SQL)"
  Write-Host "  Capital cloud NEAIZKAR — tikai lokala DB"
  Write-Host "========================================"
  Write-Host ""
}

function Ensure-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker nav PATH"
  }
  docker info 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { throw "Docker Engine nestrada — palaid Docker Desktop" }
}

function Stop-NexusPg {
  Write-Host "[1/6] Apturu Postgres/API konteinerus..."
  docker compose stop 1>$null 2>$null
  docker stop nexus-postgres 1>$null 2>$null
  docker rm -f vs-probe-pg 1>$null 2>$null
  Start-Sleep -Seconds 2
}

function Get-VolumeSizeKb([string]$vol) {
  $out = docker run --rm -v "${vol}:/data:ro" alpine sh -c "du -sk /data 2>/dev/null | cut -f1" 2>$null
  if (-not $out) { return 0 }
  $n = 0
  [int]::TryParse(($out | Select-Object -Last 1).ToString().Trim(), [ref]$n) | Out-Null
  return $n
}

function Probe-VolumeAccounts([string]$vol) {
  # Start throwaway Postgres on this data dir; count TradingAccount if DB exists.
  docker rm -f vs-probe-pg 1>$null 2>$null
  docker run -d --name vs-probe-pg `
    -e POSTGRES_HOST_AUTH_METHOD=trust `
    -v "${vol}:/var/lib/postgresql/data" `
    postgres:16-alpine 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { return -1 }

  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    docker exec vs-probe-pg pg_isready -U nexus -d nexus_pro 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    docker exec vs-probe-pg pg_isready -U postgres 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ok) {
    docker rm -f vs-probe-pg 1>$null 2>$null
    return -1
  }

  $count = -1
  $queries = @(
    @("nexus", "nexus_pro"),
    @("postgres", "nexus_pro"),
    @("postgres", "postgres")
  )
  foreach ($q in $queries) {
    $raw = docker exec vs-probe-pg psql -U $q[0] -d $q[1] -tAc 'SELECT count(*) FROM "TradingAccount";' 2>$null
    if ($LASTEXITCODE -eq 0 -and $raw) {
      $n = -1
      if ([int]::TryParse($raw.ToString().Trim(), [ref]$n)) {
        $count = $n
        break
      }
    }
  }

  docker rm -f vs-probe-pg 1>$null 2>$null
  return $count
}

function Score-SqlFile([string]$path) {
  if (-not (Test-Path $path)) { return @{ Score = 0; Accounts = 0; Bytes = 0 } }
  $item = Get-Item $path
  if ($item.Length -lt 200) { return @{ Score = 0; Accounts = 0; Bytes = $item.Length } }
  $text = Get-Content -Path $path -Raw -ErrorAction SilentlyContinue
  if (-not $text) { return @{ Score = 0; Accounts = 0; Bytes = $item.Length } }

  $hasTable = $text -match 'TradingAccount'
  if (-not $hasTable) {
    return @{ Score = 0; Accounts = 0; Bytes = $item.Length }
  }

  # Count INSERT / COPY rows roughly
  $inserts = ([regex]::Matches($text, 'INSERT INTO\s+"?TradingAccount"?')).Count
  $copyHint = 0
  if ($text -match 'COPY\s+"?TradingAccount"?') {
    # rows between COPY and \.
    $m = [regex]::Match($text, 'COPY\s+"?TradingAccount"?[^\n]*\n(.*?)\\\.', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($m.Success) {
      $copyHint = ($m.Groups[1].Value -split "`n" | Where-Object { $_.Trim() -ne "" }).Count
    }
  }
  $accounts = [Math]::Max($inserts, $copyHint)
  $score = 10 + ($accounts * 100) + [Math]::Min(50, [int]($item.Length / 100000))
  return @{ Score = $score; Accounts = $accounts; Bytes = $item.Length }
}

function Find-SqlCandidates {
  $dirs = New-Object System.Collections.Generic.List[string]
  [void]$dirs.Add((Join-Path $Root "backups"))
  $parent = Split-Path $Root -Parent
  if ($parent) {
    Get-ChildItem -Path $parent -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $b = Join-Path $_.FullName "backups"
      if (Test-Path $b) { [void]$dirs.Add($b) }
    }
  }
  # Common ZIP extract names next to clone
  foreach ($extra in @("VS-System-main", "VS-System-", "VS-System", "workspace")) {
    $b = Join-Path $parent $extra
    $b = Join-Path $b "backups"
    if (Test-Path $b) { [void]$dirs.Add($b) }
  }

  $seen = @{}
  $list = @()
  foreach ($d in $dirs) {
    if (-not (Test-Path $d)) { continue }
    Get-ChildItem -Path $d -Filter "*.sql" -File -ErrorAction SilentlyContinue | ForEach-Object {
      if ($seen.ContainsKey($_.FullName)) { return }
      $seen[$_.FullName] = $true
      $s = Score-SqlFile $_.FullName
      if ($s.Score -gt 0) {
        $list += [pscustomobject]@{
          Path = $_.FullName
          Score = $s.Score
          Accounts = $s.Accounts
          Bytes = $s.Bytes
          Written = $_.LastWriteTime
        }
      }
    }
  }
  return $list | Sort-Object Score, Written -Descending
}

function Copy-Volume([string]$from, [string]$to) {
  Write-Host "[4/6] Kopeju volume: $from  ->  $to"
  docker volume inspect $to 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) { docker volume create $to | Out-Null }
  docker run --rm -v "${from}:/from:ro" -v "${to}:/to" alpine sh -c "cd /to && rm -rf ./* ./.[!.]* 2>/dev/null; cp -a /from/. /to/ && du -sk /to"
  if ($LASTEXITCODE -ne 0) { throw "Volume kopēšana neizdevas" }
}

function Restore-Sql([string]$file) {
  Write-Host "[4/6] SQL restore: $file"
  docker compose up -d postgres
  if ($LASTEXITCODE -ne 0) { throw "postgres up neizdevas" }
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    docker exec nexus-postgres pg_isready -U nexus -d nexus_pro 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "Postgres nav gatavs" }

  Get-Content -Path $file -Raw | docker exec -i nexus-postgres psql -U nexus -d nexus_pro
  if ($LASTEXITCODE -ne 0) { throw "SQL restore neizdevas" }
}

function Count-LiveAccounts {
  docker compose up -d postgres 1>$null 2>$null
  for ($i = 0; $i -lt 40; $i++) {
    docker exec nexus-postgres pg_isready -U nexus -d nexus_pro 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 1
  }
  $raw = docker exec nexus-postgres psql -U nexus -d nexus_pro -tAc 'SELECT count(*) FROM "TradingAccount";' 2>$null
  $n = -1
  if ($raw) { [int]::TryParse($raw.ToString().Trim(), [ref]$n) | Out-Null }
  return $n
}

function Find-SiblingEnvKeys {
  $parent = Split-Path $Root -Parent
  $keys = @()
  if (-not $parent) { return $keys }
  Get-ChildItem -Path $parent -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    foreach ($rel in @(".env", "apps\api\.env")) {
      $p = Join-Path $_.FullName $rel
      if (-not (Test-Path $p)) { continue }
      $line = Select-String -Path $p -Pattern '^ENCRYPTION_KEY=' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($line) {
        $val = ($line.Line -replace '^ENCRYPTION_KEY=', '').Trim()
        if ($val.Length -eq 64) {
          $keys += [pscustomobject]@{ Path = $p; Key = $val }
        }
      }
    }
  }
  return $keys
}

# --- main ---
Write-Banner
Ensure-Docker
Stop-NexusPg

$target = "vs-system_nexus_pg"
Write-Host "[2/6] Mekleju VISUS Docker volumes (ar TradingAccount skaitu)..."
Write-Host ""

$volumes = @(docker volume ls -q)
$volHits = @()
foreach ($v in $volumes) {
  $sz = Get-VolumeSizeKb $v
  Write-Host -NoNewline ("  probe {0} (~{1} KB)... " -f $v, $sz)
  if ($sz -lt 50) {
    Write-Host "skip (tukss)"
    continue
  }
  $c = Probe-VolumeAccounts $v
  if ($c -lt 0) {
    Write-Host "nav postgres / nelasa"
    continue
  }
  Write-Host ("konti={0}" -f $c)
  $volHits += [pscustomobject]@{ Name = $v; Accounts = $c; SizeKb = $sz }
}

$bestVol = $volHits | Where-Object { $_.Accounts -gt 0 } | Sort-Object Accounts, SizeKb -Descending | Select-Object -First 1

Write-Host ""
Write-Host "[3/6] Mekleju SQL backupus (backups\ + blakus mapes)..."
$sqlHits = @(Find-SqlCandidates)
if ($sqlHits.Count -eq 0) {
  Write-Host "  nav SQL ar TradingAccount"
} else {
  foreach ($s in $sqlHits | Select-Object -First 8) {
    Write-Host ("  {0}  ~konti={1}  {2} bytes" -f $s.Path, $s.Accounts, $s.Bytes)
  }
}
$bestSql = $sqlHits | Select-Object -First 1

Write-Host ""
$mode = $null
if ($bestVol -and $bestVol.Accounts -gt 0) {
  if ($bestSql -and $bestSql.Accounts -gt $bestVol.Accounts) {
    $mode = "sql"
  } else {
    $mode = "volume"
  }
} elseif ($bestSql -and $bestSql.Accounts -gt 0) {
  $mode = "sql"
} elseif ($bestVol -and $bestVol.Name -ne $target) {
  # no account rows found but another volume exists — still try largest non-target
  $fallback = $volHits | Where-Object { $_.Name -ne $target } | Sort-Object SizeKb -Descending | Select-Object -First 1
  if ($fallback) {
    Write-Host "WARNING: neviena volume ar kontiem>0. Mekginu lielako blakus volume."
    $bestVol = $fallback
    $mode = "volume"
  }
}

if (-not $mode) {
  Write-Host "========================================"
  Write-Host "  REZULTATS: 0 — veca DB NAV atrasta"
  Write-Host "========================================"
  Write-Host ""
  Write-Host "Docker vairs nesatur tavu veco Postgres."
  Write-Host "Cloud / GitHub kontus neglabaja (API keys)."
  Write-Host ""
  Write-Host "Atjauno MANUĀLI (2–3 min):"
  Write-Host "  1) START-VS-SYSTEM.bat"
  Write-Host "  2) Logout ja vajag → login owner@nexus.pro / NexusOwner123!"
  Write-Host "  3) PIN 123456"
  Write-Host "  4) Accounts → Capital → ievadi:"
  Write-Host "       API key + email + password  (no Capital.com)"
  Write-Host "  5) Connect → Bind CFD sub-account"
  Write-Host ""
  Write-Host "ENCRYPTION_KEY: ja Connect saka decrypt error,"
  Write-Host "  saglabā .env no VECĀS mapes (VS-System-main u.c.)."
  $sib = Find-SiblingEnvKeys
  if ($sib.Count -gt 0) {
    Write-Host ""
    Write-Host "Atrasti blakus .env ENCRYPTION_KEY:"
    $sib | Select-Object -First 5 | ForEach-Object { Write-Host ("  " + $_.Path) }
  }
  exit 2
}

if ($mode -eq "volume") {
  if ($bestVol.Name -eq $target -and $bestVol.Accounts -gt 0) {
    Write-Host ("Target volume jau satur {0} kontus — kopēšana nav vajadziga." -f $bestVol.Accounts)
  } else {
    Copy-Volume $bestVol.Name $target
  }
} else {
  Restore-Sql $bestSql.Path
}

Write-Host ""
Write-Host "[5/6] Palaižu Postgres + skaitu..."
$live = Count-LiveAccounts
Write-Host ("  TradingAccount skaits tagad: {0}" -f $live)

Write-Host ""
Write-Host "[6/6] ENCRYPTION_KEY padoms"
$curEnv = Join-Path $Root ".env"
$curKey = $null
if (Test-Path $curEnv) {
  $line = Select-String -Path $curEnv -Pattern '^ENCRYPTION_KEY=' | Select-Object -First 1
  if ($line) { $curKey = ($line.Line -replace '^ENCRYPTION_KEY=', '').Trim() }
}
$exampleKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
if ($curKey -eq $exampleKey) {
  Write-Host "  .env joprojām ir EXAMPLE atslēga — Connect var failot pec restore."
  $sib = Find-SiblingEnvKeys | Where-Object { $_.Key -ne $exampleKey }
  if ($sib.Count -gt 0) {
    Write-Host ("  Atrasts cits key: {0}" -f $sib[0].Path)
    Write-Host "  Kopēju ENCRYPTION_KEY uz .env + apps\api\.env ..."
    foreach ($destRel in @(".env", "apps\api\.env")) {
      $dest = Join-Path $Root $destRel
      if (-not (Test-Path $dest)) { continue }
      (Get-Content $dest) | ForEach-Object {
        if ($_ -match '^ENCRYPTION_KEY=') { "ENCRYPTION_KEY=$($sib[0].Key)" } else { $_ }
      } | Set-Content -Path $dest -Encoding UTF8
    }
    Write-Host "  OK — key atjaunots no $($sib[0].Path)"
  }
}

Write-Host ""
Write-Host "========================================"
if ($live -gt 0) {
  Write-Host ("  OK — {0} konti DB. Tagad:" -f $live)
  Write-Host "    START-VS-SYSTEM.bat"
  Write-Host "    Login → Accounts → Connect"
} else {
  Write-Host "  Joprojam 0 konti pec restore."
  Write-Host "  Pievieno Capital manuāli Accounts lapā."
}
Write-Host "========================================"
exit $(if ($live -gt 0) { 0 } else { 3 })
