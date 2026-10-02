# su94r Mini pin helper (Windows, optional).
# Chrome can't keep a normal window above other apps, so this small script does it:
#   - it makes up a private code each time it starts and gives it only to the extension
#     (http://127.0.0.1:47923/ping; a web page cannot read that reply);
#   - about once a second it finds windows whose title ends in "(on top)" followed by that
#     code (written as invisible characters) and makes them topmost, and un-pins su94r Mini
#     windows that no longer ask for it.
# It reads nothing but window titles and listens only on this computer (127.0.0.1).
# This file must stay plain ASCII: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class LibreMiniPin {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

  private static readonly IntPtr TOPMOST = new IntPtr(-1);
  private static readonly IntPtr NOTOPMOST = new IntPtr(-2);
  private const int GWL_EXSTYLE = -20;
  private const int WS_EX_TOPMOST = 0x8;
  private const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;
  // Middle dot (U+00B7) built from its code so this file stays ASCII.
  private static readonly string Dot = ((char)0xB7).ToString();
  private static readonly string[] Markers = { Dot + " su94r Mini", Dot + " Libre Mini" };

  /// The private code as the extension writes it: 0 = U+200B, 1 = U+200C.
  public static string Code = "";

  public static string Encode(string bits) {
    var sb = new StringBuilder();
    foreach (char b in bits) sb.Append(b == '1' ? (char)0x200C : (char)0x200B);
    return sb.ToString();
  }

  public static int Apply() {
    int changed = 0;
    string wanted = "(on top)" + Code;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      string title = sb.ToString();
      bool ours = false;
      foreach (var m in Markers) if (title.IndexOf(m, StringComparison.Ordinal) >= 0) ours = true;
      if (!ours) return true;
      bool want = Code.Length > 0 && title.EndsWith(wanted, StringComparison.Ordinal);
      bool isTop = (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
      if (want != isTop) {
        SetWindowPos(h, want ? TOPMOST : NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
        changed++;
      }
      return true;
    }, IntPtr.Zero);
    return changed;
  }
}
'@

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 47923)
try { $listener.Start() } catch { exit 0 }   # port taken: another copy is already running

# 16 random bits: guessing them by cycling a page title would take many hours.
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 2
$rng.GetBytes($bytes)
$bits = -join ($bytes | ForEach-Object { [Convert]::ToString($_, 2).PadLeft(8, '0') })
[LibreMiniPin]::Code = [LibreMiniPin]::Encode($bits)

# No CORS header on purpose: only the extension (which has permission for 127.0.0.1) can read this.
$body = '{"app":"libre-mini-pin","version":2,"code":"' + $bits + '"}'
$reply = [Text.Encoding]::ASCII.GetBytes(
  "HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n$body")
$buffer = New-Object byte[] 4096
$tick = 0

while ($true) {
  while ($listener.Pending()) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $stream.ReadTimeout = 500
      try { [void]$stream.Read($buffer, 0, $buffer.Length) } catch {}
      $stream.Write($reply, 0, $reply.Length)
    } catch {} finally { $client.Close() }
  }
  # Answer pings within 0.1 s; re-check window titles every 0.8 s.
  if ($tick % 8 -eq 0) { try { [void][LibreMiniPin]::Apply() } catch {} }
  $tick++
  Start-Sleep -Milliseconds 100
}
