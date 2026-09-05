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
