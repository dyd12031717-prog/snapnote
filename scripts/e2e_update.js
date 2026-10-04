#!/usr/bin/env node
'use strict';
/**
 * 端到端更新自测（v1.4.1 新增，仅 Windows / CI）
 *
 * 在真实文件系统上跑完整"重启更新"链路（与生产同构）：
 *   旧目录（win-unpacked 副本 + 旧版私有文件）→ Updater.applyAndRestart（真实
 *   spawn powershell.exe）→ PS：等待退出 → tar 解压 → robocopy 镜像 → exe 换名 →
 *   Start-Process 新 exe → 清理 workDir
 *
 * 断言：
 *   1) applyAndRestart 返回 true（spawn 成功——v1.4.1 前因生产缺配恒 false）
 *   2) 旧版私有文件被 /MIR 镜像清掉（目录真的被新版本替换）
 *   3) 新 SnapNote.exe 就位（旧 exe 换名 .old 保留属预期）
 *
 * 可靠性设计（CI 实战教训）：
 *   - 轮询用事件循环 setTimeout（主线程 Atomics.wait 在 runner 上曾观测到挂起）
 *   - 成功/失败/硬超时三路都显式 process.exit——Windows 下 detached 子进程
 *     句柄可能令 node 自然退出失灵，绝不赌事件循环清空
 *   - 失败时自动转储 workDir/update.log（PS catch 的 ERROR 直接进 CI 日志）
 *
 * 运行前提：electron-builder 已产出 release/win-unpacked 与便携 zip。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { Updater } = require('../electron/lib/updater');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
let workDir = null; // 失败转储 update.log 用

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dumpLog() {
  try {
    const logPath = workDir && path.join(workDir, 'update.log');
    if (logPath && fs.existsSync(logPath)) {
      console.error('--- update.ps1 log ---');
      console.error(fs.readFileSync(logPath, 'utf8'));
      console.error('--- end ---');
    } else {
      console.error('(workDir 无 update.log——PS 未及落盘或未执行)');
    }
  } catch (e) { /* 诊断转储失败不影响结论 */ }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('仅 Windows 可跑（PowerShell 链路）');
  const zipName = fs.readdirSync(RELEASE).find((f) => /^SnapNote-Portable-.*-win-x64\.zip$/.test(f));
  if (!zipName) throw new Error('release 下找不到便携 zip');
  const zipPath = path.join(RELEASE, zipName);

  // 旧目录：win-unpacked 副本 + 旧版私有文件（镜像替换后必须消失）
  const appDir = path.join(RELEASE, 'e2e-old');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.cpSync(path.join(RELEASE, 'win-unpacked'), appDir, { recursive: true });
  const oldMarker = path.join(appDir, 'OLD-VERSION-MARKER.txt');
  fs.writeFileSync(oldMarker, 'this file must vanish after /MIR');

  // zip 必须位于独占 workDir（PS 末尾 Remove -Recurse 整个目录——release 绝不能当 workDir）
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-e2e-'));
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
  if (!launched) throw new Error('applyAndRestart 返回 false——替换进程未启动（v1.4.1 回归）');

  // 轮询等待替换完成（tar 解压 106MB + robocopy 镜像；留 300s 余量）
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(oldMarker)) break;
    await sleep(1000);
  }
  if (fs.existsSync(oldMarker)) throw new Error('镜像替换未完成：旧版标记文件仍在（robocopy /MIR 未生效或 PS 脚本失败）');

  const exe = path.join(appDir, 'SnapNote.exe');
  if (!fs.existsSync(exe)) throw new Error('替换后 SnapNote.exe 缺失');

  // 旧 exe 换名保留（.old）属预期；下次启动 cleanupStale 清理
  console.log('[e2e] exe.old exists =', fs.existsSync(path.join(appDir, 'SnapNote.exe.old')));

  // workDir 应被 PS 清理（zip 副本随之删除）
  await sleep(6000); // Start-Process 后 PS 还有 2 秒收尾
  if (fs.existsSync(zipCopy)) console.log('[e2e] warn: workDir 未清理（不影响判定，下次 cleanupStale 兜底）');

  // 新 exe 已被拉起 → 收尾杀掉（CI 环境不留常驻进程）
  try { execSync('taskkill /IM SnapNote.exe /F /T', { stdio: 'ignore' }); } catch (e) { /* 已退则忽略 */ }

  console.log('E2E_UPDATE_OK');
}

// 硬超时兜底（比 CI 步骤 timeout 更早触发，保证日志/转储完整落地）
setTimeout(() => {
  console.error('E2E_UPDATE_FAIL: 硬超时 6 分钟（替换链未在时限内完成）');
  dumpLog();
  process.exit(1);
}, 360000).unref();

main().then(
  () => process.exit(0), // 显式退出：Windows detached 子进程句柄可能挂住自然退出
  (err) => {
    console.error('E2E_UPDATE_FAIL: ' + (err && err.message));
    dumpLog();
    process.exit(1);
  },
);
