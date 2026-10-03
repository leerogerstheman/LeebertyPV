# 架构说明 · Architecture（LeebertyPV）

## 一句话概括

一个**配置驱动的药物警戒（PV）合规内核**，加一组领域模块，加一个零依赖的中英
双语界面。由 LeebertyGXP 改造而来：合规内核原样保留，领域集合整体替换为治疗性
药物警戒。

## 为什么是"配置驱动"

PV 各领域的合规义务形态高度同构。把差异抽象掉之后，剩下的共性是一个状态机：

```
受控的安全性记录 = 一串有顺序、有角色门槛、部分需签名的步骤
```

| 领域 | 记录前缀 | 步骤特征 |
|---|---|---|
| ICSR 快速报告 | `AES-2026-0001` | 接收登记 → 分类时限判定 → 录入编码 → 因果评价(签名) → 医学审核(签名) → 递交 → 随访 → 结案(签名) |
| ICSR 常规报告 | `AEN-2026-0001` | 同上，30 日时限；随访发现严重/非预期时转快速报告 |
| 信号检测 | `SIG-2026-0001` | 数据准备 → 计算 → 筛查 → 优先级排序 → 记录存档 |
| 信号评估 | `SIGA-2026-0001` | 验证 → 确认 → 临床评估 → 安全委员会(签名) → 处置行动 → RMM 审查 |
| PSUR | `PSUR-2026-0001` | 数据锁定 DLP → 数据汇总 → 撰写 → 内部审核 → 批准(签名) → 提交 → 归档 |
| RMP | `RMP-2026-0001` | 范围 → 风险特征 → PV 计划 → RMM 设计 → 批准(签名) → 实施 → 有效性 → 更新 |
| 文献监测 | `LIT-2026-0001` | 检索计划 → 检索 → 筛查 → 分诊 → 转交 ICSR → 归档 |
| AEFI | `AEFI-2026-0001` | 接收核实 → 六类分类 → 调查 → 因果(签名) → 上报 → 公众沟通 → 结案 |
| 投诉与召回 | `COMP-2026-0001` | 接收 → 安全性分诊 → 质量调查 → 处置 → 召回 → 联动 CAPA |
| PV 偏差 / CAPA / 变更 | `DEV-`/`CAPA-`/`CHG-` | 报告 → 调查 → 影响评估 → 措施 → 独立审批(签名) → 关闭 |

它们的差别只在**步骤数量、步骤名称、角色、签名含义、表单字段**。因此：

> **新增一个 PV 流程 = 往 `seed/workflows/` 放一个 JSON 文件。不写代码。**

`src/domain/workflow.js` 是全系统唯一的状态机。它读 `process_types.definitions_json`
（启动时从 `seed/workflows/*.json` 装填，删除定义文件会被自动停用），校验定义
合法性（步骤码不重复、目标状态存在、初始状态合法），并物化步骤清单。

### 流程定义 JSON schema（以 `seed/workflows/icsr-exp.json` → `ICSR-EXP` 为例）

顶层字段：

```jsonc
{
  "code": "ICSR-EXP",              // 流程代号（唯一，跨系统引用）
  "recordPrefix": "AES",           // 记录编号前缀 → AES-2026-0001
  "name": "严重/非预期个例安全性报告（快速报告）",
  "nameEn": "Expedited ICSR (Serious/Unexpected) Reporting",
  "category": "safety_case",
  "gxpAreas": ["ICSR", "GVP"],     // 覆盖的领域（用于角色归属推导，须 ≤3 个才是专属流程）
  "regulationRefs": [               // 法规依据条款（中英）
    "《药物警戒质量管理规范》第46条：ICSR四要素…",
    "《药物警戒质量管理规范》第49条：严重ADR 15日内报告……"
  ],
  "description": "…", "descriptionEn": "…",
  "slaDays": 15,                    // 目标完成时限（天），创建时自动计算 due_date
  "requiresRootCause": false,
  "requiresEffectivenessCheck": false,   // true → 后台进程强制检查有效性（PV-CAPA）
  "requiresQaApproval": true,
  "criticalityLevels": ["minor", "major", "critical"],
  "states": ["draft","intake","triage","data_entry","causality",
             "medical_review","submission","follow_up","closed","cancelled"],
  "initialState": "draft",
  "terminalStates": ["closed", "cancelled"],
  "fields": [                        // 记录级表单（所有步骤共用可见）
    { "key": "title", "label": "病例标题", "labelEn": "Case Title",
      "type": "text", "required": true, "help": "…" }
  ],
  "steps": [
    {
      "code": "intake",             // 步骤码（实例内唯一）
      "name": "接收与登记", "nameEn": "Intake and Registration",
      "role": ["pv_officer", "pv_data_entry"],   // 角色门槛（数组）
      "type": "task",               // task | signature（签名步骤）
      "onComplete": "intake",       // 完成后的流程状态
      "requiresFields": ["reporterName", "patientInfo", "awarenessDate",
                         "receivedDate", "minimalCriteriaComplete"],
      "form": [                     // 步骤专属表单
        { "key": "awarenessDate", "label": "首次获知日期（Day 0）", "type": "date",
          "required": true, "help": "任何渠道首次获知信息的日期，是时限起算依据……" }
      ],
      "guidance": "给操作者的指引（含条款依据）",
      "signatureMeaning": "assessed",  // 有此字段 → 完成本步必须电子签名（含义封闭枚举）
      "optional": false,
      "independentOfAuthor": true      // true → 拒绝记录作者本人执行本步（职责分离）
    }
  ]
}
```

`workflow.js` 同时支持 `persistFields`（把表单字段落到实例的专用列，如
`root_cause`）；当前 12 个 PV 流程文件使用 `requiresFields` 完成强制字段校验。

现有 12 个流程（`seed/workflows/`，实际 code/name 一一对应）：

| code | name | gxpAreas | recordPrefix | slaDays |
|---|---|---|---|---|
| `ICSR-EXP` | 严重/非预期个例安全性报告（快速报告） | ICSR, GVP | AES | 15 |
| `ICSR-REG` | 非严重个例安全性报告（常规报告） | ICSR, GVP | AEN | 30 |
| `SIG-DET` | 信号检测 | SIGNAL | SIG | 30 |
| `SIG-EVAL` | 信号评估 | SIGNAL | SIGA | 60 |
| `PSUR-COMP` | 定期安全性更新报告编制 | PSUR | PSUR | 60 |
| `RMP-LIFE` | 风险管理计划全生命周期管理 | RMP | RMP | 90 |
| `LIT-MON` | 医学文献监测 | LIT | LIT | 30 |
| `AEFI-EXP` | 疑似预防接种异常反应快速处置 | AEFI, GVP | AEFI | 2 |
| `COMP-HANDLE` | 药品投诉与召回联动 | COMPLAINT | COMP | 30 |
| `PV-DEV` | 药物警戒质量偏差 | GVP | DEV | 30 |
| `PV-CAPA` | 纠正与预防措施 | GVP | CAPA | 90 |
| `PV-CHANGE` | 药物警戒体系变更控制 | GVP | CHG | 60 |

检查表模板 JSON（`seed/checklists/*.json`，由 `inspections.registerTemplate` 装载）：
`{ code, title, titleEn, scope, gxpAreas, regulation, authority, version,
   items: [{ clauseRef, requirement, requirementEn, guidance, riskLevel,
             evidenceHint, isCritical }] }`。装入即用、重启生效；删除定义文件会
自动停用对应模板且**不破坏既有检查项与缺陷的历史引用**（条目原地更新而非删了
重建）。当前发行版目录为空、未预置模板，启动横幅如实际显示数量。

## 分层

```
┌──────────────────────────────────────────────────────────────┐
│  web/   原生 JS SPA，中英双语，零依赖，无构建步骤              │
│         index.html → i18n → api → ui → views/* → app          │
└───────────────────────────┬──────────────────────────────────┘
                            │ REST (JSON, cookie session)
┌───────────────────────────▼──────────────────────────────────┐
│  src/api/   routes.js  每个路由声明所需权限                    │
│             server.js  静态文件 + JSON API，node:http          │
├──────────────────────────────────────────────────────────────┤
│  src/domain/  领域模块（业务规则从这里开始）                   │
│    workflow   explorer   inbox   documents   inspections      │
│    training   dashboard   accounts   visibility  constraints  │
├──────────────────────────────────────────────────────────────┤
│  src/core/    合规内核（所有领域共用）★                        │
│    db         SQLite schema（含防篡改触发器）                  │
│    audit      只可追加哈希链 ★★                                │
│    auth       认证 / 会话 / 电子签名 ★★                        │
│    rbac       15 角色 46 权限矩阵                              │
│    crypto     scrypt / TOTP / 规范化 JSON 哈希                 │
├──────────────────────────────────────────────────────────────┤
│  src/daemon/  monitor.js  后台工作流进程 ★★                    │
└───────────────────────────┬──────────────────────────────────┘
                            │ node:sqlite（内置，无依赖）
                     data/pv.db  +  data/audit-chain.key
```

## 数据模型（`src/core/db.js` 的实际建表）

核心三张表，全部业务表都带 `record_key`/`record_version` 以便从审计链按时间点
重建（ALCOA+ "Enduring/Available"）：

| 表 | 关键列 | 说明 |
|---|---|---|
| `workflow_instances` | `record_key`(唯一), `process_code`, `title`, `status`, `current_step`, `gxp_areas`, `criticality`, `parent_id`/`link_type`(记录间联动：偏差→CAPA→变更), `reported_by`, `owner_id`, `qa_owner_id`, `occurred_at`, `detected_at`, `due_date`, `data_json`, `root_cause`, `effectiveness_check`, `record_version` | 一条 PV 记录（ICSR、信号、PSUR、RMP、CAPA……） |
| `workflow_steps` | `instance_id`, `seq`, `step_code`, `status`, `assignee_role`, `assignee_id`, `due_date`, `outcome`, `form_data`, `signature_meaning`, `signature_id` | 物化的步骤清单，UNIQUE(instance_id, step_code) |
| `audit_trail` | `seq`(自增), `at`, `actor_*`, `action`, `entity_type`/`entity_id`, `record_key`, `record_version`, `reason`, `old_value`, `new_value`, `meta`, `session_id`, `signature_id`, `prev_hash`, `payload_hash`, `chain_hash`, `severity` | 只可追加；`UPDATE`/`DELETE` 被触发器 `RAISE(ABORT)` |
| `signatures` | `user_id`, `printed_name`, `meaning`(封闭枚举), `reason`, `entity_type`+`entity_id`+`record_key`(三重关联), `components`, `method`, `valid`, `invalidated_*` | 双要素电子签名（见下） |
| `users` / `sessions` / `login_attempts` / `password_history` | 账号状态机 `pending/active/locked/disabled/expired`, `access_expires_at`(外部检查员限时), TOTP, 失败锁定, 会话绝对上限 | 访问控制与账号生命周期 |
| `documents` / `document_versions` / `documents_read` | 版本、审批、定期审核、阅知确认 | 文件控制 |
| `process_types` | `code`, `gxp_areas`, `regulation_refs`, `sla_days`, `definitions_json`, `source_file`, `active` | 配置库表（启动时从 JSON 装载） |
| `checklist_templates` / `checklist_items` | 模板 + 逐条要求（`clause_ref`, `risk_level`, `evidence_hint`） | 检查表库 |
| `inspections` / `inspection_findings` | 自查 + 逐条判定（`assessed_grade` 与 `status` 分离），`workflow_id` 联动 CAPA | 自查与就绪度 |
| `tasks` / `notifications` | 后台进程生成的待办与通知（`dedupe_key` 唯一索引保证幂等） | 后台工作流 |
| `gxp_areas` | 8 大 PV 领域登记表（从 `src/seed.js` 的 `PV_AREAS` 装载） | 领域注册 |
| `traceability` | `requirement_ref` → `control_desc` → `test_evidence` | 需求追溯矩阵（验证输入） |

## 合规内核的三个关键机制

### 1. 哈希链审计追踪（`src/core/audit.js`）

每行存储 `chain_hash = HMAC(key, prev_hash ‖ canonical(payload))`。

**为什么用 HMAC 而不是普通 SHA-256：** 密钥存在数据库之外（`data/audit-chain.key`，
首次启动自动生成，权限 `0600`）。因此即使有人拿到数据库文件、自己重算整条链，
也无法产出能通过校验的链。普通哈希链做不到这一点——攻击者可以重算。

三层防护：

| 攻击方式 | 防护 | 验证结果 |
|---|---|---|
| 直接 `UPDATE audit_trail` | SQLite 触发器 `RAISE(ABORT)` | 被拒绝 |
| 绕过触发器改数据库文件 | 遍历重算比对摘要 | 精确定位到断点 seq |
| 复制数据库重算整条链 | HMAC 密钥在库外 | 无法伪造 |

**规范化 JSON：** payload 序列化前对 key 排序、字符串做 NFKC 归一化，因此哈希
与字段顺序无关，跨平台稳定。

**历史重建：** `reconstruct(recordKey, version)` 从 `old_value`/`new_value` 的增量
反向重放，可单独从审计链重建任一历史版本——ALCOA+ "Enduring/Available" 的技术
证明。命令行入口见 `scripts/verify-audit.js`（`--record <key>`、`--seal <label>`）。

**断链冻结：** 服务器与后台进程启动时都先校验整条链；校验失败且
`PV_FREEZE_ON_CHAIN_BREAK` 未关闭时拒绝启动/运行，并按数据完整性事件给出处置
指引（保全数据、不要重建链、通知负责人）。

### 2. 双分量电子签名（`src/core/auth.js`）

21 CFR Part 11.200(a)(1)(i) 要求签名使用**至少两个不同的识别要素**。

```
分量 A：识别码（用户名）+ 密码   —— 签署时重新输入，不使用已登录会话
分量 B：TOTP 动态口令  或  服务端签发的一次性挑战码
```

**为什么不用"已登录会话 + 点击批准"：** 那只有一个分量（会话），不满足法规。

挑战码机制：`POST /api/signatures/challenge` 签发随机 nonce，TTL 120 秒，
**一次性消费**（`used_at` 标记），使用后立即失效；测试专门验证了重放攻击被拒绝。
演示数据集里的每条签名也走同一条 `auth.sign()` 路径——如果演示脚本绕过双要素，
它就在教用户一个错误的签名模型。

签名记录姓名、时间、含义（封闭枚举，防止自由文本模糊化）、理由，并通过
`entity_type`/`entity_id`/`record_key` 与记录永久关联，同时镜像到审计追踪。

### 3. 职责分离（`src/core/rbac.js` + `workflow.js` + `constraints.js`）

三道门，全部在服务端：

1. **路由权限** —— 每条路由声明 `permission`（共 46 项），无权限返回 403 并记入
   审计追踪
2. **步骤角色门** —— `step.role` 数组不含当前角色则 403
3. **独立性门** —— `independentOfAuthor: true` 的步骤拒绝记录作者本人
   （如 ICSR-EXP 的 `causality` 与 `closure` 步骤）

此外：**系统管理员不得作为安全性记录的唯一批准人**（`rbac.canSign` →
`ADMIN_CANNOT_APPROVE`）；CAPA 执行者不得自评有效性。所有"有约束"的判定集中
登记在 `src/domain/constraints.js`（20 项），是界面三态权限矩阵的数据源——
界面显示什么，内核就真会做什么。

角色清单（15 个）：`system_admin`、`pv_head`（QPPV）、`pv_officer`、
`pv_data_entry`、`pv_medical`、`pv_writer`、`pv_regulatory`、
`literature_reviewer`、`safety_committee`、`qa_manager`、`qa_specialist`、
`qa_auditor`、`trainer`、`auditor_external`（只读限时）、`viewer`（只读）。

## 就绪度评分模型（`src/domain/inspections.js`）

```
readiness_score = Σ(风险权重 × 判定权重) / Σ(风险权重) × 100
风险权重：critical = 10, major = 4, minor = 1
判定权重：compliant = 1, partial = 0.5, gap = 0,
         not_applicable / not_assessed = 不计入
```

**设计取舍：** 该分数是**排序工具，不是合规判定**。"不适用"与"未评估"不计入分母，
因此只评估了一半的检查表不会因为分母小而得到虚高分。

`readinessDashboard()` 把证据汇成带**具名阻碍项**的评分（critical 直接扣 25 分、
major 8 分、minor 2 分，100 分起扣）：

1. 未关闭的检查缺陷（critical 置顶）
2. 文件审核欠账
3. 培训过期/超期未完成
4. 设备校准超期（本构建无 PV 角色授权，维持休眠）
5. 质量/安全性记录超期
6. **审计链完整性**（失败则置顶，因为其他一切都失去意义）
7. 账号卫生（缺双要素、疑似共用姓名）

## 后台工作流进程（`src/daemon/monitor.js`）

独立子进程，与服务器共享同一 SQLite（WAL 模式，读写不互斥），默认 5 分钟一周期
（`--interval`，下限 30 秒；`--once` 单周期）。7 类扫描规则：工作流记录/步骤超期、
CAPA 缺有效性、设备校准维护、培训过期、文件审核超期、任务自动关闭、通知清理。
纪律：**只审计状态变化，从不审计扫描动作**；自动写入统一归属 `monitor`
系统 actor（`actor_id` 为空），人机事件一眼可分；`notifications.dedupe_key` 唯一
索引使重复周期完全幂等，进程可随时杀掉重启。

## 前端视图结构

**零依赖、无构建步骤。** `web/index.html` 按顺序加载脚本：`i18n.js` → `api.js` →
`ui.js` → 各 `views/*`（注册进 `window.Views` 的暂存队列）→ `app.js`（取出队列
成为正式注册表）。视图：inbox（我的待办）、explorer（领域与流程）、dashboard
（工作台）、records（安全性记录）、documents（文件控制）、inspections（自查与
就绪度）、training（培训）、audit（审计追踪）、compliance（合规态势）、users
（用户与权限）、account（我的账号）、philosophy（设计理念）。

合规模块相关的 UI 决策：

- **所有标识符、日期、哈希用等宽字体** —— 审计时可以电话里念清楚
- **颜色永不作为唯一信息载体** —— 每个色彩提示都配文字标签，黑白打印仍然可读
- **签名对话框不可用点击遮罩关闭** —— 避免误点丢弃已填写一半的签署声明
- **密码在提交后立即从 DOM 清除** —— 不在表单里残留凭证
- **凭证被拒时强制重新获取挑战码** —— 已消费的挑战码不可重试

## 桌面启动器原理（`desktop/Launcher.cs` + `desktop/NativeClient.cs` + `desktop/UiKit.cs` + `scripts/build-desktop.js`）

在受验证环境里，每一个 npm 包都需要单独的供应商评估，为此引入 Electron 只为了
一个窗口是荒谬的。本应用的桌面窗口是**原生 WinForms 应用**，完全不依赖浏览器：

1. **编译**：`node scripts/build-desktop.js` 用 .NET Framework 自带的 `csc.exe`
   现场编译三个文件：
   - `Launcher.cs` —— 入口、服务托管（发现/启动/连接 Node 服务）、托盘、自检；
   - `NativeClient.cs` —— 应用外壳（品牌顶栏、侧栏导航、视图切换）与全部视图
     （登录/领域/工作流/待办/记录/签名/审计/合规/理念）；
   - `UiKit.cs` —— 设计系统：主题色板与字体、自绘圆角卡片/按钮/徽章/导航项/
     统计块/列表行/步骤时间线等控件。
   引用 System、System.Drawing、System.Windows.Forms、System.Web.Extensions
   四个框架程序集（无 NuGet、无第三方引用）→ `dist/desktop/LeebertyPV.exe`
   （约 130 KB，内嵌蓝黑 PV 图标）。
2. **运行**：启动器先探测端口（默认 8793，`--port N` 可换）——已有实例在应答就
   直接连接；否则隐藏启动 `node src/server.js`（`CreateNoWindow`，继承
   `PV_BUILTIN_ACCOUNTS=1` 等环境）。服务就绪后由 UI 线程定时器打开原生窗口。
3. **窗口**：`NativeClient.cs` 构建一个真正的应用窗口 —— 自己的标题栏
   （“LeebertyPV · 药物警戒工作台”）、任务栏图标与托盘菜单；界面全部用 WinForms
   原生控件绘制：领域卡片、工作流程图（步骤 + 责任人 + 签名门槛 + 指引）、责任
   移交链、参与岗位权限表、待办列表、安全性记录表单、**双要素电子签名对话框**
   （密码 + 一次性挑战码）、审计追踪与合规态势。数据通过本地 REST API 读取；
   **不使用 Edge / WebView2 / 任何浏览器组件**。
4. **托盘**：蓝黑底色 PV 图标；菜单：打开工作台、生成演示数据、校验审计追踪、
   备份数据、停止并退出（停止 = 杀掉服务器进程树 + 清理端口占用者）。
5. **自检与故障自愈**：`LeebertyPV.exe --selftest` 无界面验证"发现运行时 → 启动 →
   应答 → 原生窗口冒烟渲染核心视图（含布局质检）→ 停止释放端口"。若服务器未能
   就绪（典型：data 与 audit-chain.key 不一致导致审计链完整性校验失败），启动器
   约 22 秒后弹出说明窗口并提供「重置演示实例」一键修复（损坏的 data 移到
   `data-corrupt-<时间戳>` 保留现场），无界面等效命令 `--repair-demo`——避免
   "窗口空白、无从下手"。

找不到 `csc.exe` 时构建脚本如实降级：一切命令行启动方式照常可用，只是没有桌面
窗口——桌面壳是便利设施，不是功能依赖。

## 已知取舍与不做的事

| 取舍 | 原因 |
|---|---|
| 配置库（JSON）不打进 exe | 站点需要能不重新构建就新增流程；代价是 exe 需同级 `app`/`seed` 目录 |
| 单文件 exe 由本机 csc 编译 | 无第三方组件；编译失败时如实降级为命令行启动 |
| 不做电子签名的生物特征分量 | 浏览器环境无法可靠实现；用 TOTP/挑战码满足"两个分量" |
| 不做数据库级加密 | SQLite 加密需第三方扩展，与零依赖冲突；用文件系统权限控制 |
| 单实例本地部署 | 无高可用、无集群；审计链为单写入者设计 |
| 设备/校准模块保留但不授权 | `equipment` 权限在权限目录中保留仅为让旧路由保持关闭；本构建没有任何 PV 角色持有 `equipment.*`，界面也不含设备视图 |
| 检查表库当前未预置模板 | `seed/checklists/` 为配置驱动目录，放入 JSON 模板后于下次启动加载；启动横幅如实显示数量 |

## 扩展点

| 想做什么 | 改哪里 |
|---|---|
| 新增 PV 领域 | `src/seed.js` 的 `PV_AREAS` + 新增 workflow JSON |
| 新增流程类型 | 往 `seed/workflows/` 加 JSON，重启即生效 |
| 新增法规检查表 | 往 `seed/checklists/` 加 JSON，重启即生效 |
| 新增角色 | `src/core/rbac.js` 的 `ROLES` |
| 新增代码强制约束 | `src/domain/constraints.js`（与内核实现同一处变更） |
| 调安全策略 | 界面「系统设置」页，或 `PV_` 环境变量 |
| 对接企业 SSO | `src/core/auth.js` 的 `login()`，替换为令牌校验 |
| 对接国家药品不良反应监测系统 | 用 `POST /api/records` 与 `sourceEntityType`/`sourceEntityId` 建立追溯链接；E2B(R3) 传输回执留存在 `ICSR-EXP`/`ICSR-REG` 的 `submission` 步骤表单 |