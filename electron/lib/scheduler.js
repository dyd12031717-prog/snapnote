'use strict';
/**
 * SnapNote 到点提醒调度器
 * 主进程每 20 秒 tick 一次：找出“未完成、已到点、尚未提醒”的任务，
 * 标记 notified（防重复）并回调 onDue(task)。
 */
class Scheduler {
  /**
   * @param {import('./store').Store} store
   * @param {(task: object) => void} onDue
   */
  constructor(store, onDue) {
    this.store = store;
    this.onDue = onDue || function () {};
    this.timer = null;
  }

  start(intervalMs) {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs || 20000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 单次检查。now 可传 Date 或毫秒时间戳。返回本次触发提醒的任务数组 */
  tick(now) {
    const n = now == null ? new Date()
      : (now instanceof Date ? now : new Date(now));
    const due = this.store.tasks.filter(t =>
      !t.done && t.dueAt && !t.notified
      && new Date(t.dueAt).getTime() <= n.getTime()
    );
    for (const task of due) {
      this.store.setNotified(task.id);
      try { this.onDue(task); } catch (e) { /* 回调异常不中断批量提醒 */ }
    }
    return due;
  }
}

module.exports = { Scheduler };
