'use strict';

/**
 * Build the desktop launcher.
 *
 *   node scripts/build-desktop.js
 *   node scripts/build-desktop.js --selftest    build, then run the self-test
 *   node scripts/build-desktop.js --no-icon     skip embedding an icon
 *
 * WHY A LAUNCHER AT ALL, AND WHY C#
 * ---------------------------------
 * The application is deliberately dependency-free: in a validated environment
 * every third-party package needs its own supplier assessment (EU GMP Annex 11
 * §7.1), so the zero-dependency property is a real compliance asset. Wrapping it
 * in Electron would import hundreds of npm packages purely to obtain a window.
 *
 * Windows already provides what is needed:
 *   - the .NET Framework C# compiler (csc.exe) ships with the OS;
 *   - Edge/WebView2 is present on Windows 10/11.
 *
 * So the launcher is compiled locally from a single .cs file using the compiler
 * already on the machine, and opens the workbench in an Edge `--app` window -
 * a real chrome-less application window with its own taskbar entry. Nothing is
 * downloaded and nothing is added to package.json.
 *
 * If csc.exe is unavailable the script says so and the browser launchers remain
 * fully functional; a missing desktop shell is a convenience problem, not a
 * functional one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const config = require('../src/config');

function parseArgs(argv) {
  const args = { selftest: false, out: path.join(config.root, 'dist', 'desktop'), clean: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--selftest') args.selftest = true;
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--no-clean') args.clean = false;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function log(m) { process.stdout.write(`  ${m}\n`); }
function fail(m) { process.stderr.write(`\n  BUILD FAILED: ${m}\n\n`); process.exit(1); }

/** Locate the C# compiler that ships with .NET Framework. */
function findCsc() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write([
      '',
      '  Build the LeebertyPV desktop launcher (a single .exe, no dependencies).',
      '',
      '  Usage:',
      '    node scripts/build-desktop.js              compile the launcher',
      '    node scripts/build-desktop.js --selftest   compile, then verify it starts and stops',
      '    node scripts/build-desktop.js --out D:\\x   choose the output directory',
      '',
      '  Requires only the C# compiler shipped with the .NET Framework, which is',
      '  part of Windows. No SDK, no NuGet, no npm package.',
      '',
    ].join('\n'));
    process.exit(0);
  }

  process.stdout.write('\n  Building the desktop launcher\n');
  process.stdout.write(`  ${'='.repeat(58)}\n\n`);

  const source = path.join(config.root, 'desktop', 'Launcher.cs');
  const client = path.join(config.root, 'desktop', 'NativeClient.cs');
  const uikit = path.join(config.root, 'desktop', 'UiKit.cs');
  if (!fs.existsSync(source)) fail(`source not found: ${source}`);
  if (!fs.existsSync(client)) fail(`source not found: ${client}`);
  if (!fs.existsSync(uikit)) fail(`source not found: ${uikit}`);

  const csc = findCsc();
  if (!csc) {
    log('csc.exe     NOT FOUND');
    log('');
    log('The C# compiler that ships with the .NET Framework is unavailable, so the');
    log('desktop window cannot be built on this machine. Everything else still works:');
    log('  start.bat           starts the server and opens your default browser');
    log('  start-silent.bat    starts it hidden, opens the browser once healthy');
    log('');
    log('Install .NET Framework 4.x (a Windows component) to enable the desktop window.');
    process.exit(0);
  }
  log(`compiler    ${csc}`);

  if (args.clean && fs.existsSync(args.out)) fs.rmSync(args.out, { recursive: true, force: true });
  fs.mkdirSync(args.out, { recursive: true });

  const exePath = path.join(args.out, 'LeebertyPV.exe');

  // Referencing the WinForms and Drawing assemblies that ship with the framework.
  const iconArg = fs.existsSync(path.join(config.root, 'desktop', 'icon.ico'))
    ? [`/win32icon:${path.join(config.root, 'desktop', 'icon.ico')}`] : [];
  const compile = spawnSync(csc, [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    '/platform:anycpu',
    '/langversion:5',
    `/out:${exePath}`,
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Web.Extensions.dll',
    ...iconArg,
    source,
    client,
    uikit,
  ], { encoding: 'utf8' });

  if (compile.status !== 0) {
    process.stderr.write(String(compile.stdout || ''));
    process.stderr.write(String(compile.stderr || ''));
    fail('compilation failed (see the compiler output above)');
  }
  if (compile.stdout && compile.stdout.trim()) {
    for (const line of compile.stdout.trim().split('\n')) log(`csc: ${line.trim()}`);
  }

  const size = fs.statSync(exePath).size;
  log(`output      ${exePath}`);
  log(`size        ${(size / 1024).toFixed(0)} KB`);
  log(`deps        none (WinForms from the .NET Framework)`);

  // A README beside the exe so the folder is self-explanatory.
  fs.writeFileSync(path.join(args.out, '使用说明.txt'), [
    'LeebertyPV - 桌面启动器',
    'LeebertyPV - desktop launcher',
    '',
    '用法 / Usage:',
    '  1. 把本 exe 复制到包含 src\\ 、web\\ 、seed\\ 的目录下（即项目根目录）。',
    '     Copy this exe into the folder that contains src\\, web\\ and seed\\.',
    '  2. 双击运行。托盘会出现蓝黑底色的 PV 图标，工作台在独立的原生窗口中打开。',
    '     Double-click it. A blue-black PV icon appears in the notification area and',
    '     the workbench opens in its own native window (no browser involved).',
    '  3. 程序会在独立的原生窗口中打开工作台（WinForms 控件渲染，不依赖浏览器）。',
    '     The workbench opens in its own native window (WinForms controls, no browser).',
    '',
    '托盘菜单 / Tray menu:',
    '  打开工作台        重新打开窗口',
    '  在浏览器中打开    用默认浏览器打开同一实例',
    '  生成演示数据      生成完整的虚构药厂场景',
    '  校验审计追踪      核对哈希链完整性',
    '  备份数据          备份数据库与审计链密钥',
    '  停止并退出        停止服务与后台工作流进程',
    '',
    '可选参数 / Optional:',
    '  LeebertyPV.exe --port 8793    换端口',
    '  LeebertyPV.exe --selftest     无界面自检（验证启动与停止）',
    '',
    '说明 / Notes:',
    '  * 本 exe 由 Windows 自带的 C# 编译器现场编译，不依赖任何第三方组件。',
    '    Compiled by the C# compiler shipped with Windows. No third-party components.',
    '  * 窗口为原生 WinForms 应用，不依赖 Edge / WebView2 / 任何浏览器组件。',
    '    The window is a native WinForms application; no Edge / WebView2 / browser needed.',
    '  * 数据仍在 data\\ 目录，与命令行启动完全一致。',
    '    Data still lives in data\\, identical to the command-line launchers.',
    '',
  ].join('\r\n'), 'utf8');
  log('readme      written');

  if (args.selftest) {
    log('');
    log('running the launcher self-test…');
    const test = spawnSync(exePath, ['--root', config.root, '--selftest'], { encoding: 'utf8' });
    process.stdout.write(String(test.stdout || ''));
    if (test.stderr && test.stderr.trim()) process.stderr.write(String(test.stderr));
    if (test.status !== 0) fail(`launcher self-test failed (exit ${test.status})`);
  }

  process.stdout.write('\n');
  log('Copy LeebertyPV.exe to the project root (beside start.bat) and double-click it.');
  process.stdout.write('\n');
}

main();
