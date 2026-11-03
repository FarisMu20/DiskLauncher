param([string]$exe, [string]$out)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PI {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern uint PrivateExtractIcons(string f, int i, int cx, int cy, IntPtr[] h, uint[] id, uint n, uint fl);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr h);
}
"@
try {
  $h = New-Object IntPtr[] 1
  $id = New-Object uint32[] 1
  $n = [PI]::PrivateExtractIcons($exe, 0, 256, 256, $h, $id, 1, 0)
  if ($n -ge 1 -and $h[0] -ne [IntPtr]::Zero) {
    $bmp = [System.Drawing.Icon]::FromHandle($h[0]).ToBitmap()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    [PI]::DestroyIcon($h[0]) | Out-Null
  } else {
    $bmp = [System.Drawing.Icon]::ExtractAssociatedIcon($exe).ToBitmap()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  }
} catch {}
$name = ""
try { $name = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductName } catch {}
if ([string]::IsNullOrWhiteSpace($name)) { $name = [System.IO.Path]::GetFileNameWithoutExtension($exe) }
Write-Output $name.Trim()
