'use strict';
/**
 * 磁吸便签 SnapNote — Electron 主进程
 * 职责：窗口管理（贴边把手/展开便签 + 磁吸动画）、托盘、全局快捷键、
 *       开机自启、任务 IPC、到点提醒调度、开机今日提醒 Toast。
 */
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain,
  screen, Notification, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./lib/store');
const { Scheduler } = require('./lib/scheduler');
const { Updater } = require('./lib/updater');
const TimeFmt = require('./lib/timeparse');

const IS_SMOKE = process.argv.includes('--smoke-test');
const FAST = IS_SMOKE || process.env.SNAPNOTE_FAST === '1'; // 测试/演示用：缩短收起与 Toast 延时

// 冒烟/CI 无 GPU 环境禁用硬件加速，避免渲染初始化失败（打包产物真实冒烟依赖）
if (IS_SMOKE && app.commandLine && app.commandLine.appendSwitch) {
  app.commandLine.appendSwitch('disable-gpu');
}

// ---- 布局常量（与 PRD 第四章视觉规格一致） ----
const HANDLE_W = 34;            // 贴边把手宽
const HANDLE_H = 152;           // 贴边把手高
const NOTE_W = 340;             // 展开便签宽
const NOTE_MAX_H = 560;         // 展开便签最大高
const MAGNET_MS = 230;          // 磁吸动画时长
const TOAST_W = 380, TOAST_H = 132;
const TOAST_LINGER = 6000;      // Toast 停留时长

const ROOT = path.join(__dirname, '..');

let noteWin = null;
let toastWin = null;
let settingsWin = null;
let tray = null;
let mode = 'docked';            // docked | expanded
let collapseTimer = null;
let animTimer = null;

// 冒烟模式使用独立的临时目录（可用 SNAPNOTE_SMOKE_DIR 注入），且每次启动前清空
const SMOKE_DIR = process.env.SNAPNOTE_SMOKE_DIR || path.join(ROOT, '.tmp-smoke');
if (IS_SMOKE) {
  try {
    for (const f of ['tasks.json', 'tasks.json.bak', 'settings.json', 'settings.json.bak']) {
      fs.rmSync(path.join(SMOKE_DIR, f), { force: true });
    }
  } catch (e) { /* 清理失败不阻断 */ }
}
const store = new Store(IS_SMOKE ? SMOKE_DIR : app.getPath('userData'));
const scheduler = new Scheduler(store, onTaskDue);
scheduler.onChange = pushState; // 每日任务滚动/复活后同步 UI（pushState 为函数声明，提升可用）

// ============================================================ 自动更新（便携版）
const pkg = require('../package.json');
const appDir = app.isPackaged ? path.dirname(process.execPath) : ROOT;
const updater = new Updater({
  owner: pkg.repository && pkg.repository.owner,
  repo: pkg.repository && pkg.repository.repo,
  currentVersion: app.getVersion(),
  appDir,
  exeBase: (pkg.build && pkg.build.productName) || 'SnapNote',
  deps: { log: (...a) => console.log('[updater]', ...a) },
});
const UPDATER_ON = !IS_SMOKE && updater.enabled;

function updaterMenuTemplate() {
  if (!UPDATER_ON) return [];
  const labelFor = () => {
    switch (updater.state) {
      case 'has-update': return `发现新版本 v${updater.lastCheck.version}，点击下载`;
      case 'downloading': return `正在下载… ${updater.progressPct || 0}%`;
      case 'ready': return '下载完成，重启并更新 ▸';
      case 'error': return '更新检查失败，点击重试';
      default: return '检查更新';
    }
  };
  return [{ label: labelFor(), click: onUpdaterMenu }];
}

function refreshTray() { if (tray && tray._rebuild) tray._rebuild(); }

function notifyUpdate(title, body, clickFn) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  if (clickFn) n.on('click', clickFn);
  n.show();
}

async function checkForUpdate(manual) {
  if (updater.state === 'downloading' || updater.state === 'ready') return;
  try {
    const info = await updater.check();
    if (!info || !info.hasUpdate) {
      updater.state = 'idle';
      refreshTray();
      if (manual) notifyUpdate('已是最新版本', `当前 v${updater.currentVersion}`);
      return;
    }
    updater.state = 'has-update';
    refreshTray();
    notifyUpdate(
      `发现新版本 v${info.version}`,
      '点击立即下载，下载完成后一键重启更新',
      startDownload,
    );
  } catch (e) {
    updater.state = 'error';
    refreshTray();
    if (manual) notifyUpdate('更新检查失败', '网络异常或 GitHub 暂不可达，稍后再试');
  }
}

async function startDownload() {
  if (updater.state !== 'has-update' || !updater.lastCheck) return;
  updater.state = 'downloading';
  updater.progressPct = 0;
  refreshTray();
  let lastUi = 0;
  try {
    await updater.download((done, total) => {
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (pct !== updater.progressPct && Date.now() - lastUi > 500) {
        updater.progressPct = pct;
        lastUi = Date.now();
        refreshTray();
      }
    });
    updater.state = 'ready';
    refreshTray();
    notifyUpdate('新版本就绪', '点击立即重启并完成更新', restartToUpdate);
  } catch (e) {
    updater.state = 'error';
    refreshTray();
    notifyUpdate('下载失败', '网络异常，可稍后从托盘菜单重试');
  }
}

function restartToUpdate() {
  if (updater.state !== 'ready') return;
  if (updater.applyAndRestart()) app.quit();
}

function onUpdaterMenu() {
  switch (updater.state) {
    case 'has-update': return startDownload();
    case 'ready': return restartToUpdate();
    case 'error': return checkForUpdate(true);
    default: return checkForUpdate(true);
  }
}

// ============================================================ 布局
function workArea() { return screen.getPrimaryDisplay().workArea; }

function dockedBounds() {
  const wa = workArea();
  return {
    x: wa.x + wa.width - HANDLE_W,
    y: wa.y + Math.round(wa.height * 0.42),
    width: HANDLE_W, height: HANDLE_H,
  };
}

function expandedBounds() {
  const wa = workArea();
  const h = Math.min(NOTE_MAX_H, wa.height - 24);
  return {
    x: wa.x + wa.width - NOTE_W,
    y: wa.y + Math.max(8, Math.round((wa.height - h) / 2)),
    width: NOTE_W, height: h,
  };
}

/** 磁吸动画：右缘固定，宽度/位置缓动（easeOutCubic） */
function animateBounds(win, to, done) {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  const from = win.getBounds();
  const t0 = Date.now();
  const draw = () => {
    const k = Math.min(1, (Date.now() - t0) / MAGNET_MS);
    const e = 1 - Math.pow(1 - k, 3);
    const width = Math.round(from.width + (to.width - from.width) * e);
    const height = Math.round(from.height + (to.height - from.height) * e);
    const x = Math.round(from.x + (to.x - from.x) * e);
    const y = Math.round(from.y + (to.y - from.y) * e);
    try { win.setBounds({ x, y, width, height }); } catch (err) { /* 窗口已销毁 */ }
    if (k >= 1) {
      clearInterval(animTimer); animTimer = null;
      win.setBounds(to);
      if (done) done();
    }
  };
  draw();
  animTimer = setInterval(draw, 16);
}

// ============================================================ 状态推送
function payload() {
  return {
    tasks: store.list(),
    settings: { ...store.settings },
    mode,
    hotkeyActive: currentHotkeyOk,
  };
}
function pushState() {
  const data = payload();
  if (noteWin && !noteWin.isDestroyed()) noteWin.webContents.send('state:push', data);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('state:push', data);
}

// ============================================================ 便签窗口
function createNoteWindow() {
  noteWin = new BrowserWindow({
    ...dockedBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  noteWin.setAlwaysOnTop(true, 'screen-saver');
  noteWin.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  noteWin.on('blur', () => { if (mode === 'expanded') scheduleCollapse(); });
  noteWin.on('closed', () => { noteWin = null; });
}

function expand() {
  if (!noteWin) createNoteWindow();
  if (mode === 'expanded') { noteWin.focus(); return; }
  mode = 'expanded';
  clearTimeout(collapseTimer); collapseTimer = null;
  noteWin.webContents.send('view:mode', 'note');
  animateBounds(noteWin, expandedBounds(), () => noteWin.focus());
  pushState();
}

function dock() {
  if (!noteWin || mode === 'docked') return;
  mode = 'docked';
  clearTimeout(collapseTimer); collapseTimer = null;
  noteWin.webContents.send('view:mode', 'handle');
  animateBounds(noteWin, dockedBounds());
  pushState();
}

function toggleMagnet() { mode === 'expanded' ? dock() : expand(); }

/** 失焦 collapseDelay 秒后自动磁吸回右缘（PRD FR-03） */
function scheduleCollapse() {
  clearTimeout(collapseTimer);
  const delay = Math.max(5, Number(store.settings.collapseDelay) || 30) * 1000;
  collapseTimer = setTimeout(dock, FAST ? Math.min(delay, 400) : delay);
  if (collapseTimer.unref) collapseTimer.unref();
}

// ============================================================ Toast 窗口（开机提醒 / 到点卡片）
function showToast(content, opts) {
  if (toastWin && !toastWin.isDestroyed()) toastWin.destroy();
  const wa = workArea();
  toastWin = new BrowserWindow({
    x: wa.x + wa.width - TOAST_W - 14,
    y: wa.y + 14,
    width: TOAST_W, height: TOAST_H,
    frame: false, transparent: true, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false,
    hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  toastWin.setAlwaysOnTop(true, 'screen-saver');
  toastWin.loadFile(path.join(ROOT, 'renderer', 'toast.html'));
  toastWin.on('closed', () => { toastWin = null; });
  const linger = (opts && opts.linger) || TOAST_LINGER;
  const send = () => { try { toastWin.webContents.send('toast:payload', content); } catch (e) { /* ignore */ } };
  if (toastWin.webContents.isLoading()) {
    toastWin.webContents.once('did-finish-load', send);
  } else send();
  setTimeout(() => { try { toastWin && toastWin.destroy(); } catch (e) { /* ignore */ } },
    IS_SMOKE ? 600 : linger);
}

// ============================================================ 设置窗口
function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 520,
    minWidth: 420, minHeight: 460,
    title: '磁吸便签 · 设置',
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  settingsWin.loadFile(path.join(ROOT, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ============================================================ 全局快捷键
let currentHotkeyOk = true;
function applyHotkey(hotkey) {
  globalShortcut.unregisterAll();
  currentHotkeyOk = true;
  try {
    globalShortcut.register(hotkey, toggleMagnet);
  } catch (e) {
    currentHotkeyOk = false;
  }
  if (!globalShortcut.isRegistered(hotkey)) currentHotkeyOk = false;
}

// ============================================================ 开机自启
function applyAutostart(enabled) {
  if (!app.isPackaged) return; // 开发态不写入注册表，避免污染开发机
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  if (!enabled) app.setLoginItemSettings({ openAtLogin: false, args: [] });
}

function firstRunNotice() {
  if (store.settings.__seen || !store.settings.autostart) return;
  store.settings.__seen = true;
  store.persistSettings();
  if (Notification.isSupported()) {
    const n = new Notification({
      title: '磁吸便签已就绪',
      body: '已为你开启开机自启动，可在托盘右键菜单或设置中关闭。',
    });
    n.show();
  }
}

// ============================================================ 到点提醒
function onTaskDue(task) {
  if (IS_SMOKE) { smokeDue.push(task.title); return; }
  if (Notification.isSupported()) {
    const isDaily = task.repeat === 'daily';
    const when = isDaily
      ? `每天 ${TimeFmt.fmtHM(new Date(task.dueAt))}`
      : TimeFmt.formatDue(task.dueAt);
    const n = new Notification({
      title: isDaily ? '每日提醒 · 磁吸便签' : '到点提醒 · 磁吸便签',
      body: `${task.title}（${when}）`,
    });
    n.on('click', expand);
    n.show();
  }
  if (noteWin && !noteWin.isDestroyed()) noteWin.webContents.send('due:alert', task);
}

// ============================================================ IPC
function setupIpc() {
  ipcMain.handle('ui:ready', () => payload());
  ipcMain.handle('tasks:add', (_e, { title, dueAt, repeat }) => {
    const t = store.add(title, dueAt, repeat);
    pushState();
    return t;
  });
  ipcMain.handle('tasks:toggle', (_e, id) => { const t = store.toggle(id); pushState(); return t; });
  ipcMain.handle('tasks:remove', (_e, id) => { const ok = store.remove(id); pushState(); return ok; });
  ipcMain.handle('settings:get', () => ({ ...store.settings }));
  ipcMain.handle('settings:set', (_e, patch) => {
    const before = store.settings.hotkey;
    const s = store.updateSettings(patch);
    if (patch.hotkey && patch.hotkey !== before) applyHotkey(s.hotkey);
    if (typeof patch.autostart === 'boolean') applyAutostart(s.autostart);
    pushState();
    return s;
  });
  ipcMain.on('magnet:expand', expand);
  ipcMain.on('magnet:dock', dock);
  ipcMain.on('magnet:keepalive', () => { if (mode === 'expanded') clearTimeout(collapseTimer); });
  ipcMain.on('magnet:idle', () => { if (mode === 'expanded') scheduleCollapse(); });
  ipcMain.on('toast:click', () => { try { toastWin && toastWin.destroy(); } catch (e) {} expand(); });
  ipcMain.on('settings:open', createSettingsWindow);
  ipcMain.on('app:quit', () => app.quit());
}

// ============================================================ 托盘
function createTray() {
  tray = new Tray(path.join(ROOT, 'assets', 'tray.png'));
  tray.setToolTip('磁吸便签 SnapNote');
  tray.on('click', toggleMagnet);
  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      ...updaterMenuTemplate(),
      { label: '打开便签', click: expand },
      { label: '设置…', click: createSettingsWindow },
      { type: 'separator' },
      {
        label: '开机自启动',
        type: 'checkbox',
        checked: !!store.settings.autostart,
        click: (item) => {
          store.updateSettings({ autostart: item.checked });
          applyAutostart(item.checked);
          pushState();
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
  };
  rebuild();
  tray._rebuild = rebuild;
}

// ============================================================ 冒烟测试（无头环境跑通核心链路）
const smokeDue = [];
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runSmoke() {
  const ok = (cond, name) => {
    if (!cond) throw new Error('SMOKE_FAIL: ' + name);
    console.log('  ok -', name);
  };
  await wait(400);
  const db = dockedBounds();
  let b = noteWin.getBounds();
  ok(Math.abs(b.x - db.x) <= 2 && b.width === HANDLE_W, '初始贴边把手位置/尺寸');

  store.add('冒烟任务A', new Date(Date.now() + 5000).toISOString());
  store.add('冒烟任务B', null);
  ok(store.tasks.length === 2, '任务写入');

  expand();
  await wait(MAGNET_MS + 250);
  b = noteWin.getBounds();
  const eb = expandedBounds();
  ok(Math.abs(b.width - NOTE_W) <= 2 && Math.abs(b.x - eb.x) <= 2, '展开磁吸至便签尺寸');

  dock();
  await wait(MAGNET_MS + 250);
  b = noteWin.getBounds();
  ok(Math.abs(b.width - HANDLE_W) <= 2, '收回磁吸至把手尺寸');

  scheduler.tick(Date.now() + 6000);
  ok(smokeDue.length === 1 && smokeDue[0] === '冒烟任务A', '到点调度触发且不重复');

  // 每日任务：到点提醒一次 + 滚动到明天 + 不重复
  store.add('冒烟每日C', new Date(Date.now() + 3000).toISOString(), 'daily');
  scheduler.tick(Date.now() + 6000);
  ok(smokeDue.length === 2 && smokeDue[1] === '冒烟每日C', '每日任务到点触发');
  const dailyC = store.tasks.find(t => t.title === '冒烟每日C');
  ok(dailyC && dailyC.repeat === 'daily', '每日任务 repeat 落盘');
  const sd = (x) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
  const dayGap = Math.round((sd(dailyC.dueAt) - sd(Date.now())) / 86400000);
  ok(dayGap >= 1, `每日任务滚动到明天（差 ${dayGap} 天）`);
  scheduler.tick(Date.now() + 6500);
  ok(smokeDue.length === 2, '每日任务提醒后不重复');

  showToast({ title: '早上好，今天有 2 个任务', body: '最早 09:30 部门周会' });
  await wait(900);
  ok(toastWin === null || toastWin.isDestroyed(), 'Toast 自动关闭');

  console.log('SMOKE_OK');
  app.exit(0);
}

// ============================================================ 生命周期
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', expand);

  app.whenReady().then(() => {
    createNoteWindow();
    applyHotkey(store.settings.hotkey);
    applyAutostart(store.settings.autostart);
    setupIpc();
    createTray();
    scheduler.start(20000);

    if (IS_SMOKE) {
      runSmoke().catch(err => { console.error(err); app.exit(1); });
      return;
    }

    // 自动更新：清理上次更新残留，启动 15 秒后台静默检查一次
    updater.cleanupStale();
    if (UPDATER_ON) {
      const checkTimer = setTimeout(() => { checkForUpdate(false); }, 15000);
      if (checkTimer.unref) checkTimer.unref();
    }

    firstRunNotice();

    // 开机今日提醒（PRD FR-07）：登录后约 8 秒，右上角滑入摘要
    const startupTimer = setTimeout(() => {
      if (!store.settings.startupToast) return;
      const today = store.listToday();
      if (today.length === 0) return;
      const earliest = today[0];
      showToast({
        title: `早上好，今天有 ${today.length} 个任务`,
        body: `最早 ${TimeFmt.fmtHM(new Date(earliest.dueAt))} ${earliest.title}`,
      });
    }, FAST ? 500 : 8000);
    if (startupTimer.unref) startupTimer.unref();
  });

  app.on('window-all-closed', () => { /* 常驻托盘，不退出 */ });
  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    if (tray) { tray.destroy(); tray = null; }
    scheduler.stop();
  });
}
