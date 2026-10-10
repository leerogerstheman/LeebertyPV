using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

/*
 * WindowTheme.cs - the half of the design system that CSS cannot reach.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * web/css/design-system.css themes everything INSIDE the client area. It cannot
 * touch the frame: on Windows the title bar, the window border and the corner
 * radius are drawn by DWM (the Desktop Window Manager), not by the web engine.
 * Without this file a dark workbench sits inside a bright white title bar, which
 * is the single most obvious "this is a web page in a box" tell.
 *
 * This file is byte-identical in LeebertyGXP, LeebertyPV and PE-Workbench, the
 * same way design-system.css is. It is compiled into each launcher by that
 * repository's scripts/build-desktop.js.
 *
 * WHAT IT SETS, AND WHAT IT DELIBERATELY DOES NOT
 * ----------------------------------------------
 *   DWMWA_USE_IMMERSIVE_DARK_MODE   dark or light title bar and system menu
 *   DWMWA_WINDOW_CORNER_PREFERENCE  Windows 11 rounded corners
 *   DWMWA_BORDER_COLOR              a 1px frame matching the design system line
 *
 * Mica / Acrylic (DWMWA_SYSTEMBACKDROP_TYPE) is NOT set, on purpose. A backdrop
 * material is only visible where the window is transparent, and this window is
 * filled edge to edge by an opaque WebView2 whose page paints
 * `html { background: var(--ds-bg) }`. Setting it would add a call that changes
 * nothing. Making it visible means extending the frame into the client area and
 * punching a transparent region through it - a custom title bar, which is a
 * different piece of work with its own layout consequences.
 *
 * WHY IT IS WRITTEN IN C# 5
 * -------------------------
 * The launchers are compiled by the C# compiler that ships inside the .NET
 * Framework, invoked with /langversion:5. No string interpolation, no nameof, no
 * expression-bodied members, no null-conditional operator. This is not a style
 * preference; the compiler rejects them.
 *
 * WHY IT READS THE REGISTRY
 * -------------------------
 * Windows exposes the "app theme" preference only as a registry value. There is
 * no .NET API for it. AppsUseLightTheme == 0 means the user prefers dark. A
 * missing value or an unreadable key means light, which is the Windows default
 * and the safe answer.
 */

/// <summary>
/// Applies the Windows window-chrome treatment - dark title bar, rounded
/// corners, matching border - to a WinForms window.
/// </summary>
static class WindowTheme
{
    /// <summary>Follow the operating system. The default.</summary>
    public const string System = "system";
    /// <summary>Force the light window chrome.</summary>
    public const string Light = "light";
    /// <summary>Force the dark window chrome.</summary>
    public const string Dark = "dark";

    /// <summary>
    /// The mode requested on the command line, set once from --theme. Anything
    /// that is not "dark" or "light" resolves to the operating system, so a typo
    /// degrades to the sensible default rather than to a wrong theme.
    /// </summary>
    public static string Requested = System;

    // DWMWINDOWATTRIBUTE. The numeric values are the ABI; they are not exported
    // as a header the C# compiler can see, so they are spelled out here.
    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;          // Windows 10 20H1+
    const int DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19;      // Windows 10 1809-1909
    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;         // Windows 11+
    const int DWMWA_BORDER_COLOR = 34;                     // Windows 11+

    const int DWMWCP_ROUND = 2;

    // The design system's --ds-line token, as a COLORREF (0x00BBGGRR):
    //   light #dbe2ea  ->  0x00EAE2DB
    //   dark  #263243  ->  0x00433226
    const int BorderLight = unchecked((int)0x00EAE2DB);
    const int BorderDark = unchecked((int)0x00433226);

    [DllImport("dwmapi.dll", PreserveSig = true)]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>
    /// One DWM attribute. Returns the HRESULT so a caller can tell "the OS
    /// accepted this" from "this build of Windows does not know the attribute".
    /// Never throws: a missing dwmapi.dll is not worth taking the app down for.
    /// </summary>
    static int Set(IntPtr hwnd, int attribute, int value)
    {
        try
        {
            return DwmSetWindowAttribute(hwnd, attribute, ref value, sizeof(int));
        }
        catch (DllNotFoundException) { return -1; }
        catch (EntryPointNotFoundException) { return -1; }
    }

    /// <summary>
    /// True when the user's applications prefer a dark theme. Windows stores this
    /// only in the registry; there is no managed API for it.
    /// </summary>
    public static bool SystemPrefersDark()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            {
                if (key == null) return false;
                object value = key.GetValue("AppsUseLightTheme");
                if (value == null) return false;
                return Convert.ToInt32(value) == 0;
            }
        }
        catch
        {
            // A locked-down or roaming profile can refuse this read. Light is the
            // Windows default, so falling back to it is never surprising.
            return false;
        }
    }

    /// <summary>Resolves --theme, falling back to the operating system.</summary>
    public static bool IsDark()
    {
        if (string.Equals(Requested, Dark, StringComparison.OrdinalIgnoreCase)) return true;
        if (string.Equals(Requested, Light, StringComparison.OrdinalIgnoreCase)) return false;
        return SystemPrefersDark();
    }

    /// <summary>True when --theme pinned a theme rather than following Windows.</summary>
    public static bool IsPinned()
    {
        return string.Equals(Requested, Dark, StringComparison.OrdinalIgnoreCase)
            || string.Equals(Requested, Light, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Normalises a command-line value to one of the three constants.</summary>
    public static string Normalize(string value)
    {
        if (string.Equals(value, Dark, StringComparison.OrdinalIgnoreCase)) return Dark;
        if (string.Equals(value, Light, StringComparison.OrdinalIgnoreCase)) return Light;
        return System;
    }

    /// <summary>
    /// Applies the chrome to a window whose handle already exists.
    /// Returns true when DWM accepted the dark-mode attribute.
    /// </summary>
    public static bool Apply(Form form, bool dark)
    {
        if (form == null) return false;
        IntPtr hwnd = form.Handle;
        if (hwnd == IntPtr.Zero) return false;

        int value = dark ? 1 : 0;

        // The attribute number moved between Windows 10 releases: 19 up to 1909,
        // 20 from 20H1 onwards. Try the current one, then the old one, so the
        // title bar is themed on every supported build instead of only recent
        // ones.
        bool darkApplied = Set(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, value) == 0;
        if (!darkApplied) darkApplied = Set(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE_OLD, value) == 0;

        // Windows 11 only. On Windows 10 these return a failure HRESULT and are
        // simply ignored - there is nothing to round and nothing to recolour.
        Set(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND);
        Set(hwnd, DWMWA_BORDER_COLOR, dark ? BorderDark : BorderLight);

        return darkApplied;
    }

    /// <summary>
    /// Applies the chrome and keeps it in step with Windows.
    ///
    /// Hooking HandleCreated rather than reading form.Handle here is deliberate:
    /// forcing the handle inside a constructor creates the window before
    /// StartPosition has been honoured, and the form then opens at the wrong
    /// place. HandleCreated fires before the first paint, so the title bar is
    /// already dark when the window appears - no white flash.
    ///
    /// When --theme pinned a theme there is nothing to follow, so the
    /// UserPreferenceChanged subscription is skipped entirely.
    /// </summary>
    public static void Attach(Form form)
    {
        if (form == null) return;

        EventHandler applyOnce = delegate { Apply(form, IsDark()); };
        if (form.IsHandleCreated) applyOnce(null, EventArgs.Empty);
        else form.HandleCreated += applyOnce;

        if (IsPinned()) return;

        // Follow a live switch between Windows light and dark. The event can
        // arrive on another thread, so the work is marshalled to the UI thread.
        UserPreferenceChangedEventHandler follow = null;
        follow = delegate(object sender, UserPreferenceChangedEventArgs e)
        {
            try
            {
                if (form.IsDisposed) return;
                if (form.InvokeRequired)
                    form.BeginInvoke((MethodInvoker)delegate { Apply(form, IsDark()); });
                else
                    Apply(form, IsDark());
            }
            catch { /* the window is going away; nothing to re-theme */ }
        };

        try { SystemEvents.UserPreferenceChanged += follow; }
        catch { return; }   // no message pump, or the event service is unavailable

        form.FormClosed += delegate
        {
            // SystemEvents holds a static reference; leaving the handler attached
            // would keep the form alive for the life of the process.
            try { SystemEvents.UserPreferenceChanged -= follow; } catch { }
        };
    }

    /// <summary>
    /// The WebView2 preferred colour scheme for the current mode, or null when
    /// the engine should decide for itself.
    ///
    /// Returning null for "system" is the important part: WebView2's Auto mode
    /// follows Windows live, which is exactly what design-system.css expects from
    /// prefers-color-scheme. Pinning it to Light or Dark here would freeze the
    /// page theme while the title bar kept following the system.
    /// </summary>
    public static int? PreferredColorScheme()
    {
        if (string.Equals(Requested, Dark, StringComparison.OrdinalIgnoreCase)) return 1;  // Dark
        if (string.Equals(Requested, Light, StringComparison.OrdinalIgnoreCase)) return 0; // Light
        return null;                                                                        // Auto
    }

    /// <summary>One line describing the decision, for logs and self-tests.</summary>
    public static string Describe()
    {
        string source = IsPinned() ? "--theme " + Requested : "windows (AppsUseLightTheme)";
        return (IsDark() ? "dark" : "light") + " via " + source;
    }
}
