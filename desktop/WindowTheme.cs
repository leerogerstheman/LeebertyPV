using System;
using System.Drawing;
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
    /// True when --custom-titlebar was passed.
    ///
    /// Opt-in on purpose. The custom title bar depends on a chain of Win32 and
    /// WebView2 behaviour that no automated check in this repository can fully
    /// confirm - whether the system caption buttons are still drawn, whether the
    /// window still resizes from its edges, whether a maximised window still
    /// respects the taskbar. A person has to look at it once. Until then the
    /// standard caption, correctly dark-themed, remains the default.
    /// </summary>
    public static bool CustomTitleBar = false;

    // The three messages a window with no non-client area has to answer itself.
    const int WM_NCCALCSIZE = 0x0083;
    const int WM_NCHITTEST = 0x0084;
    const int WM_GETMINMAXINFO = 0x0024;

    // HT* codes from winuser.h.
    const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13,
              HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

    /// <summary>
    /// How close to an edge counts as "on the resize border", in pixels. 8 is the
    /// Windows default sizing border at 100% scaling.
    /// </summary>
    const int ResizeBorder = 8;

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    /* NCCALCSIZE_PARAMS declares rgrc[3]; spelled out as three fields because a
       fixed-size array of structs cannot be marshalled by value in C# 5. */
    [StructLayout(LayoutKind.Sequential)]
    struct NCCALCSIZE_PARAMS { public RECT rgrc0, rgrc1, rgrc2; public IntPtr lppos; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MINMAXINFO
    {
        public POINT ptReserved, ptMaxSize, ptMaxPosition,
                     ptMinTrackSize, ptMaxTrackSize;
    }

    [DllImport("dwmapi.dll", PreserveSig = true)]
    static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);

    [StructLayout(LayoutKind.Sequential)]
    struct MARGINS { public int Left, Right, Top, Bottom; }

    /// <summary>
    /// A WinForms window whose client area covers the caption strip, so the page
    /// can be its own title bar.
    ///
    /// The system buttons survive because WS_CAPTION is never touched: DWM keeps
    /// drawing them over the top-right corner. That is the whole reason this uses
    /// WM_NCCALCSIZE instead of deleting WS_CAPTION, which was measured to shrink
    /// the caption but leave the client area 14px short and take the buttons with
    /// it.
    /// </summary>
    public class ChromeForm : Form
    {
        protected override void WndProc(ref Message m)
        {
            if (CustomTitleBar)
            {
                // WM_GETMINMAXINFO must be filled in by the default handler first,
                // so it is the one message that runs base first and is adjusted after.
                if (m.Msg == WM_GETMINMAXINFO)
                {
                    base.WndProc(ref m);
                    AdjustMinMaxInfo(this, ref m);
                    return;
                }
                if (HandleNcCalcSize(ref m)) return;
                if (HandleNcHitTest(this, ref m)) return;
            }
            base.WndProc(ref m);
        }
    }

    /// <summary>
    /// Claim the caption strip for the client area. Returns true when handled.
    ///
    /// Exposed separately from ChromeForm so a window that already derives from
    /// Form and has its own WndProc - PE-Workbench's MainForm - can call the same
    /// code instead of inheriting a second base class.
    /// </summary>
    public static bool HandleNcCalcSize(ref Message m)
    {
        if (m.Msg != WM_NCCALCSIZE || m.WParam == IntPtr.Zero) return false;

        // Leaving rgrc0 exactly as Windows proposed it and returning 0 means
        // "the non-client area is empty": the client area becomes the whole
        // window, caption included. Verification measured this as captionInset 0,
        // against 39 for a stock window.
        m.Result = IntPtr.Zero;
        return true;
    }

    /// <summary>
    /// Give the window back its resize edges. Returns true when handled.
    ///
    /// A window whose non-client area is empty has nothing for Windows to
    /// hit-test as a border, so without this the window cannot be resized by
    /// dragging its edge. The drag regions themselves are not handled here: those
    /// come from the engine, through app-region.
    /// </summary>
    public static bool HandleNcHitTest(Form form, ref Message m)
    {
        if (m.Msg != WM_NCHITTEST || form == null) return false;

        // Offer no resize grips on a maximised window; edges are off-screen.
        if (form.WindowState == FormWindowState.Maximized) return false;

        int lp = m.LParam.ToInt32();
        int screenX = (short)(lp & 0xFFFF);
        int screenY = (short)((lp >> 16) & 0xFFFF);

        Point p = form.PointToClient(new Point(screenX, screenY));
        int w = form.ClientSize.Width;
        int h = form.ClientSize.Height;

        bool left = p.X < ResizeBorder;
        bool right = p.X >= w - ResizeBorder;
        bool top = p.Y < ResizeBorder;
        bool bottom = p.Y >= h - ResizeBorder;

        int hit = 0;
        if (top && left) hit = HTTOPLEFT;
        else if (top && right) hit = HTTOPRIGHT;
        else if (bottom && left) hit = HTBOTTOMLEFT;
        else if (bottom && right) hit = HTBOTTOMRIGHT;
        else if (left) hit = HTLEFT;
        else if (right) hit = HTRIGHT;
        else if (top) hit = HTTOP;
        else if (bottom) hit = HTBOTTOM;

        if (hit == 0) return false;
        m.Result = (IntPtr)hit;
        return true;
    }

    /// <summary>
    /// Keep a maximised window inside the monitor work area. Call AFTER the
    /// default handler has filled the structure.
    ///
    /// Windows maximises a window to the work area plus the frame thickness,
    /// because it expects the frame to be drawn inside that rectangle. With no
    /// non-client area the content would hang over the screen edges and under the
    /// taskbar. Pulling the frame thickness back out is what stops that.
    /// </summary>
    public static void AdjustMinMaxInfo(Form form, ref Message m)
    {
        if (form == null) return;
        try
        {
            MINMAXINFO mmi = (MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(MINMAXINFO));
            int bw = SystemInformation.FrameBorderSize.Width;
            if (bw <= 0) bw = ResizeBorder;

            mmi.ptMaxPosition.X += bw;
            mmi.ptMaxPosition.Y += bw;
            mmi.ptMaxSize.X -= bw * 2;
            mmi.ptMaxSize.Y -= bw * 2;

            Marshal.StructureToPtr(mmi, m.LParam, false);
        }
        catch { /* the structure has changed shape; leave the default */ }
    }

    /// <summary>
    /// Hand the caption strip to the page: extend the frame so DWM keeps drawing
    /// the shadow, the rounded corners and the border, then let the stylesheet
    /// take over the strip itself.
    /// </summary>
    public static bool ExtendFrameIntoClientArea(Form form)
    {
        if (form == null) return false;
        IntPtr hwnd = form.Handle;
        if (hwnd == IntPtr.Zero) return false;

        MARGINS margins = new MARGINS();
        margins.Left = -1;
        margins.Right = -1;
        margins.Top = -1;
        margins.Bottom = -1;

        try { return DwmExtendFrameIntoClientArea(hwnd, ref margins) == 0; }
        catch (DllNotFoundException) { return false; }
        catch (EntryPointNotFoundException) { return false; }
    }

    /// <summary>
    /// The script the launcher registers before the first navigation. It marks the
    /// document so design-system.css can tell a hosted window from a browser tab:
    /// everything the custom title bar needs is behind
    /// `:root[data-shell="webview2"]`, so a browser - and every browser-based test
    /// suite - sees exactly the layout it saw before.
    /// </summary>
    public static string ShellMarkerScript()
    {
        return "document.documentElement.setAttribute('data-shell','webview2');";
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
