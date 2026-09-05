'use strict';
/** 任务存储层单元测试（node --test） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store, DEFAULT_SETTINGS, listToday } = require('../electron/lib/store');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapnote-test-'));
  return new Store(dir);
}

test('新增任务：写盘、字段完整', () => {
  const s = tmpStore();
  const t = s.add('写周报', new Date('2026-09-05T10:00:00').toISOString());
  assert.ok(t.id && t.id.length > 4);
  assert.strictEqual(t.title, '写周报');
  assert.strictEqual(t.done, false);
  assert.strictEqual(t.notified, false);
  const onDisk = JSON.parse(fs.readFileSync(s.tasksFile, 'utf8'));
  assert.strictEqual(onDisk.tasks.length, 1);
});

test('空标题拒绝新增', () => {
  const s = tmpStore();
  assert.strictEqual(s.add('   '), null);
  assert.strictEqual(s.add(''), null);
});

test('toggle 完成与恢复，恢复后重置提醒标记', () => {
  const s = tmpStore();
  const t = s.add('任务1', null);
  s.setNotified(t.id);
  s.toggle(t.id);
  assert.strictEqual(s.tasks[0].done, true);
  assert.ok(s.tasks[0].completedAt);
  s.toggle(t.id);
  assert.strictEqual(s.tasks[0].done, false);
  assert.strictEqual(s.tasks[0].completedAt, null);
  assert.strictEqual(s.tasks[0].notified, false); // 恢复后可再次提醒
});

test('remove 删除并持久化', () => {
  const s = tmpStore();
  const a = s.add('A', null);
  s.add('B', null);
  assert.strictEqual(s.remove(a.id), true);
  assert.strictEqual(s.tasks.length, 1);
  assert.strictEqual(s.tasks[0].title, 'B');
  assert.strictEqual(s.remove('nope'), false);
});

test('排序：未完成在前、有期在前、过期优先；完成沉底', () => {
  const s = tmpStore();
  const now = new Date('2026-09-04T12:00:00');
  s.add('已完成A', null);
  s.tasks[0].done = true; s.tasks[0].completedAt = '2026-09-04T10:00:00.000Z';
  s.add('无期B', null);
  s.add('明天C', '2026-09-05T09:00:00');
  s.add('过期D', '2026-09-04T08:00:00');
  const titles = s.list(now).map(t => t.title);
  assert.deepStrictEqual(titles, ['过期D', '明天C', '无期B', '已完成A']);
});

test('listToday 只统计今天到期且未完成', () => {
  const now = new Date('2026-09-04T12:00:00');
  const tasks = [
    { title: '今天', dueAt: '2026-09-04T15:00:00', done: false },
    { title: '今天完成', dueAt: '2026-09-04T15:00:00', done: true },
    { title: '明天', dueAt: '2026-09-05T15:00:00', done: false },
    { title: '无期', dueAt: null, done: false },
  ];
  const today = listToday(tasks, now);
  assert.deepStrictEqual(today.map(t => t.title), ['今天']);
});

test('settings 默认值与白名单合并', () => {
  const s = tmpStore();
  assert.deepStrictEqual(Object.keys(DEFAULT_SETTINGS).sort(),
    ['autostart', 'collapseDelay', 'hotkey', 'sound', 'startupToast'].sort());
  const out = s.updateSettings({ hotkey: 'Ctrl+Shift+K', collapseDelay: 999, hack: true });
  assert.strictEqual(out.hotkey, 'Ctrl+Shift+K');
  assert.strictEqual(out.collapseDelay, 600); // 上限截断
  assert.strictEqual(out.hack, undefined);    // 未知键忽略
});

test('写入产生 .bak 副本，主文件损坏时自动回退', () => {
  const s = tmpStore();
  s.add('第一个', null);
  s.add('第二个', null);
  assert.ok(fs.existsSync(s.tasksFile + '.bak'));
  // 模拟主文件损坏
  fs.writeFileSync(s.tasksFile, '{broken json', 'utf8');
  const s2 = new Store(s.baseDir);
  assert.ok(s2.tasks.length >= 1); // 从 .bak 回退
});
