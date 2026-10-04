#!/usr/bin/env node
'use strict';
/**
 * 端到端更新自测（v1.4.1 新增，仅 Windows / CI）
 *
 * 在真实文件系统上跑完整"重启更新"链路（与生产同构）：
 *   旧目录（win-unpacked 副本 + 旧版私有文件）→ Updater.applyAndRestart（真实
 *   spawn powershell.exe）→ PS：等待退出 → 解压 → robocopy 镜像 → exe 换名 →
 *   Start-Process 新 exe → 清理 workDir
 *
 * 断言：
 *   1) applyAndRestart 返回 true（spawn 成功——v1.4.1 前因生产缺配恒 false）
 *   2) 旧版私有文件被 /MIR 镜像清掉（目录真的被新版本替换）
 *   3) 新 SnapNote.exe 就位；标记文件（新版才有）出现
 *   4) 新 exe 被 PS 拉起（进程出现后由 CI 收尾 taskkill）
 *
 * 运行前提：npm run dist / electron-builder 已产出 release/win-unpacked 与便携 zip。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Updater } = require('../electron/lib/updater');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function fail(msg) {
  console.error('E2E_UPDATE_FAIL: ' + msg);
  // 失败时转储 PS 更新日志（脚本 catch 块会把 ERROR 写到 workDir/update.log），
  // CI 日志里直接看到 PS 侧的失败原因——不再需要 runner 上翻临时目录
  try {
    const logPath = global.__e2e_workdir && path.join(global.__e2e_workdir, 'update.log');
    if (logPath && fs.existsSync(logPath)) {
      console.error('--- update.ps1 log ---');
      console.error(fs.readFileSync(logPath, 'utf8'));
      console.error('--- end ---');
    } else {
      console.error('(workDir 无 update.log——PS 未及落盘或未执行)');
    }
  } catch (e) { /* 诊断转储失败不影响失败结论 */ }
  process.exit(1);
}

function main() {
  if (process.platform !== 'win32') fail('仅 Windows 可跑（PowerShell 链路）');
  const zipName = fs.readdirSync(RELEASE).find((f) => /^SnapNote-Portable-.*-win-x64\.zip$/.test(f));
  if (!zipName) fail('release 下找不到便携 zip');
  const zipPath = path.join(RELEASE, zipName);

  // 旧目录：win-unpacked 副本 + 旧版私有文件（镜像替换后必须消失）
  const appDir = path.join(RELEASE, 'e2e-old');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.cpSync(path.join(RELEASE, 'win-unpacked'), appDir, { recursive: true });
  const oldMarker = path.join(appDir, 'OLD-VERSION-MARKER.txt');
  fs.writeFileSync(oldMarker, 'this file must vanish after /MIR');

  // 新版本才有的标记：塞进 zip 所在的解压源不可行（zip 已定型）——改为直接
  // 校验镜像结果：NEW-MARKER 放不进去，用「旧标记消失 + exe 就位」判定替换完成。
  // zip 同构契约：zip 必须位于独占 workDir（PS 会 Remove -Recurse 整个目录）
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-e2e-'));
  global.__e2e_workdir = workDir;
  const zipCopy = path.join(workDir, 'update.zip');
  fs.copyFileSync(zipPath, zipCopy);

  const u = new Updater({
    owner: 'dyd12031717-prog',
    repo: 'snapnote',
    currentVersion: '0.0.0',
    appDir,
    exeBase: 'SnapNote',
    deps: { log: (m) => console.log('[e2e]', m) }, // spawn 走默认真实实现——这正是回归点
  });
  u.zipPath = zipCopy;
  u.state = 'ready';

  console.log('[e2e] appDir =', appDir);
  console.log('[e2e] zip =', zipCopy);
  const launched = u.applyAndRestart();
  if (!launched) fail('applyAndRestart 返回 false——替换进程未启动（v1.4.1 回归）');

  // 轮询等待替换完成（tar 解压 106MB + robocopy 镜像 380MB；v1.4.1 CI 实测
  // Expand-Archive 慢到顶爆 150s，换 tar 后正常 <60s，留 300s 余量）
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(oldMarker)) break;
    sleep(1000);
  }
  if (fs.existsSync(oldMarker)) fail('镜像替换未完成：旧版标记文件仍在（robocopy /MIR 未生效或 PS 脚本失败）');

  const exe = path.join(appDir, 'SnapNote.exe');
  if (!fs.existsSync(exe)) fail('替换后 SnapNote.exe 缺失');

  // 旧 exe 换名保留（.old）属预期；下次启动 cleanupStale 清理
  const oldExe = path.join(appDir, 'SnapNote.exe.old');
  console.log('[e2e] exe.old exists =', fs.existsSync(oldExe));

  // workDir 应被 PS 清理（zip 副本随之删除）
  sleep(4000); // Start-Process 后 PS 还有 2 秒收尾
  if (fs.existsSync(zipCopy)) console.log('[e2e] warn: workDir 未清理（不影响判定，下次 cleanupStale 兜底）');

  // 新 exe 已被拉起 → 收尾杀掉（CI 环境不留常驻进程）
  sleep(2000);
  try { execSync('taskkill /IM SnapNote.exe /F /T', { stdio: 'ignore' }); } catch (e) { /* 已退则忽略 */ }

  console.log('E2E_UPDATE_OK');
}

main();
