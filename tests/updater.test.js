'use strict';
/** 自动更新器单测：全流程 mock，不触真实网络与进程。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  Updater, compareVersions, pickAsset, pickChecksumAsset, parseChecksum, parseRelease,
  buildUpdateScript, downloadToFile, downloadVerified, sha256File, psEscape,
  PLACEHOLDER_OWNER, DOWNLOAD_MIRRORS,
} = require('../electron/lib/updater');

const crypto = require('crypto');
function sha256buf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

/** mock fetch：按 URL 前缀/精确匹配返回不同 body。
 *  路由标记：body='STALL'（挂起流）；truncate:true（只发前半，模拟优雅断流）；
 *  range:true（读取请求 Range 头返回剩余部分 + 206，模拟断点续传服务）；
 *  status:206（无 Range 请求也回 206，异常场景）。
 *  calls 保持 URL 字符串数组（兼容旧断言），callsFull 额外记录请求头。
 */
function mockFetch(routes) {
  const calls = [];
  const callsFull = [];
  const fn = async (url, opts) => {
    calls.push(String(url));
    callsFull.push({ url: String(url), headers: (opts && opts.headers) || null });
    const hit = routes.find((r) => (r.match === 'exact' ? r.url === url : String(url).startsWith(r.url)));
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, body: Readable.from([]) };
    if (hit.body === 'STALL') { // 永不吐数据的挂起流（测首字节超时）
      return { ok: true, status: 200, headers: { get: () => '100' }, body: new Readable({ read() { /* 不 push，挂着 */ } }) };
    }
    const raw = typeof hit.body === 'string' ? Buffer.from(hit.body) : hit.body;
    if (hit.truncate) { // 优雅断流：只给前一半，Content-Length 仍报完整长度
      const half = raw.subarray(0, Math.floor(raw.length / 2));
      return {
        ok: true, status: 200,
        headers: { get: (k) => (k === 'content-length' ? String(raw.length) : null) },
        body: Readable.from([half]),
      };
    }
    if (hit.range) { // 断点续传服务：读 Range 头返回 206 + 剩余字节
      const m = /bytes=(\d+)-/.exec(String((opts && opts.headers && opts.headers.Range) || ''));
      const start = m ? Number(m[1]) : 0;
      const rest = raw.subarray(Math.min(start, raw.length));
      return {
        ok: true, status: 206,
        headers: { get: (k) => (k === 'content-length' ? String(rest.length) : null) },
        body: Readable.from([rest]),
        text: async () => rest.toString(),
        json: async () => JSON.parse(rest.toString()),
      };
    }
    const body = raw;
    return {
      ok: true, status: hit.status || 200,
      headers: { get: (k) => (k === 'content-length' ? String(body.length) : null) },
      body: Readable.from([body]),
      text: async () => body.toString(),
      json: async () => JSON.parse(body.toString()),
    };
  };
  fn.calls = calls;
  fn.callsFull = callsFull;
  return fn;
}

// ------------------------------------------------------------ 版本比较
test('compareVersions：基本语义', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);   // v 前缀
  assert.equal(compareVersions('1.9', '1.10'), -1);      // 数值比较非字典序
  assert.equal(compareVersions('1.2', '1.2.0'), 0);      // 缺位补 0
});

// ------------------------------------------------------------ 资产挑选
const RELEASE = {
  tag_name: 'v1.2.0',
  body: '修复若干问题',
  assets: [
    { name: 'SnapNote-Setup-1.2.0.exe', browser_download_url: 'u1', size: 1 },
    { name: 'SnapNote-Portable-1.2.0-win-x64.zip', browser_download_url: 'u2', size: 999 },
    { name: 'SnapNote-Portable-1.2.0-win-x64.zip.sha256', browser_download_url: 'u2s', size: 95 },
    { name: 'latest.yml', browser_download_url: 'u3', size: 2 },
  ],
};

test('pickAsset：挑中便携 zip 资产', () => {
  const a = pickAsset(RELEASE);
  assert.equal(a.name, 'SnapNote-Portable-1.2.0-win-x64.zip');
  assert.equal(a.url, 'u2');
  assert.equal(a.size, 999);
});

test('pickChecksumAsset / parseChecksum：识别 sha256 资产并解析内容', () => {
  const c = pickChecksumAsset(RELEASE);
  assert.equal(c.name, 'SnapNote-Portable-1.2.0-win-x64.zip.sha256');
  const h = sha256buf('hello');
  assert.equal(parseChecksum(h + '  SnapNote-Portable-1.2.0-win-x64.zip'), h);
  assert.equal(parseChecksum('no-hash-here'), null);
  assert.equal(pickChecksumAsset({ assets: [{ name: 'x.zip' }] }), null);
});

test('pickAsset：无匹配返回 null', () => {
  assert.equal(pickAsset({ assets: [{ name: 'x.exe' }] }), null);
  assert.equal(pickAsset(null), null);
});

// ------------------------------------------------------------ Release 解析
test('parseRelease：远端更新 / 已最新 / 无资产', () => {
  assert.equal(parseRelease(RELEASE, '1.0.0').hasUpdate, true);
  assert.equal(parseRelease(RELEASE, '1.2.0').hasUpdate, false);
  assert.equal(parseRelease(RELEASE, '1.3.0').hasUpdate, false);
  const noAsset = parseRelease({ tag_name: 'v2.0.0', assets: [] }, '1.0.0');
  assert.equal(noAsset.hasUpdate, false); // 无便携资产时不可更新
  assert.equal(parseRelease(null, '1.0.0'), null);
});

// ------------------------------------------------------------ PS 脚本生成
test('buildUpdateScript：含关键步骤且路径转义', () => {
  const s = buildUpdateScript({
    exeBase: 'SnapNote',
    appDir: "C:\\Tools\\Snap Note's",
    zipPath: 'C:\\temp\\update.zip',
    workDir: 'C:\\temp\\w1',
  });
  assert.match(s, /Expand-Archive/); // v1.5.5：tar 失败兜底保留
  assert.match(s, /System32\\tar\.exe/); // v1.5.5：系统 tar 绝对路径（防 Git GNU tar 抢 PATH）
  assert.match(s, /robocopy "\$src" "\$appDir" \/MIR/); // v1.4.1：路径含空格时参数须整体引用
  assert.match(s, /\/XF "\$exeBase\.exe"/);
  assert.match(s, /Get-Process -Name \$exeBase/);
  assert.match(s, /Start-Process -FilePath "\$exe"/);
  assert.match(s, /update-error\.log/); // v1.5.5：失败留痕写到程序目录
  assert.match(s, /Snap Note''s/); // 单引号 PS 转义
  assert.doesNotMatch(s, /__undefined__/);
});

test('psEscape：单引号翻倍', () => {
  assert.equal(psEscape("a'b"), "a''b");
  assert.equal(psEscape('plain'), 'plain');
});

// ------------------------------------------------------------ 下载（mock fetch + Node stream）
function mockFetchFor(bodyChunks, headers) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (headers || {})[k] },
    body: Readable.from(bodyChunks.map((c) => Buffer.from(c))),
  });
}

test('downloadToFile：落盘内容与进度回调', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-t-'));
  const dest = path.join(dir, 'a.zip');
  const progress = [];
  await downloadToFile('http://x/a.zip', dest, (done, total) => progress.push([done, total]), {
    fetch: mockFetchFor(['hello', ' world'], { 'content-length': '11' }),
  });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'hello world');
  assert.equal(progress[progress.length - 1][0], 11);
  assert.equal(progress[progress.length - 1][1], 11);
});

// ------------------------------------------------------------ Updater 类（注入 deps）
function makeUpdater(overrides) {
  return new Updater(Object.assign({
    owner: 'alice',
    repo: 'snapnote',
    currentVersion: '1.0.0',
    appDir: 'C:\\Apps\\SnapNote',
    exeBase: 'SnapNote',
    deps: {
      fetch: async (url) => {
        if (url.includes('/releases/latest')) {
          return { ok: true, status: 200, json: async () => RELEASE };
        }
        return { ok: false, status: 404, headers: { get: () => null } };
      },
      spawn: () => ({ unref() {} }),
      log: () => {},
      tmpdir: () => os.tmpdir(),
    },
  }, overrides));
}

test('Updater.enabled：占位符/空 owner 禁用', () => {
  assert.equal(makeUpdater({ owner: 'alice' }).enabled, true);
  assert.equal(makeUpdater({ owner: PLACEHOLDER_OWNER }).enabled, false);
  assert.equal(makeUpdater({ owner: undefined }).enabled, false);
});

test('Updater.check：发现新版本并解析资产', async () => {
  const u = makeUpdater();
  const info = await u.check();
  assert.equal(info.hasUpdate, true);
  assert.equal(info.version, '1.2.0');
  assert.equal(info.asset.url, 'u2');
});

test('Updater.check：HTTP 非 200 抛错', async () => {
  const u = makeUpdater();
  u.deps.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => u.check(), /500/);
});

test('Updater.download：写 zip 到临时目录', async () => {
  const u = makeUpdater();
  u.deps.fetch = async (url) => {
    if (url.includes('/releases/latest')) {
      return { ok: true, status: 200, json: async () => RELEASE };
    }
    return { ok: true, status: 200, headers: { get: () => '9' }, body: Readable.from([Buffer.from('zip-bytes')]) };
  };
  await u.check();
  const zip = await u.download();
  assert.equal(fs.readFileSync(zip, 'utf8'), 'zip-bytes');
  assert.match(zip, /snapnote-update-\d+[/\\]update\.zip$/);
});

test('Updater.applyAndRestart：写脚本并 spawn powershell', () => {
  const u = makeUpdater();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-apply-'));
  u.zipPath = path.join(dir, 'update.zip');
  fs.writeFileSync(u.zipPath, 'x');
  let spawned = null;
  u.deps.spawn = (cmd, args, opts) => {
    spawned = { cmd, args, opts };
    return { unref() {} };
  };
  const ok = u.applyAndRestart();
  assert.equal(ok, true);
  assert.equal(spawned.cmd, 'powershell.exe');
  assert.deepEqual(spawned.args.slice(0, 3), ['-NoProfile', '-ExecutionPolicy', 'Bypass']);
  assert.equal(spawned.args[4], path.join(dir, 'update.ps1'));
  assert.equal(spawned.opts.detached, true);
  const script = fs.readFileSync(path.join(dir, 'update.ps1'), 'utf8');
  assert.match(script, new RegExp(u.appDir.replace(/\\/g, '\\\\')));
  assert.match(script, /System32\\tar\.exe/); // v1.5.5：系统 tar 绝对路径（防 Git GNU tar 抢 PATH）
});

test('Updater.applyAndRestart：未下载时返回 false', () => {
  const u = makeUpdater();
  assert.equal(u.applyAndRestart(), false);
});

// ------------------------------------------------------------ 装配完备性（v1.4.1 回归）
// 历史 bug：main.js 构造 Updater 只传了 log，deps.spawn 缺失默认 null →
// applyAndRestart 恒 false → "重启并更新"点击后无声失灵（不退出、不更新、不报错）。
// 单测曾全绿，因为 makeUpdater 恒注入 spawn stub——生产装配从未被覆盖。
test('装配完备性：deps 未传 spawn 时默认注入真实 child_process.spawn', () => {
  const u = new Updater({
    owner: 'alice',
    repo: 'snapnote',
    currentVersion: '1.0.0',
    appDir: 'C:\\Apps\\SnapNote',
    exeBase: 'SnapNote',
    deps: { log: () => {} }, // 模拟 main.js 的最小注入
  });
  assert.equal(typeof u.deps.spawn, 'function', '默认 spawn 应可用（生产缺配防护）');
  // zipPath 未设置时仍返回 false，但原因不再是"缺 spawn"（spawn 已具备）
  assert.equal(u.applyAndRestart(), false);
});

test('Updater.cleanupStale：删除残留 .old（不存在也不报错）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-stale-'));
  const u = makeUpdater({ appDir: dir });
  fs.writeFileSync(path.join(dir, 'SnapNote.exe.old'), 'x');
  u.cleanupStale();
  assert.equal(fs.existsSync(path.join(dir, 'SnapNote.exe.old')), false);
  u.cleanupStale(); // 再跑一次不应抛错
});

// ------------------------------------------------------------ 多源下载 + 校验（v1.5.1）
const ORIG = 'https://github.com/o/r/releases/download/v1.2.0/SnapNote-Portable-1.2.0-win-x64.zip';

function tmpDest() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-')), 'update.zip');
}

test('downloadVerified：镜像命中且校验通过 → 走 mirror，不碰官方源', async () => {
  const content = Buffer.from('便携包内容-镜像版');
  const fetch = mockFetch([{ url: 'https://gh-proxy.com/', body: content }]);
  const dest = tmpDest();
  const r = await downloadVerified(ORIG, dest, sha256buf(content), null, { fetch }, null, 100);
  assert.equal(r.via, 'mirror');
  assert.equal(fetch.calls.length, 1, '镜像成功就不该再碰官方源');
  assert.equal(fs.readFileSync(dest).toString(), content.toString());
});

test('downloadVerified：镜像内容被篡改（hash 不符）→ 弃用并回退官方源', async () => {
  const good = Buffer.from('官方真包');
  const bad = Buffer.from('镜像投毒包');
  const fetch = mockFetch([
    { url: 'https://gh-proxy.com/', body: bad },
    { url: ORIG, match: 'exact', body: good },
  ]);
  const dest = tmpDest();
  const r = await downloadVerified(ORIG, dest, sha256buf(good), null, { fetch }, null, 100);
  assert.equal(r.via, 'official', '校验不符必须回退官方');
  assert.ok(fetch.calls[0].startsWith('https://gh-proxy.com/'));
  assert.equal(fetch.calls[fetch.calls.length - 1], ORIG);
  assert.equal(fs.readFileSync(dest).toString(), good.toString());
});

test('downloadVerified：无校验值 → 只走官方源（不信任镜像的可执行文件）', async () => {
  const good = Buffer.from('官方包');
  const fetch = mockFetch([{ url: ORIG, match: 'exact', body: good }]);
  const dest = tmpDest();
  const r = await downloadVerified(ORIG, dest, null, null, { fetch }, null, 100);
  assert.equal(r.via, 'official');
  assert.deepEqual(fetch.calls, [ORIG], '无校验时绝不能请求镜像域名');
});

test('downloadVerified：镜像首字节超时 → 切下一个源', async () => {
  const good = Buffer.from('官方包');
  const fetch = mockFetch([
    { url: 'https://gh-proxy.com/', body: 'STALL' },   // 第一个镜像挂死
    { url: 'https://ghfast.top/', body: good },        // 第二个镜像正常
  ]);
  const dest = tmpDest();
  const t0 = Date.now();
  const r = await downloadVerified(ORIG, dest, sha256buf(good), null, { fetch }, null, 120);
  assert.equal(r.via, 'mirror');
  assert.equal(fetch.calls.length, 2);
  assert.ok(Date.now() - t0 < 2000, '超时应快速触发而非久等');
});

test('downloadVerified：全部源失败 → 抛出最后错误', async () => {
  const fetch = mockFetch([]); // 全 404
  const dest = tmpDest();
  await assert.rejects(
    () => downloadVerified(ORIG, dest, sha256buf('x'), null, { fetch }, null, 100),
    /HTTP 404|全部下载源/,
  );
});

test('sha256File：流式计算与 crypto 一致', async () => {
  const buf = Buffer.alloc(1024 * 512, 7); // 512KB 模拟分块读取
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')), 'x.bin');
  fs.writeFileSync(p, buf);
  assert.equal(await sha256File(p), sha256buf(buf));
});

test('Updater check→download 全链路：拉官方校验值 + 镜像下载 + 校验通过', async () => {
  const zip = Buffer.from('新版本包内容');
  const sha = sha256buf(zip);
  const fetch = mockFetch([
    { url: 'https://api.github.com/', body: JSON.stringify({
      tag_name: 'v1.2.0', body: '', assets: [
        { name: 'SnapNote-Portable-1.2.0-win-x64.zip', browser_download_url: ORIG, size: zip.length },
        { name: 'SnapNote-Portable-1.2.0-win-x64.zip.sha256', browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/c.sha256' },
      ],
    }) },
    { url: 'https://github.com/o/r/releases/download/v1.2.0/c.sha256', match: 'exact', body: sha + '  x.zip' },
    { url: 'https://gh-proxy.com/' + ORIG, match: 'exact', body: zip },
  ]);
  const u = new Updater({
    owner: 'o', repo: 'r', currentVersion: '1.0.0',
    appDir: fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')), exeBase: 'S',
    deps: { fetch, log: () => {} },
  });
  const info = await u.check();
  assert.ok(info.hasUpdate);
  assert.equal(u.expectedChecksum, sha);
  const p = await u.download();
  assert.equal(u.downloadVia, 'mirror', '有校验值时优先镜像');
  assert.equal(fs.readFileSync(p).toString(), zip.toString());
  assert.ok(!fetch.calls.includes(ORIG), '镜像成功则官方源零请求');
});

// ------------------------------------------------------------ 断点续传（v1.5.3）
test('downloadVerified：镜像 99% 断流 → 下一源 Range 续传拼接完整（进度不回 0）', async () => {
  const full = Buffer.alloc(4096, 9);
  const fetch = mockFetch([
    { url: 'https://gh-proxy.com/', body: full, truncate: true },  // 镜像1：下到一半优雅断流
    { url: 'https://ghfast.top/', body: full, range: true },       // 镜像2：支持续传
  ]);
  const dest = tmpDest();
  const progress = [];
  const r = await downloadVerified(ORIG, dest, sha256buf(full),
    (done, total) => progress.push([done, total]), { fetch }, null, 100);
  assert.equal(r.via, 'mirror');
  assert.equal(fs.readFileSync(dest).length, full.length, '拼接后完整');
  assert.equal(await sha256File(dest), sha256buf(full), '整文件校验通过（不同源拼接由 sha256 把关）');
  // 续传请求带 Range 且起点 = 断流时已写字节（一半）
  const resumeCall = fetch.callsFull.find(c => c.url.startsWith('https://ghfast.top/'));
  const half = Math.floor(full.length / 2);
  assert.equal(resumeCall.headers.Range, `bytes=${half}-`, '续传请求从断点开始');
  // 进度单调不减（核心 UX：不再 99%→0% 回跳）
  let max = 0;
  for (const [done] of progress) { assert.ok(done >= max, '进度单调不减'); max = Math.max(max, done); }
  assert.equal(max, full.length);
});

test('downloadToFile：截断检测——流正常结束但字节数不足必须抛错', async () => {
  const full = Buffer.from('0123456789ABCDEF');
  const fetch = mockFetch([{ url: ORIG, match: 'exact', body: full, truncate: true }]);
  const dest = tmpDest();
  await assert.rejects(
    () => downloadToFile(ORIG, dest, null, { fetch }, null, 0),
    /文件不完整/,
  );
  assert.equal(fs.statSync(dest).size, 8, '半个文件保留在盘上（供续传）');
});

test('downloadVerified：镜像断流 + 下一源忽略 Range 返回 200 全量 → 重写完整', async () => {
  const full = Buffer.alloc(2048, 5);
  const fetch = mockFetch([
    { url: 'https://gh-proxy.com/', body: full, truncate: true },
    { url: 'https://ghfast.top/', body: full },  // 不带 range 标记：收到 Range 也回 200 全量
  ]);
  const dest = tmpDest();
  const r = await downloadVerified(ORIG, dest, sha256buf(full), null, { fetch }, null, 100);
  assert.equal(r.via, 'mirror');
  assert.equal(fs.readFileSync(dest).length, full.length, '200 回退整文件重写，无重复拼接');
});

test('downloadVerified：校验失败（内容污染）→ 删文件从 0 重来（不续传污染字节）', async () => {
  const good = Buffer.alloc(1024, 1);
  const bad = Buffer.alloc(1024, 2);
  const fetch = mockFetch([
    { url: 'https://gh-proxy.com/', body: bad },                  // 镜像1：完整但内容错
    { url: 'https://ghfast.top/', body: good, range: true },      // 镜像2：正确
  ]);
  const dest = tmpDest();
  const r = await downloadVerified(ORIG, dest, sha256buf(good), null, { fetch }, null, 100);
  assert.equal(r.via, 'mirror');
  // 镜像2 的请求不带 Range（校验失败后 offset 已归 0）
  const c2 = fetch.callsFull.find(c2 => c2.url.startsWith('https://ghfast.top/'));
  assert.equal(c2.headers, null, '校验失败后必须整文件重来（无 Range 头）');
  assert.equal(fs.readFileSync(dest).length, good.length);
});
