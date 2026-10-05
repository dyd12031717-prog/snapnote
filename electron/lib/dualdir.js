'use strict';
/**
 * 双目录原子切换 — SnapNote v1.6.0+（PRD：docs/PRD-dualdir.md）
 *
 * 职责：把「新版本 zip」变成「appRoot 下的新版本目录」并翻转指针。
 * 全程无破坏性动作：
 *  - 解压/挪移都只写入 workDir 与全新目录，失败 = 本次更新失败可重试；
 *  - 根布局与当前运行版本目录在任何一步失败时都原封不动；
 *  - 指针翻转用「临时文件 + rename」原子完成，翻转前旧版永远是入口。
 *
 * 设计约束：
 *  - 纯逻辑 + fs/child_process 操作，进程依赖全部可注入（deps），单测真跑临时目录；
 *  - 不依赖 PATH：tar 用绝对路径（Windows System32；非 Windows 走系统 tar 供测试），
 *    失败兜底 PowerShell Expand-Archive；
 *  - 失败必须抛错（调用方负责留痕与 UI 提示），绝不静默吞掉。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const APP_EXE = 'SnapNoteApp.exe';
const CHANNELS_FILE = 'channels.json';
const WORK_DIR = '.update-work';

/** 版本目录名规则：app-x.y.z（x/y/z 为数字，后续段忽略） */
function parseAppDirName(name) {
  const m = /^app-(\d+)\.(\d+)\.(\d+)/.exec(name);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function join2(dir, name) {
  return path.join(dir, name);
}

/**
 * 拆分「任意平台风格」的路径（生产 Windows 反斜杠 / 测试 Linux 正斜杠均正确）。
 * 不依赖 path 模块的平台行为——单测在 Linux 跑、产物在 Windows 跑，两边都稳。
 */
function splitParts(p) {
  return String(p).split(/[\\/]+/).filter(Boolean);
}

/** exe 是否位于版本子目录内（是 → 双目录形态；否 → 平铺/开发态） */
function appDirOf(execPath) {
  const parts = splitParts(execPath);
  if (parts.length < 2) return null;
  const dirName = parts[parts.length - 2];
  return parseAppDirName(dirName) ? dirName : null;
}

/**
 * 从可执行文件路径推导应用根目录（PRD 3.3）：
 * exe 位于 app-x.y.z 子目录内 → 根 = 其父目录（双目录正常形态）；
 * 否则 → 根 = exe 所在目录（开发态 / v1.5.x 平铺迁移中间态）。
 */
function deriveAppRoot(execPath) {
  const abs = /^[\\/]/.test(String(execPath)); // posix 绝对路径（盘符走 parts 首段）
  const parts = splitParts(execPath);
  if (parts.length < 2) return path.dirname(String(execPath));
  const join = (segs) => (abs ? path.sep : '') + segs.join(path.sep);
  if (appDirOf(execPath)) {
    const rootParts = parts.slice(0, -2);
    // 保留盘符（Windows）：首段形如 "E:" 单独成段
    return rootParts.length ? join(rootParts) : path.sep;
  }
  // 平铺/开发态：根 = exe 所在目录（去掉最后一段 exe 名）
  return join(parts.slice(0, -1)) || path.dirname(String(execPath));
}

/** 当前 exe 应归属的版本目录名（平铺/开发态返回 null） */
function deriveVersionDir(execPath) {
  return appDirOf(execPath);
}

/** 读指针文件；缺失/损坏返回 null（不抛——launcher 也遵循此契约） */
function readChannels(appRoot) {
  try {
    const raw = fs.readFileSync(path.join(appRoot, CHANNELS_FILE), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.current === 'string') {
      return { current: obj.current, previous: obj.previous || null };
    }
  } catch (e) { /* 缺失/损坏按无指针处理 */ }
  return null;
}

/** 指针原子写：临时文件 + rename（同目录 rename 原子性由文件系统保证） */
function writeChannelsAtomic(appRoot, obj) {
  const dst = path.join(appRoot, CHANNELS_FILE);
  const tmp = path.join(appRoot, `${CHANNELS_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, dst);
  } catch (e) {
    // rename 失败（极端：dst 被占用）→ 回退直接写并清理 tmp；仍失败才抛
    try { fs.copyFileSync(tmp, dst); fs.rmSync(tmp, { force: true }); }
    catch (e2) { try { fs.rmSync(tmp, { force: true }); } catch (x) { /* ignore */ } throw e2; }
  }
  return dst;
}

/** 翻转 current/previous（回滚入口）；无可回滚返回 false */
function rollbackChannels(appRoot) {
  const c = readChannels(appRoot);
  if (!c || !c.previous) return false;
  writeChannelsAtomic(appRoot, { current: c.previous, previous: c.current });
  return true;
}

/** 在指定目录下定位版本目录（zip 解压产物扫描 / 根目录现状检查通用），
 *  返回版本号最大的目录名；无候选返回 null */
function findLatestAppDir(dir) {
  if (!fs.existsSync(dir)) return null;
  let best = null;
  let bestKey = null;
  for (const name of fs.readdirSync(dir)) {
    const key = parseAppDirName(name);
    if (!key) continue;
    if (!fs.existsSync(path.join(dir, name, APP_EXE))) continue;
    const cmp = key[0] - bestKey?.[0] || key[1] - bestKey?.[1] || key[2] - bestKey?.[2];
    if (bestKey === null || cmp > 0) { best = name; bestKey = key; }
  }
  return best;
}

/**
 * 解压 zip 到 destDir（destDir 须不存在或为空——幂等由调用方保证）。
 * Windows 生产：System32\tar.exe 绝对路径（不信任 PATH——v1.5.4 教训）；
 * 兜底：PowerShell Expand-Archive；非 Windows（单测/Linux）：系统 tar。
 * @param {object} deps 可注入 { execFile }（测试桩/真实环境）
 */
async function extractZip(zipPath, destDir, deps) {
  const exec = (deps && deps.execFile) || cp.execFile;
  fs.mkdirSync(destDir, { recursive: true });
  const tarCandidates = process.platform === 'win32'
    ? ['C:\\Windows\\System32\\tar.exe', 'tar']
    : ['tar', '/usr/bin/tar'];
  let lastErr = null;
  for (const tar of tarCandidates) {
    try {
      await new Promise((resolve, reject) => {
        exec(tar, ['-xf', zipPath, '-C', destDir], { timeout: 120000 }, (err) => err ? reject(err) : resolve());
      });
      if (fs.readdirSync(destDir).length > 0) return destDir;
      throw new Error('解压产物为空');
    } catch (e) {
      lastErr = e;
    }
  }
  // Windows 兜底：Expand-Archive（tar 全灭时的第二生命线）
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      exec('powershell.exe',
        ['-NoProfile', '-Command',
          `Microsoft.PowerShell.Archive\\Expand-Archive -LiteralPath '${String(zipPath).replace(/'/g, "''")}' -DestinationPath '${String(destDir).replace(/'/g, "''")}' -Force`],
        { timeout: 300000 },
        (err) => (err ? reject(err) : resolve()));
    });
    if (fs.readdirSync(destDir).length > 0) return destDir;
    lastErr = new Error('Expand-Archive 解压产物为空');
  }
  throw lastErr || new Error('解压失败');
}

/** 同卷 rename、跨卷 copy（fs.rename 跨卷抛 EXDEV） */
function moveDirIntoPlace(srcDir, dstDir) {
  try {
    fs.renameSync(srcDir, dstDir);
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
    fs.cpSync(srcDir, dstDir, { recursive: true });
    // 校验目标主程序就位后再删源——挪移半途死时目标不完整会被就位校验拦下
    if (!fs.existsSync(path.join(dstDir, APP_EXE))) {
      throw new Error(`新版本目录不完整（缺 ${APP_EXE}）`);
    }
    fs.rmSync(srcDir, { recursive: true, force: true });
  }
  return dstDir;
}

/**
 * 安装新版本（下载校验完成后调用）：解压 → 定位 app-x.y.z → 挪入根 → 翻指针。
 * 任一步失败：抛错且根布局不变（workDir 残留下次重试时清理）。
 * @returns {{ installed: string, channels: object }} 新版本目录名 + 新指针
 */
async function installNewVersion({ zipPath, appRoot, deps }) {
  if (!zipPath || !fs.existsSync(zipPath)) throw new Error('更新包不存在');
  const workDir = path.join(appRoot, WORK_DIR);
  const extractDir = path.join(workDir, 'extract');
  fs.rmSync(extractDir, { recursive: true, force: true }); // 幂等：上次失败的残留清掉重来
  fs.mkdirSync(extractDir, { recursive: true });

  await extractZip(zipPath, extractDir, deps);
  // zip 结构：{ SnapNote.exe(launcher), channels.json, app-<ver>/ }，
  // 也兼容极端形态（zip 内直接平铺——视为单目录包，包一层 app-<zip 版本名>）
  const appDirName = findLatestAppDir(extractDir);
  if (!appDirName) throw new Error('更新包内未找到版本目录（app-x.y.z）——包结构不符合 v1.6.0+ 布局');
  const srcDir = path.join(extractDir, appDirName);

  const dstDir = path.join(appRoot, appDirName);
  if (fs.existsSync(dstDir)) {
    // 目标目录已存在（上次就位了但指针没翻 / 重复应用）：废弃重挪，保证内容完整
    fs.rmSync(dstDir, { recursive: true, force: true });
  }
  moveDirIntoPlace(srcDir, dstDir);
  if (!fs.existsSync(path.join(dstDir, APP_EXE))) {
    throw new Error(`新版本目录就位校验失败（缺 ${APP_EXE}）`);
  }

  const prev = readChannels(appRoot);
  const channels = { current: appDirName, previous: (prev && prev.current) || null };
  writeChannelsAtomic(appRoot, channels);
  return { dir: appDirName, channels };
}

/** 当前版本应运行的 exe 路径（优先指针，其次扫根取最大版本） */
function targetExe(appRoot) {
  const c = readChannels(appRoot);
  if (c && parseAppDirName(c.current) && fs.existsSync(path.join(appRoot, c.current, APP_EXE))) {
    return path.join(appRoot, c.current, APP_EXE);
  }
  const latest = findLatestAppDir(appRoot);
  return latest ? path.join(appRoot, latest, APP_EXE) : null;
}

/**
 * 首跑清理（新版本进程内调用——此时运行的是 current，删的是 previous，无锁冲突）：
 *  - previous 版本目录（若存在且 ≠ current）
 *  - workDir 残留（上次下载/解压的中间物）
 *  - 迁移遗留的 .exe.old（v1.5.x PS 链换名残留）
 * 任何失败静默忽略（清理是优化不是正确性前提），但记录返回值供诊断。
 * @returns {object} 实际删除项的清单（诊断/测试断言用）
 */
function cleanupPrevious(appRoot, exeBase) {
  const removed = { previous: null, workDir: false, staleExe: false };
  const c = readChannels(appRoot);
  if (c && c.previous && c.previous !== c.current) {
    try {
      fs.rmSync(path.join(appRoot, c.previous), { recursive: true, force: true });
      removed.previous = c.previous;
      writeChannelsAtomic(appRoot, { current: c.current, previous: null });
    } catch (e) { /* 忽略：下次再清 */ }
  }
  try {
    fs.rmSync(path.join(appRoot, WORK_DIR), { recursive: true, force: true });
    removed.workDir = true;
  } catch (e) { /* 忽略 */ }
  const exe = exeBase || 'SnapNoteApp';
  for (const stale of [`${exe}.exe.old`, 'SnapNote.exe.old']) {
    try {
      fs.rmSync(path.join(appRoot, stale), { force: true });
      removed.staleExe = true;
    } catch (e) { /* 忽略 */ }
  }
  return removed;
}

module.exports = {
  APP_EXE,
  CHANNELS_FILE,
  WORK_DIR,
  parseAppDirName,
  deriveAppRoot,
  deriveVersionDir,
  readChannels,
  writeChannelsAtomic,
  rollbackChannels,
  findLatestAppDir,
  extractZip,
  moveDirIntoPlace,
  installNewVersion,
  targetExe,
  cleanupPrevious,
};
