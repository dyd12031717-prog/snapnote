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

/** mock fetch：按 URL 前缀/精确匹配返回不同 body（node stream 或挂起 stream） */
function mockFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = routes.find((r) => (r.match === 'exact' ? r.url === url : String(url).startsWith(r.url)));
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, body: Readable.from([]) };
    if (hit.body === 'STALL') { // 永不吐数据的挂起流（测首字节超时）
      return { ok: true, status: 200, headers: { get: () => '100' }, body: new Readable({ read() { /* 不 push，挂着 */ } }) };
    }
    const body = typeof hit.body === 'string' ? Buffer.from(hit.body) : hit.body;
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k === 'content-length' ? String(body.length) : null) },
      body: Readable.from([body]),
      text: async () => body.toString(),
      json: async () => JSON.parse(body.toString()),
    };
  };
  fn.calls = calls;
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
  assert.match(s, /Expand-Archive|tar -xf/);
  assert.match(s, /robocopy "\$src" "\$appDir" \/MIR/); // v1.4.1：路径含空格时参数须整体引用
  assert.match(s, /\/XF "\$exeBase\.exe"/);
  assert.match(s, /Get-Process -Name \$exeBase/);
  assert.match(s, /Start-Process -FilePath \$exe/);
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
    return { ok: true, status: 200, headers: { get: () => '11' }, body: Readable.from([Buffer.from('zip-bytes')]) };
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
  assert.match(script, /tar -xf \$zipPath -C \$extract/);
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
