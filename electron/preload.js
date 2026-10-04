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
  addTask: (title, dueAt, repeat) => ipcRenderer.invoke('tasks:add', { title, dueAt, repeat }),
  toggleTask: (id) => ipcRenderer.invoke('tasks:toggle', id),
  removeTask: (id) => ipcRenderer.invoke('tasks:remove', id),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openSettings: () => ipcRenderer.send('settings:open'),
  quitApp: () => ipcRenderer.send('app:quit'),

  // 更新（v1.3.0 手动检查）
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  restartUpdate: () => ipcRenderer.invoke('update:restart'),

  // 全屏强提醒（v1.4.0）
  reminderAction: (act) => ipcRenderer.send('reminder:action', act),
  onReminder: (cb) => ipcRenderer.on('reminder:payload', (_e, tasks) => cb(tasks)),
  onReminderAdd: (cb) => ipcRenderer.on('reminder:add', (_e, t) => cb(t)),

  // Toast
  toastClick: () => ipcRenderer.send('toast:click'),

  // 备忘录（v1.5.0）
  memoOpen: () => ipcRenderer.send('memo:open'),
  memoState: () => ipcRenderer.invoke('memo:state'),
  memoItems: (o) => ipcRenderer.invoke('memo:items', o),
  memoAddCategory: (name, parentId) => ipcRenderer.invoke('memo:addCategory', { name, parentId }),
  memoRenameCategory: (id, name) => ipcRenderer.invoke('memo:renameCategory', { id, name }),
  memoMoveCategory: (id, parentId) => ipcRenderer.invoke('memo:moveCategory', { id, parentId }),
  memoReorderCategory: (id, dir) => ipcRenderer.invoke('memo:reorderCategory', { id, dir }),
  memoRemoveCategory: (id, deleteItems) => ipcRenderer.invoke('memo:removeCategory', { id, deleteItems }),
  memoAddItem: (o) => ipcRenderer.invoke('memo:addItem', o),
  memoUpdateItem: (id, patch) => ipcRenderer.invoke('memo:updateItem', { id, patch }),
  memoRemoveItem: (id) => ipcRenderer.invoke('memo:removeItem', { id }),
  memoMoveItem: (id, categoryId) => ipcRenderer.invoke('memo:moveItem', { id, categoryId }),
  memoCopyItem: (id) => ipcRenderer.invoke('memo:copyItem', { id }),

  // 捕获气泡（v1.5.0）
  onCapturePayload: (cb) => ipcRenderer.on('capture:payload', (_e, d) => cb(d)),
  onCaptureDone: (cb) => ipcRenderer.on('capture:done', (_e, d) => cb(d)),
  captureArchive: (categoryId) => ipcRenderer.send('capture:archive', { categoryId }),
  captureIgnore: () => ipcRenderer.send('capture:ignore'),

  // E2E 剪贴板写桥：渲染层无条件暴露（仅自家 file:// 页面加载，无外部内容），
  // 主进程端由 SNAPNOTE_E2E_CLIPBRIDGE 门控注册 handler——生产环境该消息无人接收。
  // （沙箱 preload 读不到自定义 env，故门控只能放主进程侧）
  e2eWriteClipboard: (t) => ipcRenderer.send('e2e:write-clipboard', t),
});
