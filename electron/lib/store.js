'use strict';
/**
 * SnapNote 任务存储层
 * - tasks.json / settings.json 存放于应用数据目录（测试可注入自定义目录）
 * - 原子写入（tmp + rename），写入前保留 .bak 副本，损坏时自动回退
 * - 纯 CommonJS，无 Electron 依赖，可被单元测试直接加载
 */
const fs = require('fs');
const path = require('path');

const TASKS_SCHEMA = 1;

const DEFAULT_SETTINGS = {
  hotkey: 'Ctrl+Alt+N',   // 全局快捷键（可在设置中修改）
  autostart: true,        // 开机自启动
  sound: true,            // 到点提醒提示音
  collapseDelay: 30,      // 失焦后自动磁收回边缘的秒数
  startupToast: true,     // 开机今日任务提醒卡片
};

function newId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 本地时区的“同一天”判断 */
function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function isToday(iso, now) {
  if (!iso) return false;
  return isSameDay(new Date(iso), now || new Date());
}

/** 下一个每日触发时刻：今天 hh:mm（已过则明天）。秒截零。 */
function nextDailyAt(now, hh, mm) {
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * 今日任务 = 未完成且到期日在今天（含已过期），或未完成的每日任务。
 * 每日任务的 dueAt 是"下一次触发时刻"，提醒后会滚到明天——
 * 但只要今天还没打卡（done=false），它仍然算"今天的事"。
 */
function listToday(tasks, now) {
  const n = now || new Date();
  return tasks.filter(t =>
    !t.done && t.dueAt
    && (t.repeat === 'daily' || isSameDay(new Date(t.dueAt), n))
  );
}

function cmpTasks(a, b, now) {
  const n = now || new Date();
  const ua = a.done ? 1 : 0, ub = b.done ? 1 : 0;
  if (ua !== ub) return ua - ub; // 未完成在前
  if (ua === 1) { // 均已完成：完成时间倒序
    return String(b.completedAt || '').localeCompare(String(a.completedAt || ''));
  }
  const da = a.dueAt ? new Date(a.dueAt).getTime() : null;
  const db = b.dueAt ? new Date(b.dueAt).getTime() : null;
  if (da === null && db === null) return String(b.createdAt).localeCompare(String(a.createdAt));
  if (da === null) return 1;
  if (db === null) return -1;
  return da - db;
}

class Store {
  /**
   * @param {string} [baseDir] 数据目录；生产环境传 app.getPath('userData')
   */
  constructor(baseDir) {
    this.baseDir = baseDir || path.join(process.env.APPDATA || process.env.HOME || '.', 'SnapNote');
    this.tasksFile = path.join(this.baseDir, 'tasks.json');
    this.settingsFile = path.join(this.baseDir, 'settings.json');
    this.tasks = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this._load();
  }

  _readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      try {
        return JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
      } catch (e2) {
        return fallback;
      }
    }
  }

  _writeJson(file, data) {
    try { fs.mkdirSync(this.baseDir, { recursive: true }); } catch (e) { /* ignore */ }
    const tmp = file + '.tmp';
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
    } catch (e) { /* bak 尽力而为 */ }
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  _load() {
    const t = this._readJson(this.tasksFile, { schema: TASKS_SCHEMA, tasks: [] });
    this.tasks = Array.isArray(t.tasks) ? t.tasks : [];
    const s = this._readJson(this.settingsFile, null);
    if (s && typeof s === 'object') this.settings = { ...DEFAULT_SETTINGS, ...s };
  }

  persist() {
    this._writeJson(this.tasksFile, { schema: TASKS_SCHEMA, tasks: this.tasks });
  }

  persistSettings() {
    this._writeJson(this.settingsFile, this.settings);
  }

  /** 新增任务。title 为空返回 null；dueAt 为 ISO 字符串或 null；repeat='daily' 为每日任务 */
  add(title, dueAt, repeat) {
    const clean = String(title || '').trim();
    if (!clean) return null;
    let d = null;
    if (dueAt) {
      const x = new Date(dueAt);
      if (!isNaN(x.getTime())) d = x;
    }
    const isDaily = !!d && repeat === 'daily';
    if (isDaily) {
      // 过去的时刻（今天已错过）→ 规范化到明天同时刻；未来时刻原样保留
      const now = new Date();
      if (d.getTime() <= now.getTime()) {
        d = nextDailyAt(now, d.getHours(), d.getMinutes());
      }
    }
    const task = {
      id: newId(),
      title: clean.slice(0, 200),
      dueAt: d ? d.toISOString() : null,
      repeat: isDaily ? 'daily' : null,
      done: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
      notified: false,
    };
    this.tasks.push(task);
    this.persist();
    return task;
  }

  toggle(id) {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return null;
    t.done = !t.done;
    t.completedAt = t.done ? new Date().toISOString() : null;
    if (!t.done) t.notified = false; // 取消完成后，如仍在将来会重新提醒
    this.persist();
    return t;
  }

  remove(id) {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter(x => x.id !== id);
    if (this.tasks.length !== before) { this.persist(); return true; }
    return false;
  }

  setNotified(id) {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return null;
    t.notified = true;
    this.persist();
    return t;
  }

  /** 排序后的全量列表（渲染用） */
  list(now) {
    const n = now || new Date();
    return [...this.tasks].sort((a, b) => cmpTasks(a, b, n));
  }

  /** 未完成的今日任务（开机提醒摘要用） */
  listToday(now) {
    return listToday(this.tasks, now);
  }

  updateSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    for (const k of Object.keys(patch || {})) {
      if (!allowed.includes(k)) continue;
      let v = patch[k];
      if (k === 'collapseDelay') {
        v = Math.max(5, Math.min(600, Number(v) || DEFAULT_SETTINGS[k]));
      } else if (k === 'hotkey') {
        v = String(v || '').trim() || DEFAULT_SETTINGS[k];
      } else {
        v = typeof v === 'boolean' ? v : DEFAULT_SETTINGS[k];
      }
      this.settings[k] = v;
    }
    this.persistSettings();
    return { ...this.settings };
  }
}

module.exports = { Store, DEFAULT_SETTINGS, listToday, isToday, cmpTasks, nextDailyAt };
