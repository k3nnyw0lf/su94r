# su94r Mini pin helper and desktop widget (Windows, optional).
#
# Keeps su94r Mini windows on top: Chrome can't keep a normal window above other apps, so
#   - this script makes up a private code each time it starts and gives it only to the
#     extension (http://127.0.0.1:47923/ping; a web page cannot read that reply);
#   - about once a second it finds windows whose title ends in "(on top)" followed by that
#     code (written as invisible characters) and makes them topmost, and un-pins su94r Mini
#     windows that no longer ask for it.
#
# Draws the desktop widget: a small frameless square, always on top, that you drag anywhere,
# with the reading, trend, change, age and a 3-hour line. su94r Mini sends it each reading
# (POST /widget, signed with the private code, so a web page cannot show a fake number).
# Right-click it to change its size or hide it for an hour.
#
# It reads nothing but window titles and what su94r Mini sends, listens only on this
# computer (127.0.0.1), and keeps its position in %USERPROFILE%\.su94r\widget.txt.
# This file must stay plain ASCII: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
param(
  [int]$Port = 47923,
  [string]$RenderTest = '',  # for testing: draw the widget into this PNG and exit (no window shown)
  [string]$RenderJson = ''   # ... from this request body file instead of sample data
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Web.Extensions

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class LibreMiniPin {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  private static readonly IntPtr TOPMOST = new IntPtr(-1);
  private static readonly IntPtr NOTOPMOST = new IntPtr(-2);
  private const int GWL_EXSTYLE = -20;
  private const int WS_EX_TOPMOST = 0x8;
  private const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;
  private static readonly string Dot = ((char)0xB7).ToString();
  private static readonly string[] Markers = { Dot + " su94r Mini", Dot + " Libre Mini" };

  /// The private code as the extension writes it: 0 = U+200B, 1 = U+200C.
  public static string Code = "";
  public static string Bits = "";

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

public class WidgetPerson {
  public string Name = "";
  public double Mg;
  public int Trend;
  public long T;
  public double Low = 70, High = 180;
  public bool Mmol;
  public string Delta = "";
  public bool Urgent;
  public List<double[]> Spark = new List<double[]>();
}

public class Su94rWidget : Form {
  private List<WidgetPerson> people = new List<WidgetPerson>();
  private readonly string statePath;
  private Point dragFrom;
  private bool dragging, moved;
  private float scale = 1f;
  private int sizeStep = 1;            // 0 small, 1 normal, 2 large
  private DateTime hiddenUntil = DateTime.MinValue;
  private readonly Timer clock = new Timer();
  public static bool NeverShow;          // tests: draw without putting a window on screen

  static readonly Color Bg = Color.FromArgb(22, 27, 34);
  static readonly Color Line = Color.FromArgb(48, 54, 61);
  static readonly Color Fg = Color.FromArgb(230, 237, 243);
  static readonly Color Muted = Color.FromArgb(139, 148, 158);
  static readonly Color InRange = Color.FromArgb(63, 185, 80);
  static readonly Color High = Color.FromArgb(227, 163, 59);
  static readonly Color Low = Color.FromArgb(255, 107, 99);
  static readonly Color Stale = Color.FromArgb(110, 118, 129);
  const double Mmol = 18.0182;

  public Su94rWidget(string statePath) {
    this.statePath = statePath;
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    BackColor = Bg;
    DoubleBuffered = true;
    Text = "su94r Mini widget";
    using (var g = CreateGraphics()) scale = g.DpiX / 96f;
    LoadState();
    Relayout();
    var menu = new ContextMenuStrip();
    menu.Items.Add("Smaller", null, (s, e) => { sizeStep = Math.Max(0, sizeStep - 1); Relayout(); SaveState(); });
    menu.Items.Add("Larger", null, (s, e) => { sizeStep = Math.Min(2, sizeStep + 1); Relayout(); SaveState(); });
    menu.Items.Add("Hide for an hour", null, (s, e) => { hiddenUntil = DateTime.Now.AddHours(1); Hide(); });
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add("Turn the widget off in su94r Mini Settings").Enabled = false;
    ContextMenuStrip = menu;
    MouseDown += (s, e) => { if (e.Button == MouseButtons.Left) { dragging = true; moved = false; dragFrom = e.Location; } };
    MouseMove += (s, e) => {
      if (!dragging) return;
      Location = new Point(Location.X + e.X - dragFrom.X, Location.Y + e.Y - dragFrom.Y);
      moved = true;
    };
    MouseUp += (s, e) => { if (dragging && moved) SaveState(); dragging = false; };
    clock.Interval = 20000;
    clock.Tick += (s, e) => { if (Visible) Invalidate(); };
    clock.Start();
  }

  protected override CreateParams CreateParams {
    get {
      var cp = base.CreateParams;
      cp.ExStyle |= 0x80 | 0x08000000;   // WS_EX_TOOLWINDOW (no taskbar, no alt-tab), WS_EX_NOACTIVATE
      return cp;
    }
  }
  protected override bool ShowWithoutActivation { get { return true; } }

  float Unit { get { return scale * (sizeStep == 0 ? 0.8f : sizeStep == 2 ? 1.3f : 1f); } }

  void Relayout() {
    float u = Unit;
    int w = (int)(232 * u);
    int h = people.Count > 1 ? (int)((18 + 34 * Math.Min(people.Count, 6)) * u) : (int)(120 * u);
    Size = new Size(w, h);
    var path = Rounded(new RectangleF(0, 0, w, h), 14 * u);
    Region = new Region(path);
    var area = Screen.FromPoint(Location).WorkingArea;
    if (!area.Contains(new Rectangle(Location, new Size(40, 40))))
      Location = new Point(area.Right - w - (int)(20 * scale), area.Bottom - h - (int)(20 * scale));
    Invalidate();
  }

  static GraphicsPath Rounded(RectangleF r, float rad) {
    var p = new GraphicsPath();
    float d = rad * 2;
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }

  void LoadState() {
    try {
      var parts = File.ReadAllText(statePath).Trim().Split(',');
      Location = new Point(int.Parse(parts[0]), int.Parse(parts[1]));
      if (parts.Length > 2) sizeStep = Math.Max(0, Math.Min(2, int.Parse(parts[2])));
    } catch { Location = new Point(-10000, -10000); }
  }
  void SaveState() {
    try {
      Directory.CreateDirectory(Path.GetDirectoryName(statePath));
      File.WriteAllText(statePath, Location.X + "," + Location.Y + "," + sizeStep);
    } catch { }
  }

  public void SetPeople(List<WidgetPerson> list, bool show) {
    int before = people.Count;
    people = list;
    if (!show || list.Count == 0 || DateTime.Now < hiddenUntil) { if (Visible) Hide(); return; }
    // Resize whenever the number of rows changes, so nobody is cut off.
    int want = list.Count > 1 ? (int)((18 + 34 * Math.Min(list.Count, 6)) * Unit) : (int)(120 * Unit);
    if (Height != want || before == 0) Relayout();
    if (!Visible && !NeverShow) Show();
    Invalidate();
  }

  static Color ColorFor(WidgetPerson p, bool stale) {
    if (stale) return Stale;
    if (p.Mg < p.Low) return Low;
    if (p.Mg > p.High) return High;
    return InRange;
  }
  static string Value(WidgetPerson p) {
    if (p.Mg < 40) return "LO";
    if (p.Mg > 400) return "HI";
    return p.Mmol ? (p.Mg / Mmol).ToString("0.0", System.Globalization.CultureInfo.InvariantCulture) : Math.Round(p.Mg).ToString();
  }
  static string Ago(long t) {
    double mins = (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - t) / 60000.0;
    if (mins < 1) return "just now";
    if (mins < 60) return Math.Round(mins) + " min ago";
    return Math.Floor(mins / 60) + " h " + Math.Round(mins % 60) + " min ago";
  }
  static bool IsStale(WidgetPerson p) { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - p.T > 10 * 60000; }

  // Trend arrow: 1 down, 2 down-right, 3 right, 4 up-right, 5 up.
  static void Arrow(Graphics g, PointF c, float size, int trend, Color color) {
    if (trend < 1 || trend > 5) return;
    float angle = new float[] { 0, 90, 45, 0, -45, -90 }[trend];
    var st = g.Save();
    g.TranslateTransform(c.X, c.Y);
    g.RotateTransform(angle);
    using (var pen = new Pen(color, size * 0.16f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round }) {
      g.DrawLine(pen, -size * 0.45f, 0, size * 0.42f, 0);
      g.DrawLines(pen, new[] { new PointF(size * 0.08f, -size * 0.36f), new PointF(size * 0.45f, 0), new PointF(size * 0.08f, size * 0.36f) });
    }
    g.Restore(st);
  }

  protected override void OnPaint(PaintEventArgs e) {
    var g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
    float u = Unit;
    bool urgent = false;
    foreach (var p in people) if (!IsStale(p) && p.Urgent) urgent = true;
    using (var bg = new SolidBrush(urgent ? Color.FromArgb(58, 18, 20) : Bg)) g.FillRectangle(bg, ClientRectangle);
    using (var border = new Pen(urgent ? Low : Line, urgent ? 2 * u : 1))
    using (var path = Rounded(new RectangleF(0.5f, 0.5f, Width - 1, Height - 1), 14 * u)) g.DrawPath(border, path);
    if (people.Count == 0) return;
    if (people.Count == 1) PaintOne(g, people[0], u); else PaintMany(g, u);
  }

  void PaintOne(Graphics g, WidgetPerson p, float u) {
    bool stale = IsStale(p);
    Color c = ColorFor(p, stale);
    string v = Value(p);
    using (var big = new Font("Segoe UI Semibold", 30 * u, GraphicsUnit.Pixel))
    using (var small = new Font("Segoe UI", 11 * u, GraphicsUnit.Pixel))
    using (var smallBold = new Font("Segoe UI Semibold", 11 * u, GraphicsUnit.Pixel))
    using (var cb = new SolidBrush(c))
    using (var fg = new SolidBrush(Fg))
    using (var mb = new SolidBrush(Muted)) {
      var vs = g.MeasureString(v, big);
      g.DrawString(v, big, cb, 10 * u, 4 * u);
      Arrow(g, new PointF(10 * u + vs.Width + 10 * u, 4 * u + vs.Height / 2 + 1 * u), 20 * u, stale ? 0 : p.Trend, c);
      g.DrawString(p.Mmol ? "mmol/L" : "mg/dL", small, mb, 10 * u + vs.Width + 24 * u, 4 * u + vs.Height / 2 + 2 * u);
      var right = new StringFormat { Alignment = StringAlignment.Far };
      g.DrawString(stale ? "no new reading" : p.Delta, smallBold, stale ? mb : fg, Width - 10 * u, 10 * u, right);
      g.DrawString(Ago(p.T), small, mb, Width - 10 * u, 25 * u, right);
      if (p.Name.Length > 0) g.DrawString(p.Name, small, mb, Width - 10 * u, 40 * u, right);
    }
    // 3-hour line with the target band.
    var plot = new RectangleF(10 * u, 58 * u, Width - 20 * u, Height - 66 * u);
    long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    long from = now - 3 * 3600000L;
    // Scale to the readings and the target range, so the line shows real movement.
    double lo = p.Low, hi = p.High;
    foreach (var s in p.Spark) if (s[0] >= from) { lo = Math.Min(lo, s[1]); hi = Math.Max(hi, s[1]); }
    lo -= 15; hi += 15;
    Func<double, float> y = mg => plot.Bottom - (float)((Math.Min(Math.Max(mg, lo), hi) - lo) / (hi - lo)) * plot.Height;
    Func<double, float> x = t => plot.Left + (float)((t - from) / (now - from)) * plot.Width;
    using (var band = new SolidBrush(Color.FromArgb(30, 63, 185, 80)))
      g.FillRectangle(band, plot.Left, y(p.High), plot.Width, y(p.Low) - y(p.High));
    var pts = new List<PointF>();
    foreach (var s in p.Spark) if (s[0] >= from) pts.Add(new PointF(x(s[0]), y(s[1])));
    // Each stretch coloured by where it ends: amber above range, red below, green in it.
    var vals = new List<double>();
    foreach (var s in p.Spark) if (s[0] >= from) vals.Add(s[1]);
    for (int i = 1; i < pts.Count; i++)
      using (var pen = new Pen(stale ? Stale : vals[i] < p.Low ? Low : vals[i] > p.High ? High : InRange, 2 * u) { StartCap = LineCap.Round, EndCap = LineCap.Round })
        g.DrawLine(pen, pts[i - 1], pts[i]);
    if (pts.Count > 0) using (var dot = new SolidBrush(c)) { var last = pts[pts.Count - 1]; g.FillEllipse(dot, last.X - 3.5f * u, last.Y - 3.5f * u, 7 * u, 7 * u); }
  }

  void PaintMany(Graphics g, float u) {
    using (var name = new Font("Segoe UI", 12 * u, GraphicsUnit.Pixel))
    using (var val = new Font("Segoe UI Semibold", 20 * u, GraphicsUnit.Pixel))
    using (var small = new Font("Segoe UI", 10 * u, GraphicsUnit.Pixel))
    using (var mb = new SolidBrush(Muted))
    using (var fg = new SolidBrush(Fg)) {
      float top = 9 * u;
      int shown = 0;
      foreach (var p in people) {
        if (shown++ >= 6) break;
        bool stale = IsStale(p);
        Color c = ColorFor(p, stale);
        g.DrawString(p.Name, name, fg, 10 * u, top + 6 * u);
        string v = Value(p);
        var right = new StringFormat { Alignment = StringAlignment.Far };
        using (var cb = new SolidBrush(c)) g.DrawString(v, val, cb, Width - 36 * u, top, right);
        Arrow(g, new PointF(Width - 22 * u, top + 15 * u), 14 * u, stale ? 0 : p.Trend, c);
        g.DrawString(Ago(p.T), small, mb, 10 * u, top + 21 * u);
        top += 34 * u;
      }
    }
  }
}

public static class Su94rHelper {
  public static Su94rWidget Widget;
  static TcpListener listener;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static int ticks;

  public static bool Start(int port) {
    listener = new TcpListener(IPAddress.Loopback, port);
    try { listener.Start(); } catch { return false; }
    ListenPort = port;
    return true;
  }

  // Called by a WinForms timer every 100 ms on the UI thread.
  public static void Tick() {
    while (listener.Pending()) {
      using (var client = listener.AcceptTcpClient()) {
        try { Serve(client); } catch { }
      }
    }
    if (ticks++ % 8 == 0) { try { LibreMiniPin.Apply(); } catch { } }
    if (ticks % 300 == 0 && Feeds.Count > 0) { try { Redraw(); } catch { } }   // drop feeds gone quiet (every 30 s)
  }

  // ---- only this Windows session's programs may talk to this helper ----
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool sort, int af, int tableClass, uint reserved);
  [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [StructLayout(LayoutKind.Sequential)] struct TcpRow { public uint State, LocalAddr, LocalPort, RemoteAddr, RemotePort, Pid; }
  static int Port(uint p) { return (int)(((p & 0xFF) << 8) | ((p >> 8) & 0xFF)); }
  public static int ListenPort;

  /// The connection's other end belongs to a process in this Windows session (or we cannot tell).
  static bool SameSession(int clientPort) {
    int size = 0;
    GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 4, 0);   // AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (GetExtendedTcpTable(buf, ref size, false, 2, 4, 0) != 0) return true;
      int n = Marshal.ReadInt32(buf);
      int rowSize = Marshal.SizeOf(typeof(TcpRow));
      uint mine = (uint)Process.GetCurrentProcess().SessionId;
      for (int i = 0; i < n; i++) {
        var r = (TcpRow)Marshal.PtrToStructure(IntPtr.Add(buf, 4 + i * rowSize), typeof(TcpRow));
        if (Port(r.LocalPort) == clientPort && Port(r.RemotePort) == ListenPort) {
          uint s;
          return !ProcessIdToSessionId(r.Pid, out s) || s == mine;
        }
      }
      return true;
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static void Serve(TcpClient client) {
    var stream = client.GetStream();
    // Another Windows user on this computer gets nothing: not the code, not the widget.
    var remote = client.Client.RemoteEndPoint as IPEndPoint;
    if (remote != null && !SameSession(remote.Port)) {
      var no = Encoding.ASCII.GetBytes("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      stream.Write(no, 0, no.Length);
      return;
    }
    stream.ReadTimeout = 800;
    var data = new MemoryStream();
    var buf = new byte[8192];
    int headerEnd = -1, length = 0;
    var deadline = DateTime.UtcNow.AddMilliseconds(800);
    while (DateTime.UtcNow < deadline) {
      int n = stream.Read(buf, 0, buf.Length);
      if (n <= 0) break;
      data.Write(buf, 0, n);
      var bytes = data.ToArray();
      if (headerEnd < 0) {
        for (int i = 3; i < bytes.Length; i++)
          if (bytes[i - 3] == 13 && bytes[i - 2] == 10 && bytes[i - 1] == 13 && bytes[i] == 10) { headerEnd = i + 1; break; }
        if (headerEnd >= 0) {
          var head = Encoding.ASCII.GetString(bytes, 0, headerEnd);
          foreach (var line in head.Split('\n'))
            if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) int.TryParse(line.Substring(15).Trim(), out length);
        }
      }
      if (headerEnd >= 0 && bytes.Length - headerEnd >= length) break;
    }
    var all = data.ToArray();
    string firstLine = all.Length > 0 ? Encoding.ASCII.GetString(all, 0, Math.Min(all.Length, 200)).Split('\r')[0] : "";
    string reply;
    int status = 200;
    if (firstLine.StartsWith("POST /widget") && headerEnd > 0) {
      reply = HandleWidget(Encoding.UTF8.GetString(all, headerEnd, all.Length - headerEnd), out status);
    } else {
      reply = "{\"app\":\"libre-mini-pin\",\"version\":3,\"widget\":true,\"code\":\"" + LibreMiniPin.Bits + "\"}";
    }
    var body = Encoding.UTF8.GetBytes(reply);
    // No CORS header on purpose: only the extension (which has permission for 127.0.0.1) can read replies.
    var header = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + (status == 200 ? " OK" : " Forbidden") + "\r\nContent-Type: application/json\r\nContent-Length: " + body.Length + "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n");
    stream.Write(header, 0, header.Length);
    stream.Write(body, 0, body.Length);
  }

  static string HandleWidget(string text, out int status) {
    status = 200;
    var o = Json.Deserialize<Dictionary<string, object>>(text);
    if (o == null || !o.ContainsKey("code") || (o["code"] as string) != LibreMiniPin.Bits) { status = 403; return "{\"ok\":false}"; }
    var list = new List<WidgetPerson>();
    object raw;
    if (o.TryGetValue("people", out raw) && raw is System.Collections.ArrayList) {
      foreach (var item in (System.Collections.ArrayList)raw) {
        var d = item as Dictionary<string, object>;
        if (d == null) continue;
        var p = new WidgetPerson();
        p.Name = Str(d, "name");
        p.Mg = Num(d, "mg");
        p.Trend = (int)Num(d, "trend");
        p.T = (long)Num(d, "t");
        p.Low = Num(d, "low", 70);
        p.High = Num(d, "high", 180);
        p.Mmol = Str(d, "units") == "mmol/L";
        p.Delta = Str(d, "delta");
        p.Urgent = d.ContainsKey("urgent") ? Convert.ToBoolean(d["urgent"]) : p.Mg < 55;
        object sp;
        if (d.TryGetValue("spark", out sp) && sp is System.Collections.ArrayList)
          foreach (var pt in (System.Collections.ArrayList)sp) {
            var a = pt as System.Collections.ArrayList;
            if (a != null && a.Count == 2) p.Spark.Add(new[] { Convert.ToDouble(a[0]), Convert.ToDouble(a[1]) });
          }
        if (p.T > 0) list.Add(p);
      }
    }
    bool show = !o.ContainsKey("show") || Convert.ToBoolean(o["show"]);
    // Each browser's feed is kept apart; the widget shows the union of fresh ones.
    string sender = Str(o, "sender");
    Feeds[sender.Length > 0 ? sender : "default"] = new Feed { People = list, Show = show, At = DateTime.UtcNow };
    Redraw();
    return "{\"ok\":true}";
  }

  class Feed { public List<WidgetPerson> People; public bool Show; public DateTime At; }
  static readonly Dictionary<string, Feed> Feeds = new Dictionary<string, Feed>();

  // Everyone from browsers that sent within the last 3 minutes and want the widget shown;
  // the same person from two browsers once, newest reading kept.
  static void Redraw() {
    var byName = new Dictionary<string, WidgetPerson>();
    var order = new List<string>();
    foreach (var f in Feeds.Values) {
      if (!f.Show || DateTime.UtcNow - f.At > TimeSpan.FromMinutes(3)) continue;
      foreach (var p in f.People) {
        WidgetPerson have;
        if (!byName.TryGetValue(p.Name, out have)) { byName[p.Name] = p; order.Add(p.Name); }
        else if (p.T > have.T) byName[p.Name] = p;
      }
    }
    var list = new List<WidgetPerson>();
    foreach (var n in order) list.Add(byName[n]);
    Widget.SetPeople(list, list.Count > 0);
  }

  static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
  static double Num(Dictionary<string, object> d, string k, double def = 0) {
    object v;
    if (!d.TryGetValue(k, out v) || v == null) return def;
    try { return Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture); } catch { return def; }
  }

  /// For testing, without showing a window: the given request body (as su94r Mini sends it),
  /// or one sample person, drawn to a PNG. Returns the handler's reply.
  public static string Render(string path, string json) {
    Su94rWidget.NeverShow = true;
    string result = "sample";
    if (!string.IsNullOrEmpty(json)) {
      int status;
      LibreMiniPin.Bits = "test";
      result = HandleWidget(json, out status) + " " + status;
    } else {
      long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      var p = new WidgetPerson { Name = "Ken", Mg = 131, Trend = 3, T = now - 60000, Delta = "-1 / 15 min" };
      for (int i = 36; i >= 0; i--) p.Spark.Add(new double[] { now - i * 300000L, 150 + 40 * Math.Sin(i / 5.0) - i * 0.6 });
      Widget.SetPeople(new List<WidgetPerson> { p }, true);
    }
    using (var bmp = new Bitmap(Widget.Width, Widget.Height)) {
      Widget.DrawToBitmap(bmp, new Rectangle(0, 0, Widget.Width, Widget.Height));
      bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    }
    return result;
  }
}
'@

[void][LibreMiniPin]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()
$state = Join-Path $env:USERPROFILE '.su94r\widget.txt'
[Su94rHelper]::Widget = New-Object Su94rWidget $state

if ($RenderTest) {
  $json = if ($RenderJson) { [IO.File]::ReadAllText($RenderJson) } else { '' }
  [Su94rHelper]::Render($RenderTest, $json)
  exit 0
}

if (-not [Su94rHelper]::Start($Port)) { exit 0 }   # port taken: another copy is already running

# 16 random bits: guessing them by cycling a page title would take many hours.
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 2
$rng.GetBytes($bytes)
$bits = -join ($bytes | ForEach-Object { [Convert]::ToString($_, 2).PadLeft(8, '0') })
[LibreMiniPin]::Bits = $bits
[LibreMiniPin]::Code = [LibreMiniPin]::Encode($bits)

# Answer within 0.1 s; re-check window titles every 0.8 s (inside Tick).
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({ [Su94rHelper]::Tick() })
$timer.Start()
[System.Windows.Forms.Application]::Run()
