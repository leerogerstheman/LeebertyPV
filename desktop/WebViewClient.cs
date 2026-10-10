using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

/*
 * WebViewClient.cs - LeebertyPV's web frontend, hosted in a native window.
 *
 * WHY THIS EXISTS ALONGSIDE NativeClient.cs
 * -----------------------------------------
 * LeebertyPV has two frontends. NativeClient.cs + UiKit.cs draw the whole
 * interface with GDI+ in a WinForms window, deliberately without a browser: the
 * launcher's own header says "No Edge, no WebView2, no embedded browser". The
 * web/ folder is the other one - the same views LeebertyGXP and PE-Workbench
 * serve, and the one the shared design system in web/css/design-system.css
 * styles.
 *
 * That is two interfaces to maintain. This file makes the second one viewable in
 * a real window so the two can be compared side by side before anything is
 * deleted. It changes no default: without --webview the launcher still opens
 * NativeForm exactly as before.
 *
 * WHAT IT COSTS
 * -------------
 * desktop/webview2-sdk/ - Microsoft's redistributable hosting component, about
 * 1.4 MB of binaries - is now vendored in this repository, the same way
 * LeebertyGXP vendors it. The launcher is still compiled by the C# compiler that
 * ships inside Windows, still from a set of local .cs files, still with no
 * package manager involved. The cost is disk, not dependencies.
 *
 * The vendored loader is the 64-bit one, matching the other two workbenches. An
 * any-CPU build runs 64-bit on any 64-bit Windows, so this is the right loader
 * in practice; a 32-bit process would not find one and says so in the log.
 */

static class WebViewClient
{
    static Form window;

    /// <summary>True while a web window is open, so the tray can re-focus it.</summary>
    public static bool IsOpen
    {
        get { return window != null && !window.IsDisposed; }
    }

    /// <summary>
    /// The WebView2 SDK bindings must sit beside the exe at runtime. The compiler
    /// could not reference anything it does not have, and the loader is loaded by
    /// name when the control initialises.
    /// </summary>
    public static bool SdkPresent()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        return File.Exists(Path.Combine(dir, "Microsoft.Web.WebView2.Core.dll"))
            && File.Exists(Path.Combine(dir, "Microsoft.Web.WebView2.WinForms.dll"))
            && File.Exists(Path.Combine(dir, "WebView2Loader.dll"));
    }

    /// <summary>
    /// The engine to host. Prefer the standalone WebView2 runtime; when it is
    /// absent fall back to Edge's own engine folder, which the SDK accepts as a
    /// browser executable folder. Either way the engine runs inside our window -
    /// no browser chrome is opened.
    /// </summary>
    public static string FindRuntime()
    {
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

        string runtimeRoot = Path.Combine(pf86, "Microsoft", "EdgeWebView", "Application");
        if (Directory.Exists(runtimeRoot))
        {
            var dirs = Directory.GetDirectories(runtimeRoot).OrderByDescending(d => d).ToArray();
            if (dirs.Length > 0 && File.Exists(Path.Combine(dirs[0], "msedgewebview2.exe"))) return dirs[0];
        }

        string edgeCore = Path.Combine(pf86, "Microsoft", "EdgeCore");
        if (Directory.Exists(edgeCore))
        {
            var dirs = Directory.GetDirectories(edgeCore).OrderByDescending(d => d).ToArray();
            foreach (string d in dirs)
            {
                if (File.Exists(Path.Combine(d, "msedgewebview2.exe"))) return d;
            }
        }
        return null;
    }

    /// <summary>
    /// Open the web interface in a native window. Returns false when the runtime
    /// or the SDK bindings are missing, so the caller can fall back to the native
    /// client instead of leaving the user with nothing.
    /// </summary>
    public static bool Open(string baseUrl)
    {
        if (!SdkPresent())
        {
            Program.LogLine("webview: SDK bindings missing beside the exe");
            return false;
        }

        string runtimeDir = FindRuntime();
        if (runtimeDir == null)
        {
            Program.LogLine("webview: no WebView2 runtime or EdgeCore engine found");
            return false;
        }
        Program.LogLine("webview: engine " + runtimeDir);

        string userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LeebertyPV", "webview2");
        Directory.CreateDirectory(userData);

        CoreWebView2Environment env;
        try
        {
            var task = CoreWebView2Environment.CreateAsync(runtimeDir, userData, new CoreWebView2EnvironmentOptions());
            if (!task.Wait(20000)) { Program.LogLine("webview: environment creation timed out"); return false; }
            env = task.Result;
        }
        catch (Exception ex)
        {
            Program.LogLine("webview: environment creation failed: " + ex.Message);
            return false;
        }

        // Same window chrome as the other two workbenches: the theme and the
        // optional custom title bar come from the shared WindowTheme.
        Form form = WindowTheme.CustomTitleBar
            ? (Form)new WindowTheme.ChromeForm()
            : new Form();
        form.Text = "LeebertyPV 药物警戒工作台";
        form.StartPosition = FormStartPosition.CenterScreen;
        form.Size = new Size(1400, 900);
        form.MinimumSize = new Size(1024, 680);
        form.BackColor = Color.FromArgb(16, 32, 54);
        try { form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        WindowTheme.Attach(form);

        var wv = new WebView2();
        wv.Dock = DockStyle.Fill;
        form.Controls.Add(wv);

        wv.CoreWebView2InitializationCompleted += async (s, e) =>
        {
            if (!e.IsSuccess || wv.CoreWebView2 == null)
            {
                Program.LogLine("webview: initialization failed: "
                    + (e.InitializationException != null ? e.InitializationException.Message : "unknown"));
                return;
            }

            try { wv.CoreWebView2.Settings.IsStatusBarEnabled = false; } catch { }

            try
            {
                int? scheme = WindowTheme.PreferredColorScheme();
                wv.CoreWebView2.Profile.PreferredColorScheme = !scheme.HasValue
                    ? CoreWebView2PreferredColorScheme.Auto
                    : (scheme.Value == 1 ? CoreWebView2PreferredColorScheme.Dark
                                         : CoreWebView2PreferredColorScheme.Light);
            }
            catch { }

            // Custom title bar, when asked for. Both halves have to be in place
            // before the first navigation: the setting is documented as taking
            // effect "after the next navigation", and the shell marker has to be
            // registered before the document exists or the page paints one frame
            // in the browser layout.
            if (WindowTheme.CustomTitleBar)
            {
                bool nonClientOk = false;
                try
                {
                    wv.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = true;
                    nonClientOk = wv.CoreWebView2.Settings.IsNonClientRegionSupportEnabled;
                }
                catch (Exception ncEx) { Program.LogLine("webview: non-client regions unavailable: " + ncEx.Message); }

                if (nonClientOk && WindowTheme.ExtendFrameIntoClientArea(form))
                {
                    try
                    {
                        // Awaited, not .Wait()ed: the WebView2 task posts its
                        // continuation back to this UI thread, so blocking would
                        // deadlock.
                        await wv.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                            WindowTheme.ShellMarkerScript());
                        Program.LogLine("webview: custom title bar enabled");
                    }
                    catch (Exception smEx) { Program.LogLine("webview: shell marker not registered: " + smEx.Message); }
                }
                else
                {
                    Program.LogLine("webview: custom title bar requested but not applied");
                }
            }

            wv.CoreWebView2.Navigate(baseUrl);
        };

        form.FormClosed += delegate
        {
            try { wv.Dispose(); } catch { }
            window = null;
        };

        window = form;
        form.Show();
        form.Activate();

        try { wv.EnsureCoreWebView2Async(env); }
        catch (Exception ex) { Program.LogLine("webview: EnsureCoreWebView2Async threw: " + ex.Message); }

        return true;
    }

    /// <summary>Bring an already-open web window back to the front.</summary>
    public static void Focus()
    {
        if (!IsOpen) return;
        try
        {
            if (window.WindowState == FormWindowState.Minimized)
                window.WindowState = FormWindowState.Normal;
            window.Show();
            window.BringToFront();
            window.Activate();
        }
        catch { }
    }

    /// <summary>Close the web window, if one is open.</summary>
    public static void Close()
    {
        try { if (IsOpen) window.Close(); } catch { }
        window = null;
    }
}
