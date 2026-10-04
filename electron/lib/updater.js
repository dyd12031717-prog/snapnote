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
const cp = require('child_process');
const crypto = require('crypto');

const GITHUB_API = 'https://api.github.com';
const PLACEHOLDER_OWNER = '__REPLACE_ME__';

/**
 * v1.5.1 国内下载加速镜像（拼接方式：域名 + 完整 GitHub 下载 URL）。
 * 仅在官方 sha256 校验值可用时启用——镜像内容必须通过校验才被采用，
 * 校验不符自动弃用换源，最后兜底回官方直连。镜像服务是第三方公益项目，
 * 任一失效只影响速度不影响正确性。
 */
const DOWNLOAD_MIRRORS = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
];
/** 镜像源首字节超时：迟迟无数据即切换（官方源不限——慢是它的常态） */
const FIRST_BYTE_MS = 12000;

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

/** 挑出配套 .sha256 校验文件 asset（无则 null） */
function pickChecksumAsset(release) {
  const assets = (release && release.assets) || [];
  const hit = assets.find((a) => /^SnapNote-Portable.*win-x64\.zip\.sha256$/i.test(String(a && a.name)));
  return hit ? { name: hit.name, url: hit.browser_download_url } : null;
}

/** 解析 .sha256 文件内容（"hash  filename" 格式）取 hash */
function parseChecksum(text) {
  const m = String(text || '').match(/\b([0-9a-f]{64})\b/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 解析 GitHub Releases/latest 响应：
 * 返回 { hasUpdate, version, notes, asset, checksumAsset }；结构异常返回 null。
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
    checksumAsset: pickChecksumAsset(release),
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
    '  New-Item -ItemType Directory -Force -Path $extract | Out-Null',
    // v1.4.1：Windows 自带 bsdtar 解 zip，比 Expand-Archive 快数倍（CI 实测后者
    // 对 106MB 包可超 2.5 分钟，曾直接顶爆 e2e 轮询窗口）
    '  tar -xf $zipPath -C $extract',
    '  if ($LASTEXITCODE -ne 0) { throw "tar extract failed: $LASTEXITCODE" }',
    '  $src = $extract',
    '  $entries = @(Get-ChildItem -LiteralPath $src)',
    '  if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) { $src = $entries[0].FullName }',
    '  Log \'mirror files\'',
    "  robocopy \"$src\" \"$appDir\" /MIR /XF \"$exeBase.exe\" \"$exeBase.exe.old\" /NFL /NDL /NJH /NJS /NP | Out-Null",
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

/**
 * 流式下载到文件（兼容 Web stream 与 Node stream 两种 body），onProgress(done, total)。
 * v1.5.1：firstByteMs 首字节超时——连接建立后迟迟没有数据（镜像劣化/半死连接）
 * 则中止换源，避免用户对着 0% 干等。
 * v1.5.3：
 *  - offset 断点续传：换源时带上已下载字节（Range: bytes=offset-，append 写入，
 *    进度从断点继续——用户不再看到 99%→0% 回跳）；服务器忽略 Range 返回 200
 *    全量时自动降级为整文件重写。
 *  - 截断检测：结束时比对实际字节数与 Content-Length，不符即抛错——
 *    连接被"优雅"掐断时流会正常 end 但数据不全，不能等到 sha256 才发现。
 */
async function downloadToFile(url, destPath, onProgress, deps, firstByteMs, offset) {
  const off = offset && offset > 0 ? offset : 0;
  const headers = off > 0 ? { Range: `bytes=${off}-` } : undefined;
  const res = await deps.fetch(url, headers ? { headers } : undefined);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  // 服务器忽略 Range（返回 200 全量）→ 重头写；206 → 续传
  const isResume = off > 0 && res.status === 206;
  if (off > 0 && res.status !== 206 && res.status !== 200) {
    throw new Error(`续传失败 HTTP ${res.status}`);
  }
  const contentLength = Number(res.headers && res.headers.get('content-length')) || 0;
  const total = contentLength ? (isResume ? off + contentLength : contentLength) : 0;
  const Readable = require('stream').Readable;
  const body = (typeof res.body && typeof res.body.pipe === 'function')
    ? res.body
    : Readable.fromWeb(res.body);
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(destPath, isResume ? { flags: 'a' } : undefined);
    let done = isResume ? off : 0;
    let stallTimer = null;
    const armStall = (ms, msg) => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        try { body.destroy(new Error(msg)); } catch (x) { /* ignore */ }
      }, ms);
    };
    const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
    body.on('data', (chunk) => {
      if (firstByteMs) armStall(30000, '下载数据流停滞（切换下一个源）'); // 每块数据后重置停滞计时
      done += chunk.length;
      if (onProgress) onProgress(done, total);
    });
    body.on('error', (e) => {
      clearStall();
      // end()（而非 destroy）刷盘后再 reject：半截文件是续传资本；
      // 且 reject 必须等落盘完成——否则换源逻辑读到 0 字节/文件不存在
      try { ws.end(() => reject(e)); } catch (x) { reject(e); }
    });
    ws.on('error', (e) => { clearStall(); try { body.destroy(); } catch (x) {} reject(e); });
    ws.on('finish', () => { clearStall(); resolve(); });
    body.pipe(ws);
    if (firstByteMs) armStall(firstByteMs, `下载源 ${firstByteMs}ms 内无数据（切换下一个源）`);
    body.on('end', () => {
      // 截断检测：流正常结束但字节数不足（连接被优雅掐断的典型表现）
      if (total && done < total) {
        clearStall();
        try {
          ws.end(() => reject(new Error(`文件不完整：${done}/${total} 字节（断流，将断点续传）`)));
        } catch (x) {
          reject(new Error(`文件不完整：${done}/${total} 字节（断流，将断点续传）`));
        }
      }
    });
  });
  return destPath;
}

/** 文件 sha256（流式，大包不吃内存） */
async function sha256File(p) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(p);
    rs.on('data', (d) => h.update(d));
    rs.on('error', reject);
    rs.on('end', resolve);
  });
  return h.digest('hex');
}

/**
 * 多源下载 + 完整性校验（v1.5.1 国内加速 / v1.5.3 断点续传）。
 * 源顺序：有官方校验值时 [镜像1, 镜像2, ..., 官方]；无校验值时仅 [官方]
 * （不信任任何镜像提供的可执行文件——内容真伪无从核验）。
 * v1.5.3 续传策略：某源中途失败（断流/截断/停滞）时**保留已下载字节**，
 * 下一个源带 Range 从断点续传（进度连续，不再 99%→0% 回跳）；
 * 仅当 sha256 校验不符（内容被污染）或目标不存在时才整文件重来。
 * 全部源失败 → 抛最后一个错误（保留部分文件供用户重试时续传——
 * 由 download() 的 workDir 隔离，重试进程会重新开始，可接受）。
 * @returns {Promise<{path, via}>} via = 'mirror' | 'official'
 */
async function downloadVerified(origUrl, destPath, expectedSha256, onProgress, deps, log, firstByteMs) {
  const fbMs = firstByteMs != null ? firstByteMs : FIRST_BYTE_MS;
  const sources = [];
  if (expectedSha256) {
    for (const m of DOWNLOAD_MIRRORS) sources.push({ url: m + origUrl, via: 'mirror' });
  }
  sources.push({ url: origUrl, via: 'official' });
  let lastErr = null;
  let offset = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    try {
      if (log) log(`下载源 ${i + 1}/${sources.length}（${s.via}${offset > 0 ? `，断点续传 ${offset} 字节` : ''}）`);
      await downloadToFile(s.url, destPath, onProgress, deps, s.via === 'mirror' ? fbMs : 0, offset);
      if (expectedSha256) {
        const actual = await sha256File(destPath);
        if (actual !== expectedSha256) {
          try { fs.rmSync(destPath, { force: true }); } catch (e) { /* ignore */ }
          offset = 0; // 内容与官方指纹不符：续传的字节可能已被污染，整文件重来
          throw new Error(`校验失败：下载内容与官方 sha256 不符（已弃用该下载源）`);
        }
        if (log) log('sha256 校验通过');
      }
      return { path: destPath, via: s.via };
    } catch (e) {
      lastErr = e;
      if (log) log(`源失败：${e.message}`);
      // 断流/截断类失败：保留已下载部分（续传）；文件被删（校验失败）则 offset 归 0
      try {
        offset = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
        if (offset === 0 && fs.existsSync(destPath)) { /* 空文件等同从 0 */ }
      } catch (x) { offset = 0; }
    }
  }
  throw lastErr || new Error('全部下载源失败');
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
    // v1.4.1 教训（生产装配缺配导致"重启更新"静默失灵）：spawn 默认给真实的
    // child_process.spawn——main.js 忘传时不再静默短路；测试仍可注入 stub 覆盖。
    this.deps = Object.assign({ fetch, spawn: cp.spawn, log: () => {}, tmpdir: () => os.tmpdir() }, o.deps);
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
    // v1.5.1：顺带拉取官方 sha256 校验值（几十字节，走官方源不影响速度）。
    // 拉不到（旧版本 Release 无此文件/网络抖动）→ 下载时仅走官方源，安全不降级。
    this.expectedChecksum = null;
    const ca = this.lastCheck && this.lastCheck.checksumAsset;
    if (ca && ca.url) {
      try {
        const r2 = await this.deps.fetch(ca.url);
        if (r2.ok) this.expectedChecksum = parseChecksum(await r2.text());
      } catch (e) { /* 校验值拉取失败按无校验处理 */ }
    }
    return this.lastCheck;
  }

  /** 下载上次 check 得到的便携 zip 到临时目录，返回 zip 路径 */
  async download(onProgress) {
    const info = this.lastCheck;
    if (!info || !info.asset || !info.asset.url) throw new Error('没有可下载的更新');
    const workDir = path.join(this.deps.tmpdir(), `snapnote-update-${Date.now()}`);
    fs.mkdirSync(workDir, { recursive: true });
    this.zipPath = path.join(workDir, 'update.zip');
    const r = await downloadVerified(
      info.asset.url, this.zipPath, this.expectedChecksum,
      onProgress, this.deps, (m) => this.deps.log('updater:', m),
    );
    this.downloadVia = r.via; // 'mirror' | 'official'（诊断用：用户报"慢"时看走了哪个源）
    return this.zipPath;
  }

  /**
   * 写出 update.ps1 并脱离进程启动 PowerShell 执行（等待退出→解压→镜像→换 exe→重启），
   * 随后调用方应立即退出应用。@returns {boolean} 是否成功启动更新进程。
   * 契约：zipPath 必须位于独占临时目录（download() 的产物即此形态）——
   * PS 脚本最后会 Remove-Item -Recurse 整个 workDir（= zip 所在目录）。
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
  pickChecksumAsset,
  parseChecksum,
  parseRelease,
  buildUpdateScript,
  downloadToFile,
  downloadVerified,
  sha256File,
  psEscape,
  GITHUB_API,
  PLACEHOLDER_OWNER,
  DOWNLOAD_MIRRORS,
  FIRST_BYTE_MS,
};
