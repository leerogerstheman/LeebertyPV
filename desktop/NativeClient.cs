using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Windows.Forms;
using System.Web.Script.Serialization;

/* ==========================================================================
 * LeebertyPV native desktop client (WinForms, no browser dependency).
 *
 * Runs in its own native window and talks to the local LeebertyPV Node service
 * over the REST API. All card/banner content is built from REAL child controls
 * (labels), never from Paint-event subscribers: paint-subscriber content
 * rendered blank on some display paths, which emptied every card. Compiled
 * with Launcher.cs and UiKit.cs by scripts/build-desktop.js.
 * ========================================================================== */

static class Json {
    private static readonly JavaScriptSerializer _ser = new JavaScriptSerializer();
    public static string Encode(object o) { return _ser.Serialize(o); }
    public static object Decode(string s) { return _ser.DeserializeObject(s); }
    public static Dictionary<string, object> M(object o) {
        var d = o as Dictionary<string, object>;
        return d ?? new Dictionary<string, object>();
    }
    public static string S(object o, string k) {
        var d = o as Dictionary<string, object>; if (d == null || !d.ContainsKey(k)) return "";
        var v = d[k]; return v == null ? "" : Convert.ToString(v);
    }
    public static int I(object o, string k) { int n; return int.TryParse(S(o, k), out n) ? n : 0; }
    public static bool B(object o, string k) { var v = S(o, k).ToLowerInvariant(); return v == "true" || v == "1"; }
    public static List<object> A(object o, string k) {
        var d = o as Dictionary<string, object>; if (d == null || !d.ContainsKey(k)) return new List<object>();
        var arr = d[k] as object[]; if (arr != null) return new List<object>(arr);
        var lst = d[k] as List<object>; return lst ?? new List<object>();
    }
}

static class Api {
    public static string Host = "127.0.0.1";
    public static int Port = 8793;
    public static readonly CookieContainer Cookies = new CookieContainer();
    public static string BaseUrl { get { return "http://" + Host + ":" + Port; } }

    private static HttpWebResponse Round(string method, string path, string bodyJson, out string body) {
        var req = (HttpWebRequest)WebRequest.Create(BaseUrl + path);
        req.Method = method;
        req.CookieContainer = Cookies;
        req.Timeout = 30000;
        req.Accept = "application/json";
        if (bodyJson != null) {
            req.ContentType = "application/json";
            var bytes = Encoding.UTF8.GetBytes(bodyJson);
            req.ContentLength = bytes.Length;
            using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
        }
        HttpWebResponse res;
        try {
            res = (HttpWebResponse)req.GetResponse();
        } catch (WebException we) {
            var er = we.Response as HttpWebResponse;
            if (er != null) {
                using (var r = new StreamReader(er.GetResponseStream(), Encoding.UTF8)) body = r.ReadToEnd();
                return er;
            }
            throw;
        }
        using (var r = new StreamReader(res.GetResponseStream(), Encoding.UTF8)) body = r.ReadToEnd();
        return res;
    }

    public static object Get(string path) { string b; Round("GET", path, null, out b); return Json.Decode(b); }
    public static object Post(string path, object payload) { string b; Round("POST", path, Json.Encode(payload), out b); return Json.Decode(b); }
}

class ApiError : Exception {
    public string Code = "";
    public ApiError(string code, string message) : base(message) { Code = code; }
}

static class Session {
    public static Dictionary<string, object> User;
    public static List<string> Permissions = new List<string>();
    public static string LoggedInAs = "";
    public static string RoleLabel = "";
    public static string Username = "";
    public static bool IsLoggedIn { get { return User != null; } }

    public static bool Can(string permission) {
        if (Permissions.Contains("*")) return true;
        return Permissions.Contains(permission);
    }

    public static void Set(object userObj) {
        var d = Json.M(userObj);
        User = d;
        LoggedInAs = Json.S(d, "fullName");
        if (LoggedInAs == "") LoggedInAs = Json.S(d, "username");
        Username = Json.S(d, "username");
        RoleLabel = Json.S(d, "roleLabelZh");
        if (RoleLabel == "") RoleLabel = Json.S(d, "roleLabel");
        Permissions.Clear();
        foreach (var p in Json.A(d, "permissions")) Permissions.Add(Convert.ToString(p));
    }

    public static void Clear() { User = null; Permissions.Clear(); LoggedInAs = ""; RoleLabel = ""; Username = ""; }
}

static class Req {
    public static object Get(string path) { return Check(Api.Get(path)); }
    public static object Post(string path, object payload) { return Check(Api.Post(path, payload)); }
    public static object Check(object resp) {
        if (resp is Dictionary<string, object>) {
            var d = (Dictionary<string, object>)resp;
            if (d.ContainsKey("error")) {
                var msg = Convert.ToString(d["error"]);
                var code = d.ContainsKey("code") ? Convert.ToString(d["code"]) : "";
                throw new ApiError(code, msg);
            }
        }
        return resp;
    }
}

class AuthRequired : Exception { }

/// <summary>Application shell: brand header, sidebar navigation, view host.</summary>
public class NativeForm : Form {
    private Panel _header;
    private Label _lblChain, _lblUser;
    private RButton _btnLogin;
    private Panel _nav;
    private VFlow _host;
    private Label _lblVersion;
    private Dictionary<string, object> _boot;
    private Dictionary<string, object> _choices;
    private string _currentNav = "";
    private readonly List<RNavItem> _navItems = new List<RNavItem>();
    private const int NAV_WIDTH = 216;

    public NativeForm() {
        Text = "LeebertyPV · 药物警戒工作台";
        ClientSize = new Size(1296, 860);
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(1060, 700);
        Font = Theme.BodyFont;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        BuildShell();
        try { _boot = Json.M(Req.Get("/api/bootstrap")); } catch { _boot = null; }
        try { _choices = Json.M(Req.Get("/api/login-choices")); } catch { _choices = null; }
        // optional scripted auto-login (demo / screenshot verification)
        if (!string.IsNullOrEmpty(Program.StartLogin) && _choices != null && Json.B(_choices, "enabled")) {
            try { DoLogin(Program.StartLogin, Json.S(_choices, "password"), ""); } catch { }
        }
        string startView = Program.StartView;
        if (!string.IsNullOrEmpty(startView)) {
            var parts = startView.Split(':');
            if (parts.Length > 1) {
                if (parts[0] == "record") _host.Tag = new Dictionary<string, object> { { "id", parts[1] } };
                else _host.Tag = new Dictionary<string, object> { { "code", parts[1] } };
            }
            NavTo(parts[0]);
        } else {
            NavTo("domains");
        }
    }

    // -------------------------------------------------------------- shell ---

    private void BuildShell() {
        Controls.Clear();
        BackColor = Theme.Bg;

        _header = new Panel { Dock = DockStyle.Top, Height = 60, BackColor = Color.White, Padding = new Padding(18, 0, 16, 0) };
        var underline = new Panel { Dock = DockStyle.Bottom, Height = 1, BackColor = Theme.Line };
        _header.Controls.Add(underline);

        // brand mark: blue-black rounded square with the PV monogram (child label)
        var mark = new RPanel(Theme.Sidebar) { Size = new Size(40, 40), Location = new Point(18, 10), Radius = 10 };
        ControlsHelper.AddCentered(mark, "PV", new Font("Old English Text MT", 19f, FontStyle.Regular, GraphicsUnit.Pixel), Color.FromArgb(233, 240, 255));
        _header.Controls.Add(mark);

        var brandStack = new Panel { Location = new Point(72, 8), Size = new Size(430, 46) };
        brandStack.Controls.Add(new Label { Text = "LeebertyPV", Font = new Font("Microsoft YaHei UI", 13.5f, FontStyle.Bold), ForeColor = Theme.Ink, AutoSize = true, Location = new Point(0, 2), BackColor = Color.White });
        brandStack.Controls.Add(new Label { Text = "药物警戒工作台 · Pharmacovigilance", Font = Theme.SmallFont, ForeColor = Theme.Ink3, AutoSize = true, Location = new Point(0, 28), BackColor = Color.White });
        _header.Controls.Add(brandStack);

        _lblChain = new Label { Text = "● 审计链校验中", Font = Theme.SmallFont, ForeColor = Theme.Ok, AutoSize = true, Anchor = AnchorStyles.Right, BackColor = Color.White };
        _lblUser = new Label { Text = "未登录（可先浏览领域与流程）", Font = Theme.BodyFont, ForeColor = Theme.Ink2, AutoSize = true, Anchor = AnchorStyles.Right, BackColor = Color.White };
        _btnLogin = new RButton("登录", RButton.Variant.Primary) { Size = new Size(96, 36) };

        FlowLayoutPanel right = new FlowLayoutPanel {
            Anchor = AnchorStyles.Right, AutoSize = true, FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false, BackColor = Color.White, Margin = new Padding(0),
        };
        right.Controls.Add(_lblChain);
        right.Controls.Add(new Label { Text = "   ", AutoSize = true, BackColor = Color.White });
        right.Controls.Add(_lblUser);
        right.Controls.Add(new Label { Text = "  ", AutoSize = true, BackColor = Color.White });
        right.Controls.Add(_btnLogin);
        _header.Controls.Add(right);
        right.Location = new Point(Math.Max(560, _header.ClientSize.Width - right.PreferredSize.Width - 16), 13);

        _btnLogin.Click += (s, e) => {
            if (Session.IsLoggedIn) { try { Req.Post("/api/auth/logout", new { }); } catch { } Session.Clear(); }
            RenderShell();
            NavTo("login");
        };

        var split = new SplitContainer { Dock = DockStyle.Fill, FixedPanel = FixedPanel.Panel1 };
        _nav = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Sidebar, AutoScroll = false };
        _host = new VFlow();
        split.Panel1.Controls.Add(_nav);
        split.Panel2.Controls.Add(_host);
        Controls.Add(split);
        Controls.Add(_header);

        Load += (s, e) => {
            try {
                split.Panel1MinSize = 180;
                split.Panel2MinSize = 620;
                split.SplitterDistance = NAV_WIDTH;
                Reflow();
            } catch { }
        };
        Resize += (s, e) => Reflow();

        RenderShell();
        RenderNav();
    }

    private void Reflow() {
        if (!IsHandleCreated) return;
        _host.SuspendLayout();
        int w = ContentW();
        foreach (Control c in _host.Controls) c.Width = w;
        _host.ResumeLayout(true);
        PerformLayout();
    }

    private void RenderShell() {
        if (Session.IsLoggedIn) {
            _lblUser.Text = Session.LoggedInAs + "  ·  " + Session.RoleLabel;
            _btnLogin.Text = "退出登录";
            _btnLogin.Kind = RButton.Variant.Secondary;
        } else {
            _lblUser.Text = "未登录（可先浏览领域与流程）";
            _btnLogin.Text = "登录";
            _btnLogin.Kind = RButton.Variant.Primary;
        }
        RefreshChainLabel();
    }

    private void RefreshChainLabel() {
        try {
            var h = Json.M(Api.Get("/api/health"));
            var chain = h.ContainsKey("auditChain") && h["auditChain"] is Dictionary<string, object>
                ? (Dictionary<string, object>)h["auditChain"] : h;
            if (Json.B(chain, "ok")) { _lblChain.Text = "● 审计链已校验 " + Json.I(chain, "checked") + " 条"; _lblChain.ForeColor = Theme.Ok; }
            else { _lblChain.Text = "● 审计链校验失败！"; _lblChain.ForeColor = Theme.Danger; }
        } catch { _lblChain.Text = "● 审计链不可用"; _lblChain.ForeColor = Theme.Warn; }
    }

    private void RenderNav() {
        _nav.Controls.Clear();
        _navItems.Clear();
        _nav.SuspendLayout();

        var brand = new Panel { Dock = DockStyle.Top, Height = 66, BackColor = Theme.Sidebar, Padding = new Padding(14, 10, 6, 4) };
        brand.Controls.Add(new Label {
            Text = "PV · ICSR · SIGNAL · PSUR · RMP · GVP", Font = Theme.SmallFont,
            ForeColor = Color.FromArgb(96, 115, 148), AutoSize = false, Width = 190, Height = 46,
            BackColor = Theme.Sidebar, TextAlign = ContentAlignment.TopLeft,
        });
        _nav.Controls.Add(brand);

        int y = 74;
        y = AddNav(y, "\u25a3", "领域与流程", "domains");
        y = AddNav(y, "\u2606", "设计理念", "philosophy");
        y = AddNav(y, "\u2709", "我的待办", "inbox");
        y = AddNav(y, "\u25a4", "安全性记录", "records");
        y = AddNav(y, "\u26bf", "审计追踪", "audit");
        y = AddNav(y, "\u2696", "合规态势", "compliance");
        y = AddNav(y, "\u2699", "账户与设置", "me");

        _lblVersion = new Label {
            Text = "v1.0 · 原生窗口 · 不依赖浏览器", Font = Theme.SmallFont,
            ForeColor = Color.FromArgb(71, 94, 130), AutoSize = false, Width = NAV_WIDTH - 16, Height = 26,
            TextAlign = ContentAlignment.MiddleLeft, BackColor = Color.FromArgb(8, 15, 32),
        };
        _lblVersion.Location = new Point(8, Math.Max(y + 6, 0));
        _nav.Controls.Add(_lblVersion);
        _nav.ResumeLayout();
        _nav.Resize += (s, e) => {
            try { _lblVersion.Location = new Point(8, _nav.ClientSize.Height - 30); } catch { }
        };
        try { _lblVersion.Location = new Point(8, _nav.ClientSize.Height - 30); } catch { }
    }

    private int AddNav(int y, string glyph, string label, string id) {
        var item = new RNavItem(glyph, label, Theme.Sidebar) {
            Location = new Point(0, y), Width = NAV_WIDTH, Active = _currentNav == id,
            Font = Theme.BodyFont,
        };
        item.Navigate += (s, e) => NavTo(id);
        _nav.Controls.Add(item);
        _navItems.Add(item);
        return y + 44;
    }

    public void NavTo(string name) {
        _currentNav = name;
        foreach (var it in _navItems) {
            it.Active = NavIdOf(it) == name;
        }
        _host.Tag = PreserveNavParam(name);
        _host.SuspendLayout();
        _host.Controls.Clear();
        switch (name) {
            case "login": ViewLogin(_host); break;
            case "philosophy": ViewPhilosophy(_host); break;
            case "domains": ViewDomains(_host); break;
            case "domain": ViewDomain(_host); break;
            case "workflow": ViewWorkflow(_host); break;
            case "inbox": ViewInbox(_host); break;
            case "records": ViewRecords(_host); break;
            case "record": ViewRecord(_host); break;
            case "recordNew": ViewRecordNew(_host); break;
            case "audit": ViewAudit(_host); break;
            case "compliance": ViewCompliance(_host); break;
            case "me": ViewMe(_host); break;
            default: ViewDomains(_host); break;
        }
        _host.ResumeLayout(true);
        Reflow();
    }

    /// <summary>Keep a view parameter (record id / domain+workflow code) across
    /// view switches, so the workflow page can be reopened after a record view.</summary>
    private object PreserveNavParam(string name) {
        if (name == "workflow" || name == "record") return _host.Tag;
        if (name == "domain") return _host.Tag != null && Json.S(Json.M(_host.Tag), "code") != "" ? _host.Tag : null;
        return null;
    }

    private static string NavIdOf(RNavItem item) {
        var t = item.NavText;
        if (t == "领域与流程") return "domains";
        if (t == "设计理念") return "philosophy";
        if (t == "我的待办") return "inbox";
        if (t == "安全性记录") return "records";
        if (t == "审计追踪") return "audit";
        if (t == "合规态势") return "compliance";
        if (t == "账户与设置") return "me";
        return System.Reflection.MethodBase.GetCurrentMethod().Name; // never matched
    }

    private int ContentW() {
        return Math.Max(640, ClientSize.Width - NAV_WIDTH - 56);
    }

    // ------------------------------------------------------------ helpers ---

    private string P(string key) {
        return _host.Tag != null ? Json.S(Json.M(_host.Tag), key) : "";
    }

    private static string Cut(string s, int n) {
        if (s == null) return "";
        s = s.Replace("\r", " ").Replace("\n", " ");
        return s.Length <= n ? s : s.Substring(0, n - 1) + "…";
    }

    private static Label Slate(string text, Font font, Color back) {
        return new Label { Text = text, AutoSize = false, AutoEllipsis = true, Font = font, ForeColor = Theme.Ink2, BackColor = back };
    }

    private void ErrFlow(VFlow flow, string message) {
        var card = new RCard("出错了") { Width = ContentW(), Height = 100, Margin = new Padding(0, 0, 0, Theme.Gap) };
        card.AddControl(new Label { Text = message, ForeColor = Theme.Danger, AutoSize = true });
        flow.AddFullFrom(card, 0);
    }

    private DialogResult Warn(string text) { return MessageBox.Show(this, text, "LeebertyPV", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
    private DialogResult Info(string text) { return MessageBox.Show(this, text, "LeebertyPV", MessageBoxButtons.OK, MessageBoxIcon.Information); }

    private static Color DomainColor(Dictionary<string, object> d) {
        try { return ColorTranslator.FromHtml(Json.S(d, "colour")); } catch { return Theme.Brand; }
    }

    /// <summary>Same-colour label over card/banner surfaces (real child control).</summary>
    private static void AddText(Control host, string text, Font font, Color fore, int x, int y, int w, int h, Color back) {
        host.Controls.Add(new Label {
            Text = text, AutoSize = false, AutoEllipsis = true,
            Font = font, ForeColor = fore, BackColor = back,
            Location = new Point(x, y), Size = new Size(w, h),
        });
    }

    // ------------------------------------------------------- login / setup ---

    private void ViewLogin(VFlow flow) {
        var w = ContentW();
        string demoHint = "";
        if (_choices != null && Json.B(_choices, "enabled")) {
            var pw = Json.S(_choices, "password");
            demoHint = "开放浏览：先选领域，再在其中选择身份进入。演示统一密码 " + pw + "（公开凭证）。登录后可用待办、记录、签名与全部数据。";
        } else {
            demoHint = "开放浏览：领域与流程属于公开参考模型；待办、记录、签名需要登录。";
        }
        flow.AddFullFrom(new RHero(w, 118, "药物警戒工作台", "个例报告是原料，时限是底线，信号是线索，获益-风险评估才是结论。", demoHint), Theme.Gap);

        try {
            if (_boot != null && Json.B(_boot, "setupComplete") == false) { SetupView(flow, _boot, w); return; }
            if (_choices == null || !Json.B(_choices, "enabled")) { ManualLogin(flow, null, w); return; }
        } catch (Exception ex) { ManualLogin(flow, ex.Message, w); return; }

        var pw2 = Json.S(_choices, "password");
        var personas = Json.A(_choices, "personas");
        var domains = Json.A(_choices, "domains");
        if (domains.Count == 0) { try { domains = Json.A(Json.M(Req.Get("/api/domains")), "domains"); } catch { } }

        flow.AddFullFrom(NewSection("① 选择你的 PV 领域"), Theme.GapSm);
        var grid = BuildDomainGrid(domains, w, (code) => ChooseDomain(code, personas, pw2));
        flow.AddFullFrom(grid, Theme.Gap);

        var row = new FlowLayoutPanel { Width = w, Height = 46, WrapContents = false, BackColor = Theme.Bg };
        row.Controls.Add(new RButton("使用其他账号登录", RButton.Variant.Secondary) { Size = new Size(190, 38), Margin = new Padding(0, 0, 10, 0) });
        row.Controls[0].Click += (s, e) => { _host.Controls.Clear(); ManualLogin(_host, null, w); Reflow(); };
        flow.AddFullFrom(row, 0);
    }

    private RSection NewSection(string text) { return new RSection(text); }

    private FlowLayoutPanel BuildDomainGrid(List<object> domains, int w, Action<string> onPick) {
        var grid = new FlowLayoutPanel { Width = w, Height = 620, WrapContents = true, AutoScroll = true, BackColor = Theme.Bg };
        // reserve margin for the vertical scrollbar so 3 columns never wrap
        int cw = Math.Max(240, (w - Theme.Gap * 3 - 56) / 3);
        foreach (var d in domains) {
            var dd = Json.M(d);
            var code = Json.S(dd, "code");
            var card = new RPanel(Theme.Panel) {
                Width = cw, Height = 190, Margin = new Padding(0, 0, Theme.Gap, Theme.Gap),
                Cursor = Cursors.Hand, Radius = 12, Accent = DomainColor(dd), AccentWidth = 5,
            };
            var colour = DomainColor(dd);
            AddText(card, "  " + code, new Font("Microsoft YaHei UI", 18f, FontStyle.Bold), colour, 10, 14, cw - 20, 36, Theme.Panel);
            AddText(card, "  " + Json.S(dd, "fullName"), Theme.H3Font, Theme.Ink, 10, 56, cw - 20, 24, Theme.Panel);
            AddText(card, "  " + Json.I(dd, "processCount") + " 条流程 · " + Json.I(dd, "participantCount") + " 个岗位", Theme.SmallFont, Theme.Ink3, 10, 82, cw - 20, 20, Theme.Panel);
            AddText(card, "  " + Cut(Json.S(dd, "philosophy"), 60), new Font("Microsoft YaHei UI", 8.25f), Theme.Ink3, 10, 104, cw - 20, 52, Theme.Panel);
            AddText(card, "  进入领域 →", Theme.SmallFont, colour, 10, 158, cw - 20, 20, Theme.Panel);
            var captured = code;
            card.Click += (s, e) => onPick(captured);
            foreach (Control c in card.Controls) c.Click += (s, e) => onPick(captured);
            grid.Controls.Add(card);
        }
        return grid;
    }

    private void ChooseDomain(string code, List<object> personas, string password) {
        var roster = new List<object>();
        foreach (var p in personas) {
            bool hit = false;
            foreach (var a in Json.A(Json.M(p), "gxpAreas")) if (Convert.ToString(a) == code) hit = true;
            if (hit) roster.Add(p);
        }
        if (roster.Count == 0) { Warn("该领域暂无可用演示身份，请用其他账号登录。"); return; }

        var w = ContentW();
        _host.Controls.Clear();
        _host.AddFullFrom(new RHero(w, 96, "② 选择进入 " + code + " 的身份", "选定后直接登录并进入该领域专属界面", "演示统一密码：" + password + "（公开凭证，仅用于演示实例）"), Theme.Gap);
        _host.AddFullFrom(new RBanner(w, "⚠ 演示模式：账号共用一个密码，真实部署必须为每人签发独立凭证（21 CFR Part 11.300(a)）。", Theme.WarnSoft, Theme.Warn), Theme.Gap);

        var grid = new FlowLayoutPanel { Width = w, Height = 560, WrapContents = true, AutoScroll = true, BackColor = Theme.Bg };
        int pw2 = Math.Max(280, (w - Theme.Gap - 56) / 2);
        foreach (var p in roster) {
            var pd = Json.M(p);
            var uname = Json.S(pd, "username");
            var card = new RPanel(Theme.Panel) { Width = pw2, Height = 132, Margin = new Padding(0, 0, Theme.Gap, Theme.Gap), Cursor = Cursors.Hand, Radius = 12 };
            // avatar circle
            var avatar = new RPanel(Theme.Brand) { Size = new Size(44, 44), Location = new Point(14, 16), Radius = 22 };
            var name = Json.S(pd, "fullName");
            ControlsHelper.AddCentered(avatar, name.Length > 0 ? name.Substring(0, 1) : "?", new Font("Microsoft YaHei UI", 15f, FontStyle.Bold), Color.White);
            card.Controls.Add(avatar);
            AddText(card, "  " + Json.S(pd, "roleLabelZh"), Theme.H3Font, Theme.Brand2, 70, 14, pw2 - 84, 22, Theme.Panel);
            AddText(card, "  " + name + " · " + Json.S(pd, "jobTitle"), Theme.BodyFont, Theme.Ink, 70, 40, pw2 - 84, 22, Theme.Panel);
            AddText(card, "  " + Cut(Json.S(pd, "blurb"), 56), new Font("Microsoft YaHei UI", 8.25f), Theme.Ink3, 70, 66, pw2 - 84, 52, Theme.Panel);
            var captured = uname;
            card.Click += (s, e) => DoLogin(captured, password, code);
            foreach (Control c in card.Controls) c.Click += (s, e) => DoLogin(captured, password, code);
            grid.Controls.Add(card);
        }
        _host.AddFullFrom(grid, Theme.Gap);
        var back = new RButton("返回领域选择", RButton.Variant.Ghost) { Size = new Size(160, 36) };
        back.Click += (s, e) => NavTo("domains");
        _host.AddFullFrom(back, 0);
        Reflow();
    }

    private void DoLogin(string username, string password, string domain) {
        Cursor = Cursors.WaitCursor;
        try {
            object userObj = null;
            Exception last = null;
            var candidates = new List<string> { password };
            foreach (var c in Json.A(_choices != null ? _choices : new Dictionary<string, object>(), "passwordCandidates")) {
                var s = Convert.ToString(c);
                if (s != password) candidates.Add(s);
            }
            foreach (var p in candidates) {
                userObj = null;
                try {
                    var r = Req.Post("/api/auth/login", new Dictionary<string, object> { { "username", username }, { "password", p } });
                    var rd = Json.M(r);
                    if (rd.ContainsKey("user")) { userObj = rd["user"]; break; }
                } catch (Exception ex) { last = ex; }
            }
            if (userObj == null) throw last ?? new Exception("登录失败");
            Session.Set(userObj);
            _boot = _boot ?? new Dictionary<string, object>();
            if (_boot.ContainsKey("setupComplete")) _boot["setupComplete"] = true;
            RenderShell();
            if (!string.IsNullOrEmpty(domain)) { OpenDomain(domain); } else { NavTo("domains"); }
        } catch (Exception ex) { Warn("登录失败：" + ex.Message); }
        finally { Cursor = Cursors.Default; }
    }

    private void ManualLogin(VFlow flow, string presetError, int w) {
        flow.AddFullFrom(NewSection("账号登录"), Theme.GapSm);
        if (!string.IsNullOrEmpty(presetError)) flow.AddFullFrom(new RBanner(w, presetError, Theme.DangerSoft, Theme.Danger), Theme.Gap);
        var card = new RCard("登录") { Width = 470, Height = 320, Margin = new Padding(0, 0, 0, Theme.Gap) };
        var txtUser = new TextBox { Width = 380, BorderStyle = BorderStyle.FixedSingle, Font = Theme.BodyFont, Margin = new Padding(0, 2, 0, 0) };
        var txtPass = new TextBox { Width = 380, UseSystemPasswordChar = true, BorderStyle = BorderStyle.FixedSingle, Font = Theme.BodyFont, Margin = new Padding(0, 2, 0, 0) };
        card.AddControl(new Label { Text = "账号", Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel });
        card.AddControl(txtUser);
        card.AddControl(new Label { Text = "密码", Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 12, 0, 0) });
        card.AddControl(txtPass);
        var go = new RButton("登 录", RButton.Variant.Primary) { Size = new Size(160, 40), Margin = new Padding(0, 16, 0, 0) };
        go.Click += (s, e) => {
            try {
                var r = Req.Post("/api/auth/login", new Dictionary<string, object> { { "username", txtUser.Text.Trim() }, { "password", txtPass.Text } });
                if (Json.M(r).ContainsKey("user")) { Session.Set(Json.M(r)["user"]); RenderShell(); NavTo("domains"); }
            } catch (Exception ex) { Warn(ex.Message); }
        };
        card.AddControl(go);
        flow.AddFullFrom(card, 0);
    }

    private void SetupView(VFlow flow, Dictionary<string, object> boot, int w) {
        flow.AddFullFrom(NewSection("首次初始化"), Theme.GapSm);
        var card = new RCard("创建第一个系统管理员账号") { Width = 470, Height = 460 };
        var site = new TextBox { Width = 380, BorderStyle = BorderStyle.FixedSingle };
        var name = new TextBox { Width = 380, BorderStyle = BorderStyle.FixedSingle };
        var uname = new TextBox { Width = 380, BorderStyle = BorderStyle.FixedSingle };
        var pw = new TextBox { Width = 380, UseSystemPasswordChar = true, BorderStyle = BorderStyle.FixedSingle };
        var pw2 = new TextBox { Width = 380, UseSystemPasswordChar = true, BorderStyle = BorderStyle.FixedSingle };
        card.AddControl(new Label { Text = "场所名称", Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel });
        card.AddControl(site);
        card.AddControl(new Label { Text = "姓名", Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 8, 0, 0) });
        card.AddControl(name);
        card.AddControl(new Label { Text = "账号", Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 8, 0, 0) });
        card.AddControl(uname);
        card.AddControl(new Label { Text = "密码（至少 10 位）", Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 8, 0, 0) });
        card.AddControl(pw);
        card.AddControl(new Label { Text = "确认密码", Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 8, 0, 0) });
        card.AddControl(pw2);
        var go = new RButton("创建并登录", RButton.Variant.Primary) { Size = new Size(160, 40), Margin = new Padding(0, 14, 0, 0) };
        go.Click += (s, e) => {
            if (pw.Text != pw2.Text) { Warn("两次输入的密码不一致"); return; }
            try {
                var r = Req.Post("/api/setup", new Dictionary<string, object> {
                    { "siteName", site.Text.Trim() }, { "username", uname.Text.Trim() },
                    { "fullName", name.Text.Trim() }, { "password", pw.Text } });
                if (Json.M(r).ContainsKey("user")) { Session.Set(Json.M(r)["user"]); _boot["setupComplete"] = true; RenderShell(); NavTo("domains"); }
            } catch (Exception ex) { Warn(ex.Message); }
        };
        card.AddControl(go);
        flow.AddFullFrom(card, 0);
    }

    // ---------------------------------------------------------------- me -----

    private void ViewMe(VFlow flow) {
        var w = ContentW();
        flow.AddFullFrom(NewSection("账户与设置"), Theme.GapSm);
        var card = new RCard("当前会话") { Width = w, Height = 170 };
        if (Session.IsLoggedIn) {
            card.AddControl(new Label {
                Text = Session.LoggedInAs + "\n" + Session.RoleLabel + " · " + Session.Username,
                Font = Theme.BodyFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel,
            });
            var outB = new RButton("退出登录", RButton.Variant.Danger) { Size = new Size(140, 38) };
            outB.Click += (s, e) => { try { Req.Post("/api/auth/logout", new { }); } catch { } Session.Clear(); RenderShell(); NavTo("domains"); };
            card.AddControl(outB);
        } else {
            card.AddControl(new Label { Text = "未登录。点击右上角「登录」或从领域与流程进入任一领域选择身份。", ForeColor = Theme.Ink3, AutoSize = true, BackColor = Theme.Panel });
        }
        flow.AddFullFrom(card, Theme.Gap);

        var about = new RCard("关于本工作台") { Width = w, Height = 230 };
        bool online = false;
        try { online = Json.B(Json.M(Api.Get("/api/health")), "ok"); } catch { }
        about.AddControl(new Label {
            Text = "服务地址  " + Api.BaseUrl + "\n端口      " + Api.Port +
                   "\n窗口类型  原生 WinForms 应用窗口（不使用 Edge / WebView2 / 浏览器）" +
                   "\n数据依赖  本地 Node 服务 + SQLite（data\\pv.db + audit-chain.key）" +
                   "\n技术栈    C# / .NET Framework / 零第三方依赖" +
                   "\n连接状态  " + (online ? "服务在线，审计链正常" : "服务不可达（请检查启动器日志）"),
            Font = Theme.BodyFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel,
        });
        flow.AddFullFrom(about, 0);
    }

    // ---------------------------------------------------------- philosophy ---

    private void ViewPhilosophy(VFlow flow) {
        var w = ContentW();
        flow.AddFullFrom(new RHero(w, 100, "设计理念 —— 为什么这个工作台长这样", "每条理念都对应一个具体的界面行为，而不是一句口号", null), Theme.Gap);
        try {
            var d = Json.M(Api.Get("/api/philosophy"));
            string oneLiner = "";
            if (d.ContainsKey("oneLiner")) oneLiner = Json.S(Json.M(d["oneLiner"]), "zh");
            flow.AddFullFrom(new RBanner(w, oneLiner, Theme.BrandSoft, Theme.Brand2), Theme.Gap);

            flow.AddFullFrom(NewSection("核心原则"), Theme.GapSm);
            var principles = new[] {
                new[] { "01", "时限是底线，不是目标", "报告时钟从首次获知四要素（Day 0）那天开始，而不是病例做完那天——系统在受理步骤就记录接收日期。" },
                new[] { "02", "四要素是有效个例的最低门槛", "可识别患者 + 可识别报告者 + 可疑药品 + 不良事件，缺一不可；缺失通过随访补齐，但不得延误报告。" },
                new[] { "03", "因果评价记录依据，而非只给结论", "WHO-UMC 六级分类是判断框架；时间相关性、生物学合理性等依据进入审计追踪，可重建推理。" },
                new[] { "04", "先保证报告，再追求完整", "随访不足可「待补充」，但严重非预期必须在法定时限内提交；提交步骤强制回答是否在时限内。" },
                new[] { "05", "录入的人不能同时是评价的人", "职责分离由代码强制：数据录入员没有因果评价权限，医学评价员（医师）才可签署因果结论。" },
                new[] { "06", "每一份报告都可追溯它的一生", "哈希链审计追踪 + 双要素电子签名 + 修改理由：谁、何时、为何、改了什么永远可查。" },
                new[] { "07", "检查就绪度是常态，不是突击", "自查把 GVP 与 81号令条款变成可判定检查项，缺陷一键转 CAPA，未关闭缺陷与超期时限汇成就绪度评分。" },
            };
            var pgrid = new FlowLayoutPanel { Width = w, Height = 460, WrapContents = true, AutoScroll = true, BackColor = Theme.Bg };
            int pw = Math.Max(300, (w - Theme.Gap - 56) / 2);
            foreach (var p in principles) {
                var card = new RPanel(Theme.Panel) { Width = pw, Height = 112, Margin = new Padding(0, 0, Theme.Gap, Theme.Gap), Radius = 12, Accent = Theme.Brand, AccentWidth = 4 };
                AddText(card, p[0], new Font("Consolas", 12.5f, FontStyle.Bold), Theme.Brand, 16, 10, 44, 24, Theme.Panel);
                AddText(card, p[1], Theme.H3Font, Theme.Ink, 16, 36, pw - 32, 22, Theme.Panel);
                AddText(card, p[2], new Font("Microsoft YaHei UI", 8.25f), Theme.Ink3, 16, 62, pw - 32, 46, Theme.Panel);
                pgrid.Controls.Add(card);
            }
            flow.AddFullFrom(pgrid, Theme.Gap);

            flow.AddFullFrom(NewSection("领域理念"), Theme.GapSm);
            var agrid = new FlowLayoutPanel { Width = w, Height = 400, WrapContents = true, AutoScroll = true, BackColor = Theme.Bg };
            var phiMap = d.ContainsKey("philosophy") ? Json.M(d["philosophy"]) : new Dictionary<string, object>();
            foreach (var a in Json.A(d, "areas")) {
                var ad = Json.M(a);
                var code = Json.S(ad, "code");
                var card = new RPanel(Theme.Panel) { Width = pw, Height = 96, Margin = new Padding(0, 0, Theme.Gap, Theme.Gap), Radius = 12, Accent = DomainColor(ad), AccentWidth = 4 };
                AddText(card, code + " · " + Json.S(ad, "name"), Theme.H3Font, DomainColor(ad), 16, 10, pw - 32, 22, Theme.Panel);
                AddText(card, Cut(Json.S(phiMap, code), 52), new Font("Microsoft YaHei UI", 8.25f), Theme.Ink3, 16, 36, pw - 32, 52, Theme.Panel);
                var captured = code;
                card.Click += (s, e) => OpenDomain(captured);
                foreach (Control c in card.Controls) c.Click += (s, e) => OpenDomain(captured);
                card.Cursor = Cursors.Hand;
                agrid.Controls.Add(card);
            }
            flow.AddFullFrom(agrid, 0);
        } catch (Exception ex) { ErrFlow(flow, ex.Message); }
    }

    // ------------------------------------------------------------ domains ---

    private void ViewDomains(VFlow flow) {
        var w = ContentW();
        string demoHint = (_choices != null && Json.B(_choices, "enabled"))
            ? "演示：点击任意领域卡 → 在其中选择一位身份（演示密码 PV-Demo-2026!）→ 进入该领域的受控流程"
            : "领域与流程是公开参考模型；登录后可见待办、记录与完整工作流数据";
        flow.AddFullFrom(new RHero(w, 124, "欢迎使用 LeebertyPV 药物警戒工作台",
            "个例报告 · 信号 · PSUR · 风险管理 · 文献 · 疫苗 · 投诉 · 质量体系 —— 8 大领域，12 条受控流程",
            demoHint), Theme.Gap);
        try {
            var d = Json.M(Api.Get("/api/domains"));
            var doms = Json.A(d, "domains");
            int procs = 0, roles = 0;
            foreach (var dm in doms) { procs += Json.I(Json.M(dm), "processCount"); roles += Json.I(Json.M(dm), "participantCount"); }
            flow.AddFullFrom(BuildStrip(new[] {
                S3(doms.Count.ToString(), "个 PV 领域", Theme.Ink),
                S3(procs.ToString(), "条流程领域关联", Theme.Ink),
                S3(roles.ToString(), "个参与岗位", Theme.Ink),
                S3("12", "条受控流程定义", Theme.Ink),
            }, w), Theme.Gap);

            flow.AddFullFrom(BuildDomainGrid(doms, w, (code) => OpenDomain(code)), 0);
        } catch (Exception ex) { ErrFlow(flow, ex.Message); }
    }

    private static Tuple<string, string, Color> S3(string value, string label, Color tone) {
        return Tuple.Create(value, label, tone);
    }

    private FlowLayoutPanel BuildStrip(Tuple<string, string, Color>[] items, int w) {
        var strip = new FlowLayoutPanel { Width = w, Height = 84, WrapContents = false, BackColor = Theme.Bg, Margin = new Padding(0, 0, 0, Theme.Gap) };
        foreach (var item in items) {
            var s = new RStat(item.Item1, item.Item2, item.Item3) { Width = 172, Margin = new Padding(0, 0, 12, 0) };
            strip.Controls.Add(s);
        }
        return strip;
    }

    public void OpenDomain(string code) {
        _host.Tag = new Dictionary<string, object> { { "code", code } };
        NavTo("domain");
    }

    // --------------------------------------------------------------- domain ---

    private void ViewDomain(VFlow flow) {
        var code = P("code");
        if (code == "") { ViewDomains(flow); return; }
        var w = ContentW();
        try {
            var d = Json.M(Api.Get("/api/domain/" + Uri.EscapeDataString(code)));
            var area = Json.M(d["area"]);
            flow.AddFullFrom(new RHero(w, 108, code + " · " + Json.S(area, "name"), Cut(Json.S(area, "philosophy"), 90), null), Theme.Gap);

            var summary = Json.M(d["summary"]);
            flow.AddFullFrom(BuildStrip(new[] {
                S3(Json.I(summary, "processCount").ToString(), "条专属流程", Theme.Ink),
                S3(Json.I(summary, "participantCount").ToString(), "个参与岗位", Theme.Ink),
                S3(Json.I(summary, "openRecords").ToString(), "在办记录", Theme.Warn),
                S3(Json.I(summary, "totalRecords").ToString(), "条全部记录", Theme.Ink),
            }, w), Theme.Gap);

            flow.AddFullFrom(NewSection("流程一览"), Theme.GapSm);
            var card = new RCard("该领域的受控流程") { Width = w, Height = 330 };
            var lv = Kit.Grid();
            lv.Height = 260;
            lv.Columns.Add("code", "流程"); lv.Columns.Add("name", "说明"); lv.Columns.Add("steps", "步骤"); lv.Columns.Add("roles", "岗位"); lv.Columns.Add("sig", "签名步骤"); lv.Columns.Add("open", "在办");
            foreach (var pr in Json.A(d, "processes")) {
                var pd = Json.M(pr);
                lv.Rows.Add(Json.S(pd, "code"), Json.S(pd, "name"), Json.I(pd, "stepCount"), Json.I(pd, "participantCount"), Json.I(pd, "signedStepCount"), Json.I(pd, "openCount"));
            }
            lv.CellDoubleClick += (s, e) => { if (e.RowIndex >= 0) OpenWorkflow((string)lv.Rows[e.RowIndex].Cells[0].Value); };
            card.AddControl(lv);
            card.AddControl(new Label { Text = "双击任意流程行，查看它的工作流程图、责任移交与权限矩阵。", Font = Theme.SmallFont, ForeColor = Theme.Ink3, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 6, 0, 0) });
            flow.AddFullFrom(card, Theme.Gap);

            var roles = Json.A(d, "participants");
            if (roles.Count > 0) {
                flow.AddFullFrom(NewSection("参与岗位"), Theme.GapSm);
                var rgrid = new FlowLayoutPanel { Width = w, Height = 300, WrapContents = true, AutoScroll = true, BackColor = Theme.Bg };
                int cw = Math.Max(240, (w - Theme.Gap * 2) / 3);
                foreach (var p in roles) {
                    var pd = Json.M(p);
                    var rc = new RPanel(Theme.Panel) { Width = cw, Height = 92, Margin = new Padding(0, 0, Theme.Gap, Theme.Gap), Radius = 12, Accent = Theme.Brand, AccentWidth = 3 };
                    AddText(rc, Json.S(pd, "roleLabelZh"), Theme.H3Font, Theme.Brand2, 14, 10, cw - 28, 22, Theme.Panel);
                    AddText(rc, Cut(Json.S(pd, "duty"), 42), new Font("Microsoft YaHei UI", 8.25f), Theme.Ink3, 14, 36, cw - 28, 48, Theme.Panel);
                    rgrid.Controls.Add(rc);
                }
                flow.AddFullFrom(rgrid, Theme.Gap);
            }

            var checks = Json.A(d, "checklists");
            if (checks.Count > 0) {
                flow.AddFullFrom(NewSection("覆盖本领域的法规自查表"), Theme.GapSm);
                var crow = new ChipRow { Width = w, Height = 40 };
                foreach (var ck in checks) crow.AddBadge(Json.S(Json.M(ck), "title"), RBadge.Tone.Brand);
                flow.AddFullFrom(crow, 0);
            }
        } catch (Exception ex) { ErrFlow(flow, ex.Message); }
    }

    // ---------------------------------------------------------- workflow ----

    public void OpenWorkflow(string code) {
        _host.Tag = new Dictionary<string, object> { { "code", code } };
        NavTo("workflow");
    }

    private void ViewWorkflow(VFlow flow) {
        var code = P("code");
        if (code == "") { ViewDomains(flow); return; }
        var w = ContentW();
        try {
            var d = Json.M(Api.Get("/api/explorer/" + Uri.EscapeDataString(code)));
            var proc = Json.M(d["process"]);
            var sum = Json.M(d["summary"]);
            string sla = Json.S(proc, "slaDays");
            string stepsInfo = Json.I(sum, "stepCount") + " 步 · 签名 " + Json.I(sum, "signedStepCount") + " · 独立审签 " + Json.I(sum, "independentStepCount") + (sla != "" ? " · 标准时限 " + sla + " 天" : "");
            flow.AddFullFrom(new RHero(w, 122, Json.S(proc, "name"),
                Json.S(proc, "code") + "  |  " + stepsInfo, Cut(Json.S(proc, "description"), 90)), Theme.Gap);

            var regs = Json.A(proc, "regulationRefs");
            if (regs.Count > 0) {
                var crow = new ChipRow { Width = w, Height = 40 };
                crow.AddBadge("法规依据", RBadge.Tone.Ink);
                foreach (var r in regs) crow.AddBadge(Cut(Convert.ToString(r), 60), RBadge.Tone.Muted);
                flow.AddFullFrom(crow, Theme.Gap);
            }

            if (Session.IsLoggedIn && Session.Can("record.create")) {
                var nb = new RButton("新建该流程的记录", RButton.Variant.Primary) { Size = new Size(190, 38), Margin = new Padding(0, 0, 0, Theme.Gap) };
                string pcode = code;
                nb.Click += (s, e) => OpenRecordNew(pcode);
                flow.AddFullFrom(nb, 0);
            }

            flow.AddFullFrom(NewSection("工作流时间线 —— 每一步责任人、签名门槛与指引"), Theme.GapSm);
            var flowBox = new FlowLayoutPanel { Width = w, Height = 600, WrapContents = false, FlowDirection = FlowDirection.TopDown, AutoScroll = true, BackColor = Theme.Bg };
            var st0 = Json.A(d, "steps");
            var sz = new List<Control>();
            for (int i = 0; i < st0.Count; i++) {
                var sd = Json.M(st0[i]);
                var step = new RStep(
                    Json.I(sd, "seq"), Json.S(sd, "name"), RStep.RolesText(sd),
                    Json.S(sd, "signatureMeaning"), Json.B(sd, "independentOfAuthor"),
                    Json.B(sd, "optional"), Cut(Json.S(sd, "guidance"), 80)) {
                    Width = w, Margin = new Padding(0, 0, 0, 6),
                };
                step.Height = 78;
                flowBox.Controls.Add(step);
            }
            flow.AddFullFrom(flowBox, Theme.Gap);

            var hoffs = Json.A(d, "handoffs");
            if (hoffs.Count > 0) {
                flow.AddFullFrom(NewSection("责任移交链（谁把工作交给谁）"), Theme.GapSm);
                var card = new RCard("") { Width = w, Height = Math.Min(260, 70 + hoffs.Count * 32) };
                var g2 = Kit.Grid();
                g2.Height = Math.Max(140, card.Content.Height - 12);
                g2.Columns.Add("from", "移交自"); g2.Columns.Add("fr", "角色"); g2.Columns.Add("to", "移交至"); g2.Columns.Add("tr", "角色"); g2.Columns.Add("sig", "签名");
                foreach (var h in hoffs) {
                    var hd = Json.M(h);
                    g2.Rows.Add(Cut(Json.S(hd, "fromStepName"), 24), JoinRoles(hd, "fromRoles"), Cut(Json.S(hd, "toStepName"), 24), JoinRoles(hd, "toRoles"), Json.B(hd, "requiresSignature") ? "需签名" : "");
                }
                card.AddControl(g2);
                flow.AddFullFrom(card, Theme.Gap);
            }

            var parts = Json.A(d, "participants");
            if (parts.Count > 0) {
                flow.AddFullFrom(NewSection("参与岗位与权限"), Theme.GapSm);
                var card = new RCard("岗位 · 职责 · 权限") { Width = w, Height = 170 };
                var g3 = Kit.Grid();
                g3.Height = 130;
                g3.Columns.Add("role", "岗位"); g3.Columns.Add("label", "角色"); g3.Columns.Add("duty", "职责"); g3.Columns.Add("steps", "步骤"); g3.Columns.Add("perms", "权限");
                foreach (var p in parts) {
                    var pd = Json.M(p);
                    g3.Rows.Add(Json.S(pd, "role"), Json.S(pd, "roleLabelZh"), Cut(Json.S(pd, "duty"), 34), Json.I(pd, "stepCount"), Json.S(pd, "permissionCount"));
                }
                card.AddControl(g3);
                flow.AddFullFrom(card, 0);
            }
        } catch (Exception ex) { ErrFlow(flow, ex.Message); }
    }

    private static string JoinRoles(Dictionary<string, object> hd, string key) {
        var parts = new List<string>();
        foreach (var r in Json.A(hd, key)) parts.Add(Convert.ToString(r).Replace("_", " "));
        return Cut(string.Join("/", parts.ToArray()), 28);
    }

    // ------------------------------------------------------------- inbox ----

    private void ViewInbox(VFlow flow) {
        var w = ContentW();
        if (!Session.IsLoggedIn) {
            flow.AddFullFrom(new RHero(w, 96, "我的待办", "登录后查看等待你处理的条目——待办属于具体的人，领域与流程属于所有人", null), Theme.Gap);
            var go = new RButton("前往登录", RButton.Variant.Primary) { Size = new Size(150, 40) };
            go.Click += (s, e) => NavTo("login");
            flow.AddFullFrom(go, 0);
            return;
        }
        flow.AddFullFrom(NewSection("我的待办 — " + Session.LoggedInAs), Theme.GapSm);
        try {
            var d = Json.M(Req.Get("/api/inbox?limit=120"));
            var counts = Json.M(d["counts"]);
            flow.AddFullFrom(BuildStrip(new[] {
                S3(Json.I(counts, "total").ToString(), "条待办", Theme.Ink),
                S3(Json.I(counts, "overdue").ToString(), "已超期", Theme.Danger),
                S3(Json.I(counts, "requiresSignature").ToString(), "需签名", Theme.Warn),
                S3(Json.I(counts, "toSubmit").ToString(), "待提交", Theme.Ink),
                S3(Json.I(counts, "toApprove").ToString(), "待批复", Theme.Ink),
            }, w), Theme.Gap);

            var items = Json.A(d, "items");
            var card = new RCard("等待你处理") { Width = w, Height = Math.Max(150, Math.Min(items.Count, 14) * 56 + 70) };
            var list = new FlowLayoutPanel {
                Width = w - 30, Height = Math.Max(100, card.Height - 60),
                WrapContents = false, FlowDirection = FlowDirection.TopDown, AutoScroll = true, BackColor = Theme.Bg,
            };
            card.AddControl(list);
            if (items.Count == 0) {
                list.Controls.Add(new RBanner(w - 30, "当前没有待办事项——本身份当前没有等待处理的步骤或通知。", Theme.OkSoft, Theme.Ok));
            }
            foreach (var it in items) {
                var id = Json.M(it);
                var overdue = Json.B(id, "overdue");
                var sig = Json.B(id, "requiresSignature");
                var main = (Json.S(id, "recordKey") != "" ? Json.S(id, "recordKey") + " · " : "") + Json.S(id, "title");
                var sub = Json.S(id, "stepName") != "" ? "步骤：" + Json.S(id, "stepName") + "  ·  动作：" + Json.S(id, "action") : "来自：" + Cut(Json.S(id, "description"), 30);
                var meta = (Json.S(id, "dueDate") != "" ? "期限 " + Json.S(id, "dueDate") : "") + (overdue ? "  已超期" : sig ? "  需签名" : "");
                var row = new RListRow(main, sub, meta) { Width = w - 30, Status = overdue ? Theme.Danger : (sig ? Theme.Warn : Color.Transparent) };
                int iid = Json.I(id, "instanceId");
                if (iid > 0) row.Activated += (s, e) => OpenRecord(iid);
                list.Controls.Add(row);
            }
            flow.AddFullFrom(card, Theme.Gap);

            var cap = Json.M(d["roleCapabilities"]);
            var capCard = new RCard("你的权限边界（本身份可以做什么）") { Width = w, Height = 120 };
            var caps = new List<string>();
            if (Json.B(cap, "canProcessCases")) caps.Add("处理个例报告");
            if (Json.B(cap, "canAssessCausality")) caps.Add("因果关系评价");
            if (Json.B(cap, "canManageSignals")) caps.Add("信号管理");
            if (Json.B(cap, "canManagePSUR")) caps.Add("定期报告");
            if (Json.B(cap, "canManageRMP")) caps.Add("风险管理计划");
            if (Json.B(cap, "canSubmitReports")) caps.Add("递交监管报告");
            if (Json.B(cap, "canManageComplaints")) caps.Add("处理投诉");
            if (caps.Count == 0) caps.Add("无写入类权限");
            var crow = new ChipRow { Width = w - 30, Height = 34 };
            foreach (var c in caps) crow.AddBadge(c, RBadge.Tone.Brand);
            if (Json.B(cap, "readOnly")) crow.AddBadge("只读账号", RBadge.Tone.Muted);
            capCard.AddControl(crow);
            flow.AddFullFrom(capCard, 0);
        } catch (Exception ex) { ErrFlow(flow, ex.Message); }
    }

    // ------------------------------------------------------------ records ---

    private void ViewRecords(VFlow flow) {
        var w = ContentW();
        flow.AddFullFrom(NewSection("安全性记录"), Theme.GapSm);
        if (!Session.IsLoggedIn) {
            var go = new RButton("前往登录", RButton.Variant.Primary) { Size = new Size(150, 40) };
            go.Click += (s, e) => NavTo("login");
            flow.AddFullFrom(go, 0);
            return;
        }
        if (!Session.Can("record.view")) {
            flow.AddFullFrom(new RBanner(w, "当前身份无记录查看权限。", Theme.WarnSoft, Theme.Warn), 0);
            return;
        }
        try {
            if (Session.Can("record.create")) {
                var nb = new RButton("＋ 新建记录", RButton.Variant.Primary) { Size = new Size(150, 38), Margin = new Padding(0, 0, 0, Theme.Gap) };
                nb.Click += (s, e) => NavTo("recordNew");
                flow.AddFullFrom(nb, 0);
            }
            var d = Json.M(Req.Get("/api/records?limit=200"));
            var rows = Json.A(d, "rows");
            var card = new RCard("全部记录（" + Json.I(d, "total") + " 条）") { Width = w, Height = Math.Max(160, Math.Min(rows.Count, 20) * 36 + 70) };
            var g = Kit.Grid();
            g.Height = Math.Max(120, card.Height - 60);
            g.Columns.Add("key", "记录编号"); g.Columns.Add("proc", "流程"); g.Columns.Add("title", "标题"); g.Columns.Add("crit", "级别"); g.Columns.Add("status", "状态"); g.Columns.Add("due", "期限");
            foreach (var row in rows) {
                var rd = Json.M(row);
                int idx = g.Rows.Add(Json.S(rd, "recordKey"), Json.S(rd, "processCode"), Cut(Json.S(rd, "title"), 40), Json.S(rd, "criticality"), Json.S(rd, "status"), Json.S(rd, "dueDate"));
                if (Json.B(rd, "overdue")) g.Rows[idx].DefaultCellStyle.BackColor = Theme.DangerSoft;
                g.Rows[idx].Tag = Json.I(rd, "id");
            }
            g.CellDoubleClick += (s, e) => { if (e.RowIndex >= 0 && g.Rows[e.RowIndex].Tag != null) OpenRecord((int)g.Rows[e.RowIndex].Tag); };
            card.AddControl(g);
            card.AddControl(new Label { Text = "双击行打开记录详情（字段、步骤、历史与签名）。", Font = Theme.SmallFont, ForeColor = Theme.Ink3, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 6, 0, 0) });
            flow.AddFullFrom(card, 0);
        } catch (Exception ex) { ErrFlow(flow, ex.Message); }
    }

    public void OpenRecord(int id) {
        _host.Tag = new Dictionary<string, object> { { "id", id.ToString() } };
        NavTo("record");
    }

    private void OpenRecordNew(string processCode) {
        _host.Tag = new Dictionary<string, object> { { "processCode", processCode } };
        NavTo("recordNew");
    }

    // ------------------------------------------------------------- record ----

    private void ViewRecord(VFlow flow) {
        int id; if (!int.TryParse(P("id"), out id)) { ViewRecords(flow); return; }
        var w = ContentW();
        if (!Session.IsLoggedIn || !Session.Can("record.view")) {
            flow.AddFullFrom(new RBanner(w, "需要登录且具有记录查看权限。", Theme.WarnSoft, Theme.Warn), 0);
            return;
        }
        try {
            var d = Json.M(Req.Get("/api/records/" + id));
            bool overdue = Json.B(d, "overdue");
            flow.AddFullFrom(new RHero(w, 104,
                Cut(Json.S(d, "title"), 46),
                Json.S(d, "recordKey") + "  ·  " + Json.S(d, "processName") + "  ·  " + Json.S(d, "status") + "  ·  级别 " + Json.S(d, "criticality") + "  ·  期限 " + Json.S(d, "dueDate") + (overdue ? "  ⚠ 已超期" : ""),
                null), Theme.Gap);

            var data = Json.M(d["data"]);
            if (data.Count > 0) {
                var dataCard = new RCard("记录字段") { Width = w, Height = Math.Min(240, 62 + data.Count * 24) };
                var sb = new StringBuilder();
                foreach (var kv in data) {
                    if (kv.Value == null || Convert.ToString(kv.Value) == "") continue;
                    sb.AppendLine(kv.Key + "： " + kv.Value);
                }
                dataCard.AddControl(new Label { Text = sb.ToString().TrimEnd(), Font = Theme.BodyFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel });
                flow.AddFullFrom(dataCard, Theme.Gap);
            }

            var steps = Json.A(d, "steps");
            flow.AddFullFrom(NewSection("流程步骤"), Theme.GapSm);
            var stepsCard = new RCard("步骤 · 状态 · 签名") { Width = w, Height = Math.Max(160, steps.Count * 38 + 80) };
            var stepsGrid = Kit.Grid();
            stepsGrid.Height = Math.Max(120, stepsCard.Height - 70);
            stepsGrid.Columns.Add("name", "步骤"); stepsGrid.Columns.Add("status", "状态"); stepsGrid.Columns.Add("role", "责任角色"); stepsGrid.Columns.Add("sig", "签名"); stepsGrid.Columns.Add("at", "完成时间");
            for (int i = 0; i < steps.Count; i++) {
                var sd = Json.M(steps[i]);
                int idx = stepsGrid.Rows.Add(Cut(Json.S(sd, "name"), 22), Json.S(sd, "status"), RStep.RolesText(sd).Replace("_", " "), Json.S(sd, "signatureMeaning") != "" ? "需签名" : "", Cut(Json.S(sd, "completedAt"), 16));
                var st2 = Json.S(sd, "status");
                if (st2 == "completed") stepsGrid.Rows[idx].DefaultCellStyle.BackColor = Theme.OkSoft;
            }
            stepsGrid.CellDoubleClick += (s, e) => {
                if (e.RowIndex >= 0) {
                    var stepCode = (string)stepsGrid.Rows[e.RowIndex].Cells[0].Value == null ? "" : (string)stepsGrid.Rows[e.RowIndex].Cells[0].Value;
                    // map back through the name column: use index order
                    TryCompleteStep(id, (string)(Json.M(steps[e.RowIndex])["code"]), d, w);
                }
            };
            stepsCard.AddControl(stepsGrid);
            stepsCard.AddControl(new Label { Text = "双击未完成的步骤，填写表单并（如需）电子签名。", Font = Theme.SmallFont, ForeColor = Theme.Ink3, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 6, 0, 0) });
            flow.AddFullFrom(stepsCard, Theme.Gap);

            var next = FindNextPendingStep(d);
            if (next != "") {
                var act = new RButton("推进下一步骤", RButton.Variant.Primary) { Size = new Size(170, 42), Margin = new Padding(0, 0, 0, Theme.Gap) };
                string stepCode = next;
                act.Click += (s, e) => TryCompleteStep(id, stepCode, d, w);
                flow.AddFullFrom(act, 0);
            } else {
                flow.AddFullFrom(new RBanner(w, "✓ 所有步骤已完成。", Theme.OkSoft, Theme.Ok), Theme.Gap);
            }

            var hist = Json.A(d, "history");
            if (hist.Count > 0) {
                flow.AddFullFrom(NewSection("流转历史"), Theme.GapSm);
                var hcard = new RCard("") { Width = w, Height = Math.Min(200, 50 + hist.Count * 24) };
                var hb = new StringBuilder();
                foreach (var h in hist) {
                    var hd = Json.M(h);
                    hb.AppendLine(Cut(Json.S(hd, "at"), 19) + "  " + Json.S(hd, "action") + "  " + Json.S(hd, "actor") + (Json.S(hd, "comment") != "" ? "  " + Cut(Json.S(hd, "comment"), 44) : ""));
                }
                hcard.AddControl(new Label { Text = hb.ToString().TrimEnd(), Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel });
                flow.AddFullFrom(hcard, Theme.Gap);
            }

            var sigs = Json.A(d, "signatures");
            if (sigs.Count > 0) {
                flow.AddFullFrom(NewSection("电子签名"), Theme.GapSm);
                var scard = new RCard("") { Width = w, Height = Math.Min(160, 50 + sigs.Count * 26) };
                var sb2 = new StringBuilder();
                foreach (var sg in sigs) {
                    var sd = Json.M(sg);
                    sb2.AppendLine("✍  " + Json.S(sd, "printedName") + "  ·  " + Json.S(sd, "meaning") + "  ·  " + Cut(Json.S(sd, "signedAt"), 19));
                }
                scard.AddControl(new Label { Text = sb2.ToString().TrimEnd(), Font = Theme.BodyFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel });
                flow.AddFullFrom(scard, 0);
            }
        } catch (Exception ex) { ErrFlow(flow, "读取记录失败：" + ex.Message); }
    }

    private static string FindNextPendingStep(Dictionary<string, object> d) {
        foreach (var st in Json.A(d, "steps")) if (Json.S(Json.M(st), "status") == "pending") return Json.S(Json.M(st), "code");
        return "";
    }

    // ------------------------------------------------- step completion dialog -

    private void TryCompleteStep(int recordId, string stepCode, Dictionary<string, object> record, int w) {
        Dictionary<string, object> step = null;
        foreach (var s in Json.A(record, "steps")) if (Json.S(Json.M(s), "code") == stepCode) { step = Json.M(s); break; }
        if (step == null) return;
        var meaning = Json.S(step, "signatureMeaning");
        bool needsSig = meaning != "";

        var dlg = new Form {
            Text = "完成步骤：" + Cut(Json.S(step, "name"), 30),
            ClientSize = new Size(660, 820), StartPosition = FormStartPosition.CenterParent,
            FormBorderStyle = FormBorderStyle.FixedSingle, MaximizeBox = false, MinimizeBox = false,
            BackColor = Theme.Bg, Font = Theme.BodyFont,
        };
        try { dlg.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        var flow = new VFlow { Width = 640 };
        dlg.Controls.Add(flow);

        flow.AddFullFrom(new RHero(620, 86,
            Cut(Json.S(step, "name"), 30),
            "责任人：" + RStep.RolesText(step) + (needsSig ? "  ·  需电子签名（" + meaning + "）" : ""),
            Cut(Json.S(step, "guidance"), 96)), 8);

        var formFields = new List<Dictionary<string, object>>();
        try {
            var ex = Json.M(Api.Get("/api/explorer/" + Uri.EscapeDataString(Json.S(record, "processCode"))));
            foreach (var st in Json.A(ex, "steps")) {
                if (Json.S(Json.M(st), "code") == stepCode) {
                    foreach (var f in Json.A(st, "form")) formFields.Add(Json.M(f));
                    break;
                }
            }
        } catch { }

        var formCard = new RCard("填写步骤信息") { Width = 620, Height = Math.Min(400, 70 + formFields.Count * 60) };
        var formHost = formCard.Content;
        foreach (var f in formFields) AddField(formCard, Json.M(f));
        if (formFields.Count == 0) formCard.Content.Controls.Add(new Label { Text = "（本步骤无表单字段）", ForeColor = Theme.Ink3, AutoSize = true, BackColor = Theme.Panel });
        flow.AddFullFrom(formCard, 8);

        var reasonCard = new RCard("说明 / 评论（记入历史与审计追踪）") { Width = 620, Height = 130 };
        var reason = new TextBox { Width = 540, Height = 58, Multiline = true, BorderStyle = BorderStyle.FixedSingle };
        reasonCard.AddControl(reason);
        flow.AddFullFrom(reasonCard, 8);

        TextBox pwBox = null; Label challengeLbl = null; string nonce = "";
        if (needsSig) {
            var sigCard = new RCard("电子签名（21 CFR Part 11.200 双要素）") { Width = 620, Height = 200 };
            sigCard.AddControl(new Label { Text = "第一步：点击「获取一次性挑战码」→ 第二步：输入账号密码 → 第三步：签署并完成步骤。", Font = Theme.SmallFont, ForeColor = Theme.Ink3, AutoSize = true, BackColor = Theme.Panel });
            sigCard.AddControl(new Label { Text = "账号密码", Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 8, 0, 0) });
            pwBox = new TextBox { Width = 320, UseSystemPasswordChar = true, BorderStyle = BorderStyle.FixedSingle };
            sigCard.AddControl(pwBox);
            challengeLbl = new Label { Text = "尚未获取挑战码", Font = Theme.SmallFont, ForeColor = Theme.Ink3, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 8, 0, 0) };
            sigCard.AddControl(challengeLbl);
            var getCh = new RButton("获取一次性挑战码", RButton.Variant.Secondary) { Size = new Size(180, 34) };
            getCh.Click += (s, e) => {
                try {
                    var r = Req.Post("/api/signatures/challenge", new Dictionary<string, object> {
                        { "entityType", "workflow_instances" }, { "entityId", recordId.ToString() },
                        { "recordKey", Json.S(record, "recordKey") }, { "meaning", meaning }, { "stepCode", stepCode } });
                    var rd = Json.M(r);
                    nonce = Json.S(rd, "nonce");
                    challengeLbl.Text = "挑战码：" + nonce + "（一次性，数分钟内有效）";
                    challengeLbl.ForeColor = Theme.Brand2;
                } catch (Exception ex) { Warn("获取挑战码失败：" + ex.Message); }
            };
            sigCard.AddControl(getCh);
            flow.AddFullFrom(sigCard, 8);
        }

        var submit = new RButton(needsSig ? "签署并完成步骤" : "完成步骤", RButton.Variant.Primary) { Size = new Size(200, 42) };
        submit.Click += (s, e) => {
            try {
                var formData = new Dictionary<string, object>();
                foreach (var f in formFields) {
                    var key = Json.S(f, "key");
                    Control input = FindInput(formCard.Content, key);
                    if (input == null) continue;
                    if (input is TextBox) formData[key] = ((TextBox)input).Text;
                    else if (input is ComboBox) formData[key] = ((ComboBox)input).SelectedItem == null ? "" : ((ComboBox)input).SelectedItem.ToString();
                    else if (input is DateTimePicker) formData[key] = ((DateTimePicker)input).Value.ToString("yyyy-MM-dd");
                }
                foreach (var f in formFields) {
                    if (Json.B(f, "required")) {
                        var key = Json.S(f, "key");
                        if (!formData.ContainsKey(key) || Convert.ToString(formData[key] ?? "").Trim() == "") { Warn("必填字段未填写：" + Json.S(f, "label")); return; }
                    }
                }
                string signatureId = null;
                if (needsSig) {
                    if (pwBox.Text.Trim() == "") { Warn("请先输入密码并获取挑战码"); return; }
                    if (nonce == "") { Warn("请先点击「获取一次性挑战码」"); return; }
                    var sig = Req.Post("/api/signatures", new Dictionary<string, object> {
                        { "username", Session.Username }, { "password", pwBox.Text }, { "nonce", nonce },
                        { "meaning", meaning }, { "reason", reason.Text.Trim() }, { "entityType", "workflow_instances" },
                        { "entityId", recordId.ToString() }, { "recordKey", Json.S(record, "recordKey") }, { "stepCode", stepCode } });
                    signatureId = Json.S(Json.M(sig), "id");
                }
                var payload = new Dictionary<string, object> {
                    { "stepCode", stepCode }, { "outcome", "completed" }, { "comment", reason.Text.Trim() }, { "formData", formData } };
                if (signatureId != null) payload["signatureId"] = signatureId;
                Req.Post("/api/records/" + recordId + "/steps/complete", payload);
                dlg.DialogResult = DialogResult.OK;
                dlg.Close();
                OpenRecord(recordId);
            } catch (Exception ex) { Warn(ex.Message); }
        };
        var row = new FlowLayoutPanel { Width = 620, Height = 56, WrapContents = false, BackColor = Theme.Bg };
        row.Controls.Add(submit);
        var cancel = new RButton("取 消", RButton.Variant.Ghost) { Size = new Size(110, 42), Margin = new Padding(12, 0, 0, 0) };
        cancel.Click += (s, e) => dlg.Close();
        row.Controls.Add(cancel);
        flow.AddFullFrom(row, 0);
        dlg.ShowDialog(this);
    }

    private static void AddField(Control host, Dictionary<string, object> f) {
        var type = Json.S(f, "type");
        var key = Json.S(f, "key");
        host.Controls.Add(new Label { Text = Json.S(f, "label") + (Json.B(f, "required") ? " *" : ""), Font = Theme.SmallFont, ForeColor = Theme.Ink2, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 8, 0, 0) });
        Control input;
        if (type == "select") {
            var cb = new ComboBox { Width = 420, DropDownStyle = ComboBoxStyle.DropDownList, Tag = key, Margin = new Padding(0, 2, 0, 0) };
            foreach (var o in Json.A(f, "options")) cb.Items.Add(Convert.ToString(o));
            if (cb.Items.Count > 0) cb.SelectedIndex = 0;
            input = cb;
        } else if (type == "date") {
            input = new DateTimePicker { Width = 220, Format = DateTimePickerFormat.Short, Tag = key, Margin = new Padding(0, 2, 0, 0) };
        } else if (type == "textarea") {
            input = new TextBox { Width = 500, Multiline = true, Height = 58, Tag = key, BorderStyle = BorderStyle.FixedSingle, Margin = new Padding(0, 2, 0, 0) };
        } else {
            input = new TextBox { Width = 500, Tag = key, BorderStyle = BorderStyle.FixedSingle, Margin = new Padding(0, 2, 0, 0) };
        }
        host.Controls.Add(input);
        var help = Json.S(f, "help");
        if (help != "") host.Controls.Add(new Label { Text = Cut(help, 84), Font = new Font("Microsoft YaHei UI", 8f), ForeColor = Theme.Ink3, AutoSize = true, BackColor = Theme.Panel, Margin = new Padding(0, 0, 0, 2) });
    }

    private static Control FindInput(Control host, string key) {
        foreach (Control c in host.Controls) if (c.Tag is string && (string)c.Tag == key) return c;
        return null;
    }

    // ---------------------------------------------------------- record new ---

    private void ViewRecordNew(VFlow flow) {
        var preset = P("processCode");
        var w = ContentW();
        flow.AddFullFrom(NewSection("新建安全性记录"), Theme.GapSm);
        if (!Session.IsLoggedIn || !Session.Can("record.create")) {
            flow.AddFullFrom(new RBanner(w, "需要具有记录创建权限的账号。", Theme.WarnSoft, Theme.Warn), 0);
            return;
        }
        try {
            var procs = new List<object>();
            var pl = Json.M(Req.Get("/api/process-types"));
            if (pl.ContainsKey("processTypes")) procs = Json.A(pl, "processTypes");
            var card = new RCard("① 选择流程类型") { Width = 640, Height = 130 };
            var cb = new ComboBox { Width = 480, DropDownStyle = ComboBoxStyle.DropDownList, Margin = new Padding(0, 8, 0, 0) };
            foreach (var p in procs) {
                var pd = Json.M(p);
                cb.Items.Add(new ProcItem(Json.S(pd, "code"), Json.S(pd, "name")));
            }
            for (int i = 0; i < cb.Items.Count; i++) if (((ProcItem)cb.Items[i]).Code == preset) { cb.SelectedIndex = i; break; }
            if (cb.SelectedIndex < 0 && cb.Items.Count > 0) cb.SelectedIndex = 0;
            card.AddControl(cb);
            flow.AddFullFrom(card, Theme.Gap);

            var fieldsCard = new RCard("② 填写必填字段（创建后进入受控流程步骤）") { Width = 640, Height = 520 };
            var host = fieldsCard.Content;
            var inner = new FlowLayoutPanel { Width = 560, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Height = 470, BackColor = Theme.Panel };
            host.Controls.Add(inner);
            Action refresh = null;
            refresh = () => {
                inner.Controls.Clear();
                var pi = cb.SelectedItem as ProcItem;
                if (pi == null) return;
                try {
                    var ex = Json.M(Api.Get("/api/explorer/" + Uri.EscapeDataString(pi.Code)));
                    var proc = Json.M(ex["process"]);
                    foreach (var f in Json.A(proc, "fields")) AddField(inner, Json.M(f));
                } catch (Exception ex2) {
                    inner.Controls.Add(new Label { Text = "加载字段失败：" + ex2.Message, ForeColor = Theme.Danger, AutoSize = true, BackColor = Theme.Panel });
                }
                Reflow();
            };
            cb.SelectedIndexChanged += (s, e) => refresh();
            refresh();
            flow.AddFullFrom(fieldsCard, Theme.Gap);

            var go = new RButton("创建记录", RButton.Variant.Primary) { Size = new Size(170, 40) };
            go.Click += (s, e) => {
                var pi = cb.SelectedItem as ProcItem;
                if (pi == null) { Warn("请选择流程类型"); return; }
                var payload = new Dictionary<string, object>();
                foreach (Control ctl in inner.Controls) {
                    var tag = ctl.Tag as string; if (tag == null) continue;
                    if (ctl is TextBox) payload[tag] = ((TextBox)ctl).Text.Trim();
                    else if (ctl is ComboBox) payload[tag] = ((ComboBox)ctl).SelectedItem == null ? "" : ((ComboBox)ctl).SelectedItem.ToString();
                    else if (ctl is DateTimePicker) payload[tag] = ((DateTimePicker)ctl).Value.ToString("yyyy-MM-dd");
                }
                payload["processCode"] = pi.Code;
                try {
                    var r = Req.Post("/api/records", payload);
                    var rd = Json.M(r);
                    if (rd.ContainsKey("id")) OpenRecord(Json.I(rd, "id")); else Info(Json.Encode(rd));
                } catch (Exception ex) { Warn(ex.Message); }
            };
            flow.AddFullFrom(go, 0);
        } catch (Exception ex) { ErrFlow(flow, ex.Message); }
    }

    private class ProcItem {
        public string Code; public string Name;
        public ProcItem(string c, string n) { Code = c; Name = n; }
        public override string ToString() { return Code + "  —  " + Name; }
    }

    // -------------------------------------------------------------- audit ---

    private void ViewAudit(VFlow flow) {
        var w = ContentW();
        flow.AddFullFrom(NewSection("审计追踪 —— 只可追加、带哈希链的完整操作留痕"), Theme.GapSm);
        if (!Session.IsLoggedIn) {
            var go = new RButton("前往登录（需要审计查看权限）", RButton.Variant.Primary) { Size = new Size(240, 40) };
            go.Click += (s, e) => NavTo("login");
            flow.AddFullFrom(go, 0);
            return;
        }
        try {
            if (Session.Can("audit.verify")) {
                var v = new RButton("校验哈希链完整性", RButton.Variant.Secondary) { Size = new Size(190, 38), Margin = new Padding(0, 0, 0, Theme.Gap) };
                v.Click += (s, e) => {
                    try {
                        var r = Json.M(Req.Get("/api/audit/verify"));
                        Info(Json.B(r, "ok") ? "哈希链校验通过：" + Json.I(r, "checked") + " 条，未发现篡改。" : "校验失败，审计追踪可能被篡改！");
                    } catch (Exception ex) { Warn(ex.Message); }
                };
                flow.AddFullFrom(v, 0);
            }
            var d = Json.M(Req.Get("/api/audit?limit=300"));
            var entries = Json.A(d, "entries");
            var card = new RCard("最近审计条目（" + entries.Count + " 条）") { Width = w, Height = 620 };
            var g = Kit.Grid();
            g.Height = 560;
            g.Columns.Add("at", "时间"); g.Columns.Add("who", "操作人"); g.Columns.Add("act", "操作"); g.Columns.Add("type", "对象"); g.Columns.Add("key", "记录"); g.Columns.Add("reason", "理由");
            foreach (var row in entries) {
                var rd = Json.M(row);
                g.Rows.Add(Cut(Json.S(rd, "at"), 19), Json.S(rd, "actorName"), Json.S(rd, "action"), Json.S(rd, "entityType"), Json.S(rd, "recordKey"), Cut(Json.S(rd, "reason"), 44));
            }
            card.AddControl(g);
            flow.AddFullFrom(card, 0);
        } catch (Exception ex) { ErrFlow(flow, ex.Message); }
    }

    // ---------------------------------------------------------- compliance ---

    private void ViewCompliance(VFlow flow) {
        var w = ContentW();
        flow.AddFullFrom(NewSection("合规态势 —— 把本系统自身作为受审对象"), Theme.GapSm);
        if (!Session.IsLoggedIn) {
            var go = new RButton("前往登录（需要合规查看权限）", RButton.Variant.Primary) { Size = new Size(250, 40) };
            go.Click += (s, e) => NavTo("login");
            flow.AddFullFrom(go, 0);
            return;
        }
        try {
            var d = Json.M(Req.Get("/api/compliance/posture"));
            var s = Json.M(d["summary"]);
            flow.AddFullFrom(BuildStrip(new[] {
                S3(Json.I(s, "met").ToString(), "符合", Theme.Ok),
                S3(Json.I(s, "partial").ToString(), "部分符合", Theme.Warn),
                S3(Json.I(s, "notMet").ToString(), "不符合", Theme.Danger),
                S3(Json.I(s, "total").ToString(), "检查项总数", Theme.Ink),
            }, w), Theme.Gap);

            var checks = Json.A(d, "checks");
            var card = new RCard("逐条核对监管要求") { Width = w, Height = Math.Min(620, 80 + checks.Count * 38) };
            var g = Kit.Grid();
            g.Height = Math.Max(140, card.Height - 70);
            g.Columns.Add("st", "判定"); g.Columns.Add("clause", "条款"); g.Columns.Add("req", "要求"); g.Columns.Add("ev", "现状证据");
            foreach (var c in checks) {
                var cd = Json.M(c);
                var st = Json.S(cd, "status");
                int idx = g.Rows.Add(st, Json.S(cd, "clause"), Cut(Json.S(cd, "requirement"), 44), Cut(Json.S(cd, "evidence"), 44));
                if (st == "met") g.Rows[idx].DefaultCellStyle.BackColor = Theme.OkSoft;
                else if (st == "partial") g.Rows[idx].DefaultCellStyle.BackColor = Theme.WarnSoft;
                else g.Rows[idx].DefaultCellStyle.BackColor = Theme.DangerSoft;
            }
            card.AddControl(g);
            flow.AddFullFrom(card, 0);
        } catch (Exception ex) { ErrFlow(flow, ex.Message); }
    }

    // ---------------------------------------------------------- smoke test ---

    public string SmokeTest() {
        var err = new StringBuilder();
        Action<string> step = (name) => {
            try {
                NavTo(name);
            } catch (Exception ex) {
                err.AppendLine(name + " => " + ex.GetType().Name + ": " + ex.Message + " @ " + (ex.StackTrace ?? "").Split('\n')[0]);
            }
        };
        step("domains");
        step("philosophy");
        step("login");
        if (!Session.IsLoggedIn) {
            try {
                var c = Json.M(Api.Get("/api/login-choices"));
                if (Json.B(c, "enabled")) DoLogin("qa.manager", Json.S(c, "password"), "GVP");
            } catch (Exception ex) { err.AppendLine("login: " + ex.Message); }
        }
        if (Session.IsLoggedIn) {
            step("inbox");
            step("records");
            step("audit");
            step("compliance");
            step("me");
        }
        if (!LayoutCheck()) err.AppendLine("layout: control overflow or degenerate size detected");
        return err.ToString();
    }

    private bool LayoutCheck() {
        int big = 0, bad = 0;
        var stack = new Stack<Control>();
        stack.Push(this);
        while (stack.Count > 0) {
            var c = stack.Pop();
            foreach (Control ch in c.Controls) {
                bool decorative = (ch is Label || ch is RBadge || ch is RDivider || ch is RSection || ch is RStat);
                if (!decorative) {
                    if (ch.Width > 24 && ch.Height > 24) {
                        big++;
                        if (ch.Left < -320 || ch.Top < -320) bad++;
                    } else if (ch.Width > 0 && ch.Height > 0 && ch.Width < 6 && ch.Height < 6) {
                        bad++;
                    }
                }
                stack.Push(ch);
            }
        }
        return bad == 0 && big > 20;
    }
}