#!/usr/bin/env node
'use strict';
/**
 * 端到端更新自测 v1.6.0（双目录原子切换，仅 Windows / CI）
 *
 * 在真实文件系统上跑与生产同构的「应用内 Node 更新链」：
 *   模拟安装目录（launcher + channels.json + app-旧版/）
 *   → dualdir.installNewVersion（解压 zip → app-新版/ 就位 → 原子翻指针）
 *   → 断言：新目录就位、指针翻转、旧版保留（无破坏）
 *   → 真实 spawn 新版 exe --smoke-test（真实 Electron 自检）
 *   → 真实 spawn 根 launcher → 断言它拉起 app 目录主程序（入口链）
 *   → 回滚：翻转指针 → targetExe 指回旧版
 *
 * 对比旧版（v1.4.1 PS 链）：无 PowerShell、无 robocopy、无删除动作——
 * 任何失败都发生在「加新」阶段，install 目录旧内容必须原样保留。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const dualdir = require(path.join(ROOT, 'electron', 'lib', 'dualdir'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 失败时转储安装目录树（失败必须可见——对齐 PS 链时代 update.log 转储惯例） */
function dumpTree(dir) {
  try {
    console.error('--- install 目录树 ---');
    const walk = (d, prefix) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.statSync(p);
        console.error(`${prefix}${name}${st.isDirectory() ? '/' : ` (${st.size}B)`}`);
        if (st.isDirectory() && !name.startsWith('app-')) { /* 只下钻一层，版本目录内容太长 */ }
      }
    };
    walk(dir, '  ');
    console.error('--- end ---');
  } catch (e) { /* 转储失败不影响结论 */ }
}

/** 轮询等待条件成立（返回是否成立） */
async function waitUntil(fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(everyMs);
  }
  return fn();
}

/** spawn GUI 子系统 exe 并等退出码（node spawn 的 exit 事件对 GUI exe 同样触发） */
function runExe(exe, args) {
  return new Promise((resolve, reject) => {
    const ch = cp.spawn(exe, args, { stdio: 'ignore', cwd: path.dirname(exe) });
    const timer = setTimeout(() => { try { ch.kill(); } catch (e) { /* */ } reject(new Error(`${path.basename(exe)} 超时未退出`)); }, 240000);
    ch.on('error', (e) => { clearTimeout(timer); reject(e); });
    ch.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

/** tasklist 查某进程名是否存活 */
function processAlive(name) {
  try {
    const out = cp.execSync(`tasklist /FI "IMAGENAME eq ${name}.exe" /NH`, { encoding: 'utf8', timeout: 15000 });
    return out.toLowerCase().includes(`${name.toLowerCase()}.exe`);
  } catch (e) { return false; }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('仅 Windows 可跑（双目录链路含真实 exe/launcher）');
  const zipName = fs.readdirSync(RELEASE).find((f) => /^SnapNote-Portable-.*-win-x64\.zip$/.test(f));
  if (!zipName) throw new Error('release 下找不到便携 zip');
  const zipPath = path.join(RELEASE, zipName);

  // ---- 1) 模拟用户安装目录（= 全新解压 v1.6.0 zip 的形态）----
  const install = path.join(RELEASE, 'e2e-install');
  fs.rmSync(install, { recursive: true, force: true });
  fs.mkdirSync(path.join(install, dualdir.WORK_DIR), { recursive: true });
  cp.execSync(`tar -xf "${zipPath}" -C "${install}"`, { timeout: 120000 });
  const ch0 = dualdir.readChannels(install);
  if (!ch0 || !ch0.current) throw new Error('zip 解压后 channels.json 缺失/损坏（组装流水线回归）');
  const NEW_DIR = ch0.current; // app-<tag 版本>
  console.log('[e2e] install =', install, '| zip 版本目录 =', NEW_DIR);
  if (!fs.existsSync(path.join(install, 'SnapNote.exe'))) throw new Error('zip 根缺启动器 SnapNote.exe');
  if (!fs.existsSync(path.join(install, NEW_DIR, 'SnapNoteApp.exe'))) throw new Error('版本目录缺主程序');

  // ---- 2) 构造「旧版用户」：把新目录复制为 app-0.0.1 旧版 + 指针指向它 ----
  // （生产里 app-0.0.1 是历史版本；此处用同构副本保证 Electron 真可跑）
  const OLD_DIR = 'app-0.0.1';
  fs.cpSync(path.join(install, NEW_DIR), path.join(install, OLD_DIR), { recursive: true });
  dualdir.writeChannelsAtomic(install, { current: OLD_DIR, previous: null });
  const oldExe = path.join(install, OLD_DIR, 'SnapNoteApp.exe');

  // ---- 3) 应用内更新：zip 就位（下载产物位 = install/.update-work/update.zip）----
  fs.copyFileSync(zipPath, path.join(install, dualdir.WORK_DIR, 'update.zip'));
  const r = await dualdir.installNewVersion({
    zipPath: path.join(install, dualdir.WORK_DIR, 'update.zip'),
    appRoot: install,
    deps: { log: (m) => console.log('[e2e]', m) },
  });
  console.log('[e2e] installed:', r.dir);
  if (r.dir !== NEW_DIR) throw new Error(`就位目录不符：${r.dir} ≠ ${NEW_DIR}`);
  const ch1 = dualdir.readChannels(install);
  if (ch1.current !== NEW_DIR) throw new Error(`指针未翻：current=${ch1.current}`);
  if (ch1.previous !== OLD_DIR) throw new Error(`previous 应保留旧版：${ch1.previous}`);
  if (!fs.existsSync(oldExe)) throw new Error('旧版目录被破坏——违反无破坏性契约');
  if (fs.existsSync(path.join(install, OLD_DIR, 'SnapNoteApp.exe')) === false) throw new Error('旧版 exe 被删');

  // ---- 4) 真实跑新版 exe 冒烟（Electron 自检；--wait-lock 同参数无害）----
  const newExe = path.join(install, NEW_DIR, 'SnapNoteApp.exe');
  const code = await runExe(newExe, ['--smoke-test']);
  console.log('[e2e] smoke exit =', code);
  if (code !== 0) throw new Error(`新版 exe 冒烟失败（exit=${code}）`);

  // ---- 5) launcher 入口链：跑根 SnapNote.exe → 必须拉起 app 目录主程序 ----
  const launcher = path.join(install, 'SnapNote.exe');
  const lch = cp.spawn(launcher, [], { detached: true, stdio: 'ignore', cwd: install });
  lch.unref();
  const up = await waitUntil(() => processAlive('SnapNoteApp'), 30000);
  try { cp.execSync('taskkill /IM SnapNoteApp.exe /F /T', { stdio: 'ignore', timeout: 20000 }); } catch (e) { /* */ }
  try { cp.execSync('taskkill /IM SnapNote.exe /F /T', { stdio: 'ignore', timeout: 20000 }); } catch (e) { /* */ }
  if (!up) throw new Error('launcher 未能拉起 SnapNoteApp（入口链断）');
  console.log('[e2e] launcher → SnapNoteApp 链路 OK');

  // ---- 6) 回滚：指针翻回旧版，targetExe 指向旧目录 ----
  if (!dualdir.rollbackChannels(install)) throw new Error('回滚失败（previous 缺失？）');
  const ch2 = dualdir.readChannels(install);
  if (ch2.current !== OLD_DIR) throw new Error(`回滚后 current=${ch2.current} ≠ ${OLD_DIR}`);
  if (dualdir.targetExe(install) !== path.join(install, OLD_DIR, 'SnapNoteApp.exe')) {
    throw new Error('回滚后 targetExe 未指回旧版');
  }

  console.log('E2E_UPDATE_OK');
}

// 硬超时兜底（比 CI 步骤 timeout 更早触发，保证转储落地）
setTimeout(() => {
  console.error('E2E_UPDATE_FAIL: 硬超时 8 分钟');
  process.exit(1);
}, 480000).unref();

main().then(
  () => process.exit(0),
  (err) => {
    console.error('E2E_UPDATE_FAIL: ' + (err && err.message));
    dumpTree(path.join(RELEASE, 'e2e-install'));
    process.exit(1);
  },
);
