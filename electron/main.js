'use strict';
/**
 * 磁吸便签 SnapNote — Electron 主进程
 * 职责：窗口管理（贴边把手/展开便签 + 磁吸动画）、托盘、全局快捷键、
 *       开机自启、任务 IPC、到点提醒调度、开机今日提醒 Toast。
 */
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain,
  screen, Notification, nativeImage, clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Store } = require('./lib/store');
const { Scheduler } = require('./lib/scheduler');
const { Updater } = require('./lib/updater');
const { MemoStore, ROOT_CATEGORY_ID, sha256: sha256hex } = require('./lib/memo');
const TimeFmt = require('./lib/timeparse');
const crypto = require('crypto');
const { pathToFileURL } = require('url'); // v1.5.2 修正：pathToFileURL 是模块级导出（曾误作 URL 类方法，致图片气泡静默失败）

const IS_SMOKE = process.argv.includes('--smoke-test');
const FAST = IS_SMOKE || process.env.SNAPNOTE_FAST === '1'; // 测试/演示用：缩短收起与 Toast 延时

// 冒烟/CI 无 GPU 环境禁用硬件加速，避免渲染初始化失败（打包产物真实冒烟依赖）
if (IS_SMOKE && app.commandLine && app.commandLine.appendSwitch) {
  app.commandLine.appendSwitch('disable-gpu');
}
// E2E 全流程自测注入独立 userData（scripts/e2e_full.js）：隔离真实用户数据与
// 单实例锁；生产环境不设此变量，零影响。
if (process.env.SNAPNOTE_USER_DATA) {
  app.setPath('userData', process.env.SNAPNOTE_USER_DATA);
}
// E2E 剪贴板写桥（SNAPNOTE_E2E_CLIPBRIDGE 门控）：无头环境里渲染进程的
// navigator.clipboard 因无用户激活被拒——测试用它模拟"用户复制"动作，
// 主进程轮询视角下与真实复制不可区分（同一条系统剪贴板）。生产零暴露。
// 文本：传字符串；图片：传 {imageDataUrl}（canvas 生成后注入，验证图片捕获全链路）。
if (process.env.SNAPNOTE_E2E_CLIPBRIDGE) {
  app.whenReady().then(() => {
    ipcMain.on('e2e:write-clipboard', (_e, t) => {
      if (t && typeof t === 'object' && t.imageDataUrl) {
        clipboard.writeImage(nativeImage.createFromDataURL(String(t.imageDataUrl)));
      } else {
        clipboard.writeText(String(t));
      }
    });
  }).catch(() => {});
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

// 冒烟模式使用独立的临时目录（可用 SNAPNOTE_SMOKE_DIR 注入），且每次启动前清空。
// v1.4.1：默认改用系统临时区——打包态 ROOT 指向 asar 归档（只读），曾致 CI 冒烟
// 写 tasks.json ENOENT 中断（而步骤退出码又被 GUI 子系统吞掉显示假绿）。
const SMOKE_DIR = process.env.SNAPNOTE_SMOKE_DIR || path.join(os.tmpdir(), 'snapnote-smoke');
if (IS_SMOKE) {
  try {
    for (const f of ['tasks.json', 'tasks.json.bak', 'settings.json', 'settings.json.bak']) {
      fs.rmSync(path.join(SMOKE_DIR, f), { force: true });
    }
  } catch (e) { /* 清理失败不阻断 */ }
}
const store = new Store(IS_SMOKE ? SMOKE_DIR : app.getPath('userData'));
const memoStore = new MemoStore(IS_SMOKE ? SMOKE_DIR : app.getPath('userData'));
const scheduler = new Scheduler(store, onTaskDue);
scheduler.onChange = pushState; // 每日任务滚动/复活后同步 UI（pushState 为函数声明，提升可用）

// ============================================================ 自动更新（便携版）
const pkg = require('../package.json');
// v1.6.0 双目录布局：appRoot = 指针/版本目录所在层（exe 在 app-x.y.z 子目录内时
// 为其父目录；平铺旧布局/开发态为 exe 所在目录）。appDir 保留给清理残留用。
const dualdir = require('./lib/dualdir');
const appDir = app.isPackaged ? path.dirname(process.execPath) : ROOT;
const appRoot = app.isPackaged ? dualdir.deriveAppRoot(process.execPath) : ROOT;
// v1.4.1：exe 名从自身进程路径推导（打包后 package.json 的 build 字段会被
// electron-builder 删除，此前靠 build.productName 回落 'SnapNote' 属侥幸巧合）
const exeBase = app.isPackaged
  ? path.basename(process.execPath, path.extname(process.execPath))
  // v1.6.0：打包 exe 名由 build.win.executableName 决定（productName 是用户可见
  // 产品名，不再等于 exe 名——启动器占了 SnapNote.exe）
  : ((pkg.build && pkg.build.win && pkg.build.win.executableName)
    || (pkg.build && pkg.build.productName) || 'SnapNoteApp');
const updater = new Updater({
  owner: pkg.repository && pkg.repository.owner,
  repo: pkg.repository && pkg.repository.repo,
  currentVersion: app.getVersion(),
  appDir,
  appRoot,
  exeBase,
  deps: { log: (...a) => console.log('[updater]', ...a) },
});
const UPDATER_ON = !IS_SMOKE && updater.enabled;

function updaterMenuTemplate() {
  if (!UPDATER_ON) return [];
  const labelFor = () => {
    switch (updater.state) {
      case 'has-update': return `发现新版本 v${updater.lastCheck.version}，点击下载`;
      case 'downloading': return `正在下载… ${updater.progressPct || 0}%`;
      case 'applying': return '正在就位新版本…';
      case 'ready': return `新版本 v${updater.lastCheck.version} 已就绪，重启进新版 ▸`;
      case 'error': return '更新失败，点击重试';
      default: return '检查更新';
    }
  };
  const items = [{ label: labelFor(), click: onUpdaterMenu, enabled: updater.state !== 'applying' }];
  // v1.6.0：回滚到上一版（主动权交给用户——新版有任何问题，一键退回）
  const ch = dualdir.readChannels(appRoot);
  if (ch && ch.previous && ch.previous !== ch.current) {
    const prevVer = String(ch.previous).replace(/^app-/, '');
    items.push({ label: `回滚到 v${prevVer}`, click: onRollbackMenu });
  }
  return items;
}

function onRollbackMenu() {
  if (updater.rollback()) { app.quit(); return; }
  notifyUpdate('回滚未执行', '没有可回滚的旧版本');
}

function refreshTray() {
  if (tray && tray._rebuild) tray._rebuild();
  pushState(); // v1.3.0：更新状态变化同步到设置页/便签头部
}

/** v1.3.0：更新状态摘要（渲染层展示用） */
function updatePayload() {
  if (!UPDATER_ON) return { enabled: false, state: 'disabled', currentVersion: app.getVersion() };
  return {
    enabled: true,
    state: updater.state || 'idle',
    currentVersion: updater.currentVersion || app.getVersion(),
    version: (updater.lastCheck && updater.lastCheck.version) || null,
    progressPct: updater.progressPct || 0,
  };
}

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
    // v1.6.0：下载校验完成后立即在后台「就位」（解压新版本目录 + 翻指针——
    // 全程无破坏，失败=本次更新失败可重试），用户点重启时已万事俱备。
    updater.state = 'applying';
    refreshTray();
    try {
      await updater.applyUpdate();
      updater.state = 'ready';
      refreshTray();
      notifyUpdate('新版本已就绪', '点击立即重启进入新版', restartToUpdate);
    } catch (e) {
      console.error('[updater] apply failed:', e && e.message);
      // v1.6.2：失败必须可见——落盘到 appRoot/.update-work/apply-error.log
      // （用户可直发该文件定位真因；UI 通知带简短原因，不再只有笼统的"失败"）
      const errMsg = e && e.message ? e.message : String(e);
      const logPath = path.join(appRoot, dualdir.WORK_DIR, 'apply-error.log');
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, new Date().toISOString() + ' apply failed: ' + errMsg
          + '\nzip: ' + (updater.zipPath || 'n/a') + '\nappRoot: ' + appRoot + '\n', 'utf8');
      } catch (logE) { console.error('[updater] log write failed:', logE && logE.message); }
      updater.state = 'error';
      refreshTray();
      notifyUpdate('新版本就位失败', '当前版本不受影响。' + errMsg.slice(0, 60) + '（可重试；详见 .update-work\\apply-error.log）');
    }
  } catch (e) {
    updater.state = 'error';
    refreshTray();
    notifyUpdate('下载失败', '网络异常，可稍后从托盘菜单重试');
  }
}

function restartToUpdate() {
  if (updater.state !== 'ready') return;
  if (updater.restartIntoNew()) { app.quit(); return; }
  // 启动失败必须可见——不再静默吞掉（v1.4.1 历史 bug 即此处无声失灵）
  updater.state = 'error';
  refreshTray();
  notifyUpdate('重启进新版未能启动', '请手动退出后从根目录 SnapNote.exe 启动');
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
    update: updatePayload(), // v1.3.0：手动检查更新入口
    memo: { // v1.5.0：便签头部备忘录入口（计数徽章）
      captureOn: !!store.settings.memoCapture,
      count: memoStore.counts().all,
    },
  };
}
function pushState() {
  const data = payload();
  if (noteWin && !noteWin.isDestroyed()) noteWin.webContents.send('state:push', data);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('state:push', data);
  if (memoWin && !memoWin.isDestroyed()) memoWin.webContents.send('state:push', data);
}

// ============================================================ 便签窗口
function createNoteWindow() {
  noteWin = new BrowserWindow({
    ...dockedBounds(),
    frame: false,
    transparent: true,
    // v1.2.1 防挡修复：Windows 上 transparent+frameless 若 resizable:false，
    // setBounds 缩小后 DWM 鼠标命中区可能不跟随（视觉收起、物理仍 340 宽挡点击）。
    // frameless 无边框可拖，resizable:true 无用户可见副作用，但让 API 缩放始终生效。
    resizable: true,
    maximizable: false,
    minimizable: false,
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
  animateBounds(noteWin, dockedBounds(), reassertDocked);
  pushState();
}

/**
 * v1.2.1 防挡修复：收起态硬收敛 + 窗口“重现化”。
 * Windows 透明无边框窗口缩小后，系统层鼠标命中区可能滞后不更新（看起来收起了，
 * 但展开大小的区域仍拦截底层点击）。hide → showInactive 强制 DWM 重建窗口表面，
 * 命中区随之与物理尺寸对齐。showInactive 不抢焦点。
 */
function reassertDocked() {
  if (!noteWin || noteWin.isDestroyed()) return;
  try {
    noteWin.setBounds(dockedBounds());
    if (noteWin.isVisible()) {
      noteWin.hide();
      noteWin.showInactive();
    }
  } catch (e) { /* 窗口竞态销毁时静默 */ }
}

/** v1.2.1 窗口监护：每 2 秒校验 bounds 与 mode 一致，漂移即自愈（DPI 变更/系统干扰等） */
function startWindowGuard() {
  const guard = setInterval(() => {
    if (!noteWin || noteWin.isDestroyed()) return;
    try {
      const b = noteWin.getBounds();
      if (mode === 'docked') {
        const t = dockedBounds();
        if (Math.abs(b.width - HANDLE_W) > 2 || Math.abs(b.height - HANDLE_H) > 2
          || Math.abs(b.x - t.x) > 4 || Math.abs(b.y - t.y) > 4) {
          reassertDocked();
        }
      } else if (mode === 'expanded') {
        const t = expandedBounds();
        if (Math.abs(b.width - NOTE_W) > 2 || Math.abs(b.height - t.height) > 4) {
          noteWin.setBounds(t); // 展开态只收敛不重现化，避免使用中闪动
        }
      }
    } catch (e) { /* ignore */ }
  }, 2000);
  if (guard.unref) guard.unref();
}

function toggleMagnet() { mode === 'expanded' ? dock() : expand(); }

/** 失焦 collapseDelay 秒后自动磁吸回右缘（PRD FR-03） */
function scheduleCollapse() {
  if (reminderWin && !reminderWin.isDestroyed()) return; // v1.4.0：全屏提醒期间便签不收起，等用户处理完
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
  // v1.3.0：打开即推送完整状态（设置页「软件更新」区需要初始版本/更新状态）
  const pushToSettings = () => {
    try { settingsWin.webContents.send('state:push', payload()); } catch (e) { /* ignore */ }
  };
  if (settingsWin.webContents.isLoading()) {
    settingsWin.webContents.once('did-finish-load', pushToSettings);
  } else pushToSettings();
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ============================================================ 全局快捷键
let currentHotkeyOk = true;
function applyHotkey(hotkey) {
  // v1.5.0：统一注册全部全局快捷键（便签主键 + 备忘录收集/打开键，均用户可自定义）
  globalShortcut.unregisterAll();
  currentHotkeyOk = true;
  try {
    globalShortcut.register(hotkey, toggleMagnet);
  } catch (e) {
    currentHotkeyOk = false;
  }
  if (!globalShortcut.isRegistered(hotkey)) currentHotkeyOk = false;
  const memoKeys = [
    [store.settings.memoCaptureHotkey, quickCapture],
    [store.settings.memoOpenHotkey, createMemoWindow],
  ];
  memoHotkeysOk = {};
  for (const [k, fn] of memoKeys) {
    let ok = false;
    try { ok = !!globalShortcut.register(k, fn); } catch (e) { ok = false; }
    memoHotkeysOk[k] = ok; // 冲突键记录（渲染层提示），不阻断其他键
  }
}
let memoHotkeysOk = {};

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

// ============================================================ 到点提醒（v1.4.0：全屏强提醒）
let reminderWin = null;      // 单例：多条到期聚合进同一张全屏卡片
let reminderQueue = [];      // 当前卡片承载的到期任务（关闭即清空，notified 已置不重弹）

function onTaskDue(task) {
  if (IS_SMOKE) smokeDue.push(task.title);
  showReminder(task);
  if (noteWin && !noteWin.isDestroyed()) noteWin.webContents.send('due:alert', task);
}

function showReminder(task) {
  reminderQueue.push(task);
  if (reminderWin && !reminderWin.isDestroyed()) {
    // 尚在加载中：did-finish-load 的 payload 快照会带上它，避免增量消息丢失
    if (reminderWin.webContents.isLoading()) return;
    try {
      reminderWin.webContents.send('reminder:add', task);
      reminderWin.focus();
    } catch (e) { /* 窗口竞态销毁时静默 */ }
    return;
  }
  createReminderWindow();
}

function createReminderWindow() {
  const wa = workArea();
  reminderWin = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    frame: false, transparent: true, resizable: false, movable: false,
    skipTaskbar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  reminderWin.setAlwaysOnTop(true, 'screen-saver'); // 高于一切普通置顶窗
  reminderWin.loadFile(path.join(ROOT, 'renderer', 'reminder.html'));
  const send = () => {
    try { reminderWin.webContents.send('reminder:payload', reminderQueue.slice()); } catch (e) { /* ignore */ }
  };
  if (reminderWin.webContents.isLoading()) {
    reminderWin.webContents.once('did-finish-load', send);
  } else send();
  reminderWin.once('ready-to-show', () => {
    try { reminderWin.show(); reminderWin.focus(); } catch (e) { /* ignore */ }
  });
  reminderWin.on('closed', () => { reminderWin = null; reminderQueue = []; });
}

function closeReminder() {
  if (reminderWin && !reminderWin.isDestroyed()) reminderWin.close();
}

// ============================================================ 备忘录（v1.5.0）
// 剪贴板捕获（复制即收集悬浮气泡）+ 备忘录管理窗口 + 快捷收集
let memoWin = null;
let captureWin = null;
let pendingCapture = null;   // 当前气泡对应的待归档内容
let lastClipFp = null;       // 上次见过的剪贴板指纹（变化才触发气泡）
let selfCopyUntil = 0;       // memo:copyItem 写剪贴板后的豁免窗（防自己弹自己）
let clipTimer = null;
const CLIP_POLL_MS = FAST ? 400 : 800;
const CAPTURE_W = 396, CAPTURE_H = 232;
const CAPTURE_COUNTDOWN = 8; // 气泡自动忽略秒数

function memoAssetsDir() {
  return path.join(IS_SMOKE ? SMOKE_DIR : app.getPath('userData'), 'memo-assets');
}

/** 图片落盘：原图 PNG + 缩略 JPEG（240px），返回元数据（hash 内容寻址，天然去重） */
function saveMemoImage(nativeImg) {
  const png = nativeImg.toPNG();
  const hash = crypto.createHash('sha256').update(png).digest('hex');
  const dir = memoAssetsDir();
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, hash + '.png');
  const thumb = path.join(dir, hash + '_t.jpg');
  if (!fs.existsSync(full)) fs.writeFileSync(full, png);
  if (!fs.existsSync(thumb)) {
    try {
      const t = nativeImg.getSize();
      const scale = Math.min(1, 240 / Math.max(1, Math.max(t.width, t.height)));
      const small = scale < 1 ? nativeImg.resize({ width: Math.max(1, Math.round(t.width * scale)) }) : nativeImg;
      fs.writeFileSync(thumb, small.toJPEG(78));
    } catch (e) { /* 缩略失败不阻断，详情用原图 */ }
  }
  const sz = nativeImg.getSize();
  return { hash, w: sz.width, h: sz.height, thumbUrl: pathToFileURL(thumb).href };
}

/** 读取剪贴板 → {type, fp, text?, img?}；空返回 null。
 *  v1.5.2：图片优先——Windows 部分来源（Word 内嵌图、资源管理器 Ctrl+C 图片
 *  文件、部分浏览器）复制图片时会连带文本格式（文件路径/备用文本）入剪贴板，
 *  先读文本会把图片误收成一串路径。readImage 对纯文本剪贴板返回空、代价极低，
 *  顺序反转后文本收集不受影响（纯文本时 readImage 为空才走文本分支）。
 */
function readClipboard() {
  const img = clipboard.readImage();
  if (img && !img.isEmpty()) {
    const png = img.toPNG();
    return { type: 'image', img, fp: crypto.createHash('sha256').update(png).digest('hex') };
  }
  const text = clipboard.readText();
  if (text && text.trim()) {
    return { type: 'text', text, fp: sha256hex(text) };
  }
  return null;
}

/** 条目（列表/详情）序列化：附加缩略图 URL（file://） */
function memoItemView(it) {
  if (it.type !== 'image' || !it.imageHash) return { ...it };
  const dir = memoAssetsDir();
  const thumb = path.join(dir, it.imageHash + '_t.jpg');
  const full = path.join(dir, it.imageHash + '.png');
  return {
    ...it,
    thumbUrl: fs.existsSync(thumb) ? pathToFileURL(thumb).href : null,
    fullUrl: fs.existsSync(full) ? pathToFileURL(full).href : null,
  };
}

function memoStatePayload() {
  return {
    categories: memoStore.categoriesFlat(),
    recentCatIds: memoStore.recentCatIds,
    counts: memoStore.counts(),
    settings: {
      memoCapture: !!store.settings.memoCapture,
      memoCaptureHotkey: store.settings.memoCaptureHotkey,
      memoOpenHotkey: store.settings.memoOpenHotkey,
    },
  };
}

/** 悬浮捕获气泡：右下角、无框、置顶、不抢焦点。
 *  v1.5.4：图片气泡窗口高度随图片宽高比自适应（竖长图不再压成细条、
 *  横图不留大片空白）；文本气泡维持固定尺寸。
 */
function showCaptureBubble(pending) {
  if (captureWin && !captureWin.isDestroyed()) { try { captureWin.destroy(); } catch (e) {} }
  pendingCapture = pending;
  const wa = screen.getPrimaryDisplay().workArea;
  // 预览区可用尺寸：宽 ~340（窗口 396 - 双侧留白），高上限 300
  let h = CAPTURE_H;
  if (pending.type === 'image' && pending.w && pending.h) {
    const scale = Math.min(340 / pending.w, 300 / pending.h, 1);
    h = Math.max(CAPTURE_H, Math.min(560, Math.round(pending.h * scale) + 140));
  }
  captureWin = new BrowserWindow({
    x: wa.x + wa.width - CAPTURE_W - 16,
    y: wa.y + wa.height - h - 12,
    width: CAPTURE_W, height: h,
    frame: false, resizable: false, movable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  captureWin.loadFile(path.join(ROOT, 'renderer', 'capture.html'));
  const send = () => {
    try {
      captureWin.webContents.send('capture:payload', {
        type: pending.type,
        preview: pending.type === 'text'
          ? String(pending.text).slice(0, 120)
          : pending.thumbDataURL,
        categories: memoStore.categoriesFlat(),
        recentCatIds: memoStore.recentCatIds,
        countdown: CAPTURE_COUNTDOWN,
      });
    } catch (e) { /* ignore */ }
  };
  if (captureWin.webContents.isLoading()) captureWin.webContents.once('did-finish-load', send);
  else send();
  captureWin.once('ready-to-show', () => { try { captureWin.showInactive(); } catch (e) {} });
  captureWin.on('closed', () => { captureWin = null; pendingCapture = null; });
}

/** 图片气泡预览：提前生成小缩略 dataURL（气泡窗口用 dataURL，简单直接） */
function thumbDataURLFor(nativeImg, maxPx) {
  try {
    const t = nativeImg.getSize();
    const scale = Math.min(1, maxPx / Math.max(1, Math.max(t.width, t.height)));
    const small = scale < 1 ? nativeImg.resize({ width: Math.max(1, Math.round(t.width * scale)) }) : nativeImg;
    return 'data:image/jpeg;base64,' + small.toJPEG(70).toString('base64');
  } catch (e) { return null; }
}

function onClipboardTick() {
  try {
    if (!store.settings.memoCapture) return;
    if (captureWin && !captureWin.isDestroyed()) return; // 上一条气泡未决，不叠弹
    const clip = readClipboard();
    if (!clip || clip.fp === lastClipFp) return;
    lastClipFp = clip.fp;
    if (Date.now() < selfCopyUntil) return; // 自己复制的内容不弹
    if (clip.type === 'text' && clip.text.trim().length < 2) return; // 碎片不打扰
    if (clip.type === 'image') {
      const saved = saveMemoImage(clip.img);
      showCaptureBubble({
        type: 'image', imageHash: saved.hash, w: saved.w, h: saved.h,
        thumbDataURL: thumbDataURLFor(clip.img, 360), source: 'clipboard',
      });
    } else {
      showCaptureBubble({ type: 'text', text: clip.text, source: 'clipboard' });
    }
  } catch (e) { /* 轮询永不抛出 */ }
}

function startClipboardWatch() {
  if (IS_SMOKE) return; // 冒烟环境无剪贴板交互，且不能弹气泡
  if (clipTimer) return;
  clipTimer = setInterval(onClipboardTick, CLIP_POLL_MS);
  if (clipTimer.unref) clipTimer.unref();
}

/** 快捷键直达收集：当前剪贴板 → 默认分类（最近使用，否则快速收集），无气泡 */
function quickCapture() {
  const clip = readClipboard();
  if (!clip) {
    if (Notification.isSupported()) new Notification({ title: '备忘录', body: '剪贴板是空的，先复制点内容吧' }).show();
    return;
  }
  lastClipFp = clip.fp; // 收集后同内容不再弹气泡
  const catId = memoStore.recentCatIds[0] || ROOT_CATEGORY_ID;
  const cat = memoStore._cat(catId) ? memoStore._cat(catId) : memoStore._cat(ROOT_CATEGORY_ID);
  const r = addItemFromClip(clip, cat.id);
  const body = r && r.duplicate
    ? `内容已存在于「${cat.name}」（10 分钟内收集过）`
    : `已存入「${cat.name}」`;
  if (Notification.isSupported()) {
    const n = new Notification({ title: '备忘录 · 快速收集', body });
    n.on('click', createMemoWindow);
    n.show();
  }
  if (memoWin && !memoWin.isDestroyed()) pushMemoState();
}

function addItemFromClip(clip, catId) {
  const base = {
    categoryId: catId,
    source: clip.source || 'clipboard',
  };
  if (clip.type === 'image') {
    const saved = clip.saved || saveMemoImage(clip.img);
    return memoStore.addItem({ ...base, type: 'image', imageHash: saved.hash, imageW: saved.w, imageH: saved.h });
  }
  return memoStore.addItem({ ...base, type: 'text', text: clip.text });
}

function pushMemoState() {
  if (memoWin && !memoWin.isDestroyed()) {
    try { memoWin.webContents.send('state:push', payload()); } catch (e) { /* ignore */ }
  }
}

function createMemoWindow() {
  if (memoWin && !memoWin.isDestroyed()) { memoWin.focus(); return; }
  const saved = store.settings.memoWinBounds || {};
  const wa = screen.getPrimaryDisplay().workArea;
  const w = Math.min(saved.w || 920, wa.width - 60);
  const h = Math.min(saved.h || 620, wa.height - 60);
  memoWin = new BrowserWindow({
    x: saved.x != null ? saved.x : undefined,
    y: saved.y != null ? saved.y : undefined,
    width: w, height: h,
    minWidth: 720, minHeight: 480,
    title: '磁吸便签 · 备忘录',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  memoWin.loadFile(path.join(ROOT, 'renderer', 'memo.html'));
  const pushToMemo = () => { try { memoWin.webContents.send('state:push', payload()); } catch (e) { /* ignore */ } };
  if (memoWin.webContents.isLoading()) memoWin.webContents.once('did-finish-load', pushToMemo);
  else pushToMemo();
  const saveBounds = () => {
    try {
      const b = memoWin.getBounds();
      store.settings.memoWinBounds = { x: b.x, y: b.y, w: b.width, h: b.height };
      store.persistSettings();
    } catch (e) { /* ignore */ }
  };
  memoWin.on('resized', saveBounds);
  memoWin.on('moved', saveBounds);
  memoWin.on('closed', () => { memoWin = null; });
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
    const before = { hotkey: store.settings.hotkey, cap: store.settings.memoCaptureHotkey, open: store.settings.memoOpenHotkey };
    const s = store.updateSettings(patch);
    if ((patch.hotkey && patch.hotkey !== before.hotkey)
      || (patch.memoCaptureHotkey && patch.memoCaptureHotkey !== before.cap)
      || (patch.memoOpenHotkey && patch.memoOpenHotkey !== before.open)) {
      applyHotkey(s.hotkey); // applyHotkey 注册全部全局快捷键（含备忘录两个）
    }
    if (typeof patch.autostart === 'boolean') applyAutostart(s.autostart);
    if (tray && tray._rebuild) tray._rebuild(); // 捕获开关等托盘勾选项同步
    pushState();
    return s;
  });

  // ---- v1.5.0 备忘录 ----
  ipcMain.handle('memo:state', () => memoStatePayload());
  ipcMain.handle('memo:items', (_e, o) => memoStore.list(o || {}).map(memoItemView));
  ipcMain.handle('memo:addCategory', (_e, { name, parentId }) => memoStore.addCategory(name, parentId || null));
  ipcMain.handle('memo:renameCategory', (_e, { id, name }) => memoStore.renameCategory(id, name));
  ipcMain.handle('memo:moveCategory', (_e, { id, parentId }) => memoStore.moveCategory(id, parentId || null));
  ipcMain.handle('memo:reorderCategory', (_e, { id, dir }) => memoStore.reorderCategory(id, dir));
  ipcMain.handle('memo:removeCategory', (_e, { id, deleteItems }) => memoStore.removeCategory(id, !!deleteItems));
  ipcMain.handle('memo:addItem', (_e, o) => {
    const r = memoStore.addItem({
      type: o.type === 'image' ? 'image' : 'text',
      text: o.type === 'image' ? undefined : String(o.text || ''),
      // v1.6.1：补透传 image 元数据（此前仅剪贴板捕获通道传全字段，渲染层
      // 直接 addItem 的图片条目被静默砍成 null——e2e_lightbox 抓获）
      imageHash: o.imageHash,
      imageW: o.imageW,
      imageH: o.imageH,
      categoryId: o.categoryId || null,
      sensitive: !!o.sensitive,
      note: o.note || '',
      source: o.source || 'manual',
    });
    pushMemoState();
    pushState();
    return r;
  });
  ipcMain.handle('memo:updateItem', (_e, { id, patch }) => {
    const r = memoStore.updateItem(id, patch || {});
    pushMemoState();
    return r;
  });
  ipcMain.handle('memo:removeItem', (_e, { id }) => {
    const r = memoStore.removeItem(id);
    pushMemoState();
    pushState();
    return r;
  });
  ipcMain.handle('memo:moveItem', (_e, { id, categoryId }) => {
    const r = memoStore.moveItem(id, categoryId || null);
    pushMemoState();
    return r;
  });
  ipcMain.handle('memo:copyItem', async (_e, { id }) => {
    const it = memoStore.item(id);
    if (!it) return { ok: false };
    try {
      if (it.type === 'image') {
        const full = path.join(memoAssetsDir(), it.imageHash + '.png');
        clipboard.writeImage(nativeImage.createFromBuffer(fs.readFileSync(full)));
      } else {
        clipboard.writeText(it.text || '');
      }
      // 豁免自身：轮询侧读回同一内容并记指纹，避免气泡弹自己
      const clip = readClipboard();
      if (clip) lastClipFp = clip.fp;
      selfCopyUntil = Date.now() + 3000;
      return { ok: true };
    } catch (e) { return { ok: false }; }
  });
  ipcMain.on('memo:open', createMemoWindow);
  // 捕获气泡
  ipcMain.on('capture:archive', (_e, { categoryId }) => {
    if (!pendingCapture) return;
    const catId = memoStore._cat(categoryId) ? categoryId : (pendingCapture.categoryId || ROOT_CATEGORY_ID);
    const r = addItemFromClip(pendingCapture, catId);
    memoStore.touchCategory(catId);
    const cat = memoStore._cat(catId);
    try {
      captureWin && captureWin.webContents.send('capture:done', {
        catName: cat ? cat.name : '快速收集',
        duplicate: !!(r && r.duplicate),
      });
    } catch (e) { /* ignore */ }
    pushMemoState();
    pushState();
  });
  ipcMain.on('capture:ignore', () => { try { captureWin && captureWin.destroy(); } catch (e) {} });

  // v1.3.0 手动检查更新（设置页「软件更新」区 / 便签头部按钮）
  ipcMain.handle('update:check', async () => {
    await checkForUpdate(true);
    return updatePayload();
  });
  ipcMain.handle('update:download', () => { startDownload(); return updatePayload(); });
  ipcMain.handle('update:restart', () => { restartToUpdate(); return updatePayload(); });
  ipcMain.on('reminder:action', (_e, act) => {
    // v1.4.0：全屏提醒的两个出口——「完成它」勾掉任务；「稍后处理」仅关闭（notified 已置不重弹）
    if (act === 'done') {
      reminderQueue.forEach(t => {
        const cur = store.list().find(x => x.id === t.id);
        if (cur && !cur.done) store.toggle(t.id);
      });
    }
    reminderQueue = [];
    closeReminder();
    pushState();
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
      { label: '备忘录', click: createMemoWindow },
      {
        label: '剪贴板捕获',
        type: 'checkbox',
        checked: !!store.settings.memoCapture,
        click: (item) => {
          store.updateSettings({ memoCapture: item.checked });
          pushState();
        },
      },
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

  // v1.5.0：备忘录数据层就绪 + IPC 通道可用（渲染窗口自检由 memo:state 拉取验证）
  ok(memoStore._cat(ROOT_CATEGORY_ID) && memoStore.categories.length >= 4, '备忘录分类树就绪');
  const memoItem = memoStore.addItem({ type: 'text', text: '冒烟备忘条目', categoryId: ROOT_CATEGORY_ID, source: 'manual' });
  ok(memoItem && memoStore.list({ categoryId: 'cat-root' }).length === 1, '备忘录条目写入');
  ok(memoStore.removeItem(memoItem.id) && memoStore.items.length === 0, '备忘录条目清理');

  expand();
  await wait(MAGNET_MS + 250);
  b = noteWin.getBounds();
  const eb = expandedBounds();
  ok(Math.abs(b.width - NOTE_W) <= 2 && Math.abs(b.x - eb.x) <= 2, '展开磁吸至便签尺寸');

  dock();
  await wait(MAGNET_MS + 250);
  b = noteWin.getBounds();
  ok(Math.abs(b.width - HANDLE_W) <= 2, '收回磁吸至把手尺寸');

  // v1.2.1 防挡：模拟窗口被外部改大（Windows DWM 命中区漂移路径），监护应自愈
  noteWin.setBounds({ x: db.x - (NOTE_W - HANDLE_W), y: db.y, width: NOTE_W, height: 560 });
  await wait(2500);
  b = noteWin.getBounds();
  ok(Math.abs(b.width - HANDLE_W) <= 2 && Math.abs(b.x - db.x) <= 4, '监护自愈：被改大后收敛回收起尺寸');
  ok(noteWin.isVisible(), '自愈重现化后窗口保持可见');

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

  // v1.4.0：到点全屏强提醒（真实窗口链路：出现 → 显示任务 → 稍后处理关闭）
  await wait(600);
  ok(reminderWin && !reminderWin.isDestroyed(), '到点弹出全屏提醒');
  let rInfo = null;
  try {
    rInfo = await reminderWin.webContents.executeJavaScript(
      "(() => ({ n: document.querySelectorAll('.task').length,"
      + " first: (document.querySelector('.t-title') || {}).textContent || '' }))()");
  } catch (e) { /* mock 环境：无页面 UI，跳过文案级断言 */ }
  if (rInfo) {
    ok(rInfo.n >= 2 && rInfo.first.indexOf('冒烟') >= 0,
      `提醒卡片聚合显示到期任务（n=${rInfo.n} first=${rInfo.first}）`);
  }
  if (rInfo) {
    // 真实环境：点真按钮 → 渲染层走 reminder:action IPC
    await reminderWin.webContents.executeJavaScript('document.getElementById("btnAck").click()');
  } else {
    // mock 环境：无页面 UI，直接模拟渲染层发出同款 IPC
    ipcMain.emit('reminder:action', null, 'ack');
  }
  await wait(500);
  ok(reminderWin === null || reminderWin.isDestroyed(), '稍后处理关闭全屏提醒');

  showToast({ title: '早上好，今天有 2 个任务', body: '最早 09:30 部门周会' });
  await wait(900);
  ok(toastWin === null || toastWin.isDestroyed(), 'Toast 自动关闭');

  console.log('SMOKE_OK');
  app.exit(0);
}

// ============================================================ 生命周期
/**
 * v1.6.0 单实例锁：更新重启/回滚场景下，新进程 spawn 时旧进程退出存在窗口期。
 * 带 --wait-lock 启动的进程最多重试 10 秒等锁释放，避免「点了重启进新版，
 * 新进程起来发现锁还被旧进程占着，直接退出」的竞态空窗。
 */
const WAIT_LOCK = process.argv.includes('--wait-lock');
async function acquireInstanceLock() {
  for (let attempt = 0; ; attempt++) {
    if (app.requestSingleInstanceLock()) return true;
    if (!WAIT_LOCK || attempt >= 20) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

acquireInstanceLock().then((locked) => {
if (!locked) {
  app.quit();
} else {
  app.on('second-instance', expand);

  app.whenReady().then(() => {
    createNoteWindow();
    applyHotkey(store.settings.hotkey);
    applyAutostart(store.settings.autostart);
    setupIpc();
    createTray();
    startClipboardWatch(); // v1.5.0：剪贴板捕获（复制即收集）
    scheduler.start(FAST ? 300 : 20000); // FAST（测试/冒烟）下 300ms 一拍，便于驱动到点链路
    startWindowGuard(); // v1.2.1：窗口 bounds 与 mode 漂移自愈

    if (IS_SMOKE) {
      runSmoke().catch(err => { console.error(err); app.exit(1); });
      return;
    }

    // 自动更新：v1.6.0 首跑清理（上一版目录/工作目录/迁移残留 .old），随后 15 秒后台静默检查
    updater.cleanupPrevious();
    // v1.6.3：自报安装位置（升级器 SnapNoteUpgrader.exe 的寻址锚）——
    // %AppData%\SnapNote\install-location.txt。best-effort：写不进不影响功能。
    if (app.isPackaged) {
      try {
        const locDir = path.join(app.getPath('appData'), 'SnapNote');
        fs.mkdirSync(locDir, { recursive: true });
        fs.writeFileSync(path.join(locDir, 'install-location.txt'), appRoot + '\n', 'utf8');
      } catch (e) { /* 升级器会回落到手选目录 */ }
    }
    // v1.5.5 遗留：检测上次更新替换失败留痕（PS 链最后一跑的 update-error.log）
    // ——迁移失败不再无声无息；通知一次后清理，避免每次启动都打扰
    const updateErrFile = path.join(appRoot, 'update-error.log');
    if (app.isPackaged && fs.existsSync(updateErrFile)) {
      try { fs.unlinkSync(updateErrFile); } catch (e) { /* ignore */ }
      if (Notification.isSupported()) {
        new Notification({
          title: '上次更新未完成',
          body: '替换阶段出错，已保住当前版本。请从托盘菜单重试更新；若再次失败请截图发给开发者。',
        }).show();
      }
    }
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
}); // acquireInstanceLock().then

// 测试钩子（v1.4.1 回归防护）：node --test 下暴露更新器装配供完备性断言。
// 装配缺配曾导致"重启更新"静默失灵（deps.spawn 未注入），生产/冒烟环境不触发。
if (process.env.NODE_TEST_CONTEXT) {
  module.exports = { __updater: updater, __exeBase: exeBase };
}
