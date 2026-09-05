'use strict';
/** 渲染层 ↔ 主进程桥（contextIsolation 安全通道） */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapnote', {
  // 状态
  ready: () => ipcRenderer.invoke('ui:ready'),
  onPush: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('state:push', h);
    return () => ipcRenderer.removeListener('state:push', h);
  },
  onViewMode: (cb) => ipcRenderer.on('view:mode', (_e, m) => cb(m)),
  onDueAlert: (cb) => ipcRenderer.on('due:alert', (_e, task) => cb(task)),
  onToast: (cb) => ipcRenderer.on('toast:payload', (_e, data) => cb(data)),

  // 磁吸
  expand: () => ipcRenderer.send('magnet:expand'),
  dock: () => ipcRenderer.send('magnet:dock'),
  keepalive: () => ipcRenderer.send('magnet:keepalive'),
  idle: () => ipcRenderer.send('magnet:idle'),

  // 任务
  addTask: (title, dueAt) => ipcRenderer.invoke('tasks:add', { title, dueAt }),
  toggleTask: (id) => ipcRenderer.invoke('tasks:toggle', id),
  removeTask: (id) => ipcRenderer.invoke('tasks:remove', id),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openSettings: () => ipcRenderer.send('settings:open'),
  quitApp: () => ipcRenderer.send('app:quit'),

  // Toast
  toastClick: () => ipcRenderer.send('toast:click'),
});
