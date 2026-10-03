using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;

/*
 * LeebertyPV - desktop launcher.
 *
 * WHY A NATIVE WINDOW AND NO BROWSER
 * ----------------------------------
 * The workbench deliberately has zero third-party runtime dependencies. The
 * desktop client is a native WinForms window (see NativeClient.cs) - its own
 * title bar, taskbar icon and tray entry - rendered entirely with the controls
 * Windows ships with. No Edge, no WebView2, no embedded browser. The window
 * talks to the local LeebertyPV Node service over its REST API, exactly as a
 * thin desktop client for a local server should.
 *
 * The launcher is compiled locally at build time by scripts/build-desktop.js
 * using the C# compiler (csc.exe) that ships with Windows.
 *
 * WHAT IT DOES
 *   1. Reuses an already-running instance if the health endpoint answers.
 *   2. Otherwise starts `node src/server.js` hidden, and waits for health.
 *   3. Opens the native application window.
 *   4. Sits in the notification area with a menu: open, verify audit trail,
 *      generate demo data, back up, stop, exit.
 */
static class Program
{
    const string AppName = "LeebertyPV";
    /// <summary>Optional startup view from --go (view or view:param), also used
    /// by the screenshot verification to open a specific page directly.</summary>
    internal static string StartView;
    /// <summary>Optional auto-login account from --login (demo scripting).</summary>
    internal static string StartLogin;

    static NotifyIcon tray;
    static Process serverProcess;
    static string port = "8793";
    static string root;
    static string nodeExe;
    static bool weStartedServer;
    static NativeForm mainForm;

    /// <summary>Locate the directory that contains src\server.js.</summary>
    static string ResolveRoot()
    {
        string[] starts = new string[]
        {
            AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'),
            Directory.GetCurrentDirectory().TrimEnd('\\')
        };

        foreach (string start in starts)
        {
            string dir = start;
            for (int depth = 0; depth < 5 && dir != null; depth++)
            {
                if (File.Exists(Path.Combine(dir, "src", "server.js"))) return dir;
                DirectoryInfo parent = Directory.GetParent(dir);
                dir = parent == null ? null : parent.FullName;
            }
        }
        return AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    }

    [STAThread]
    static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        root = ResolveRoot();
        bool selfTest = false;
        bool selfRepair = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length) port = args[i + 1];
            else if (args[i] == "--root" && i + 1 < args.Length) root = args[i + 1];
            else if (args[i] == "--selftest") selfTest = true;
            else if (args[i] == "--repair-demo") selfRepair = true;
            else if (args[i] == "--go" && i + 1 < args.Length) StartView = args[i + 1];
            else if (args[i] == "--login" && i + 1 < args.Length) StartLogin = args[i + 1];
        }

        nodeExe = FindNode();

        // Headless verification path: exercises discovery and process management
        // without putting a window or a tray icon on screen.
        if (selfTest) { RunSelfTest(); return; }

        if (nodeExe == null)
        {
            MessageBox.Show(
                "未找到 Node.js。\r\n\r\n本工作台需要 Node.js 22.5 或更高版本。\r\n请从 https://nodejs.org 安装后重试。\r\n\r\n" +
                "Node.js was not found. This workbench requires Node.js 22.5 or newer.\r\n" +
                "Install the LTS build from https://nodejs.org and try again.",
                AppName + " - 缺少运行环境", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }

        // Headless self-repair mode: move a damaged data folder aside so the next
        // start can create a fresh demonstration instance. No window, no tray.
        if (selfRepair)
        {
            int rc = HeadlessRepair();
            Environment.Exit(rc);
        }

        BuildTray();

        if (HealthOk())
        {
            ShowTrayMessage("已连接到运行中的实例 / Connected to the running instance");
        }
        else
        {
            if (!StartServer())
            {
                tray.Visible = false;
                return;
            }
            ShowTrayMessage("正在启动，请稍候… / Starting, please wait…");
        }

        // Open the native window once the server answers. A WinForms Form must be
        // created and shown on the same STA thread that runs the message pump, so
        // this cannot happen on a background thread: a UI-thread timer polls
        // health, and the first healthy tick opens the window.
        //
        // A server that refuses to start (e.g. an audit-trail integrity failure
        // from a damaged data folder) would otherwise leave the user staring at a
        // blank window forever. The timer therefore diagnoses failure after a
        // timeout: the user is told what happened and offered a one-click reset
        // of the demonstration instance (the damaged data folder is moved aside,
        // never just deleted).
        var bootTimer = new System.Windows.Forms.Timer { Interval = 200 };
        int bootTicks = 0;
        bootTimer.Tick += (s, e) =>
        {
            if (HealthOk()) { bootTimer.Stop(); OpenWindow(); return; }
            bootTicks++;
            if (bootTicks > 110)   // ~22s: enough for first-run seeding
            {
                bootTimer.Stop();
                DiagnoseAndRecover();
            }
        };
        bootTimer.Start();

        Application.Run();
    }

    // -------------------------------------------------------------- selftest --

    static void RunSelfTest()
    {
        int failures = 0;
        Action<string, bool, string> check = (name, ok, detail) =>
        {
            Console.WriteLine((ok ? "  PASS  " : "  FAIL  ") + name + (detail.Length > 0 ? "  [" + detail + "]" : ""));
            if (!ok) failures++;
        };

        Console.WriteLine();
        Console.WriteLine("  LeebertyPV - desktop launcher self-test");
        Console.WriteLine("  " + new string('=', 66));
        Console.WriteLine();
        Console.WriteLine("  root        " + root);
        Console.WriteLine("  port        " + port);
        Console.WriteLine();

        check("Node.js runtime is discoverable", nodeExe != null, nodeExe ?? "not found");
        check("the server entry point exists", File.Exists(Path.Combine(root, "src", "server.js")),
            Path.Combine(root, "src", "server.js"));
        check("the desktop icon can be drawn without a resource file", MakeIcon() != null, "generated");
        check("the native client type compiles and loads", typeof(NativeForm) != null, "NativeForm");
        check("the health probe reports no server on a free port", !HealthOk(), "port " + port);

        if (nodeExe == null) { Console.WriteLine("\n  " + failures + " failure(s)\n"); Environment.Exit(1); }

        bool started = StartServer();
        check("the server starts as a hidden child process", started,
            serverProcess != null ? "pid " + serverProcess.Id : "no process");

        bool healthy = false;
        for (int i = 0; i < 40; i++)
        {
            if (HealthOk()) { healthy = true; break; }
            Thread.Sleep(250);
        }
        check("the server answers on the expected port within 10 seconds", healthy,
            "port " + port);

        // The REST API answers and the native client can read the domain list:
        // this proves the window has a live backend without opening a window.
        bool apiOk = false;
        string diag = "";
        try
        {
            using (var client = new System.Net.WebClient())
            {
                var json = client.DownloadString("http://127.0.0.1:" + port + "/api/domains");
                apiOk = json.Contains("ICSR") && json.Contains("GVP");
                diag = apiOk ? "domains payload OK" : "payload missing domains";
            }
        }
        catch (Exception ex)
        {
            diag = ex.Message;
        }
        check("the native client backend (/api/domains) answers", apiOk, diag);

        // Headless UI smoke test: instantiate the native window and render the
        // core views against the live API (logging in with a demo account when
        // available). No window is shown and nothing is clicked by a human.
        bool uiOk = false;
        string uiDiag = "";
        try
        {
            using (var form = new NativeForm())
            {
                string smoke = form.SmokeTest();
                uiOk = smoke == "";
                uiDiag = uiOk ? "core views rendered" : smoke.Trim();
            }
        }
        catch (Exception ex)
        {
            uiDiag = ex.Message;
        }
        check("the native window renders core views (smoke test)", uiOk, uiDiag);

        StopServer();
        Thread.Sleep(1200);
        bool gone = true;
        for (int i = 0; i < 20; i++)
        {
            if (!HealthOk()) { gone = true; break; }
            gone = false;
            Thread.Sleep(250);
        }
        check("stopping the launcher releases the port", gone, gone ? "released" : "still listening");

        Console.WriteLine();
        Console.WriteLine(failures == 0
            ? "  SELF-TEST PASSED - the launcher starts, serves and stops cleanly"
            : "  SELF-TEST FAILED - " + failures + " check(s) failed");
        Console.WriteLine();
        Environment.Exit(failures == 0 ? 0 : 1);
    }

    // -------------------------------------------------------- failure paths --

    /// <summary>Read the tail of logs\desktop.log (the launcher's own log).</summary>
    static string ReadLogTail(int lines)
    {
        try
        {
            string file = Path.Combine(root, "logs", "desktop.log");
            if (!File.Exists(file)) return "";
            var all = File.ReadAllLines(file);
            int take = Math.Min(lines, all.Length);
            var sb = new System.Text.StringBuilder();
            for (int i = all.Length - take; i < all.Length; i++) sb.AppendLine(all[i]);
            return sb.ToString().TrimEnd();
        }
        catch { return ""; }
    }

    /// <summary>Move the data folder aside (preserving it for investigation),
    /// never delete it. Returns true when something was moved.</summary>
    static bool RepairDemoData()
    {
        string dataDir = Path.Combine(root, "data");
        if (!Directory.Exists(dataDir)) return false;
        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        string target = dataDir + "-corrupt-" + stamp;
        try
        {
            Directory.Move(dataDir, target);
            return true;
        }
        catch (Exception ex)
        {
            LogLine("repair move failed: " + ex.Message);
            return false;
        }
    }

    /// <summary>GUI path: explain the failure and offer a one-click reset of the
    /// demonstration instance. Called from the UI-thread boot timer.</summary>
    static void DiagnoseAndRecover()
    {
        string logTail = ReadLogTail(80);
        bool integrity = logTail.IndexOf("AUDIT TRAIL INTEGRITY FAILURE", StringComparison.OrdinalIgnoreCase) >= 0
            || logTail.IndexOf("integrity failure", StringComparison.OrdinalIgnoreCase) >= 0
            || logTail.IndexOf("chain", StringComparison.OrdinalIgnoreCase) >= 0 && logTail.IndexOf("fail", StringComparison.OrdinalIgnoreCase) >= 0;

        if (integrity)
        {
            var choice = MessageBox.Show(
                "服务器未能启动：审计追踪完整性校验失败。\r\n" +
                "这通常意味着数据文件与审计链密钥不一致，或数据被修改过（演示环境最常见的原因是 data 目录被部分清理、或在旧实例运行期间被删除）。\r\n\r\n" +
                "演示环境可以一键修复：把现有 data 文件夹移到 data-corrupt-<时间戳> 保留现场，然后生成一套全新的演示数据。\r\n" +
                "生产实例请勿使用此功能——请按数据完整性事件处置程序处理，并保全数据。\r\n\r\n" +
                "是否现在重置演示实例？\r\n\r\n" +
                "The server could not start: audit trail integrity check failed. Move data aside and rebuild a fresh demo instance?",
                AppName + " — 审计链完整性故障 / integrity failure",
                MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (choice == DialogResult.Yes)
            {
                RepairDemoData();
                KillPortHolder();
                serverProcess = null;
                weStartedServer = false;
                StartServer();
                StartBootPoller();
                return;
            }
            tray.Visible = false;
            Environment.Exit(3);
            return;
        }

        string info = ReadLogTail(40);
        MessageBox.Show(
            "工作台服务未能就绪（端口 " + port + " 没有应答）。\r\n\r\n最近日志：\r\n" +
            (info == "" ? "（无日志）" : info) +
            "\r\n\r\n可尝试：\r\n  1) 查看 logs\\desktop.log 与 logs\\server.log\r\n" +
            "  2) 用 stop.bat 停止旧实例后重新启动\r\n  3) 首次初始化生成演示数据需要约 5-10 秒",
            AppName + " — 启动失败 / start failure",
            MessageBoxButtons.OK, MessageBoxIcon.Error);
        tray.Visible = false;
        Environment.Exit(4);
    }

    /// <summary>Restart the health-polling timer after a repair (same logic as
    /// the boot timer in Main, factored out so a repair can reuse it).</summary>
    static void StartBootPoller()
    {
        var timer = new System.Windows.Forms.Timer { Interval = 200 };
        int ticks = 0;
        timer.Tick += (s, e) =>
        {
            if (HealthOk()) { timer.Stop(); OpenWindow(); return; }
            ticks++;
            if (ticks > 110) { timer.Stop(); DiagnoseAndRecover(); }
        };
        timer.Start();
    }

    /// <summary>Headless repair for scripts and tests: move a damaged data
    /// folder aside (nothing else, no window). Exit 0 on success.</summary>
    static int HeadlessRepair()
    {
        Console.WriteLine();
        Console.WriteLine("  LeebertyPV - demo instance repair");
        Console.WriteLine("  " + new string('=', 66));
        Console.WriteLine("  root   " + root);
        Console.WriteLine("  port   " + port);
        Console.WriteLine();
        // Make sure nothing is still holding the data folder.
        if (HealthOk()) KillPortHolder();
        if (RepairDemoData())
        {
            Console.WriteLine("  moved data aside; a fresh demonstration instance will be created");
            Console.WriteLine("  on the next start (keep the preserved folder for investigation).");
            Console.WriteLine();
            return 0;
        }
        Console.WriteLine("  nothing to repair: no data folder present (or it cannot be moved).");
        Console.WriteLine();
        return 0;
    }

    // ------------------------------------------------------------- discovery --

    static string FindNode()
    {
        string[] candidates = new string[]
        {
            Path.Combine(root, "node", "node.exe"),
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"),
        };
        foreach (string c in candidates)
        {
            if (File.Exists(c)) return c;
        }
        return null;
    }

    static string BaseUrl { get { return "http://127.0.0.1:" + port; } }

    static bool HealthOk()
    {
        try
        {
            using (var client = new TcpClient())
            {
                var task = client.ConnectAsync("127.0.0.1", int.Parse(port));
                if (!task.Wait(1200)) return false;
                return client.Connected;
            }
        }
        catch { return false; }
    }

    // ---------------------------------------------------------------- server --

    /// <summary>
    /// Set one environment variable on the child process, reporting rather than
    /// swallowing a failure. Returns true when the value was applied.
    /// </summary>
    static bool SetEnvVar(ProcessStartInfo psi, string name, string value)
    {
        try
        {
            psi.EnvironmentVariables[name] = value;
            return true;
        }
        catch (ArgumentException)
        {
            // The inherited environment holds two names differing only in case,
            // which this dictionary cannot represent. Remove the colliding twin
            // and retry once before giving up: losing PV_BUILTIN_ACCOUNTS means
            // the instance starts with no way to sign in at all.
            try
            {
                // Plain loop rather than LINQ: this file is compiled by csc from
                // the .NET Framework directory and does not reference System.Linq.
                string twin = null;
                foreach (string key in psi.EnvironmentVariables.Keys)
                {
                    if (string.Equals(key, name, StringComparison.OrdinalIgnoreCase)
                        && !string.Equals(key, name, StringComparison.Ordinal))
                    {
                        twin = key;
                        break;
                    }
                }
                if (twin != null)
                {
                    psi.EnvironmentVariables.Remove(twin);
                    psi.EnvironmentVariables[name] = value;
                    LogLine("environment: removed colliding '" + twin + "' to set '" + name + "'");
                    return true;
                }
            }
            catch (Exception retryError)
            {
                LogLine("environment: could not set '" + name + "' (" + retryError.Message + ")");
                return false;
            }
            LogLine("environment: could not set '" + name + "' (duplicate-case variable name)");
            return false;
        }
        catch (Exception ex)
        {
            LogLine("environment: could not set '" + name + "' (" + ex.Message + ")");
            return false;
        }
    }

    static bool StartServer()
    {
        string serverJs = Path.Combine(root, "src", "server.js");
        if (!File.Exists(serverJs))
        {
            MessageBox.Show(
                "未找到 src\\server.js，请确认启动器与程序文件在同一目录。\r\n" +
                "src\\server.js was not found; keep the launcher beside the application files.",
                AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }

        var psi = new ProcessStartInfo(nodeExe, "\"" + serverJs + "\"")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // Environment overrides are set one at a time, each in its own guard.
        //
        // WHY NOT ONE try/catch: ProcessStartInfo.EnvironmentVariables is a
        // case-insensitive StringDictionary built from the inherited environment.
        // If that environment already contains two names differing only in case
        // (Windows permits this), the first assignment throws ArgumentException -
        // and a single surrounding try/catch then silently discards *every*
        // override, not just the offending one. The observed consequence was
        // severe: PV_BUILTIN_ACCOUNTS never reached the server, so the instance
        // came up with no demonstration accounts and no way to sign in, while the
        // log line reported nothing more specific than "overrides skipped".
        //
        // Setting each separately means a failure is reported against the
        // variable that actually failed, and the others still take effect.
        SetEnvVar(psi, "PV_PORT", port);
        SetEnvVar(psi, "PV_OPEN_BROWSER", "0");
        if (Environment.GetEnvironmentVariable("PV_BUILTIN_ACCOUNTS") == null)
        {
            SetEnvVar(psi, "PV_BUILTIN_ACCOUNTS", "1");
        }

        try
        {
            serverProcess = new Process();
            serverProcess.StartInfo = psi;
            serverProcess.OutputDataReceived += (s, e) => { };
            serverProcess.ErrorDataReceived += (s, e) =>
            {
                if (e.Data != null) LogLine("[server] " + e.Data);
            };
            serverProcess.Start();
            serverProcess.BeginOutputReadLine();
            serverProcess.BeginErrorReadLine();
            weStartedServer = true;
            LogLine("server started, pid " + serverProcess.Id);
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show("启动失败 / Failed to start:\r\n" + ex.Message, AppName,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
    }

    static void StopServer()
    {
        if (!weStartedServer || serverProcess == null) return;
        try
        {
            if (!serverProcess.HasExited)
            {
                serverProcess.Kill();
                serverProcess.WaitForExit(5000);
            }
        }
        catch { }
        finally
        {
            KillPortHolder();
        }
        serverProcess = null;
        weStartedServer = false;
    }

    static void KillPortHolder()
    {
        try
        {
            var psi = new ProcessStartInfo("cmd.exe", "/c netstat -ano -p TCP | findstr LISTENING | findstr :" + port)
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true,
            };
            var p = Process.Start(psi);
            string output = p.StandardOutput.ReadToEnd();
            p.WaitForExit(4000);
            foreach (string line in output.Split('\n'))
            {
                string[] parts = line.Trim().Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5) continue;
                int pid;
                if (!int.TryParse(parts[parts.Length - 1], out pid)) continue;
                try { Process.GetProcessById(pid).Kill(); } catch { }
            }
        }
        catch { }
    }

    // ----------------------------------------------------------------- window --

    static void OpenWindow()
    {
        if (!HealthOk())
        {
            ShowTrayMessage("服务未能启动，请查看日志 / The server did not start; check the log");
            return;
        }
        try
        {
            if (mainForm == null || mainForm.IsDisposed)
            {
                mainForm = new NativeForm();
                mainForm.FormClosed += (s, e) => { mainForm = null; };
            }
            // Bring the native window to the front (restore from tray double-click).
            mainForm.Show();
            if (mainForm.WindowState == FormWindowState.Minimized) mainForm.WindowState = FormWindowState.Normal;
            mainForm.BringToFront();
            mainForm.Activate();
        }
        catch (Exception ex)
        {
            MessageBox.Show("无法打开窗口 / Cannot open the window:\r\n" + ex.Message, AppName,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>Run one of the project's command-line tools in a visible console.</summary>
    static void RunTool(string arguments, string title)
    {
        try
        {
            string cmd = "\"" + nodeExe + "\" " + arguments + " & echo. & echo " + title + " & pause";
            Process.Start(new ProcessStartInfo("cmd.exe", "/k chcp 65001 >nul & " + cmd)
            {
                WorkingDirectory = root,
                UseShellExecute = true,
            });
        }
        catch (Exception ex) { ShowTrayMessage("无法运行 / Cannot run: " + ex.Message); }
    }

    // ------------------------------------------------------------------ tray --

    static void BuildTray()
    {
        tray = new NotifyIcon();
        tray.Icon = MakeIcon();
        tray.Text = AppName;
        tray.Visible = true;

        var menu = new ContextMenuStrip();
        menu.Items.Add(MenuItem("打开工作台 / Open", (s, e) => OpenWindow(), true));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(MenuItem("生成演示数据 / Generate demo data",
            (s, e) => RunTool("\"scripts\\seed-demo.js\"", "演示数据已生成 / demo data generated"), false));
        menu.Items.Add(MenuItem("校验审计追踪 / Verify audit trail",
            (s, e) => RunTool("\"scripts\\verify-audit.js\"", "校验完成 / verification complete"), false));
        menu.Items.Add(MenuItem("备份数据 / Back up data",
            (s, e) => RunTool("\"scripts\\backup.js\"", "备份完成 / backup complete"), false));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(MenuItem("停止并退出 / Stop and exit", (s, e) =>
        {
            if (MessageBox.Show(
                "将停止服务与后台工作流进程。\r\n数据已提交到磁盘，可以安全退出。\r\n\r\n" +
                "This stops the server and the background workflow monitor.\r\nThe data is already committed to disk.",
                AppName, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK)
            {
                StopServer();
                tray.Visible = false;
                Application.Exit();
            }
        }, false));

        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (s, e) => OpenWindow();
    }

    static ToolStripMenuItem MenuItem(string text, EventHandler handler, bool bold)
    {
        var item = new ToolStripMenuItem(text);
        item.Click += handler;
        if (bold) item.Font = new Font(item.Font, FontStyle.Bold);
        return item;
    }

    static void ShowTrayMessage(string message)
    {
        try { tray.ShowBalloonTip(2500, AppName, message, ToolTipIcon.Info); } catch { }
    }

    /// <summary>Draw the tray icon at runtime so the build needs no .ico resource.</summary>
    static Icon MakeIcon()
    {
        var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;

            using (var grad = new System.Drawing.Drawing2D.LinearGradientBrush(
                new Rectangle(0, 0, 32, 32),
                Color.FromArgb(16, 32, 84),
                Color.FromArgb(2, 4, 12),
                System.Drawing.Drawing2D.LinearGradientMode.ForwardDiagonal))
            {
                g.FillRectangle(grad, 0, 0, 32, 32);
            }

            using (var pen = new Pen(Color.FromArgb(120, 160, 255), 1.2f))
            {
                g.DrawEllipse(pen, 1.4f, 1.4f, 29.2f, 29.2f);
            }

            // The monogram: gothic face, stretched tall and narrow.
            g.TranslateTransform(16, 21);
            g.ScaleTransform(0.82f, 1.6f);
            using (var font = new Font("Old English Text MT", 15f, FontStyle.Regular, GraphicsUnit.Pixel))
            {
                using (var brush = new SolidBrush(Color.FromArgb(233, 240, 255)))
                {
                    var sz = g.MeasureString("PV", font);
                    g.DrawString("PV", font, brush, -sz.Width / 2f, -sz.Height / 2f);
                }
            }
            g.ResetTransform();
        }
        IntPtr handle = bmp.GetHicon();
        return Icon.FromHandle(handle);
    }

    static void LogLine(string line)
    {
        try
        {
            string dir = Path.Combine(root, "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "desktop.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine);
        }
        catch { }
    }
}