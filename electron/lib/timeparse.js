'use strict';
/**
 * SnapNote 时间工具：快捷时间胶囊、到期格式化、过期判断
 * 纯函数模块，无副作用，可单元测试
 */

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function isTomorrow(iso, now) {
  const n = startOfDay(now || new Date());
  n.setDate(n.getDate() + 1);
  return isSameDay(new Date(iso), n);
}

/** 任务已过期：有到期时间、未完成、且早于当前时刻 */
function isOverdue(task, now) {
  if (!task.dueAt || task.done) return false;
  return new Date(task.dueAt).getTime() <= (now || new Date()).getTime();
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtHM(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

/**
 * 解析 'HH:mm'（快捷胶囊/自定义输入用）
 * 规则：今天该时刻已过则顺延到明天，避免立刻变成“已过期”
 */
function parseHM(hm, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const base = new Date(now || new Date());
  const d = new Date(base);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 到期时间展示文案（列表胶囊用）
 * 今天→“20:00”；明天→“明天 09:30”；后天→“后天 14:00”；
 * 7 天内→“周五 10:00”；今年→“09-12 10:00”；跨年→“2027-01-02 10:00”
 */
function formatDue(iso, now) {
  if (!iso) return '';
  const d = new Date(iso);
  const n = now || new Date();
  const hm = fmtHM(d);
  if (isSameDay(d, n)) return hm;
  if (isTomorrow(iso, n)) return '明天 ' + hm;
  const dayDiff = Math.round((startOfDay(d) - startOfDay(n)) / 86400000);
  if (dayDiff === 2) return '后天 ' + hm;
  if (dayDiff > 0 && dayDiff <= 7) return WEEK[d.getDay()] + ' ' + hm;
  const ymd = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (d.getFullYear() === n.getFullYear()) return ymd + ' ' + hm;
  return `${d.getFullYear()}-${ymd} ` + hm;
}

/** 快捷时间胶囊集合（渲染层每次展开时重新计算） */
function chips(now) {
  const n = now || new Date();
  const oneHour = new Date(n.getTime() + 3600000);
  const tonight = new Date(n);
  tonight.setHours(20, 0, 0, 0);
  let tonightLabel = '今晚 20:00';
  if (tonight.getTime() <= n.getTime()) {
    tonight.setHours(21, 0, 0, 0);
    tonightLabel = '今晚 21:00';
  }
  const tomorrow = startOfDay(n);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const afterTomorrow = startOfDay(n);
  afterTomorrow.setDate(afterTomorrow.getDate() + 2);
  afterTomorrow.setHours(9, 0, 0, 0);
  return [
    { label: '1 小时后', at: oneHour.toISOString() },
    { label: tonightLabel, at: tonight.toISOString() },
    { label: '明天 09:00', at: tomorrow.toISOString() },
    { label: '后天 09:00', at: afterTomorrow.toISOString() },
  ];
}

module.exports = { startOfDay, isSameDay, isTomorrow, isOverdue, fmtHM, parseHM, formatDue, chips, WEEK };
