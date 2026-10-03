'use strict';

/**
 * Build a distributable Windows package.
 *
 *   node scripts/build-exe.js
 *   node scripts/build-exe.js --single-exe      (also try to produce one .exe)
 *   node scripts/build-exe.js --out D:\dist
 *
 * Two outputs are possible, and the script is honest about which one you get:
 *
 *  1. PORTABLE FOLDER (always produced)
 *     `dist/LeebertyPV/` containing the Node runtime, the application, the
 *     configuration library and launchers. Copy the folder to any Windows
 *     machine and double-click. No installer, no admin rights, no network.
 *     This is what a validated site should deploy: the runtime is version-pinned
 *     and auditable, and the whole package can be hashed as one artefact.
 *
 *  2. SINGLE .EXE (only when the Node SEA tooling can be obtained)
 *     Node's Single Executable Application support needs the `postject` package
 *     to inject the blob into the binary. If it is not available offline the
 *     script says so and leaves you with the portable folder rather than
 *     producing a broken executable. Set PV_ALLOW_NPM=1 to permit fetching it.
 *
 * The build records a manifest with SHA-256 hashes so the artefact can be
 * released under change control (EU GMP Annex 11 §4.4 supplier/artefact control).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const config = require('../src/config');

function parseArgs(argv) {
  const args = { out: path.join(config.root, 'dist'), singleExe: false, clean: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--single-exe') args.singleExe = true;
    else if (a === '--no-clean') args.clean = false;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function log(message) { process.stdout.write(`  ${message}\n`); }
function fail(message) { process.stderr.write(`\n  BUILD FAILED: ${message}\n\n`); process.exit(1); }

function copyDir(src, dest, filter) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (filter && !filter(s, entry)) continue;
    if (entry.isDirectory()) count += copyDir(s, d, filter);
    else { fs.copyFileSync(s, d); count += 1; }
  }
  return count;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function findNodeBinary() {
  // process.execPath is the runtime currently running this script, which is
  // exactly the runtime the package should ship with.
  if (process.execPath && fs.existsSync(process.execPath)) return process.execPath;
  fail('cannot locate the Node executable to bundle');
  return null;
}

function writeLaunchers(target, exeName) {
  fs.writeFileSync(path.join(target, '启动-LeebertyPV.bat'), `@echo off
chcp 65001 >nul 2>&1
title LeebertyPV
cd /d "%~dp0"
set "PV_PORT=8793"
if not "%~1"=="" set "PV_PORT=%~1"

echo.
echo   LeebertyPV
echo   ------------------------------------------
echo   数据保存在 data 文件夹，审计追踪密钥为 data\\audit-chain.key。
echo   Data lives in the data folder; the audit key is data\\audit-chain.key.
echo   请整体备份 data 文件夹 —— 缺少密钥的备份无法校验审计追踪。
echo   Back up the whole data folder: without the key the chain cannot be verified.
echo.
echo   原生应用窗口会自动打开（LeebertyPV.exe，不依赖浏览器）；关闭本窗口即停止服务。
echo   The native app window opens automatically (LeebertyPV.exe, no browser
echo   needed); closing this window stops the service.
echo.

if exist "%~dp0app\\LeebertyPV.exe" start "" /min "%~dp0app\\LeebertyPV.exe" --port %PV_PORT% >nul 2>&1

"%~dp0node\\node.exe" "%~dp0app\\src\\server.js"

if errorlevel 1 (
  echo.
  echo   [错误] 服务异常退出，代码 %ERRORLEVEL%。
  echo   [ERROR] The server exited with code %ERRORLEVEL%.
  if "%ERRORLEVEL%"=="2" (
    echo.
    echo   审计追踪完整性校验失败。请勿反复重启：先保全数据，再联系系统负责人。
    echo   Audit trail integrity failure. Do NOT restart repeatedly: preserve the
    echo   data folder and contact the system owner.
  )
)
pause
`, 'utf8');

  fs.writeFileSync(path.join(target, '启动-LeebertyPV-静默.bat'), `@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set "PV_PORT=8793"
if not "%~1"=="" set "PV_PORT=%~1"
if not exist "logs" mkdir "logs"
start "LeebertyPV" /min cmd /c ""%~dp0node\\node.exe" "%~dp0app\\src\\server.js" >> "%~dp0logs\\server.log" 2>&1"
timeout /t 6 /nobreak >nul 2>&1
if exist "%~dp0app\\LeebertyPV.exe" (
  start "" "%~dp0app\\LeebertyPV.exe" --port %PV_PORT% >nul 2>&1
) else (
  start "" "http://127.0.0.1:%PV_PORT%"
)
exit /b 0
`, 'utf8');

  fs.writeFileSync(path.join(target, '备份数据.bat'), `@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo 正在备份数据 / Backing up data...
"%~dp0node\\node.exe" "%~dp0app\\scripts\\backup.js" %*
echo.
echo 备份完成后请运行校验 / After backing up, verify with:
echo   "%~dp0node\\node.exe" "%~dp0app\\scripts\\backup.js" --verify-only ^<备份目录^>\\manifest.json
pause
`, 'utf8');

  fs.writeFileSync(path.join(target, '校验审计追踪.bat'), `@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
"%~dp0node\\node.exe" "%~dp0app\\scripts\\verify-audit.js" %*
pause
`, 'utf8');
}

function buildPortable(args) {
  const target = path.join(args.out, 'LeebertyPV');
  if (args.clean && fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  // --- runtime -------------------------------------------------------------
  const nodeBinary = findNodeBinary();
  const nodeDir = path.join(target, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.copyFileSync(nodeBinary, path.join(nodeDir, 'node.exe'));
  log(`runtime         node.exe (${(fs.statSync(path.join(nodeDir, 'node.exe')).size / 1048576).toFixed(0)} MB) from ${nodeBinary}`);

  // --- application ---------------------------------------------------------
  const appDir = path.join(target, 'app');
  const fileCount = copyDir(config.root, appDir, (fullPath, entry) => {
    const rel = path.relative(config.root, fullPath).replace(/\\/g, '/');
    // Never ship data, backups, exports, dist or VCS metadata.
    if (/^(data|backups|exports|dist|\.git|node_modules)(\/|$)/.test(rel)) return false;
    if (entry.isFile() && /\.(log|db|db-wal|db-shm|key)$/.test(rel)) return false;
    return true;
  });
  log(`application     ${fileCount} file(s)`);

  // --- empty runtime folders so first start works --------------------------
  for (const dir of ['data', 'backups', 'exports', 'logs']) {
    fs.mkdirSync(path.join(appDir, dir), { recursive: true });
    fs.writeFileSync(path.join(appDir, dir, '.gitkeep'), '');
  }

  writeLaunchers(target, 'node\\node.exe');

  // --- readme --------------------------------------------------------------
  fs.writeFileSync(path.join(target, '使用说明-README.txt'), `LeebertyPV
版本 / Version: ${config.app.version}
构建时间 / Built: ${new Date().toISOString()}
Node 运行时 / Bundled runtime: ${process.version}

============================================================
 快速开始 / Quick start
============================================================

1. 双击「启动-LeebertyPV.bat」。
   原生应用窗口会自动打开（LeebertyPV.exe，WinForms 窗口，不依赖浏览器）。
   也可用浏览器访问 http://127.0.0.1:8793 。
   首次使用会要求创建第一个管理员账号。

   Double-click 启动-LeebertyPV.bat. The native app window opens automatically
   (LeebertyPV.exe, a WinForms window - no browser needed). The web UI remains
   available at http://127.0.0.1:8793. The first run asks you to create the
   first administrator account.

2. 换端口：启动-LeebertyPV.bat 8793
   Different port: 启动-LeebertyPV.bat 8793

============================================================
 重要：数据与备份 / Data and backup
============================================================

所有数据都在 app\\data 文件夹内：
  pv.db            业务数据与审计追踪
  audit-chain.key   审计追踪哈希链密钥

  * audit-chain.key 必须与 pv.db 一同备份。
    密钥丢失或与数据库不匹配，审计追踪将永远无法校验。

  * 双击「备份数据.bat」执行备份；生产环境建议每日自动执行，
    并定期做一次恢复演练（21 CFR Part 11.10(c) / EU GMP Annex 11 §7.2）。

All data lives in app\\data:
  pv.db            business records and the audit trail
  audit-chain.key   the audit trail hash chain key

  * audit-chain.key must be backed up together with pv.db. If the key is lost
    or does not match the database, the audit trail can never be verified again.

  * Run 备份数据.bat to back up. In production, schedule it daily and rehearse a
    restore periodically.

============================================================
 网络与共享使用 / Network use
============================================================

默认仅监听本机（127.0.0.1），其他人无法访问。
如需车间/实验室共享，设置环境变量后启动：

  set PV_HOST=0.0.0.0
  启动-LeebertyPV.bat

共享使用时请在前面配置 HTTPS 反向代理，并确认符合贵司的
计算机化系统与网络安全要求。

By default the service listens on localhost only. To share it on a LAN, set
PV_HOST=0.0.0.0 before launching, and terminate TLS in front of it.

============================================================
 合规提示 / Compliance notes
============================================================

本软件是辅助工具，不替代质量体系、不替代人员培训、也不替代
法规要求的验证活动。投入 GxP 使用前，请按贵司的计算机化系统
验证程序完成评估，至少包括：

  * 用户需求说明 (URS) 与基于风险的验证范围
  * 安装与运行确认 (IQ/OQ)，并保留签署记录
  * 权限与职责分离的确认（含本系统管理员不作唯一批准人）
  * 备份与恢复演练记录
  * 用户培训记录（含数据完整性培训）

本系统的「合规态势」页面逐条列出了 21 CFR Part 11 / EU GMP
Annex 11 对应的控制措施与现状证据，可直接作为验证文件的输入。

This software is an aid. It does not replace your quality system, personnel
training, or the validation activities your regulations require.

============================================================
 默认端口与账号 / Ports and accounts
============================================================

端口 / Port: 8793（可用第一个参数修改）
无默认账号：首次启动时由你创建第一个管理员。
  No default account: you create the first administrator on first start.

界面语言可在右上角切换中文 / English。
Language can be toggled in the top-right corner.
`, 'utf8');

  return target;
}

/**
 * Attempt a true single-file executable. Returns the produced path or null with
 * an explanation; never leaves a half-built artefact behind.
 */
function trySingleExe(target, args) {
  log('');
  log('single .exe    attempting Node SEA packaging');

  const seaConfigPath = path.join(args.out, 'sea-config.json');
  const blobPath = path.join(args.out, 'sea-prep.blob');
  const entry = path.join(target, 'app', 'src', 'server.js');

  fs.writeFileSync(seaConfigPath, JSON.stringify({
    main: entry,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    // The web assets and the configuration library are read from disk at
    // runtime, so they stay external. That keeps the definition library
    // editable by the site, which is a deliberate design choice.
    assets: {},
  }, null, 2), 'utf8');

  const nodeBinary = path.join(target, 'node', 'node.exe');
  const gen = spawnSync(nodeBinary, ['--experimental-sea-config', seaConfigPath], { encoding: 'utf8' });
  if (gen.status !== 0 || !fs.existsSync(blobPath)) {
    log(`               skipped: could not generate the SEA blob${gen.stderr ? ` (${String(gen.stderr).split('\n')[0]})` : ''}`);
    log('               the portable folder is complete and usable without it');
    return null;
  }

  const exePath = path.join(target, 'LeebertyPV.exe');
  fs.copyFileSync(nodeBinary, exePath);

  // postject is required to inject the blob. It is an npm package, so a fully
  // offline build cannot use it - say so plainly rather than shipping a broken exe.
  let postjectAvailable = false;
  try {
    require.resolve('postject');
    postjectAvailable = true;
  } catch { postjectAvailable = false; }

  if (!postjectAvailable && process.env.PV_ALLOW_NPM === '1') {
    log('               fetching postject (PV_ALLOW_NPM=1)');
    const install = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-save', '--no-audit', '--no-fund', 'postject'],
      { cwd: config.root, encoding: 'utf8', shell: process.platform === 'win32' });
    if (install.status === 0) postjectAvailable = true;
    else log(`               npm install failed: ${String(install.stderr || '').split('\n')[0]}`);
  }

  if (!postjectAvailable) {
    fs.rmSync(exePath, { force: true });
    log('               skipped: the "postject" tool is not available offline');
    log('               run with PV_ALLOW_NPM=1 to fetch it, or use the portable folder');
    return null;
  }

  const inject = spawnSync(process.execPath, [
    require.resolve('postject/dist/cli.js'),
    exePath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ], { encoding: 'utf8' });

  if (inject.status !== 0) {
    fs.rmSync(exePath, { force: true });
    log(`               injection failed: ${String(inject.stderr || '').split('\n')[0]}`);
    return null;
  }

  log(`               produced ${path.relative(args.out, exePath)}`);
  log('               note: this exe still needs the sibling "app" and "seed" folders,');
  log('               because the checklist and workflow definitions are intentionally');
  log('               kept as editable JSON files rather than baked in.');
  return exePath;
}

function writeManifest(target, outDir, singleExe) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({
        path: path.relative(target, full).replace(/\\/g, '/'),
        sizeBytes: fs.statSync(full).size,
        sha256: sha256(full),
      });
    }
  };
  walk(target);

  const manifest = {
    artefact: 'LeebertyPV portable package',
    appVersion: config.app.version,
    schemaVersion: config.app.schemaVersion,
    builtAt: new Date().toISOString(),
    builtOn: `${os.platform()} ${os.release()} ${os.arch()}`,
    hostNode: process.version,
    bundledRuntime: path.join('node', 'node.exe'),
    singleExe: singleExe ? path.basename(singleExe) : null,
    fileCount: files.length,
    totalBytes: files.reduce((a, b) => a + b.sizeBytes, 0),
    files,
    releaseNotes: [
      'Zero third-party runtime dependencies: the app requires only the bundled Node runtime.',
      'The configuration library (seed/) stays editable so the site can add GxP areas and',
      'workflow definitions without a code change.',
      'Before GxP use, complete your own computerised system validation: URS, risk-based',
      'scope, IQ/OQ, access review, backup and restore rehearsal, and user training.',
    ],
  };
  const manifestPath = path.join(outDir, 'BUILD-MANIFEST.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write([
      '',
      '  Build a distributable GxP Workbench package.',
      '',
      '  Usage:',
      '    node scripts/build-exe.js                    -> dist/LeebertyPV/ (portable)',
      '    node scripts/build-exe.js --single-exe       also attempt one .exe',
      '    node scripts/build-exe.js --out D:\\release    choose the output directory',
      '    node scripts/build-exe.js --no-clean         keep an existing output folder',
      '',
      '  Environment:',
      '    PV_ALLOW_NPM=1   permit fetching "postject" to build a single .exe',
      '',
    ].join('\n'));
    process.exit(0);
  }

  process.stdout.write('\n  Building the LeebertyPV distribution package\n');
  process.stdout.write(`  ${'='.repeat(58)}\n\n`);

  fs.mkdirSync(args.out, { recursive: true });
  const target = buildPortable(args);
  const singleExe = args.singleExe ? trySingleExe(target, args) : null;

  const manifest = writeManifest(target, args.out, singleExe);

  process.stdout.write('\n');
  log(`output          ${target}`);
  log(`files           ${manifest.fileCount}`);
  log(`total size      ${(manifest.totalBytes / 1048576).toFixed(1)} MB`);
  log(`manifest        ${path.join(args.out, 'BUILD-MANIFEST.json')}`);
  log('');
  log('To distribute: copy the whole LeebertyPV folder. Recipients double-click');
  log('启动-LeebertyPV.bat - no installer, no admin rights, no network access needed.');
  log('');
  log('The BUILD-MANIFEST.json carries a SHA-256 per file so the artefact can be');
  log('released under change control.');
  process.stdout.write('\n');
}

if (require.main === module) main();
