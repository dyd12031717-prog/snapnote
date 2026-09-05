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
