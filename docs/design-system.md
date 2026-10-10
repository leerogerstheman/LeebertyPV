# 共享设计系统 / Shared design system

`web/css/design-system.css` 在 **LeebertyGXP、LeebertyPV、PE-Workbench** 三个仓库中
**逐字节相同**。它不是构建产物，也没有构建步骤——它是一个手写文件，被复制了三份。

改动它之前请先读完本文，尤其是「三条硬约束」。

---

## 它是什么

一个**追加层**，在应用自己的样式表（`app.css` / `pe.css`）**之后**加载：

```html
<link rel="stylesheet" href="/css/app.css">
<link rel="stylesheet" href="/css/design-system.css">   <!-- 必须在后面 -->
```

它只做两件事：

1. **重定义应用已经在消费的 CSS 自定义属性**（`--ink`/`--panel`/`--brand`… 以及
   PE 的 `--c-ink`/`--c-panel`/`--c-brand`…）。应用样式表里凡是走变量的地方，
   自动跟随新配色。
2. **用相同或更高优先级覆盖已有选择器**，精修组件。

它**不新增任何应用未定义的类名**。这一点是硬性的：`test/assets.js` 会解析视图里
用到的每一个类，并断言它出现在 `app.css` 中。在这里新定义一个类并在视图里使用，
会让 LeebertyGXP / LeebertyPV 的测试失败。

加载顺序靠「同优先级 + 后加载者胜出」生效，因此**不能**把它挪到应用样式表之前。

---

## 三个仓库的差异如何表达

每个外壳在 `<html>` 上声明一次身份：

```html
<html lang="zh-CN" data-app="gxp">   <!-- LeebertyGXP   teal #0f766e -->
<html lang="zh-CN" data-app="pv">    <!-- LeebertyPV    teal #0f766e -->
<html lang="zh-CN" data-app="pe">    <!-- PE-Workbench  sky  #075985 -->
```

缺少该属性时回落到 teal 默认值，所以「漏写」的后果是**品牌色略偏**，而不是「整个界面没样式」。

深色模式默认跟随操作系统；外壳可以强制指定：

```html
<html data-app="gxp" data-theme="dark">    <!-- 强制深色 -->
<html data-app="gxp" data-theme="light">   <!-- 强制浅色 -->
```

`color-scheme` 会同步设置，因此 WebView2 的原生滚动条、表单控件和窗口底色会跟着走，
不会在深色界面里留一块白。

---

## 三条硬约束

### 1. 自定义属性不能引用自己

CSS 规范把「自定义属性在自身值里引用自己」判定为 **invalid**，而不是回退到旧值——
整条属性会静默消失。

所以浅色身份值放在 `--ds-brand-base` 这类**永不被重新赋值**的变量里，深色主题从它们
派生。在深色块里写下面这种是错的，品牌色会直接消失：

```css
--ds-brand: color-mix(in srgb, var(--ds-brand) 62%, #ffffff);  /* ✗ 自引用 */
```

### 2. `.main` 与 `.content` 在两个家族里是互换的

| | 有内边距的滚动区 | flex 外壳 |
|---|---|---|
| LeebertyGXP / LeebertyPV | `.main` | `.content` |
| PE-Workbench | `.content` | `.main` |

**两者都不能在这里设置 padding**，否则其中一个家族的顶栏会被一起缩进。
只有 `.view` 是安全的——PE 不使用它。

### 3. 深色块故意写了两遍

`@media (prefers-color-scheme: dark)` 和 `[data-theme="dark"]` **无法合并**成同一个
选择器列表：媒体查询不是选择器。`light-dark()` 能省掉一份，但它需要 Chromium 123+，
而这两个工作台仍保留 legacy Edge 回退路径。

在受控环境里，可预测性优先于简洁，所以两份都保留。**改一份就必须改另一份。**

---

## 同步副本

需要同步的是**两个**逐字节相同的文件：

| 文件 | 作用 |
|---|---|
| `web/css/design-system.css` | 设计系统本体 |
| `scripts/check-css.js` | 静态体检工具（零依赖 Node 脚本） |

以任意一份为准，覆盖另外两份，然后校验哈希：

```powershell
$files = @('web\css\design-system.css', 'scripts\check-css.js')
$src   = 'D:\LeebertyGXP'

foreach ($f in $files) {
  Copy-Item (Join-Path $src $f) (Join-Path 'D:\LeebertyPV'   $f) -Force
  Copy-Item (Join-Path $src $f) (Join-Path 'D:\PE-Workbench' $f) -Force
}

@('D:\LeebertyGXP','D:\LeebertyPV','D:\PE-Workbench') | ForEach-Object {
  foreach ($f in $files) {
    "{0}  {1}  {2}" -f (Get-FileHash (Join-Path $_ $f) -Algorithm SHA256).Hash.Substring(0,16), $_, $f
  }
}
# 每个文件的三行必须完全相同
```

---

## 改完之后怎么验

```powershell
# 1. 静态体检：括号配平、自定义属性是否成环、var() 是否有未定义引用
#    这一步能在打开浏览器之前就抓住最隐蔽的那类错误
node scripts/check-css.js web/css/design-system.css

# 2. 三个仓库的完整测试（GXP/PV 各约 3 分钟，PE 约 2 秒）
node test/run-all.js
```

测试套件里有 DOM 断言、类名覆盖检查和像素校验，**任何一项失败都不要继续**。
深色模式的改动尤其要跑 `test/assets.js`——它是唯一真正把页面渲染出来的套件。

---

## 已知取舍

- **`color-mix()`**：全文件只有 `--ds-ring`（聚焦光晕）依赖它，需要 Chromium 111+
  （2023 年 3 月）。缺少它时聚焦光晕消失，但边框变化、`:focus-visible` 轮廓和所有布局
  决策都还在。其余颜色全是字面量。
- **硬编码颜色**：应用样式表里有约 90 处直接写死的颜色，其中绝大多数是品牌填充上的
  `#fff`（深色下无需处理）。真正需要深色覆盖的浅色表面已在第 4c 节逐条列出，不是猜的。
- **打印**：第 11 节把主题强制回浅色。检查证据经常是黑白打印的，深色主题绝不能上纸。
