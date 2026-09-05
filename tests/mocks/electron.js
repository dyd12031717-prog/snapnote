'use strict';
/**
 * Electron API 桩模块（仅测试用）
 * 在 node 环境下模拟主进程所需的 BrowserWindow / Tray / globalShortcut /
 * ipcMain / screen / Notification / app，让 main.js 可被直接加载测试。
 */
const { EventEmitter } = require('node:events');

const state = {
  windows: [],
  sent: [],          // 所有 webContents.send 记录
  hotkeys: new Map(),
  loginItems: null,
  notifications: [],
  appHandlers: new EventEmitter(),
};

class WebContents {
  constructor(win) { this.win = win; this._once = {}; }
  isLoading() { return false; }
  send(channel, data) { state.sent.push({ win: this.win, channel, data }); }
  once(ev, cb) { this._once[ev] = cb; }
  emitOnce(ev) { if (this._once[ev]) { const cb = this._once[ev]; delete this._once[ev]; cb(); } }
}

class BrowserWindow {
  constructor(opts) {
    this.opts = opts;
    this._bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 0, height: opts.height || 0 };
    this._destroyed = false;
    this.webContents = new WebContents(this);
    this._handlers = new EventEmitter();
    state.windows.push(this);
  }
  loadFile(p) { this.loadedFile = p; return Promise.resolve(); }
  setBounds(b) { Object.assign(this._bounds, b); }
  getBounds() { return { ...this._bounds }; }
  setAlwaysOnTop() {}
  focus() { this.focused = true; }
  isDestroyed() { return this._destroyed; }
  destroy() { this._destroyed = true; this._handlers.emit('closed'); }
  close() { this.destroy(); }
  on(ev, cb) { this._handlers.on(ev, cb); }
  emitWin(ev) { this._handlers.emit(ev); }
}

class Tray {
  constructor(img) { this.img = img; this._destroyed = false; this._h = new EventEmitter(); }
  setToolTip(t) { this.tip = t; }
  setContextMenu(m) { this.menu = m; }
  on(ev, cb) { this._h.on(ev, cb); }
  emitTray(ev) { this._h.emit(ev); }
  destroy() { this._destroyed = true; }
  isDestroyed() { return this._destroyed; }
}

class Notification {
  constructor(opts) { this.opts = opts; }
  show() { state.notifications.push(this.opts); }
  on() { return this; }
  static isSupported() { return false; }
}

class IpcMain extends EventEmitter {
  constructor() { super(); this.handlers = new Map(); }
  handle(channel, fn) { this.handlers.set(channel, fn); }
  _invoke(channel, arg) {
    if (!this.handlers.has(channel)) throw new Error('no handler: ' + channel);
    return this.handlers.get(channel)({ sender: null }, arg);
  }
}

const app = {
  isPackaged: false,
  userDataDir: null,
  exitCode: null,
  requestSingleInstanceLock() { return true; },
  on: (ev, cb) => state.appHandlers.on(ev, cb),
  whenReady() { return Promise.resolve(); },
  getPath() { return process.env.SNAPNOTE_MOCK_USER_DATA || '/tmp/snapnote-mock'; },
  setLoginItemSettings(o) { state.loginItems = o; },
  exit(code) { app.exitCode = code; state.appHandlers.emit('__exit', code); },
  quit() { state.appHandlers.emit('before-quit'); },
};

module.exports = {
  app, BrowserWindow, Tray, Notification,
  Menu: { buildFromTemplate: (tpl) => ({ template: tpl }) },
  globalShortcut: {
    register(hk, cb) { state.hotkeys.set(hk, cb); },
    isRegistered(hk) { return state.hotkeys.has(hk); },
    unregisterAll() { state.hotkeys.clear(); },
  },
  ipcMain: new IpcMain(),
  screen: { getPrimaryDisplay() { return { workArea: { x: 0, y: 0, width: 1600, height: 900 } }; } },
  nativeImage: { createFromPath: () => ({}) },
  __state: state,
};
