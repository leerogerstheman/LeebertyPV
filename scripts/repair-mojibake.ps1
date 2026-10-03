# Recover Chinese that was corrupted by "UTF-8 bytes read as GB18030" in a JS
# source file. The corrupted file is itself valid UTF-8; every CJK run in it is
# mojibake. Inversion: GB18030-encode the mojibake chars to recover the original
# bytes, then decode those bytes as UTF-8.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\repair-mojibake.ps1 <in> <out>
param(
  [string]$In = 'scripts\seed-demo.js',
  [string]$Out = 'scripts\seed-demo.recovered.js'
)
$ErrorActionPreference = 'Stop'
$gbk = [System.Text.Encoding]::GetEncoding('GB18030')
$utf8 = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$inPath = Join-Path $root $In
$outPath = Join-Path $root $Out
$text = [System.IO.File]::ReadAllText($inPath, $utf8)

function Is-Cjk([char]$c) {
  $cp = [int]$c
  return ($cp -ge 0x4E00 -and $cp -le 0x9FFF) -or
         ($cp -ge 0x3400 -and $cp -le 0x4DBF) -or
         ($cp -ge 0xF900 -and $cp -le 0xFAFF) -or
         ($cp -ge 0xFF00 -and $cp -le 0xFFEF) -or
         ($cp -ge 0x3000 -and $cp -le 0x303F) -or
         ($cp -eq 0x2018 -or $cp -eq 0x2019)
}

function Try-Recover([string]$candidate) {
  try {
    $bytes = $gbk.GetBytes($candidate)
    $decoded = $utf8.GetString($bytes)
    # The recovered text must not still contain GBK-misread CJK pairs: a clean
    # recovery has real Chinese and no unpaired trailing replacement char.
    if ($decoded -match '[\uFFFD]') { return $null }
    return $decoded
  } catch { return $null }
}

$sb = New-Object System.Text.StringBuilder
$i = 0
$n = $text.Length
while ($i -lt $n) {
  $ch = $text[$i]
  if (-not (Is-Cjk $ch)) {
    [void]$sb.Append($ch)
    $i += 1
    continue
  }
  # maximal CJK run
  $j = $i
  while ($j -lt $n -and (Is-Cjk $text[$j])) { $j += 1 }
  $run = $text.Substring($i, $j - $i)

  # try recovering the run plus 0..2 following chars (the GBK decoder consumed
  # the first byte of the following ASCII char at odd boundaries)
  $best = $null
  $bestConsumed = 0
  for ($extra = 0; $extra -le 2; $extra++) {
    if ($j + $extra -gt $n) { break }
    $candidate = $run + $text.Substring($j, $extra)
    $decoded = Try-Recover $candidate
    if ($decoded -ne $null) {
      $best = $decoded
      $bestConsumed = $extra
    }
  }
  if ($best -ne $null) {
    [void]$sb.Append($best)
    $i = $j + $bestConsumed
  } else {
    [void]$sb.Append($run)
    $i = $j
  }
}

[System.IO.File]::WriteAllText($outPath, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "wrote $outPath"