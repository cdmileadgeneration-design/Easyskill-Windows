Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IdleTime {
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }
}
"@

$info = New-Object IdleTime+LASTINPUTINFO
$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
[IdleTime]::GetLastInputInfo([ref]$info) | Out-Null
$tickCount = [Environment]::TickCount
$idleMs = $tickCount - $info.dwTime
if ($idleMs -lt 0) { $idleMs += [Int32]::MaxValue }
$idleMs
