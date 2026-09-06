'use strict';
/**
 * SnapNote 到点提醒调度器
 * 主进程每 20 秒 tick 一次：
 * - 一次性任务：找出“未完成、已到点、尚未提醒”的任务，标记 notified（防重复）并回调 onDue(task)。
 * - 每日任务（repeat='daily'）：dueAt 始终指向下一次触发时刻——
 *   · 到点提醒后自动滚动到明天同时刻（notified 复位），实现天天循环；
 *   · 关机错过：当天时刻已过 → 开机补弹一次；当天时刻未到 → 对齐到今天，不提前弹；
 *   · 完成打卡只对“今天”生效：跨天首个 tick 自动复活为未完成；
 *   · 崩溃恢复（已提醒但未滚动落盘）：不二次弹，仅滚动。
 * 任何变更都会落盘，并通过 onChange()（可选）通知 UI 刷新。
 */
const { nextDailyAt } = require('./store');

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

class Scheduler {
  /**
   * @param {import('./store').Store} store
   * @param {(task: object) => void} onDue
   */
  constructor(store, onDue) {
    this.store = store;
    this.onDue = onDue || function () {};
    this.onChange = null;   // tick 产生数据变更（滚动/复活）后的 UI 刷新钩子
    this.timer = null;
  }

  start(intervalMs) {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs || 20000);
    if (this.timer.unref) this.timer.unref();
    this.tick(); // 启动即查一次：开机补弹不等第一个间隔
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 单次检查。now 可传 Date 或毫秒时间戳。返回本次触发提醒的任务数组 */
  tick(now) {
    const n = now == null ? new Date()
      : (now instanceof Date ? now : new Date(now));
    const nTs = n.getTime();
    const due = [];
    let dirty = false;

    for (const t of this.store.tasks) {
      const dTs = t.dueAt ? new Date(t.dueAt).getTime() : null;
      if (t.repeat === 'daily' && dTs !== null && !isNaN(dTs)) {
        if (this._tickDaily(t, dTs, n, nTs, due)) dirty = true;
        continue;
      }
      // 一次性任务（原逻辑）
      if (!t.done && t.dueAt && !t.notified && dTs <= nTs) {
        this.store.setNotified(t.id);
        try { this.onDue(t); } catch (e) { /* 回调异常不中断批量提醒 */ }
        due.push(t);
      }
    }

    if (dirty) {
      this.store.persist();
      if (this.onChange) { try { this.onChange(); } catch (e) { /* UI 钩子异常忽略 */ } }
    }
    return due;
  }

  /**
   * 每日任务单条处理。返回是否产生了需要落盘的变更。
   * @param {object} t 任务
   * @param {number} dTs t.dueAt 的毫秒时间戳
   * @param {Date} n 本次 tick 的时刻
   * @param {number} nTs n 的毫秒时间戳
   * @param {object[]} due 收集本次触发提醒的任务
   */
  _tickDaily(t, dTs, n, nTs, due) {
    let dirty = false;
    const fire = () => {
      try { this.onDue(t); } catch (e) { /* 回调异常不中断批量提醒 */ }
      due.push(t);
    };

    // 1) 完成态处理：打卡只对“今天”生效
    if (t.done) {
      const c = t.completedAt ? new Date(t.completedAt) : null;
      const doneToday = c && !isNaN(c.getTime()) && isSameDay(c, n);
      if (doneToday) {
        // 今天已打卡：到点不打扰，时刻已过则直接滚到明天
        if (dTs <= nTs) {
          t.dueAt = nextDailyAt(n, new Date(t.dueAt).getHours(), new Date(t.dueAt).getMinutes()).toISOString();
          t.notified = false;
          dirty = true;
        }
        return dirty;
      }
      // 昨天打的卡 → 跨天复活，继续走未完成逻辑
      t.done = false;
      t.completedAt = null;
      t.notified = false;
      dirty = true;
    }

    // 2) 未完成：对齐 / 提醒 / 滚动
    const d = new Date(t.dueAt);
    const hh = d.getHours(), mm = d.getMinutes();
    const slot = new Date(n); slot.setHours(hh, mm, 0, 0); // 今天的 hh:mm
    const slotTs = slot.getTime();

    if (dTs < slotTs && slotTs > nTs) {
      // 错过历史提醒、但今天时刻还没到：对齐到今天，不提前弹
      t.dueAt = slot.toISOString();
      t.notified = false;
      dirty = true;
    } else if (dTs <= nTs) {
      // 今天时刻已过（准点到点，或关机错过后的补弹）
      if (!t.notified) fire(); // notified=true 意味着提醒已发但滚动未落盘（崩溃），不重弹
      t.dueAt = nextDailyAt(n, hh, mm).toISOString();
      t.notified = false;
      dirty = true;
    }
    return dirty;
  }
}

module.exports = { Scheduler };
