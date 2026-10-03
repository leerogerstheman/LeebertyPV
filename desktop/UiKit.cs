using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Windows.Forms;

/* ==========================================================================
 * LeebertyPV UI kit - the design system for the native window.
 *
 * A small set of self-drawn controls (rounded cards, buttons, badges, nav
 * items, stats, step timelines) plus a colour/type/space system, so every
 * view shares one visual language: blue-black brand, generous whitespace,
 * rounded corners, capsule badges, clear hierarchy. Nothing here uses a
 * browser - it is GDI+ drawing on the Windows message loop.
 * ========================================================================== */

static class Theme {
    // ---- brand & surfaces ------------------------------------------------
    public static readonly Color Sidebar = Color.FromArgb(11, 19, 38);      // #0B1326 blue-black
    public static readonly Color SidebarText = Color.FromArgb(148, 163, 184); // slate-400
    public static readonly Color SidebarHover = Color.FromArgb(30, 41, 59);   // slate-800
    public static readonly Color SidebarActive = Color.FromArgb(29, 78, 216); // blue-700
    public static readonly Color SidebarActiveText = Color.White;

    public static readonly Color Brand = Color.FromArgb(29, 78, 216);        // #1D4ED8
    public static readonly Color Brand2 = Color.FromArgb(30, 64, 175);
    public static readonly Color BrandSoft = Color.FromArgb(232, 238, 252);  // #E8EEFC

    public static readonly Color Bg = Color.FromArgb(244, 246, 248);         // #F4F6F8
    public static readonly Color Panel = Color.White;
    public static readonly Color Line = Color.FromArgb(226, 232, 240);       // #E2E8F0
    public static readonly Color Hover = Color.FromArgb(241, 245, 249);      // slate-100

    // ---- text -------------------------------------------------------------
    public static readonly Color Ink = Color.FromArgb(15, 23, 42);           // #0F172A
    public static readonly Color Ink2 = Color.FromArgb(71, 85, 105);         // slate-600
    public static readonly Color Ink3 = Color.FromArgb(148, 163, 184);       // slate-400

    // ---- status tones -----------------------------------------------------
    public static readonly Color Ok = Color.FromArgb(22, 163, 74);
    public static readonly Color OkSoft = Color.FromArgb(220, 252, 231);
    public static readonly Color Warn = Color.FromArgb(217, 119, 6);
    public static readonly Color WarnSoft = Color.FromArgb(254, 243, 199);
    public static readonly Color Danger = Color.FromArgb(220, 38, 38);
    public static readonly Color DangerSoft = Color.FromArgb(254, 226, 226);
    public static readonly Color Info = Color.FromArgb(2, 132, 199);
    public static readonly Color InfoSoft = Color.FromArgb(224, 242, 254);

    // ---- type scale -------------------------------------------------------
    public static Font TitleFont { get { return new Font("Microsoft YaHei UI", 16f, FontStyle.Bold); } }
    public static Font H2Font { get { return new Font("Microsoft YaHei UI", 11.5f, FontStyle.Bold); } }
    public static Font H3Font { get { return new Font("Microsoft YaHei UI", 10f, FontStyle.Bold); } }
    public static Font BodyFont { get { return new Font("Microsoft YaHei UI", 9.5f); } }
    public static Font SmallFont { get { return new Font("Microsoft YaHei UI", 8.5f); } }
    public static Font MonoFont { get { return new Font("Consolas", 9f); } }

    // ---- metrics ----------------------------------------------------------
    public const int Radius = 10;
    public const int RadiusSm = 6;
    public const int Pad = 20;        // view padding
    public const int Gap = 12;        // between cards
    public const int GapSm = 8;

    public static Color MutedSoft() { return Color.FromArgb(241, 245, 249); }
}

/// <summary>Temporary render diagnostics: native-window content that fails to
/// paint is invisible to the user, and paint-subscriber content proved
/// unreliable under some render paths; anything unexpected is logged.</summary>
static class UiDebug {
    public static void Log(string m) {
        try {
            string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "uidebug.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + " " + m + Environment.NewLine);
        } catch { }
    }
}

/// <summary>GDI+ helpers: rounded paths and rectangles.</summary>
static class Gdip {    public static GraphicsPath Rounded(Rectangle r, int radius) {
        var path = new GraphicsPath();
        int d = radius * 2;
        if (d > r.Width) d = r.Width;
        if (d > r.Height) d = r.Height;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void FillRounded(Graphics g, Rectangle r, int radius, Color color) {
        if (radius <= 0) { using (var b = new SolidBrush(color)) g.FillRectangle(b, r); return; }
        using (var path = Rounded(r, radius))
        using (var b = new SolidBrush(color))
            g.FillPath(b, path);
    }

    public static void DrawRounded(Graphics g, Rectangle r, int radius, Color color, float width) {
        if (radius <= 0) { using (var p = new Pen(color, width)) g.DrawRectangle(p, r); return; }
        using (var path = Rounded(r, radius))
        using (var p = new Pen(color, width))
            g.DrawPath(p, path);
    }

    public static void Text(Graphics g, string text, Font font, Rectangle r, Color color, TextFormatFlags flags) {
        TextRenderer.DrawText(g, text, font, r, color, flags);
    }
}

/// <summary>Self-drawn rounded panel: background, optional border and accent bar.</summary>
public class RPanel : Control {
    public int Radius { get { return _radius; } set { _radius = value; Invalidate(); } }
    public Color Fill = Theme.Panel;
    public Color Border = Color.Empty;
    public Color Accent = Color.Empty;      // top accent strip color
    public int AccentWidth = 4;
    private int _radius = Theme.Radius;

    public RPanel() : this(Color.Empty) { }
    public RPanel(Color fill) {
        Fill = fill == Color.Empty ? Theme.Panel : fill;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        BackColor = Theme.Bg;
    }

    protected override void OnPaintBackground(PaintEventArgs e) { /* round corners need transparency: nothing painted here */ }

    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        // IMPORTANT: paint the surface FIRST, and raise the Paint event LAST.
        // Subscribers (views that draw card text through the Paint event) must
        // end up on top of the rounded fill, or their content is hidden and the
        // cards render as blank boxes.
        if (Accent != Color.Empty) {
            var strip = new Rectangle(0, 0, Width, AccentWidth + 6);
            Gdip.FillRounded(g, strip, _radius, Accent);
        }
        if (Fill.A > 0) Gdip.FillRounded(g, r, _radius, Fill);
        if (Border != Color.Empty) Gdip.DrawRounded(g, r, _radius, Border, 1f);
        base.OnPaint(e);
    }
}

/// <summary>A rounded card with an optional bold title and a content host.</summary>
public class RCard : RPanel {
    private Label _title;
    public Panel Content;
    public int ContentPad = 14;

    public RCard(string title) {
        Accent = Color.Empty;
        if (!string.IsNullOrEmpty(title)) {
            _title = new Label {
                Text = title, Font = Theme.H3Font, ForeColor = Theme.Ink,
                AutoSize = false, Height = 34, Dock = DockStyle.Top, Padding = new Padding(16, 10, 10, 0),
                BackColor = Color.White,
            };
            Controls.Add(_title);
        }
        Content = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Panel, Padding = new Padding(ContentPad, 2, ContentPad, ContentPad) };
        Controls.Add(Content);
    }

    public void AddControl(Control c) { Content.Controls.Add(c); }
    public void AddControls(params Control[] cs) { foreach (var c in cs) Content.Controls.Add(c); }
}

/// <summary>Self-drawn rounded button with hover states.</summary>
public class RButton : Control {
    public enum Variant { Primary, Secondary, Ghost, Danger }

    public Variant Kind = Variant.Secondary;
    public int Radius = Theme.RadiusSm;
    private bool _hover;
    private bool _down;
    private string _text = "";

    public RButton(string text) { _text = text; SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true); Cursor = Cursors.Hand; }
    public RButton(string text, Variant kind) : this(text) { Kind = kind; }
    public override string Text { get { return _text; } set { _text = value; Invalidate(); } }

    protected override void OnPaintBackground(PaintEventArgs e) { }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { _down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }

    public Color TextColor = Color.Empty;
    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        Color back = Theme.Panel, fore = Theme.Ink2, border = Theme.Line;
        if (Kind == Variant.Primary) { back = Theme.Brand; fore = Color.White; border = Theme.Brand; if (_hover) back = Theme.Brand2; }
        else if (Kind == Variant.Secondary) { back = _hover ? Theme.Hover : Theme.Panel; fore = Theme.Ink2; border = Theme.Line; }
        else if (Kind == Variant.Ghost) { back = _hover ? Theme.Hover : Color.Transparent; fore = Theme.Ink2; border = Color.Transparent; }
        else if (Kind == Variant.Danger) { back = _hover ? Theme.Danger : Theme.DangerSoft; fore = Color.White; border = Theme.Danger; }
        if (Kind == Variant.Danger && _hover) fore = Color.White; else if (Kind == Variant.Danger) fore = Theme.Danger;
        if (TextColor != Color.Empty) fore = TextColor;
        if (_down) { back = ControlPaint.Dark(back, 0.02f); }
        Gdip.FillRounded(g, r, Radius, back);
        Gdip.DrawRounded(g, r, Radius, border, 1f);
        var fr = new Rectangle(0, 0, Width, Height);
        TextRenderer.DrawText(g, _text, Font, fr, fore, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

/// <summary>Capsule badge with a tone.</summary>
public class RBadge : Control {
    public enum Tone { Brand, Ok, Warn, Danger, Muted, Ink }
    public Tone Kind = Tone.Muted;
    private string _text;

    public RBadge(string text) { _text = text; SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true); AutoSize = true; Font = Theme.SmallFont; }

    public override string Text { get { return _text; } set { _text = value; Invalidate(); } }

    protected override void OnPaintBackground(PaintEventArgs e) { }

    public static Size Measure(string text, Font f) {
        using (var g = BitmapHelper.Graphics)
        {
            var sz = TextRenderer.MeasureText(g, text, f);
            return new Size(sz.Width + 20, sz.Height + 6);
        }
    }

    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        Color back = Theme.MutedSoft(), fore = Theme.Ink2;
        if (Kind == Tone.Brand) { back = Theme.BrandSoft; fore = Theme.Brand2; }
        else if (Kind == Tone.Ok) { back = Theme.OkSoft; fore = Theme.Ok; }
        else if (Kind == Tone.Warn) { back = Theme.WarnSoft; fore = Theme.Warn; }
        else if (Kind == Tone.Danger) { back = Theme.DangerSoft; fore = Theme.Danger; }
        else if (Kind == Tone.Ink) { back = Theme.Sidebar; fore = Color.White; }
        Gdip.FillRounded(g, r, Math.Min(Height / 2, 12), back);
        var fr = new Rectangle(0, 0, Width, Height);
        TextRenderer.DrawText(g, _text, Font, fr, fore, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

static class BitmapHelper {
    private static Bitmap _bmp;
    public static Graphics Graphics {
        get {
            if (_bmp == null) _bmp = new Bitmap(1, 1);
            return System.Drawing.Graphics.FromImage(_bmp);
        }
    }
}

/// <summary>Sidebar navigation item (icon + label, rounded active pill).</summary>
public class RNavItem : Control {
    public string Glyph;
    public string NavText;
    public bool Active;
    private Color _navBg;
    private bool _hover;
    public event EventHandler Navigate;

    public RNavItem(string glyph, string text, Color navBg) {
        Glyph = glyph; NavText = text; _navBg = navBg;
        Height = 42; Cursor = Cursors.Hand;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnPaintBackground(PaintEventArgs e) { }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseUp(MouseEventArgs e) { if (e.Button == MouseButtons.Left && Navigate != null) Navigate(this, EventArgs.Empty); base.OnMouseUp(e); }

    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new Rectangle(8, 3, Width - 16, Height - 6);
        Color back = _navBg; Color fore = Theme.SidebarText;
        if (Active) { back = Theme.SidebarActive; fore = Theme.SidebarActiveText; }
        else if (_hover) { back = Theme.SidebarHover; fore = Color.White; }
        Gdip.FillRounded(g, r, 8, back);
        var iconRect = new Rectangle(r.X + 12, r.Y, 20, r.Height);
        TextRenderer.DrawText(g, Glyph, Font, iconRect, fore, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        var textRect = new Rectangle(r.X + 40, r.Y, r.Width - 52, r.Height);
        TextRenderer.DrawText(g, NavText, Theme.BodyFont, textRect, fore, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

/// <summary>A stat block: big number + label, used in strip headers.</summary>
public class RStat : RPanel {
    private readonly Label _num, _lbl;
    public RStat(string value, string label, Color tone) {
        Fill = Theme.Panel;
        Border = Theme.Line;
        Height = 64;
        var stack = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = Color.White, Padding = new Padding(14, 8, 8, 8) };
        Controls.Add(stack);
        stack.Controls.Add(_num = new Label { Text = value, AutoSize = true, Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold), ForeColor = tone });
        stack.Controls.Add(_lbl = new Label { Text = label, AutoSize = true, Font = Theme.SmallFont, ForeColor = Theme.Ink3 });
    }
    public void SetValue(string v) { _num.Text = v; }
}

/// <summary>A divider line.</summary>
public class RDivider : Control {
    public RDivider() { SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true); Height = 1; }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) {
        using (var p = new Pen(Theme.Line)) e.Graphics.DrawLine(p, 0, 0, Width, 0);
    }
}

/// <summary>One row of a record list: main + sub + right meta; self drawn with
/// an optional status colour bar on the left edge.</summary>
public class RListRow : Control {
    public string Main;
    public string Sub;
    public string Meta;
    public Color Status = Color.Transparent;   // left edge bar
    public bool Clickable = true;
    private bool _hover;
    public event EventHandler Activated;

    public RListRow(string main, string sub, string meta) {
        Main = main; Sub = sub; Meta = meta;
        Height = 52; Cursor = Cursors.Hand;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        BackColor = Theme.Bg;
    }

    protected override void OnPaintBackground(PaintEventArgs e) { }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { if (Clickable && e.Button == MouseButtons.Left && Activated != null) Activated(this, EventArgs.Empty); base.OnMouseDown(e); }

    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        if (_hover && Clickable) Gdip.FillRounded(g, r, 8, Theme.Hover);
        if (Status != Color.Transparent) {
            Gdip.FillRounded(g, new Rectangle(0, 6, 4, Height - 12), 2, Status);
        }
        var mainRect = new Rectangle(14, 6, Width - 240, 22);
        var subRect = new Rectangle(14, 28, Width - 240, 20);
        TextRenderer.DrawText(g, Main, Theme.BodyFont, mainRect, Theme.Ink, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        TextRenderer.DrawText(g, Sub, Theme.SmallFont, subRect, Theme.Ink3, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        if (!string.IsNullOrEmpty(Meta)) {
            var metaRect = new Rectangle(Width - 220, 0, 206, Height);
            TextRenderer.DrawText(g, Meta, Theme.SmallFont, metaRect, Theme.Ink2, TextFormatFlags.Right | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        }
    }
}

/// <summary>A workflow step in the timeline: numbered dot, name, role chips,
/// signature badge and guidance - all self drawn.</summary>
public class RStep : Control {
    public int Seq;
    public string StepName;
    public string Roles;
    public string Signature;
    public bool Independent;
    public bool Optional;
    public string Guidance;
    private bool _hover;

    public RStep(int seq, string name, string roles, string signatureMeaning, bool independent, bool optional, string guidance) {
        Seq = seq; StepName = name; Roles = roles; Signature = signatureMeaning; Independent = independent; Optional = optional; Guidance = guidance;
        Height = 74; Cursor = Cursors.Hand;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
    }

    protected override void OnPaintBackground(PaintEventArgs e) { }

    public static string RolesText(Dictionary<string, object> step) {
        var parts = new List<string>();
        foreach (var r in Json.A(step, "roles")) parts.Add(Convert.ToString(r).Replace("_", " "));
        return string.Join(" / ", parts.ToArray());
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var r = new Rectangle(0, 0, Width - 1, Height - 1);
        Gdip.FillRounded(g, r, Theme.RadiusSm, _hover ? Theme.Hover : Theme.Panel);
        Gdip.DrawRounded(g, r, Theme.RadiusSm, Theme.Line, 1f);

        // numbered dot
        var dot = new Rectangle(14, Height / 2 - 13, 26, 26);
        Gdip.FillRounded(g, dot, 13, Theme.Brand);
        TextRenderer.DrawText(g, Seq.ToString(), new Font("Microsoft YaHei UI", 10f, FontStyle.Bold), dot, Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);

        // a connector line from the previous step to this dot
        using (var p = new Pen(Theme.Line, 2f)) g.DrawLine(p, 27, 0, 27, Math.Max(0, Height / 2 - 14));

        var nameRect = new Rectangle(52, 8, Width - 210, 22);
        TextRenderer.DrawText(g, StepName, Theme.H3Font, nameRect, Theme.Ink, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);

        var rolesRect = new Rectangle(52, 30, Width - 210, 18);
        TextRenderer.DrawText(g, Roles, Theme.SmallFont, rolesRect, Theme.Ink3, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);

        var guidRect = new Rectangle(52, 48, Width - 230, 20);
        TextRenderer.DrawText(g, Guidance, new Font("Microsoft YaHei UI", 8f), guidRect, Theme.Ink3, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);

        // right badges
        int bx = Width - 200;
        if (Signature != "") DrawChip(g, "签名", bx, 12, Theme.BrandSoft, Theme.Brand2); bx += 72;
        if (Independent) DrawChip(g, "独立审签", bx, 12, Theme.WarnSoft, Theme.Warn); bx += 90;
        if (Optional) DrawChip(g, "可选", bx, 12, Theme.MutedSoft(), Theme.Ink2);
    }

    private static void DrawChip(Graphics g, string text, int x, int y, Color back, Color fore) {
        var sz = TextRenderer.MeasureText(text, Theme.SmallFont);
        var r = new Rectangle(x, y, sz.Width + 14, 20);
        Gdip.FillRounded(g, r, 10, back);
        TextRenderer.DrawText(g, text, Theme.SmallFont, r, fore, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
    }
}

/// <summary>Section heading for a view.</summary>
public class RSection : Control {
    public RSection(string text) {
        Text = text;
        Height = 32;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
    }
    protected override void OnPaintBackground(PaintEventArgs e) { }
    protected override void OnPaint(PaintEventArgs e) {
        TextRenderer.DrawText(e.Graphics, Text, Theme.H2Font, new Rectangle(2, 4, Width, 24), Theme.Ink, TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
    }
}

/// <summary>Static factory for a polished DataGridView.</summary>
static class Kit {
    public static DataGridView Grid() {
        var g = new DataGridView {
            AllowUserToAddRows = false, AllowUserToDeleteRows = false, ReadOnly = true,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill,
            RowHeadersVisible = false, BackgroundColor = Theme.Panel, BorderStyle = BorderStyle.None,
            CellBorderStyle = DataGridViewCellBorderStyle.SingleHorizontal,
            GridColor = Theme.Line, EnableHeadersVisualStyles = false,
            ColumnHeadersBorderStyle = DataGridViewHeaderBorderStyle.None,
            DefaultCellStyle = new DataGridViewCellStyle {
                BackColor = Theme.Panel, ForeColor = Theme.Ink2, SelectionBackColor = Theme.BrandSoft,
                SelectionForeColor = Theme.Ink, Font = new Font("Microsoft YaHei UI", 9f),
                Padding = new Padding(0, 3, 0, 3),
            },
            ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle {
                BackColor = Theme.Bg, ForeColor = Theme.Ink2, SelectionBackColor = Theme.Bg, SelectionForeColor = Theme.Ink2,
                Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold),
                Padding = new Padding(0, 6, 0, 6),
            },
            AlternatingRowsDefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.FromArgb(250, 251, 252) },
            RowTemplate = { Height = 34 },
        };
        g.CellPainting += (s, e) => {
            if (e.RowIndex >= 0 && g.Rows[e.RowIndex].DefaultCellStyle.BackColor == Color.Empty) { }
            g.RowsDefaultCellStyle.SelectionBackColor = Theme.BrandSoft;
        };
        g.ColumnHeadersHeightSizeMode = DataGridViewColumnHeadersHeightSizeMode.EnableResizing;
        g.ColumnHeadersHeight = 38;
        return g;
    }

    /// <summary>A single-line text input styled for the kit.</summary>
    public static TextBox Input(string placeholder) {
        return new TextBox {
            Width = 360, Height = 30, BorderStyle = BorderStyle.FixedSingle,
            Font = Theme.BodyFont, Margin = new Padding(0, 2, 0, 0), Tag = placeholder,
        };
    }
}

/// <summary>VFlow: a vertical flow host whose children get reflowed; width is
/// derived from the container size so cards fill the width.</summary>
public class VFlow : FlowLayoutPanel {
    public VFlow() {
        Dock = DockStyle.Fill;
        FlowDirection = FlowDirection.TopDown;
        WrapContents = false;
        AutoScroll = true;
        BackColor = Theme.Bg;
        Padding = new Padding(Theme.Pad, 6, Theme.Pad, 24);
    }

    public void AddFull(Control c) { c.Width = Math.Max(600, ClientSize.Width - Padding.Left - Padding.Right - 2); Controls.Add(c); }
    public void AddFullFrom(Control c, int bottomMargin) { c.Margin = new Padding(0, 0, 0, bottomMargin); AddFull(c); }

    /// <summary>Add a panel full-width with an optional hint text painted in it
    /// (used for warning / success banners).</summary>
    public void AddFullFrom(Control c, int bottomMargin, string hintText) {
        if (c is RPanel && hintText != null) {
            var p = (RPanel)c;
            string t = hintText;
            p.Paint += (s, e) => {
                var fr = new Rectangle(12, 8, p.Width - 24, p.Height - 16);
                TextRenderer.DrawText(e.Graphics, t, Theme.SmallFont, fr, Theme.Ink2, TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            };
        }
        AddFullFrom(c, bottomMargin);
    }
}

/// <summary>A horizontal chip row (flow) helper for badges.</summary>
public class ChipRow : FlowLayoutPanel {
    public ChipRow() { WrapContents = false; AutoSize = true; BackColor = Theme.Panel; }
    public RBadge AddBadge(string text, RBadge.Tone tone) {
        var b = new RBadge(text) { Kind = tone };
        b.Width = RBadge.Measure(text, Theme.SmallFont).Width;
        b.Height = RBadge.Measure(text, Theme.SmallFont).Height;
        Controls.Add(b);
        return b;
    }
}

/// <summary>Dark blue-black hero banner built from REAL child controls (labels
/// render reliably; Paint-event subscribers proved unreliable for card text on
/// some render paths, which is why this kit avoids them for content).</summary>
public class RHero : RPanel {
    public RHero(int w, int height, string title, string sub, string hint) {
        Fill = Theme.Sidebar;
        Radius = 14;
        Width = w; Height = height;
        int y = 14;
        if (!string.IsNullOrEmpty(title)) {
            Controls.Add(new Label {
                Text = title, AutoSize = false, Width = w - 48, Height = 30, Location = new Point(24, y),
                Font = new Font("Microsoft YaHei UI", 15f, FontStyle.Bold), ForeColor = Color.White,
                AutoEllipsis = true, BackColor = Theme.Sidebar,
            });
            y += 34;
        }
        if (!string.IsNullOrEmpty(sub)) {
            Controls.Add(new Label {
                Text = sub, AutoSize = false, Width = w - 48, Height = 22, Location = new Point(24, y),
                Font = Theme.SmallFont, ForeColor = Color.FromArgb(196, 208, 232), AutoEllipsis = true,
                BackColor = Theme.Sidebar,
            });
            y += 26;
        }
        if (!string.IsNullOrEmpty(hint)) {
            Controls.Add(new Label {
                Text = hint, AutoSize = false, Width = w - 48, Height = height - y - 6, Location = new Point(24, y),
                Font = new Font("Microsoft YaHei UI", 8.5f), ForeColor = Color.FromArgb(160, 178, 214),
                AutoEllipsis = true, BackColor = Theme.Sidebar,
            });
        }
    }
}

/// <summary>Soft-toned banner with dark text, built from a real child label.</summary>
public class RBanner : RPanel {
    public RBanner(int w, string text, Color soft, Color fore) {
        Fill = soft; Radius = 10;
        Width = w; Height = 44;
        Controls.Add(new Label {
            Text = text, AutoSize = false, Width = w - 30, Height = 30, Location = new Point(14, 7),
            Font = Theme.SmallFont, ForeColor = fore, AutoEllipsis = true, BackColor = soft,
        });
    }

    /// <summary>Multi-line variant with an explicit height.</summary>
    public RBanner(int w, int height, string text, Color soft, Color fore) {
        Fill = soft; Radius = 10;
        Width = w; Height = height;
        Controls.Add(new Label {
            Text = text, AutoSize = false, Width = w - 30, Height = height - 14, Location = new Point(14, 7),
            Font = Theme.SmallFont, ForeColor = fore, AutoEllipsis = true, BackColor = soft,
        });
    }
}

/// <summary>Label factory tuned for the kit (real Label: renders reliably).</summary>
static class K {
    public static Label L(string text, Font font, Color color) {
        return new Label { Text = text, AutoSize = false, AutoEllipsis = true, Font = font, ForeColor = color, BackColor = Color.Transparent, Margin = new Padding(0), Height = (int)Math.Ceiling(font.SizeInPoints * 1.8f) };
    }
}

/// <summary>Small control helpers.</summary>
public static class ControlsHelper {
    /// <summary>Add a full-size centered label over a surface (e.g. the PV
    /// monogram over the brand mark's rounded square).</summary>
    public static void AddCentered(Control host, string text, Font font, Color fore) {
        var l = new Label {
            Text = text, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter,
            Font = font, ForeColor = fore, BackColor = Color.Transparent,
        };
        host.Controls.Add(l);
    }
}