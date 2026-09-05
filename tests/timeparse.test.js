'use strict';
/** 时间工具单元测试（node --test） */
const test = require('node:test');
const assert = require('node:assert');
const T = require('../electron/lib/timeparse');

test('parseHM 合法输入', () => {
  const now = new Date('2026-09-04T10:00:00');
  const d = T.parseHM('20:00', now);
  assert.strictEqual(d.getDate(), 4);
  assert.strictEqual(d.getHours(), 20);
  assert.strictEqual(d.getMinutes(), 0);
});

test('parseHM 过去时刻顺延到明天', () => {
  const now = new Date('2026-09-04T21:30:00');
  const d = T.parseHM('09:00', now);
  assert.strictEqual(d.getDate(), 5);
  assert.strictEqual(d.getHours(), 9);
});

test('parseHM 非法输入返回 null', () => {
  assert.strictEqual(T.parseHM('25:00'), null);
  assert.strictEqual(T.parseHM('10:70'), null);
  assert.strictEqual(T.parseHM('abc'), null);
  assert.strictEqual(T.parseHM(''), null);
});

test('formatDue 各时间档位文案', () => {
  const now = new Date('2026-09-04T12:00:00'); // 周五
  assert.strictEqual(T.formatDue('2026-09-04T20:00', now), '20:00');
  assert.strictEqual(T.formatDue('2026-09-05T09:30', now), '明天 09:30');
  assert.strictEqual(T.formatDue('2026-09-06T14:00', now), '后天 14:00');
  assert.strictEqual(T.formatDue('2026-09-09T10:00', now), '周三 10:00'); // 5 天后
  assert.strictEqual(T.formatDue('2026-10-12T08:15', now), '10-12 08:15'); // 今年更远
  assert.strictEqual(T.formatDue('2027-01-02T08:15', now), '2027-01-02 08:15'); // 跨年
});

test('isOverdue 判定', () => {
  const now = new Date('2026-09-04T12:00:00');
  assert.strictEqual(T.isOverdue({ dueAt: '2026-09-04T08:00', done: false }, now), true);
  assert.strictEqual(T.isOverdue({ dueAt: '2026-09-04T20:00', done: false }, now), false);
  assert.strictEqual(T.isOverdue({ dueAt: '2026-09-04T08:00', done: true }, now), false); // 已完成不算过期
  assert.strictEqual(T.isOverdue({ dueAt: null, done: false }, now), false);
});

test('chips：基本形态与今晚顺延', () => {
  const morning = new Date('2026-09-04T10:00:00');
  const cs = T.chips(morning);
  assert.strictEqual(cs.length, 4);
  assert.strictEqual(cs[0].label, '1 小时后');
  assert.strictEqual(new Date(cs[0].at).getHours(), 11);
  assert.strictEqual(cs[1].label, '今晚 20:00');
  // 21:30 之后“今晚 20:00”已过 → 顺延为今晚 21:00
  const late = new Date('2026-09-04T21:30:00');
  const cs2 = T.chips(late);
  assert.strictEqual(cs2[1].label, '今晚 21:00');
  assert.strictEqual(new Date(cs2[1].at).getHours(), 21);
  // 明天 09:00 胶囊
  const tm = new Date(cs[2].at);
  assert.strictEqual(tm.getDate(), 5);
  assert.strictEqual(tm.getHours(), 9);
});
