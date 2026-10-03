# Screenshot the native LeebertyPV window and check content richness.
# Usage: powershell -File scripts\native-shot.ps1 -ExePath <exe> -GoArgs <view> -Out <png>
param(
  [string]$ExePath = 'D:\LeebertyPV\desktop\NativeTest.exe',
  [string]$Go = '',
  [string]$Login = '',
  [string]$Out = 'D:\LeebertyPV\docs\screenshots\native-shot.png'
)
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WShot {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

Get-Process NativeTest, LeebertyPV -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne 0 } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

$argList = New-Object 'System.Collections.Generic.List[string]'
if ($Login -ne '') { $argList.Add('--login'); $argList.Add($Login) }
if ($Go -ne '') { $argList.Add('--go'); $argList.Add($Go) }
if ($argList.Count -gt 0) { Start-Process -FilePath $ExePath -ArgumentList $argList } else { Start-Process -FilePath $ExePath }
Start-Sleep -Seconds 6

$p = Get-Process NativeTest, LeebertyPV -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Host 'NO WINDOW'; exit 1 }
$rect = New-Object WShot+RECT
[WShot]::GetWindowRect($p.MainWindowHandle, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[WShot]::PrintWindow($p.MainWindowHandle, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc); $g.Dispose()

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host ("captured {0}x{1} -> {2}" -f $w, $h, $Out)

# ---- content richness: ink-ish pixels + distinct quantized hues in content pane ----
$ink = 0; $tot = 0
$hues = New-Object 'System.Collections.Generic.HashSet[int]'
for ($y = 90; $y -lt $h - 40; $y += 2) {
  for ($x = 300; $x -lt $w - 20; $x += 2) {
    $c = $bmp.GetPixel($x, $y); $tot++
    $mx = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
    $mn = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
    if ($mx -lt 235 -or ($mx - $mn) -gt 40) { $ink++ }
    $key = [int](([int]($c.R) -shr 5) * 64 + ([int]($c.G) -shr 5) * 8 + ([int]($c.B) -shr 5))
    $null = $hues.Add($key)
  }
}
if ($tot -gt 0) {
  Write-Host ("content ink-ish: {0}%  distinct hues: {1}" -f [Math]::Round(100 * $ink / $tot, 2), $hues.Count)
  if ((100 * $ink / $tot) -gt 2.0) { Write-Host '=> CONTENT PRESENT' } else { Write-Host '=> LOOKS BLANK' }
}
$bmp.Dispose()