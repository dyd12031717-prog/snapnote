'use strict';
/** 调度器单元测试（node --test） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../electron/lib/store');
const { Scheduler } = require('../electron/lib/scheduler');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-sched-'));
  return new Store(dir);
}

test('到点未提醒的任务触发回调并去重', () => {
  const s = tmpStore();
  const past = new Date(Date.now() - 60000).toISOString();
  s.add('已到点', past);
  s.add('未到点', new Date(Date.now() + 3600000).toISOString());
  s.add('无时间', null);

  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  const due1 = sch.tick();
  assert.deepStrictEqual(fired, ['已到点']);
  assert.strictEqual(due1.length, 1);

  // 再次 tick：已提醒过的不重复
  const due2 = sch.tick();
  assert.strictEqual(due2.length, 0);
  assert.strictEqual(fired.length, 1);
});

test('已完成任务不触发提醒', () => {
  const s = tmpStore();
  const t = s.add('做完了', new Date(Date.now() - 60000).toISOString());
  s.toggle(t.id);
  const fired = [];
  const sch = new Scheduler(s, x => fired.push(x.title));
  assert.strictEqual(sch.tick().length, 0);
  assert.strictEqual(fired.length, 0);
});

test('恢复未完成会重置提醒标记（可再次提醒）', () => {
  const s = tmpStore();
  const t = s.add('再来一次', new Date(Date.now() - 30000).toISOString());
  const sch = new Scheduler(s, () => {});
  assert.strictEqual(sch.tick().length, 1);       // 提醒一次
  s.toggle(t.id);                                  // 完成 → 恢复
  s.toggle(t.id);
  assert.strictEqual(sch.tick().length, 1);       // 恢复后允许再提醒
});

test('start/stop 定时器可正常启停', () => {
  const s = tmpStore();
  const sch = new Scheduler(s, () => {});
  sch.start(50);
  assert.ok(sch.timer);
  sch.stop();
  assert.strictEqual(sch.timer, null);
});

// ---------------- 每日任务（v1.2.0） ----------------
// 全部用固定假时钟驱动 tick(now)，保证确定性。
// mkDaily：先以未来时刻建任务（避开 add 的过去规范化），再覆写为受控 dueAt，
// 模拟"已存在/已滚动/关机错过的历史数据"。

function mkDaily(s, title, iso) {
  const t = s.add(title, new Date(Date.now() + 3600000).toISOString(), 'daily');
  const task = s.tasks.find(x => x.id === t.id);
  task.dueAt = iso;
  s.persist();
  return task;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

test('每日任务：未到点不提醒', () => {
  const s = tmpStore();
  s.add('吃维生素', new Date(Date.now() + 3600000).toISOString(), 'daily');
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  assert.strictEqual(sch.tick().length, 0);
  assert.strictEqual(fired.length, 0);
});

test('每日任务：到点提醒一次并滚动到明天，不再重复', () => {
  const s = tmpStore();
  mkDaily(s, '吃维生素', '2026-09-06T09:00:00');
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  const due1 = sch.tick(new Date('2026-09-06T09:00:30'));
  assert.deepStrictEqual(fired, ['吃维生素']);
  assert.strictEqual(due1.length, 1);
  const t = s.tasks[0];
  const d = new Date(t.dueAt);
  assert.ok(sameDay(d, new Date('2026-09-07T09:00:00')), '应滚到明天');
  assert.strictEqual(d.getHours(), 9);
  assert.strictEqual(d.getMinutes(), 0);
  assert.strictEqual(t.notified, false, '滚动后复位提醒标记');
  // 再次 tick（同一时刻之后）：不重复
  assert.strictEqual(sch.tick(new Date('2026-09-06T09:01:00')).length, 0);
  assert.strictEqual(fired.length, 1);
});

test('每日任务：昨天提醒滚动后，今天到点再提醒（天天循环）', () => {
  const s = tmpStore();
  mkDaily(s, '吃维生素', '2026-09-06T09:00:00');
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  sch.tick(new Date('2026-09-06T09:00:30'));  // 昨天提醒，滚到 09-07
  sch.tick(new Date('2026-09-07T09:00:30'));  // 今天再提醒
  assert.strictEqual(fired.length, 2);
  const d = new Date(s.tasks[0].dueAt);
  assert.ok(sameDay(d, new Date('2026-09-08T09:00:00')), '滚到后天');
});

test('每日任务：关机错过多天、当天时刻已过 → 开机只补弹一次', () => {
  const s = tmpStore();
  mkDaily(s, '吃维生素', '2026-09-03T09:00:00'); // 3 天前
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  const due = sch.tick(new Date('2026-09-06T10:30:00'));
  assert.deepStrictEqual(fired, ['吃维生素'], '补弹且仅弹一次');
  assert.strictEqual(due.length, 1);
  const d = new Date(s.tasks[0].dueAt);
  assert.ok(sameDay(d, new Date('2026-09-07T09:00:00')), '滚到明天');
  assert.strictEqual(sch.tick(new Date('2026-09-06T10:30:20')).length, 0, '不重复');
});

test('每日任务：关机错过、但当天时刻还没到 → 对齐到今天，不提前弹', () => {
  const s = tmpStore();
  mkDaily(s, '吃维生素', '2026-09-03T09:00:00'); // 3 天前
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  sch.tick(new Date('2026-09-06T08:00:00')); // 今天 09:00 未到
  assert.strictEqual(fired.length, 0, '不提前弹');
  let d = new Date(s.tasks[0].dueAt);
  assert.ok(sameDay(d, new Date('2026-09-06T09:00:00')), '对齐到今天 09:00');
  // 到点后正常提醒
  sch.tick(new Date('2026-09-06T09:00:30'));
  assert.strictEqual(fired.length, 1);
  d = new Date(s.tasks[0].dueAt);
  assert.ok(sameDay(d, new Date('2026-09-07T09:00:00')), '提醒后滚到明天');
});

test('每日任务：今天完成 → 到点不打扰，直接滚到明天', () => {
  const s = tmpStore();
  mkDaily(s, '吃维生素', '2026-09-06T09:00:00');
  s.tasks[0].done = true;
  s.tasks[0].completedAt = '2026-09-06T08:00:00';
  s.persist();
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  sch.tick(new Date('2026-09-06T09:00:30'));
  assert.strictEqual(fired.length, 0, '完成当天不提醒');
  const d = new Date(s.tasks[0].dueAt);
  assert.ok(sameDay(d, new Date('2026-09-07T09:00:00')), '滚到明天');
});

test('每日任务：昨天完成 → 今天复活，到点正常提醒', () => {
  const s = tmpStore();
  mkDaily(s, '吃维生素', '2026-09-06T09:00:00'); // 今天 09:00 槽位
  s.tasks[0].done = true;
  s.tasks[0].completedAt = '2026-09-05T10:00:00'; // 昨天打的卡
  s.persist();
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  sch.tick(new Date('2026-09-06T07:00:00')); // 跨天首 tick：复活
  assert.strictEqual(s.tasks[0].done, false, '复活为未完成');
  assert.strictEqual(s.tasks[0].completedAt, null);
  assert.strictEqual(fired.length, 0, '槽位未到不弹');
  sch.tick(new Date('2026-09-06T09:00:30'));
  assert.deepStrictEqual(fired, ['吃维生素']);
});

test('每日任务：昨天完成且今天错过 → 复活并补弹一次', () => {
  const s = tmpStore();
  mkDaily(s, '吃维生素', '2026-09-05T09:00:00'); // 昨天槽位（关机错过）
  s.tasks[0].done = true;
  s.tasks[0].completedAt = '2026-09-05T10:00:00';
  s.persist();
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  sch.tick(new Date('2026-09-06T10:30:00')); // 今天开机
  assert.strictEqual(s.tasks[0].done, false, '先复活');
  assert.deepStrictEqual(fired, ['吃维生素'], '再补弹一次');
  assert.strictEqual(sch.tick(new Date('2026-09-06T10:30:20')).length, 0, '不重复');
});

test('每日任务：崩溃恢复（已提醒未滚动）不二次弹，仅滚动', () => {
  const s = tmpStore();
  mkDaily(s, '吃维生素', '2026-09-06T09:00:00');
  s.tasks[0].notified = true; // 模拟：提醒回调已发但滚动未落盘（进程崩溃）
  s.persist();
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  sch.tick(new Date('2026-09-06T09:00:30'));
  assert.strictEqual(fired.length, 0, '不二次弹');
  const d = new Date(s.tasks[0].dueAt);
  assert.ok(sameDay(d, new Date('2026-09-07T09:00:00')), '仅滚动到明天');
});

test('每日任务：tick 变更应落盘并触发 onChange 回调', () => {
  const s = tmpStore();
  mkDaily(s, '吃维生素', '2026-09-06T09:00:00');
  const changes = [];
  const sch = new Scheduler(s, () => {});
  sch.onChange = () => changes.push(1);
  sch.tick(new Date('2026-09-06T09:00:30'));
  assert.strictEqual(changes.length, 1, '滚动后应通知 UI 刷新');
  const onDisk = JSON.parse(fs.readFileSync(s.tasksFile, 'utf8'));
  const d = new Date(onDisk.tasks[0].dueAt);
  assert.ok(sameDay(d, new Date('2026-09-07T09:00:00')), '滚动结果应已写盘');
});

test('回归：一次性任务提醒后 dueAt 不滚动', () => {
  const s = tmpStore();
  s.add('一次性', '2026-09-06T09:00:00');
  const fired = [];
  const sch = new Scheduler(s, t => fired.push(t.title));
  sch.tick(new Date('2026-09-06T09:00:30'));
  assert.deepStrictEqual(fired, ['一次性']);
  assert.strictEqual(new Date(s.tasks[0].dueAt).getTime(),
    new Date('2026-09-06T09:00:00').getTime(), '一次性任务 dueAt 保持不变');
});
