'use strict';
/** 自动更新器单测：全流程 mock，不触真实网络与进程。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const {
  Updater, compareVersions, pickAsset, parseRelease, buildUpdateScript,
  downloadToFile, psEscape, PLACEHOLDER_OWNER,
} = require('../electron/lib/updater');

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
    { name: 'latest.yml', browser_download_url: 'u3', size: 2 },
  ],
};

test('pickAsset：挑中便携 zip 资产', () => {
  const a = pickAsset(RELEASE);
  assert.equal(a.name, 'SnapNote-Portable-1.2.0-win-x64.zip');
  assert.equal(a.url, 'u2');
  assert.equal(a.size, 999);
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
  assert.match(s, /Expand-Archive/);
  assert.match(s, /robocopy \$src \$appDir \/MIR/);
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
  assert.match(script, /Expand-Archive/);
});

test('Updater.applyAndRestart：未下载时返回 false', () => {
  const u = makeUpdater();
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
