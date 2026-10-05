'use strict';
/** 双目录原子切换单测（v1.6.0）：真实临时目录 + 可注入 execFile/spawn，不触网络。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const dualdir = require('../electron/lib/dualdir');
const { Updater } = require('../electron/lib/updater');

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dualdir-test-'));
}
function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ---------- 纯逻辑 ----------

test('parseAppDirName：识别与拒绝', () => {
  assert.deepStrictEqual(dualdir.parseAppDirName('app-1.6.0'), [1, 6, 0]);
  assert.deepStrictEqual(dualdir.parseAppDirName('app-2.10.3'), [2, 10, 3]);
  assert.deepStrictEqual(dualdir.parseAppDirName('app-1.6.0-beta'), [1, 6, 0], '后续段忽略');
  assert.strictEqual(dualdir.parseAppDirName('app-x.y.z'), null);
  assert.strictEqual(dualdir.parseAppDirName('SnapNote'), null);
  assert.strictEqual(dualdir.parseAppDirName('app-1'), null);
});

// 路径断言归一化：分隔符随 OS 的 path.sep 变化（CI=Windows 反斜杠，
// 本地 Linux 正斜杠），代码行为两者皆正确——断言比较前统一为 '/'。
const norm = (p) => String(p).replace(/\\/g, '/');

test('deriveAppRoot：Windows 双目录/平铺（生产形态）', () => {
  assert.strictEqual(norm(dualdir.deriveAppRoot('E:\\project\\SnapNote\\app-1.6.0\\SnapNoteApp.exe')), 'E:/project/SnapNote');
  assert.strictEqual(norm(dualdir.deriveAppRoot('E:\\project\\SnapNote\\SnapNoteApp.exe')), 'E:/project/SnapNote');
  assert.strictEqual(norm(dualdir.deriveAppRoot('C:\\SnapNote\\app-1.6.0\\SnapNoteApp.exe')), 'C:/SnapNote');
});

test('deriveAppRoot：posix（单测/Linux 形态）与裸文件名', () => {
  assert.strictEqual(norm(dualdir.deriveAppRoot('/tmp/x/app-1.7.2/SnapNoteApp.exe')), '/tmp/x');
  assert.strictEqual(norm(dualdir.deriveAppRoot('/tmp/x/SnapNoteApp.exe')), '/tmp/x');
  assert.strictEqual(norm(dualdir.deriveAppRoot('SnapNoteApp.exe')), '.');
});

test('deriveVersionDir：版本目录名或 null', () => {
  assert.strictEqual(dualdir.deriveVersionDir('/r/app-1.7.2/SnapNoteApp.exe'), 'app-1.7.2');
  assert.strictEqual(dualdir.deriveVersionDir('/r/SnapNoteApp.exe'), null);
});

// ---------- 指针文件 ----------

test('readChannels/writeChannelsAtomic：正常往返 + 损坏容错', () => {
  const root = mkRoot();
  assert.strictEqual(dualdir.readChannels(root), null, '缺失 → null');
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.0', previous: null });
  assert.deepStrictEqual(dualdir.readChannels(root), { current: 'app-1.6.0', previous: null });
  fs.writeFileSync(path.join(root, 'channels.json'), '{oops');
  assert.strictEqual(dualdir.readChannels(root), null, '损坏 JSON → null');
  assert.strictEqual(dualdir.readChannels(root), null);
  fs.writeFileSync(path.join(root, 'channels.json'), '{"current":123}');
  assert.strictEqual(dualdir.readChannels(root), null, 'current 非字符串 → null');
});

test('rollbackChannels：翻转成功 / 无 previous 拒绝', () => {
  const root = mkRoot();
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.1', previous: 'app-1.6.0' });
  assert.ok(dualdir.rollbackChannels(root));
  assert.deepStrictEqual(dualdir.readChannels(root), { current: 'app-1.6.0', previous: 'app-1.6.1' });
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.0', previous: null });
  assert.strictEqual(dualdir.rollbackChannels(root), false);
});

// ---------- 版本目录定位 ----------

test('findLatestAppDir：取版本最大；缺主程序 exe 的目录跳过；不存在目录 null', () => {
  const root = mkRoot();
  assert.strictEqual(dualdir.findLatestAppDir(root), null, '空目录');
  for (const v of ['app-1.5.0', 'app-1.6.0', 'app-1.10.0', 'app-1.9.0']) {
    writeFile(root, `${v}/SnapNoteApp.exe`, 'x');
  }
  writeFile(root, 'app-2.0.0/别的东西.txt', 'x'); // 无 exe：跳过
  assert.strictEqual(dualdir.findLatestAppDir(root), 'app-1.10.0', '数值比较非字典序');
});

test('targetExe：读指针 → 主程序路径；无指针 null', () => {
  const root = mkRoot();
  writeFile(root, 'app-1.6.0/SnapNoteApp.exe', 'x');
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.0' });
  assert.strictEqual(dualdir.targetExe(root), path.join(root, 'app-1.6.0', 'SnapNoteApp.exe'));
  dualdir.writeChannelsAtomic(root, { current: 'app-9.9.9' }); // 指向不存在的目录 → 扫描兜底
  assert.strictEqual(dualdir.targetExe(root), path.join(root, 'app-1.6.0', 'SnapNoteApp.exe'));
});

// ---------- 解压（注入 mock）----------

function fakeExtractor(extractDir) {
  // 模拟 tar：把「预置源目录」复制为解压产物（真 cp，文件系统操作是真实的）
  return (cmd, args, opts, cb) => {
    setImmediate(() => {
      try {
        const dest = args[args.indexOf('-C') + 1];
        const src = cmd.includes('SOURCE:') ? cmd.split('SOURCE:')[1] : null;
        if (!src) return cb(new Error('mock: no source'));
        fs.cpSync(src, dest, { recursive: true });
        cb(null);
      } catch (e) { cb(e); }
    });
  };
}

test('extractZip：mock 成功 / 全部失败抛错', async () => {
  const root = mkRoot();
  const src = path.join(root, 'zipsrc');
  writeFile(src, 'app-1.6.0/SnapNoteApp.exe', 'NEW');
  const dest = path.join(root, 'extract');
  await dualdir.extractZip(path.join(root, 'x.zip'), dest, { execFile: (cmd, a, o, cb) => {
    fs.cpSync(src, dest, { recursive: true });
    setImmediate(() => cb(null));
  } });
  assert.ok(fs.existsSync(path.join(dest, 'app-1.6.0', 'SnapNoteApp.exe')));
  await assert.rejects(() => dualdir.extractZip(path.join(root, 'x.zip'), path.join(root, 'extract2'),
    { execFile: (c, a, o, cb) => setImmediate(() => cb(new Error('boom'))) }),
    /boom|解压/);
});

test('moveDirIntoPlace：同卷 rename 原子挪移', () => {
  const root = mkRoot();
  const src = path.join(root, 'work', 'app-1.6.1');
  writeFile(src, 'SnapNoteApp.exe', 'NEW');
  const dst = path.join(root, 'app-1.6.1');
  dualdir.moveDirIntoPlace(src, dst);
  assert.ok(fs.existsSync(path.join(dst, 'SnapNoteApp.exe')));
  assert.strictEqual(fs.existsSync(src), false, '源目录已消失（rename）');
});

// ---------- installNewVersion 全链（解压 mock，其余真实）----------

function mockExtractFrom(src) {
  return (cmd, args, opts, cb) => {
    setImmediate(() => {
      try {
        const dest = args[args.indexOf('-C') + 1];
        fs.cpSync(src, dest, { recursive: true });
        cb(null);
      } catch (e) { cb(e); }
    });
  };
}

test('installNewVersion：解压→就位→翻指针→旧版保留（无破坏）', async () => {
  const root = mkRoot();
  writeFile(root, 'app-1.6.0/SnapNoteApp.exe', 'OLD');
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.0', previous: null });
  const zipSrc = path.join(root, 'zipsrc');
  writeFile(zipSrc, 'app-1.6.1/SnapNoteApp.exe', 'NEW');
  writeFile(zipSrc, 'SnapNote.exe', 'LAUNCHER');
  writeFile(zipSrc, 'channels.json', JSON.stringify({ current: 'app-1.6.1', previous: null }));
  const fakeZip = writeFile(root, 'fake.zip', 'PK-zip-content'); // 真实占位（解压被 mock）

  const r = await dualdir.installNewVersion({
    zipPath: fakeZip,
    appRoot: root,
    deps: { execFile: mockExtractFrom(zipSrc) },
  });

  assert.strictEqual(r.dir, 'app-1.6.1');
  const c = dualdir.readChannels(root);
  assert.strictEqual(c.current, 'app-1.6.1');
  assert.strictEqual(c.previous, 'app-1.6.0', '旧版进 previous（保留后路）');
  assert.strictEqual(fs.readFileSync(path.join(root, 'app-1.6.1', 'SnapNoteApp.exe'), 'utf8'), 'NEW');
  assert.ok(fs.existsSync(path.join(root, 'app-1.6.0', 'SnapNoteApp.exe')), '旧版目录原封不动');
});

test('installNewVersion：失败时根布局不变（可重试）', async () => {
  const root = mkRoot();
  writeFile(root, 'app-1.6.0/SnapNoteApp.exe', 'OLD');
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.0', previous: null });
  await assert.rejects(() => dualdir.installNewVersion({
    zipPath: path.join(root, 'nope.zip'), appRoot: root, deps: {},
  }), /更新包不存在/);
  assert.strictEqual(dualdir.readChannels(root).current, 'app-1.6.0', '指针未动');
  await assert.rejects(() => dualdir.installNewVersion({
    zipPath: writeFile(root, 'x.zip', 'PK'), appRoot: root,
    deps: { execFile: (c, a, o, cb) => setImmediate(() => cb(new Error('tar 被劫持'))) },
  }), /tar 被劫持|解压/);
  assert.strictEqual(dualdir.readChannels(root).current, 'app-1.6.0', '指针仍未动');
  assert.ok(fs.existsSync(path.join(root, 'app-1.6.0', 'SnapNoteApp.exe')), '当前版本完好');
});

test('installNewVersion：包内无版本目录 → 拒绝（防平铺旧包误装）', async () => {
  const root = mkRoot();
  const zipSrc = path.join(root, 'zipsrc');
  writeFile(zipSrc, 'SnapNoteApp.exe', 'PLAIN'); // 平铺旧布局（v1.5.x 包）
  await assert.rejects(() => dualdir.installNewVersion({
    zipPath: writeFile(root, 'x.zip', 'PK'), appRoot: root, deps: { execFile: mockExtractFrom(zipSrc) },
  }), /未找到版本目录/);
});

// ---------- 首跑清理 ----------

test('cleanupPrevious：删上一版目录 + 工作目录 + .old 残留；清后指针 previous 归 null', () => {
  const root = mkRoot();
  writeFile(root, 'app-1.6.0/SnapNoteApp.exe', 'CUR');
  writeFile(root, 'app-1.5.9/SnapNoteApp.exe', 'OLD');
  writeFile(root, dualdir.WORK_DIR + '/update.zip', 'zip');
  writeFile(root, 'SnapNoteApp.exe.old', 'stale');
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.0', previous: 'app-1.5.9' });

  const removed = dualdir.cleanupPrevious(root);
  assert.strictEqual(removed.previous, 'app-1.5.9');
  assert.ok(!fs.existsSync(path.join(root, 'app-1.5.9')), '上一版已删');
  assert.ok(!fs.existsSync(path.join(root, dualdir.WORK_DIR)), '工作目录已删');
  assert.ok(!fs.existsSync(path.join(root, 'SnapNoteApp.exe.old')), '.old 残留已删');
  assert.ok(fs.existsSync(path.join(root, 'app-1.6.0', 'SnapNoteApp.exe')), '当前版完好');
  const c = dualdir.readChannels(root);
  assert.strictEqual(c.previous, null);
  // 幂等：再跑不炸
  dualdir.cleanupPrevious(root);
});

// ---------- Updater 层装配（applyUpdate / restartIntoNew / rollback）----------

function newUpdater(appRoot, deps = {}) {
  return new Updater({
    owner: 'o', repo: 'snapnote', currentVersion: '1.6.0',
    appRoot, appDir: appRoot, exeBase: 'SnapNoteApp',
    deps: Object.assign({ log: () => {} }, deps),
  });
}

test('Updater.applyUpdate：成功后 pendingVersionDir 指向新目录', async () => {
  const root = mkRoot();
  writeFile(root, 'app-1.6.0/SnapNoteApp.exe', 'OLD');
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.0' });
  const zipSrc = path.join(root, 'zipsrc');
  writeFile(zipSrc, 'app-1.7.0/SnapNoteApp.exe', 'NEW');
  const u = newUpdater(root, { execFile: mockExtractFrom(zipSrc) });
  u.zipPath = writeFile(root, 'fake.zip', 'PK'); // 直接喂 zip（跳过下载）
  await u.applyUpdate();
  assert.strictEqual(u.pendingVersionDir, 'app-1.7.0');
  assert.strictEqual(dualdir.readChannels(root).current, 'app-1.7.0');
});

test('Updater.restartIntoNew：spawn 指针目标 + --wait-lock；无目标 false', () => {
  const root = mkRoot();
  writeFile(root, 'app-1.6.1/SnapNoteApp.exe', 'NEW');
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.1' });
  const spawned = [];
  const u = newUpdater(root, { spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; } });
  assert.strictEqual(u.restartIntoNew(), true);
  assert.strictEqual(spawned[0].cmd, path.join(root, 'app-1.6.1', 'SnapNoteApp.exe'));
  assert.deepStrictEqual(spawned[0].args, ['--wait-lock']);
  assert.strictEqual(spawned[0].opts.detached, true);
  // 无指针/无目录
  const u2 = newUpdater(mkRoot(), { spawn: () => ({ unref() {} }) });
  assert.strictEqual(u2.restartIntoNew(), false);
});

test('Updater.rollback：翻转指针 + spawn 根启动器；无 previous false', () => {
  const root = mkRoot();
  writeFile(root, 'app-1.6.1/SnapNoteApp.exe', 'NEW');
  writeFile(root, 'app-1.6.0/SnapNoteApp.exe', 'OLD');
  writeFile(root, 'SnapNote.exe', 'LAUNCHER');
  dualdir.writeChannelsAtomic(root, { current: 'app-1.6.1', previous: 'app-1.6.0' });
  const spawned = [];
  const u = newUpdater(root, { spawn: (cmd, args, opts) => { spawned.push({ cmd }); return { unref() {} }; } });
  assert.strictEqual(u.rollback(), true);
  assert.strictEqual(spawned[0].cmd, path.join(root, 'SnapNote.exe'), '经根启动器拉起（由它等旧进程退出）');
  assert.strictEqual(dualdir.readChannels(root).current, 'app-1.6.0');
  // 无 previous：拒绝（新 root 干净状态）
  const root2 = mkRoot();
  writeFile(root2, 'app-1.6.0/SnapNoteApp.exe', 'X');
  dualdir.writeChannelsAtomic(root2, { current: 'app-1.6.0', previous: null });
  const u2 = newUpdater(root2, { spawn: () => ({ unref() {} }) });
  assert.strictEqual(u2.rollback(), false);
});
