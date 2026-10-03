Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap('D:\LeebertyPV\docs\screenshots\native-app-ui.png')
$w = $bmp.Width; $h = $bmp.Height
$colors = New-Object 'System.Collections.Generic.HashSet[int]'
$dark = 0; $white = 0; $mid = 0
for ($y = 80; $y -lt $h - 20; $y += 3) {
  for ($x = 235; $x -lt $w - 10; $x += 3) {
    $c = $bmp.GetPixel($x, $y)
    $key = [int](([int]($c.R) -shr 4) * 65536 + ([int]($c.G) -shr 4) * 256 + ([int]($c.B) -shr 4))
    $null = $colors.Add($key)
    $lum = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
    if ($lum -lt 60) { $dark++ } elseif ($lum -gt 235) { $white++ } else { $mid++ }
  }
}
Write-Host ("content distinct 4bit colors: {0}" -f $colors.Count)
Write-Host ("tone dark/mid/white: {0}/{1}/{2}" -f $dark, $mid, $white)

$targets = @{ 'e11d48' = 'ICSR_red'; 'f59e0b' = 'SIGNAL_amber'; '2563eb' = 'PSUR_blue'; '7c3aed' = 'RMP_purple'; '0891b2' = 'LIT_cyan'; '16a34a' = 'AEFI_green'; 'ea580c' = 'COMP_orange'; '475569' = 'GVP_slate'; '1d4ed8' = 'brand_blue'; '0b1326' = 'sidebar_blueblack' }
$found = @{}
for ($y = 60; $y -lt $h - 30; $y += 2) {
  for ($x = 10; $x -lt $w - 5; $x += 2) {
    $c = $bmp.GetPixel($x, $y)
    foreach ($t in $targets.Keys) {
      if ($found.ContainsKey($t)) { continue }
      $tc = [System.Drawing.ColorTranslator]::FromHtml('#' + $t)
      if ([Math]::Abs($c.R - $tc.R) -le 14 -and [Math]::Abs($c.G - $tc.G) -le 14 -and [Math]::Abs($c.B - $tc.B) -le 14) {
        $found[$t] = $true
      }
    }
  }
}
Write-Host 'brand / domain accents:'
foreach ($t in $targets.Keys) { if ($found.ContainsKey($t)) { Write-Host ("  [yes] {0} #{1}" -f $targets[$t], $t) } else { Write-Host ("  [no ] {0} #{1}" -f $targets[$t], $t) } }
$cSide = $bmp.GetPixel(30, 320); $cHero = $bmp.GetPixel(600, 120); $cBody = $bmp.GetPixel(700, 340)
Write-Host ("sidebar={0},{1},{2} hero={3},{4},{5} body={6},{7},{8}" -f $cSide.R, $cSide.G, $cSide.B, $cHero.R, $cHero.G, $cHero.B, $cBody.R, $cBody.G, $cBody.B)
$bmp.Dispose()