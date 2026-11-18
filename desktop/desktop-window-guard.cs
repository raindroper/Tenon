using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal static class DesktopWindowGuard
{
    private const string NotepadFamily = "Microsoft.WindowsNotepad_8wekyb3d8bbwe";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly int Session = Process.GetCurrentProcess().SessionId;
    private delegate bool EnumWindowProc(IntPtr hwnd, IntPtr unused);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect bounds);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder family);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private sealed class Window
    {
        public int pid { get; set; }
        public long hwnd { get; set; }
        public long owner { get; set; }
        public string started { get; set; }
        public string windowClass { get; set; }
        public string title { get; set; }
        public bool visible { get; set; }
        public bool minimized { get; set; }
        public int[] bounds { get; set; }
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        SetProcessDPIAware();
        try
        {
            if (Session == 0) throw new InvalidOperationException("没有可用的 Windows 用户会话。");
            if (args.Length == 1 && args[0] == "foreground")
            {
                Console.WriteLine(Json.Serialize(GetForegroundWindow().ToInt64()));
                return 0;
            }
            if (args.Length == 2 && args[0] == "windows")
            {
                Console.WriteLine(Json.Serialize(Windows(args[1])));
                return 0;
            }
            if (args.Length == 14 && args[0] == "capture")
            {
                var window = Windows(args[1]).SingleOrDefault(w => w.hwnd == long.Parse(args[2])
                    && w.pid == int.Parse(args[3]) && w.started == args[4]);
                if (window == null || !window.visible || window.minimized)
                    throw new InvalidOperationException("指定窗口已更换、隐藏或最小化，无法取得截图。");
                var area = new Rectangle(int.Parse(args[6]), int.Parse(args[7]), int.Parse(args[8]), int.Parse(args[9]));
                var expected = args.Skip(10).Select(int.Parse).ToArray();
                if (window.bounds == null || !window.bounds.SequenceEqual(expected))
                    throw new InvalidOperationException("窗口位置已变化，无法确认截图区域。");
                if (args[1] == "notepad" && window.windowClass != "#32770")
                    throw new InvalidOperationException("记事本只可截图本任务的另存为控件。");
                Capture(window, args[5], area);
                if (!Windows(args[1]).Any(w => w.hwnd == window.hwnd && w.pid == window.pid && w.started == window.started
                    && w.title == window.title && w.visible && !w.minimized && w.bounds != null && w.bounds.SequenceEqual(expected)))
                    throw new InvalidOperationException("截图时目标窗口状态已改变，无法确认图片来源。");
                Console.WriteLine("true");
                return 0;
            }
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static bool IsNotepad(Process process)
    {
        var handle = OpenProcess(0x1000, false, process.Id);
        if (handle == IntPtr.Zero) return false;
        try
        {
            uint size = 0;
            if (GetPackageFamilyName(handle, ref size, null) != 122 || size < 2 || size > 128) return false;
            var family = new StringBuilder((int)size);
            return GetPackageFamilyName(handle, ref size, family) == 0 && family.ToString() == NotepadFamily;
        }
        finally { CloseHandle(handle); }
    }

    private static IEnumerable<string> ClashInstallations()
    {
        foreach (var hive in new[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        using (var root = RegistryKey.OpenBaseKey(hive, view))
        using (var uninstall = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"))
        {
            if (uninstall == null) continue;
            foreach (var key in uninstall.GetSubKeyNames())
            using (var app = uninstall.OpenSubKey(key))
            {
                if (app == null || !String.Equals(app.GetValue("DisplayName") as string, "Clash Verge", StringComparison.Ordinal)
                    || !String.Equals(app.GetValue("Publisher") as string, "Clash Verge Rev", StringComparison.Ordinal)) continue;
                string location = (app.GetValue("InstallLocation") as string ?? "").Trim('"', ' ');
                if (!Path.IsPathRooted(location)) continue;
                yield return Path.GetFullPath(Path.Combine(location, "clash-verge.exe"));
            }
        }
    }

    private static bool VerifiedClash(Process process, HashSet<string> installs)
    {
        string executable = Path.GetFullPath(process.MainModule.FileName);
        if (!installs.Contains(executable)) return false;
        var version = process.MainModule.FileVersionInfo;
        return String.Equals(version.ProductName, "Clash Verge", StringComparison.OrdinalIgnoreCase);
    }

    private static List<Window> Windows(string app)
    {
        if (app != "notepad" && app != "clash-verge") throw new ArgumentException("应用未配置执行策略。");
        var notepad = app == "notepad";
        var installs = new HashSet<string>(notepad ? new string[0] : ClashInstallations(), StringComparer.OrdinalIgnoreCase);
        var pids = new Dictionary<int, string>();
        foreach (var process in Process.GetProcessesByName(app))
        using (process)
        {
            try
            {
                if (process.SessionId == Session && (notepad ? IsNotepad(process) : VerifiedClash(process, installs)))
                    pids.Add(process.Id, process.StartTime.ToUniversalTime().Ticks.ToString());
            }
            catch (System.ComponentModel.Win32Exception) { /* Process exited or cannot be queried. */ }
            catch (InvalidOperationException) { /* Process exited. */ }
        }
        var found = new List<Window>();
        EnumWindows(delegate (IntPtr hwnd, IntPtr unused)
        {
            int pid;
            GetWindowThreadProcessId(hwnd, out pid);
            string started;
            if (!pids.TryGetValue(pid, out started)) return true;
            var title = new StringBuilder(512);
            var windowClass = new StringBuilder(100);
            GetWindowText(hwnd, title, title.Capacity);
            GetClassName(hwnd, windowClass, windowClass.Capacity);
            string cls = windowClass.ToString();
            if (notepad ? cls == "Notepad" || cls == "#32770" : cls == "Tauri Window")
            {
                Rect bounds;
                found.Add(new Window { pid = pid, hwnd = hwnd.ToInt64(), owner = GetWindow(hwnd, 4).ToInt64(),
                    started = started, windowClass = cls, title = title.ToString(), visible = IsWindowVisible(hwnd), minimized = IsIconic(hwnd),
                    bounds = GetWindowRect(hwnd, out bounds) ? new[] { bounds.Left, bounds.Top, bounds.Right, bounds.Bottom } : null });
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private static void Capture(Window window, string file, Rectangle area)
    {
        var hwnd = new IntPtr(window.hwnd);
        int left = window.bounds[0], top = window.bounds[1];
        int width = window.bounds[2] - left, height = window.bounds[3] - top;
        if (width < 80 || height < 60 || (long)width * height > 16000000)
            throw new InvalidOperationException("窗口大小不适合截图。");
        using (var original = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        {
            using (var graphics = Graphics.FromImage(original))
            {
                IntPtr dc = graphics.GetHdc();
                try
                {
                    // Ask the window to render itself. Never substitute a screen region.
                    if (!PrintWindow(hwnd, dc, 2)) throw new InvalidOperationException("目标窗口未返回画面。");
                }
                finally { graphics.ReleaseHdc(dc); }
            }
            Rectangle wanted = Rectangle.Intersect(new Rectangle(area.X - left, area.Y - top, area.Width, area.Height),
                new Rectangle(0, 0, width, height));
            if (wanted.Width < 40 || wanted.Height < 25) throw new InvalidOperationException("控件截图区域不在目标窗口内。");
            using (var cropped = original.Clone(wanted, PixelFormat.Format24bppRgb))
                WriteImage(cropped, file);
        }
    }

    private static void WriteImage(Bitmap original, string file)
    {
            int width = original.Width, height = original.Height;
            Color first = original.GetPixel(width / 40, height / 40);
            var hasFrame = false;
            for (int y = 1; y < 40 && !hasFrame; y++)
            for (int x = 1; x < 40; x++)
                if (original.GetPixel(x * width / 40, y * height / 40) != first) { hasFrame = true; break; }
            if (!hasFrame) throw new InvalidOperationException("目标窗口返回空白画面。");

            for (int max = 1280; max >= 480; max -= 160)
            {
                double scale = Math.Min(1, (double)max / Math.Max(width, height));
                using (var png = new MemoryStream())
                using (var frame = new Bitmap(original, Math.Max(1, (int)(width * scale)), Math.Max(1, (int)(height * scale))))
                {
                    frame.Save(png, ImageFormat.Png);
                    if (png.Length > 1000000) continue;
                    using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        png.Position = 0;
                        png.CopyTo(output);
                    }
                    return;
                }
            }
            throw new InvalidOperationException("窗口截图超过附件大小限制。");
    }
}
