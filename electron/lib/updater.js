'use strict';
/**
 * 便携版自动更新器 — SnapNote v1.1.0+
 *
 * 链路：GitHub Releases latest → 比较版本 → 下载便携 zip →
 *       PowerShell 脱离进程执行（等待退出 → 解压 → robocopy 镜像 → exe 两步换名 → 重启）
 *
 * 设计约束：
 *  - 纯逻辑（版本比较 / Release 解析 / PS 脚本生成）无副作用，单测可全覆盖；
 *  - 网络（fetch）与进程（spawn）通过构造参数注入，测试无需真实 GitHub；
 *  - 用户数据存于 userData（AppData），程序目录镜像替换不会触碰数据。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const GITHUB_API = 'https://api.github.com';
const PLACEHOLDER_OWNER = '__REPLACE_ME__';

/** PS 单引号字符串转义：' → '' */
function psEscape(s) {
  return String(s).replace(/'/g, "''");
}

/** 宽松版本比较（v 前缀可选，数字段逐位比）：a<b 返回 -1，相等 0，a>b 返回 1 */
function compareVersions(a, b) {
  const norm = (v) => String(v).trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 从 Release 的 assets 中挑出便携版 zip：{ name, url, size } 或 null */
function pickAsset(release) {
  const assets = (release && release.assets) || [];
  const hit = assets.find((a) => /^SnapNote-Portable.*win-x64\.zip$/i.test(String(a && a.name)));
  if (!hit) return null;
  return { name: hit.name, url: hit.browser_download_url, size: hit.size || 0 };
}

/**
 * 解析 GitHub Releases/latest 响应：
 * 返回 { hasUpdate, version, notes, asset }；结构异常返回 null。
 */
function parseRelease(release, currentVersion) {
  if (!release || !release.tag_name) return null;
  const version = String(release.tag_name).replace(/^v/i, '');
  const asset = pickAsset(release);
  return {
    hasUpdate: !!asset && compareVersions(currentVersion, version) < 0,
    version,
    notes: String(release.body || '').slice(0, 600),
    asset,
  };
}

/**
 * 生成脱机更新 PowerShell 脚本。
 * 关键点：
 *  1) 先等旧进程退出（运行中的 exe 不能被覆盖写入，但可重命名）；
 *  2) robocopy /MIR 镜像新目录到程序目录（排除 exe 本体，单独换名）；
 *  3) exe 两步换名：旧 exe → .old，新 exe 覆盖原名；残留 .old 由新进程启动时清理；
 *  4) zip 顶层可能多一层目录（SnapNote/），自动检测降层。
 */
function buildUpdateScript({ exeBase, appDir, zipPath, workDir }) {
  return [
    '$ErrorActionPreference = \'Stop\'',
    `$exeBase = '${psEscape(exeBase)}'`,
    `$appDir  = '${psEscape(appDir)}'`,
    `$zipPath = '${psEscape(zipPath)}'`,
    `$workDir = '${psEscape(workDir)}'`,
    "$extract = Join-Path $workDir 'extract'",
    "$logFile = Join-Path $workDir 'update.log'",
    'function Log($m) { Add-Content -LiteralPath $logFile -Value "$((Get-Date).ToString(\'s\')) $m" }',
    'try {',
    '  Log \'waiting app exit\'',
    '  $deadline = (Get-Date).AddSeconds(20)',
    '  while ((Get-Date) -lt $deadline) {',
    '    if (-not (Get-Process -Name $exeBase -ErrorAction SilentlyContinue)) { break }',
    '    Start-Sleep -Milliseconds 400',
    '  }',
    '  Log \'extract\'',
    '  if (Test-Path -LiteralPath $extract) { Remove-Item -Recurse -Force -LiteralPath $extract }',
    '  New-Item -ItemType Directory -Force -Path $workDir | Out-Null',
    '  Expand-Archive -LiteralPath $zipPath -DestinationPath $extract -Force',
    '  $src = $extract',
    '  $entries = @(Get-ChildItem -LiteralPath $src)',
    '  if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $src = $entries[0].FullName }',
    '  Log \'mirror files\'',
    "  robocopy $src $appDir /MIR /XF \"$exeBase.exe\" \"$exeBase.exe.old\" /NFL /NDL /NJH /NJS /NP | Out-Null",
    '  if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }',
    '  Log \'swap exe\'',
    '  $exe = Join-Path $appDir "$exeBase.exe"',
    '  $old = Join-Path $appDir "$exeBase.exe.old"',
    '  if (Test-Path -LiteralPath $old) { Remove-Item -Force -LiteralPath $old -ErrorAction SilentlyContinue }',
    '  if (Test-Path -LiteralPath $exe) { Move-Item -Force -LiteralPath $exe $old }',
    '  Copy-Item -Force -LiteralPath (Join-Path $src "$exeBase.exe") $exe',
    '  Log \'restart\'',
    '  Start-Process -FilePath $exe -WorkingDirectory $appDir',
    '  Start-Sleep -Seconds 2',
    '  Remove-Item -Recurse -Force -LiteralPath $workDir -ErrorAction SilentlyContinue',
    '  Log \'done\'',
    '} catch {',
    '  Log "ERROR: $($_.Exception.Message)"',
    '  exit 1',
    '}',
  ].join('\n');
}

/** 流式下载到文件（兼容 Web stream 与 Node stream 两种 body），onProgress(done, total) */
async function downloadToFile(url, destPath, onProgress, deps) {
  const res = await deps.fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers && res.headers.get('content-length')) || 0;
  const Readable = require('stream').Readable;
  const body = (typeof res.body && typeof res.body.pipe === 'function')
    ? res.body
    : Readable.fromWeb(res.body);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath);
    let done = 0;
    body.on('data', (chunk) => {
      done += chunk.length;
      if (onProgress) onProgress(done, total);
    });
    body.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    body.pipe(ws);
  });
  return destPath;
}

class Updater {
  /**
   * @param {object} o
   * @param {string} o.owner           GitHub 用户名（占位符表示未配置）
   * @param {string} o.repo            仓库名
   * @param {string} o.currentVersion  当前版本
   * @param {string} o.appDir          便携程序目录（exe 所在目录）
   * @param {string} o.exeBase         主进程名（不含 .exe）
   * @param {object} [o.deps]          依赖注入：{ fetch, spawn, log, tmpdir }
   */
  constructor(o) {
    this.owner = o.owner;
    this.repo = o.repo;
    this.currentVersion = o.currentVersion;
    this.appDir = o.appDir;
    this.exeBase = o.exeBase;
    this.deps = Object.assign({ fetch, spawn: null, log: () => {}, tmpdir: () => os.tmpdir() }, o.deps);
    this.state = 'idle';          // idle | has-update | downloading | ready | error
    this.lastCheck = null;        // parseRelease 结果
    this.zipPath = null;          // 已下载的 zip
  }

  /** owner 未配置（占位符）时禁用更新 */
  get enabled() {
    return !!this.owner && this.owner !== PLACEHOLDER_OWNER && !!this.repo;
  }

  /** 清理上次更新残留的旧 exe */
  cleanupStale() {
    try {
      fs.rmSync(path.join(this.appDir, `${this.exeBase}.exe.old`), { force: true });
    } catch (e) { /* 忽略 */ }
  }

  /** 查询 GitHub Releases/latest（未启用/无更新时返回 null） */
  async check() {
    if (!this.enabled) return null;
    const url = `${GITHUB_API}/repos/${this.owner}/${this.repo}/releases/latest`;
    const res = await this.deps.fetch(url, {
      headers: { 'User-Agent': 'SnapNote-Updater', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`更新检查失败 HTTP ${res.status}`);
    this.lastCheck = parseRelease(await res.json(), this.currentVersion);
    return this.lastCheck;
  }

  /** 下载上次 check 得到的便携 zip 到临时目录，返回 zip 路径 */
  async download(onProgress) {
    const info = this.lastCheck;
    if (!info || !info.asset || !info.asset.url) throw new Error('没有可下载的更新');
    const workDir = path.join(this.deps.tmpdir(), `snapnote-update-${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });
    this.zipPath = path.join(workDir, 'update.zip');
    await downloadToFile(info.asset.url, this.zipPath, onProgress, this.deps);
    return this.zipPath;
  }

  /**
   * 写出 PS 脚本并脱离进程启动，随后调用方应立即退出应用。
   * @returns {boolean} 是否成功启动更新进程
   */
  applyAndRestart() {
    if (!this.zipPath) return false;
    const workDir = path.dirname(this.zipPath);
    const ps1 = path.join(workDir, 'update.ps1');
    const script = buildUpdateScript({
      exeBase: this.exeBase,
      appDir: this.appDir,
      zipPath: this.zipPath,
      workDir,
    });
    fs.writeFileSync(ps1, script, 'utf8');
    this.deps.log('updater: launch powershell', ps1);
    if (!this.deps.spawn) return false;
    const child = this.deps.spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return true;
  }
}

module.exports = {
  Updater,
  compareVersions,
  pickAsset,
  parseRelease,
  buildUpdateScript,
  downloadToFile,
  psEscape,
  GITHUB_API,
  PLACEHOLDER_OWNER,
};
