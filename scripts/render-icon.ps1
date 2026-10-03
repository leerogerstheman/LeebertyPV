# LeebertyPV icon renderer.
# Blue-black ground, the letters "PV" in a gothic (Old English) letterform,
# stretched tall and narrow, white with a soft cold glow - the identity of the
# pharmacovigilance workbench. Produces web/favicon.png, web/logo-lg.png and a
# multi-size desktop/icon.ico.
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\render-icon.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$webDir = Join-Path $root 'web'
$deskDir = Join-Path $root 'desktop'
New-Item -ItemType Directory -Force -Path $webDir | Out-Null
New-Item -ItemType Directory -Force -Path $deskDir | Out-Null

$fontName = 'Old English Text MT'
$font = New-Object System.Drawing.Font($fontName, 100.0, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

function Render-Size([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # ---- blue-black ground: deep navy to near black -------------------------
  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 18, 32, 74),   # deep navy top-left
    [System.Drawing.Color]::FromArgb(255, 2, 4, 12),     # near black bottom-right
    [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
  $g.FillRectangle($grad, $rect)

  # ---- cold glow behind the letters ---------------------------------------
  $glowR = [int]($size * 0.46)
  $glow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(70, 70, 130, 255))
  $g.FillEllipse($glow, ($size - $glowR) / 2, [int]($size * 0.14), $glowR, [int]($glowR * 0.92))
  $glow.Dispose()

  # ---- thin blue ring echoing the page brand ------------------------------
  $penW = [Math]::Max(1.2, $size * 0.012)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(130, 130, 170, 255), [float]$penW)
  $g.DrawEllipse($pen, [float]($size * 0.045), [float]($size * 0.045), [float]($size * 0.91), [float]($size * 0.91))
  $pen.Dispose()

  # ---- the gothic "PV", stretched tall and narrow -------------------------
  # Measure at 100px, then solve the font size so the stretched glyphs fit the
  # padded box (the gothic face is deceptively wide).
  $measure = $g.MeasureString('PV', $font)
  $sx = 0.80; $sy = 1.62
  $padX = $size * 0.16; $padY = $size * 0.10
  $fs = [Math]::Min(($size - 2 * $padX) / ($sx * $measure.Width / 100.0), ($size - 2 * $padY) / ($sy * $measure.Height / 100.0))

  $g.TranslateTransform($size / 2, $size / 2)
  $g.ScaleTransform([float]$sx, [float]$sy)
  $font2 = New-Object System.Drawing.Font($fontName, [float]$fs, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

  # shadow pass, then the white face
  $shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(150, 0, 0, 0))
  $m2 = $g.MeasureString('PV', $font2)
  $g.DrawString('PV', $font2, $shadow, [float](-$m2.Width / 2 + $size * 0.012), [float](-$m2.Height / 2 + $size * 0.014))
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 234, 240, 255))
  $g.DrawString('PV', $font2, $white, [float](-$m2.Width / 2), [float](-$m2.Height / 2))
  $white.Dispose(); $shadow.Dispose(); $font2.Dispose()
  $g.ResetTransform()

  $g.Dispose(); $grad.Dispose()
  return $bmp
}

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

# ---- render the sizes we publish ------------------------------------------
$png256 = Render-Size 256
$png512 = Render-Size 512
Save-Png $png256 (Join-Path $webDir 'favicon.png')
Save-Png $png512 (Join-Path $webDir 'logo-lg.png')

# ---- pack a multi-size .ico with PNG-compressed entries --------------------
$sizes = @(16, 32, 48, 64, 128, 256)
$streams = @{}
try {
  $ms = New-Object System.IO.MemoryStream
  foreach ($s in $sizes) {
    $b = Render-Size $s
    $tmp = New-Object System.IO.MemoryStream
    $b.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $streams[$s] = $tmp.ToArray()
    $tmp.Dispose(); $b.Dispose()
  }
  $n = $sizes.Count
  $header = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($header)
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$n)
  $off = 6 + 16 * $n
  $dirData = New-Object System.Byte[] (16 * $n)
  for ($i = 0; $i -lt $n; $i++) {
    $s = $sizes[$i]
    $b = $streams[$s]
    $d = 16 * $i
    $dirData[$d]   = if ($s -ge 256) { 0 } else { $s }
    $dirData[$d+1] = if ($s -ge 256) { 0 } else { $s }
    $dirData[$d+2] = 1   # color planes
    $dirData[$d+3] = 32  # bpp
    $dirData[$d+4] = [byte]($b.Length -band 0xFF)
    $dirData[$d+5] = [byte](($b.Length -shr 8) -band 0xFF)
    $dirData[$d+6] = [byte](($b.Length -shr 16) -band 0xFF)
    $dirData[$d+7] = [byte](($b.Length -shr 24) -band 0xFF)
    $dirData[$d+8]  = [byte]($off -band 0xFF)
    $dirData[$d+9]  = [byte](($off -shr 8) -band 0xFF)
    $dirData[$d+10] = [byte](($off -shr 16) -band 0xFF)
    $dirData[$d+11] = [byte](($off -shr 24) -band 0xFF)
    $dirData[$d+12] = 0; $dirData[$d+13] = 0; $dirData[$d+14] = 0; $dirData[$d+15] = 0
    $off += $b.Length
  }
  $bw.Write($dirData)
  $body = New-Object System.IO.MemoryStream
  foreach ($s in $sizes) { $body.Write($streams[$s], 0, $streams[$s].Length) }
  $ico = New-Object System.IO.MemoryStream
  $ico.Write($header.ToArray(), 0, $header.ToArray().Length)
  $ico.Write($body.ToArray(), 0, $body.ToArray().Length)
  [System.IO.File]::WriteAllBytes((Join-Path $deskDir 'icon.ico'), $ico.ToArray())
  $bw.Dispose(); $header.Dispose(); $body.Dispose(); $ico.Dispose()
} finally {
  $png256.Dispose(); $png512.Dispose()
  foreach ($k in $streams.Keys) { }
}

Write-Host ('  saved web/favicon.png  -> ' + (Join-Path $webDir 'favicon.png'))
Write-Host ('  saved web/logo-lg.png  -> ' + (Join-Path $webDir 'logo-lg.png'))
Write-Host ('  saved desktop/icon.ico -> ' + (Join-Path $deskDir 'icon.ico'))