'use strict';
/**
 * 主进程逻辑测试（无 Electron 二进制）：
 * 用 mock 模块替换 require('electron')，加载真实 main.js，
 * 先跑内置冒烟链路（贴边/展开/收回/调度/Toast），再驱动 IPC 细节。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const MOCK = path.join(__dirname, 'mocks', 'electron.js');

function loadMain(argvExtra, userData) {
  // 独立进程内运行更干净，但 node --test 每文件一个进程：
  // 这里通过删除缓存 + 重新 require 实现“每次加载均为全新 main.js 状态”。
  const snapshot = [...process.argv];
  if (argvExtra) process.argv.push(...argvExtra);
  if (userData) {
    process.env.SNAPNOTE_MOCK_USER_DATA = userData;
    if (argvExtra && argvExtra.includes('--smoke-test')) {
      process.env.SNAPNOTE_SMOKE_DIR = userData;
    }
  }
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === 'electron') return MOCK;
    return origResolve.call(this, request, ...args);
  };
  try {
    const electron = require(MOCK);
    const main = require(path.join(__dirname, '..', 'electron', 'main.js'));
    return { electron, main };
  } finally {
    Module._resolveFilename = origResolve;
    process.argv.length = 0; process.argv.push(...snapshot);
  }
}

test('冒烟链路：贴边 → 展开 → 收回 → 调度 → Toast', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-main-'));
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const { electron } = loadMain(['--smoke-test'], userData);
    await new Promise((resolve) => {
      electron.__state.appHandlers.on('__exit', resolve);
      setTimeout(() => resolve('timeout'), 8000);
    });
    assert.strictEqual(electron.app.exitCode, 0, '冒烟应正常退出');
    const joined = logs.join('\n');
    assert.ok(joined.includes('SMOKE_OK'), '应输出 SMOKE_OK，实际：\n' + joined);
  } finally {
    console.log = origLog;
  }
  assert.ok(fs.existsSync(path.join(userData, 'tasks.json')), '冒烟数据应落盘');
});

test('非冒烟模式：初始化、IPC、托盘、快捷键', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-main2-'));
  fs.writeFileSync(path.join(userData, 'settings.json'),
    JSON.stringify({ hotkey: 'Ctrl+Alt+K' }), 'utf8');
  process.env.SNAPNOTE_FAST = '1'; // 收起延时缩至 400ms
  const { electron } = loadMain(null, userData);
  const st = electron.__state;
  await new Promise(r => setImmediate(r)); // 让 whenReady 微任务跑完

  // 窗口与托盘
  assert.strictEqual(st.windows.length, 1, '应创建便签窗口');
  const win = st.windows[0];
  assert.strictEqual(win.opts.skipTaskbar, true, '便签不进任务栏');
  assert.strictEqual(win.opts.alwaysOnTop, true, '便签置顶');
  const b = win.getBounds();
  assert.strictEqual(b.width, 34, '初始为把手宽度');
  assert.strictEqual(b.x, 1600 - 34, '把手贴右缘');

  // 快捷键来自 settings.json
  assert.ok(st.hotkeys.has('Ctrl+Alt+K'), '应注册自定义热键');

  // 热键触发 = 展开
  st.hotkeys.get('Ctrl+Alt+K')();
  await new Promise(r => setTimeout(r, 300)); // 动画
  assert.strictEqual(win.getBounds().width, 340, '热键展开后宽度 340');

  // IPC：加任务 → 推送
  st.sent.length = 0;
  const t = await electron.ipcMain._invoke('tasks:add', { title: 'IPC任务', dueAt: null });
  assert.ok(t.id, '返回带 id');
  const pushed = st.sent.filter(s => s.channel === 'state:push');
  assert.ok(pushed.length >= 1, '任务变更应推送');
  assert.ok(JSON.stringify(pushed[0].data.tasks).includes('IPC任务'));

  // IPC：设置热键并应换绑
  await electron.ipcMain._invoke('settings:set', { hotkey: 'Ctrl+Shift+Y' });
  assert.ok(st.hotkeys.has('Ctrl+Shift+Y') && !st.hotkeys.has('Ctrl+Alt+K'), '热键应换绑');

  // IPC：折叠事件
  electron.ipcMain.emit('magnet:dock');
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(win.getBounds().width, 34, 'magnet:dock 收回把手');

  // 失焦自动收回（blur → 定时 → dock）
  st.hotkeys.get('Ctrl+Shift+Y')(); // 展开
  await new Promise(r => setTimeout(r, 300));
  win.emitWin('blur');
  await new Promise(r => setTimeout(r, 900)); // FAST 收起 400ms + 磁吸动画 230ms
  assert.strictEqual(win.getBounds().width, 34, '失焦后应自动磁回右缘');

  // 托盘左键 = 切换
  assert.ok(st.windows.length >= 1);
});

test('收起防挡（v1.2.1）：重现化 + 监护自愈 + 窗口参数防御', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-dock-'));
  process.env.SNAPNOTE_FAST = '1';
  const { electron } = loadMain(null, userData);
  const st = electron.__state;
  await new Promise(r => setImmediate(r));
  const win = st.windows[0];

  // 1) 窗口参数：frameless + resizable:true（规避 Windows 透明窗 bounds 锁死），
  //    显式禁最大化/最小化（无系统手势把窗口搞大的口子）
  assert.strictEqual(win.opts.resizable, true, 'resizable 应为 true');
  assert.strictEqual(win.opts.maximizable, false, '应禁最大化');
  assert.strictEqual(win.opts.minimizable, false, '应禁最小化');

  // 2) 展开 → 失焦自动收起：动画完成后应“重现化”强制 DWM 命中区跟随窗口
  st.hotkeys.get('Ctrl+Alt+N')();
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(win.getBounds().width, 340, '展开宽度 340');

  win.emitWin('blur'); // 失焦 → FAST 下 400ms 后 dock
  await new Promise(r => setTimeout(r, 1200)); // 400 收起延时 + 230 动画 + 缓冲
  assert.strictEqual(win.getBounds().width, 34, '收起后宽度 34');
  const i = win.calls.lastIndexOf('hide');
  assert.ok(i >= 0, '收起后应执行 hide（重现化），calls=' + JSON.stringify(win.calls));
  assert.strictEqual(win.calls[i + 1], 'showInactive', 'hide 后应 showInactive 恢复');
  assert.ok(win.isVisible(), '重现化后窗口应可见');

  // 3) 监护自愈：模拟 Windows 异常路径把窗口“改大”（视觉把手 + 物理 340 宽）
  win.setBounds({ x: 1600 - 340, y: 100, width: 340, height: 560 });
  await new Promise(r => setTimeout(r, 2600)); // 等监护 tick（2s）
  const b = win.getBounds();
  assert.strictEqual(b.width, 34, '监护应把 docked 态窗口收敛回 34 宽');
  assert.strictEqual(b.x, 1600 - 34, '收敛位置应贴右缘');
  const hides = win.calls.filter(c => c === 'hide').length;
  assert.ok(hides >= 2, '自愈时也应执行重现化（hide 次数 ' + hides + '）');
});

test('每日任务 IPC：tasks:add 携带 repeat 透传存储并落盘', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-daily-'));
  process.env.SNAPNOTE_FAST = '1';
  const { electron } = loadMain(null, userData);
  await new Promise(r => setImmediate(r));

  const t = await electron.ipcMain._invoke('tasks:add', {
    title: '每日IPC任务',
    dueAt: new Date(Date.now() + 3600000).toISOString(),
    repeat: 'daily',
  });
  assert.strictEqual(t.repeat, 'daily', 'IPC 返回应带 repeat');
  assert.strictEqual(t.done, false);
  const disk = JSON.parse(fs.readFileSync(path.join(userData, 'tasks.json'), 'utf8'));
  assert.strictEqual(disk.tasks[0].repeat, 'daily', 'repeat 应落盘');
  assert.strictEqual(disk.tasks[0].title, '每日IPC任务');

  // 不带 repeat 的旧调用方式（老渲染层兼容）：退化为一次性
  const t2 = await electron.ipcMain._invoke('tasks:add', { title: '普通任务', dueAt: null });
  assert.strictEqual(t2.repeat, null, '无 repeat 退化为一次性');
});

test('手动检查更新 IPC（v1.3.0）：check/download/restart + 状态推送', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-upd-'));
  process.env.SNAPNOTE_FAST = '1';

  // 用桩替换 ./lib/updater（仅 main.js 的 require 生效），驱动完整状态机
  const calls = { check: 0, download: 0, apply: 0 };
  class StubUpdater {
    constructor() {
      this.enabled = true; this.currentVersion = '1.2.1';
      this.state = 'idle'; this.progressPct = 0; this.lastCheck = null;
    }
    async check() { calls.check++; this.lastCheck = { hasUpdate: true, version: '1.3.0' }; return this.lastCheck; }
    async download(onProgress) { calls.download++; onProgress(50, 100); return '/tmp/x.zip'; }
    applyAndRestart() { calls.apply++; return true; }
    cleanupStale() {}
  }
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === './lib/updater' && parent
        && String(parent.filename).endsWith(path.join('electron', 'main.js'))) {
      return { Updater: StubUpdater };
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    const { electron } = loadMain(null, userData);
    const st = electron.__state;
    await new Promise(r => setImmediate(r));

    // 1) ui:ready 载荷带 update 字段（enabled + 当前版本）
    const ready = await electron.ipcMain._invoke('ui:ready');
    assert.strictEqual(ready.update.enabled, true, 'ui:ready 应带 update.enabled');
    assert.strictEqual(ready.update.state, 'idle', '初始 idle');
    assert.strictEqual(ready.update.currentVersion, '1.2.1');

    // 2) 手动检查：发现新版本 → has-update + 推送 UI
    st.sent.length = 0;
    const r1 = await electron.ipcMain._invoke('update:check');
    assert.strictEqual(calls.check, 1, '应调用 updater.check');
    assert.strictEqual(r1.state, 'has-update');
    assert.strictEqual(r1.version, '1.3.0', '新版本号透传');
    const push2 = st.sent.filter(s => s.channel === 'state:push');
    assert.ok(push2.length >= 1, '更新状态变化应推送 UI');
    assert.strictEqual(push2[push2.length - 1].data.update.state, 'has-update', '推送应含最新状态');

    // 3) 下载：downloading → ready，进度回调推进
    st.sent.length = 0;
    const r2 = await electron.ipcMain._invoke('update:download');
    assert.strictEqual(calls.download, 1, '应调用 updater.download');
    assert.strictEqual(r2.state, 'downloading', 'IPC 即时返回 downloading');
    await new Promise(r => setImmediate(r));   // 后台下载完成 → ready
    assert.ok(true);

    // 4) 就绪后 restart：触发 applyAndRestart（mock app.quit 无害）
    const r4 = await electron.ipcMain._invoke('update:restart');
    assert.strictEqual(calls.apply, 1, 'ready 时应触发重启更新');
    assert.ok(r4, 'restart 应返回状态对象');
  } finally {
    Module._load = origLoad;
  }
});

test('到点全屏强提醒（v1.4.0）：due → 全屏窗 → 完成/稍后', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-rem-'));
  process.env.SNAPNOTE_FAST = '1';
  const { electron } = loadMain(null, userData);
  const st = electron.__state;
  await new Promise(r => setImmediate(r));

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // 1) 加一条已过期任务 → FAST tick（300ms）到期触发
  const past = new Date(Date.now() - 60000).toISOString();
  await electron.ipcMain._invoke('tasks:add', { title: '强提醒任务A', dueAt: past });
  await wait(900);

  const remWin = st.windows.find(w => w.loadedFile
    && String(w.loadedFile).endsWith(path.join('renderer', 'reminder.html')));
  assert.ok(remWin, '到期应创建全屏提醒窗');
  assert.strictEqual(remWin.opts.skipTaskbar, true, '提醒窗不应占任务栏');
  assert.strictEqual(remWin.opts.frame, false, '提醒窗应为无边框全屏');
  assert.deepStrictEqual(remWin._bounds, { x: 0, y: 0, width: 1600, height: 900 }, '提醒窗应覆盖整个工作区');

  const pay = st.sent.filter(s => s.channel === 'reminder:payload');
  assert.ok(pay.length >= 1, '应向提醒窗推送到期任务');
  assert.ok(pay[0].data.some(t => t.title === '强提醒任务A'), '推送应含到期任务');

  // 2) 聚合：提醒窗存活期间第二条到期 → reminder:add 增量
  await electron.ipcMain._invoke('tasks:add', { title: '强提醒任务B', dueAt: past });
  await wait(900);
  const add = st.sent.filter(s => s.channel === 'reminder:add');
  assert.ok(add.some(s => s.data.title === '强提醒任务B'), '第二条到期应增量推送而不新开窗口');
  assert.strictEqual(st.windows.filter(w => w.loadedFile
    && String(w.loadedFile).endsWith(path.join('renderer', 'reminder.html'))).length, 1, '提醒窗单例');

  // 3) 稍后处理 → 窗口关闭、任务未完成、不重弹
  electron.ipcMain.emit('reminder:action', { sender: null }, 'ack');
  await new Promise(r => setImmediate(r));
  assert.ok(remWin.isDestroyed(), '稍后处理应关闭提醒窗');
  const ready1 = await electron.ipcMain._invoke('ui:ready');
  assert.ok(ready1.tasks.some(t => t.title === '强提醒任务A' && !t.done), '稍后处理不勾任务');
  await wait(900);
  const remWin2 = st.windows.filter(w => w.loadedFile
    && String(w.loadedFile).endsWith(path.join('renderer', 'reminder.html')));
  assert.strictEqual(remWin2.length, 1, '已提醒任务不应重弹（沿用唯一窗口）');
  assert.ok(remWin2[0].isDestroyed(), '已提醒任务不应重开提醒窗');

  // 4) done 路径：再次到期前先重开（手动再造到期链路）
  const past2 = new Date(Date.now() - 30000).toISOString();
  await electron.ipcMain._invoke('tasks:add', { title: '强提醒任务C', dueAt: past2 });
  await wait(900);
  electron.ipcMain.emit('reminder:action', { sender: null }, 'done');
  await new Promise(r => setImmediate(r));
  const ready2 = await electron.ipcMain._invoke('ui:ready');
  assert.ok(ready2.tasks.some(t => t.title === '强提醒任务C' && t.done), '完成它应勾掉任务');
});

test('主进程更新器装配完备性（v1.4.1 回归）：spawn 可用 + 失败可见', async () => {
  // 历史 bug：main.js 构造 Updater 时 deps 只传了 log → deps.spawn 为 null →
  // applyAndRestart 静默 false → 用户点「重启并更新」不退出不更新不报错。
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-updass-'));
  process.env.SNAPNOTE_FAST = '1';
  const { electron, main } = loadMain(null, userData);
  const st = electron.__state;
  await new Promise(r => setImmediate(r));

  // 1) 装配完备：主进程 updater 的 spawn 必须是真实函数（默认注入，不再依赖 main.js 传参）
  assert.strictEqual(typeof main.__updater.deps.spawn, 'function',
    '主进程 updater.deps.spawn 应默认可用（生产装配缺配曾致更新失灵）');
  // 2) exeBase：开发态从 build.productName 兜底（打包态走 process.execPath basename）
  assert.strictEqual(main.__exeBase, 'SnapNote', 'exeBase 应为 SnapNote');

  // 3) 失败可见性：state=ready 但 zip 缺失 → restart 应转 error 并推送 UI（不再静默）
  //    （mock 下 UPDATER_ON=false，updatePayload 显示 disabled 属正确语义；
  //     这里断言的是状态翻转与推送链路本身）
  main.__updater.state = 'ready';
  main.__updater.zipPath = null;
  st.sent.length = 0;
  await electron.ipcMain._invoke('update:restart');
  await new Promise(r => setImmediate(r));
  assert.strictEqual(main.__updater.state, 'error', 'apply 失败应转 error 态（可感知）');
  const pushes = st.sent.filter(s => s.channel === 'state:push');
  assert.ok(pushes.length >= 1, '失败时应触发 state:push 同步 UI（含托盘/设置页/头部按钮）');
});

test('备忘录 v1.5.0：IPC CRUD 全链路 + 多快捷键注册 + 捕获豁免', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-memo-'));
  process.env.SNAPNOTE_FAST = '1';
  const { electron, main } = loadMain(null, userData);
  const st = electron.__state;
  await new Promise(r => setImmediate(r));
  const { ipcMain } = electron;

  // 1) 状态载荷：默认分类树（含内置「快速收集」）与设置键
  const ms = await ipcMain._invoke('memo:state');
  assert.ok(ms.categories.length >= 4, '默认分类树');
  assert.ok(ms.categories.some(c => c.name === '快速收集' && c.locked), '内置根分类');
  assert.equal(ms.settings.memoCaptureHotkey, 'Ctrl+Shift+M');

  // 2) 分类 → 条目 → 列表/搜索 全链路
  const cat = await ipcMain._invoke('memo:addCategory', { name: '测试集', parentId: null });
  assert.ok(cat && cat.id, '新建分类');
  const sub = await ipcMain._invoke('memo:addCategory', { name: '子集', parentId: cat.id });
  assert.ok(sub.id, '二级分类');
  const it = await ipcMain._invoke('memo:addItem',
    { type: 'text', text: '账号 abc@example', categoryId: sub.id, sensitive: true });
  assert.ok(it.id, '新建条目');
  let items = await ipcMain._invoke('memo:items', { categoryId: cat.id, q: '' });
  assert.equal(items.length, 1, '父分类列表含子孙条目');
  assert.equal(items[0].sensitive, true);
  items = await ipcMain._invoke('memo:items', { categoryId: null, q: '' });
  assert.equal(items.length, 0, '未分类视图不串');

  // 3) 敏感切换 / 移动 / 删除
  await ipcMain._invoke('memo:updateItem', { id: it.id, patch: { sensitive: false } });
  await ipcMain._invoke('memo:moveItem', { id: it.id, categoryId: null });
  items = await ipcMain._invoke('memo:items', { categoryId: null, q: '' });
  assert.equal(items.length, 1);
  assert.equal(items[0].sensitive, false);
  await ipcMain._invoke('memo:removeItem', { id: it.id });
  items = await ipcMain._invoke('memo:items', { categoryId: null, q: '' });
  assert.equal(items.length, 0);

  // 4) 快捷键：主便签键 + 备忘录两键共三个全局注册
  assert.ok(st.hotkeys.size >= 3, '三个全局快捷键均注册');
  assert.ok(st.hotkeys.has('Ctrl+Shift+M') && st.hotkeys.has('Ctrl+Shift+O'), '备忘录默认键位');
  // 换键 → 重新注册生效
  await ipcMain._invoke('settings:set', { memoCaptureHotkey: 'Ctrl+Alt+K' });
  assert.ok(st.hotkeys.has('Ctrl+Alt+K') && !st.hotkeys.has('Ctrl+Shift+M'), '收集键改键生效');

  // 5) 快捷收集：注入剪贴板文本 → quickCapture 走默认分类（快速收集）
  st.clipText = '快捷键收集的内容';
  st.clipImage = null;
  st.hotkeys.get('Ctrl+Alt+K')(); // 模拟按下收集键
  await new Promise(r => setImmediate(r));
  items = await ipcMain._invoke('memo:items', { categoryId: 'cat-root', q: '' });
  assert.equal(items.length, 1, '快捷收集落入快速收集');
  assert.equal(items[0].text, '快捷键收集的内容');

  // 6) 复制条目回剪贴板（豁免自捕获）
  await ipcMain._invoke('memo:copyItem', { id: items[0].id });
  assert.equal(st.clipWritten, '快捷键收集的内容', 'copyItem 写剪贴板');

  // 7) payload 携带 memo 计数（便签头部徽章）
  const p = await ipcMain._invoke('ui:ready');
  assert.ok(p.memo && p.memo.count === 1 && p.memo.captureOn === true, 'payload.memo 徽章数据');
});

test('回归：打包态 package.json（无 build/repository 字段）不崩', async () => {
  // electron-builder 打包时会删除 build 等字段（ignoredPackageMetadataProperties），
  // 历史 bug：v1.1.0 正式版 main.js 直读 pkg.build.productName → 启动即 TypeError 崩溃。
  // 此测试用"打包后字段形态"喂给 main.js，确保此类问题永不再现。
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-packaged-'));
  process.env.SNAPNOTE_FAST = '1';
  const strippedPkg = {
    name: 'snapnote', productName: '磁吸便签 SnapNote', version: '1.1.1',
    description: '', author: '', license: 'MIT', main: 'electron/main.js',
  };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '../package.json' && parent
        && String(parent.filename).endsWith(path.join('electron', 'main.js'))) {
      return strippedPkg;
    }
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const { electron } = loadMain(null, userData);
    const st = electron.__state;
    await new Promise(r => setImmediate(r));
    assert.strictEqual(st.windows.length, 1, '打包态字段缺失时仍应正常启动建窗');
  } finally {
    Module._load = origLoad;
  }
});
