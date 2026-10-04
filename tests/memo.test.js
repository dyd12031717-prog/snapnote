'use strict';
/** 备忘录存储层单测：分类树 / 条目 / 去重 / 过滤搜索——纯逻辑，直接跑真文件系统（临时目录）。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MemoStore, ROOT_CATEGORY_ID, DEDUP_WINDOW_MS, sha256,
} = require('../electron/lib/memo');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-test-'));
  return new MemoStore(dir);
}

// ------------------------------------------------------------ 分类树
test('MemoStore 初始化：默认分类树 + 内置「快速收集」', () => {
  const m = mkStore();
  assert.equal(m.categories.length, 4);
  const root = m._cat(ROOT_CATEGORY_ID);
  assert.ok(root && root.name === '快速收集' && root.locked);
  assert.ok(fs.existsSync(path.join(m.baseDir, 'memo.json')));
});

test('addCategory：正常 / 同层重名拒 / 父不存在拒 / 空名拒', () => {
  const m = mkStore();
  const c1 = m.addCategory('项目文档', 'cat-work');
  assert.ok(c1 && c1.parentId === 'cat-work');
  assert.equal(m.addCategory('项目文档', 'cat-work'), null); // 同层重名
  assert.equal(m.addCategory('x', 'cat-nope'), null);        // 父不存在
  assert.equal(m.addCategory('  ', null), null);             // 空名
  const c2 = m.addCategory('顶层新类', null);
  assert.ok(c2 && c2.order > 3);
});

test('分类树无限层级 + pathOf 面包屑', () => {
  const m = mkStore();
  const a = m.addCategory('一级', null);
  const b = m.addCategory('二级', a.id);
  const c = m.addCategory('三级', b.id);
  const d = m.addCategory('四级', c.id);
  assert.deepEqual(m.pathOf(d.id), ['一级', '二级', '三级', '四级']);
});

test('moveCategory：环防护（移进自己的子孙必须拒绝）', () => {
  const m = mkStore();
  const a = m.addCategory('一级', null);
  const b = m.addCategory('二级', a.id);
  const c = m.addCategory('三级', b.id);
  assert.equal(m.moveCategory(a.id, c.id), false); // 一级移进三级（自己子孙）→ 拒
  assert.equal(m.moveCategory(a.id, b.id), false); // 移进直接子 → 拒
  assert.equal(m.moveCategory(a.id, a.id), false);
  const w = m._cat('cat-work');
  assert.equal(m.moveCategory(c.id, w.id), true);  // 正常移动
  assert.equal(m._cat(c.id).parentId, w.id);
});

test('removeCategory：locked 不可删；提级模式保留子树层级语义', () => {
  const m = mkStore();
  assert.equal(m.removeCategory(ROOT_CATEGORY_ID, true), false); // 快速收集锁定
  const a = m.addCategory('一级', null);
  const b = m.addCategory('二级', a.id);
  const c = m.addCategory('三级', b.id);
  m.addItem({ type: 'text', text: '在三级', categoryId: c.id });
  // 提级删除「一级」：二级→顶层，三级仍挂二级
  assert.equal(m.removeCategory(a.id, false), true);
  assert.equal(m._cat(b.id).parentId, null);
  assert.equal(m._cat(c.id).parentId, b.id);
  const it = m.list({ categoryId: c.id });
  assert.equal(it.length, 1); // 条目随三级保留
});

test('removeCategory：递归删除模式清空子分类与条目', () => {
  const m = mkStore();
  const a = m.addCategory('一级', null);
  const b = m.addCategory('二级', a.id);
  m.addItem({ type: 'text', text: 'x1', categoryId: b.id });
  m.addItem({ type: 'text', text: 'x2', categoryId: a.id });
  assert.equal(m.removeCategory(a.id, true), true);
  assert.equal(m.list({ categoryId: 'all' }).filter(i => i.text === 'x1' || i.text === 'x2').length, 0);
  assert.equal(m._cat(b.id), null);
});

test('categoriesFlat：深度与计数（含子孙）', () => {
  const m = mkStore();
  const a = m.addCategory('一级', null);
  const b = m.addCategory('二级', a.id);
  m.addItem({ type: 'text', text: '1', categoryId: b.id });
  m.addItem({ type: 'text', text: '2', categoryId: a.id });
  const flat = m.categoriesFlat();
  const fa = flat.find(x => x.id === a.id);
  const fb = flat.find(x => x.id === b.id);
  assert.equal(fa.depth, 0);
  assert.equal(fa.count, 2); // 子孙累计
  assert.equal(fb.depth, 1);
  assert.equal(fb.count, 1);
});

test('reorderCategory：同层上移下移', () => {
  const m = mkStore();
  const x = m.addCategory('X', null);
  const y = m.addCategory('Y', null);
  assert.equal(m.reorderCategory(y.id, 'up'), true);
  const flat = m.categoriesFlat().filter(c => c.parentId === null);
  assert.ok(flat.findIndex(c => c.id === y.id) < flat.findIndex(c => c.id === x.id));
  // 连续上移到顶后再上移返回 false
  for (let i = 0; i < 10; i++) m.reorderCategory(y.id, 'up');
  assert.equal(m.reorderCategory(y.id, 'up'), false);
});

// ------------------------------------------------------------ 条目
test('addItem 文本：正常 / 空拒 / 重复窗口内返回 duplicate', () => {
  const m = mkStore();
  const it = m.addItem({ type: 'text', text: '账号 admin', source: 'clipboard' });
  assert.ok(it && it.categoryId === ROOT_CATEGORY_ID); // 未指定分类 → 快速收集
  assert.equal(m.addItem({ type: 'text', text: '  ' }), null);
  assert.deepEqual(m.addItem({ type: 'text', text: '账号 admin' }), { duplicate: true });
  // 不同文本不判重
  const it2 = m.addItem({ type: 'text', text: '账号 root' });
  assert.ok(it2);
});

test('addItem 图片：hash 去重 / 尺寸记录', () => {
  const m = mkStore();
  const i1 = m.addItem({ type: 'image', imageHash: 'abc', imageW: 800, imageH: 600, source: 'clipboard' });
  assert.ok(i1 && i1.imageW === 800);
  assert.deepEqual(m.addItem({ type: 'image', imageHash: 'abc' }), { duplicate: true });
  const i3 = m.addItem({ type: 'image', imageHash: 'zzz' });
  assert.ok(i3);
});

test('updateItem / removeItem / moveItem', () => {
  const m = mkStore();
  const it = m.addItem({ type: 'text', text: '旧文本' });
  const u = m.updateItem(it.id, { text: '新文本', note: '备注', sensitive: true });
  assert.equal(u.text, '新文本');
  assert.equal(u.fingerprint, sha256('新文本')); // 指纹随内容更新
  assert.ok(u.sensitive);
  const w = m._cat('cat-work');
  assert.equal(m.moveItem(it.id, w.id).categoryId, w.id);
  assert.equal(m.removeItem(it.id), true);
  assert.equal(m.removeItem(it.id), false);
});

test('list：分类过滤（含子孙）/ 未分类 / 类型过滤 / 搜索', () => {
  const m = mkStore();
  const a = m.addCategory('一级', null);
  const b = m.addCategory('二级', a.id);
  m.addItem({ type: 'text', text: '登录密码 123', categoryId: b.id, note: '公司账号' });
  m.addItem({ type: 'text', text: '会议纪要', categoryId: a.id });
  m.addItem({ type: 'text', text: '杂记', categoryId: 'cat-idea' });
  m.addItem({ type: 'image', imageHash: 'h1', categoryId: a.id });

  assert.equal(m.list({ categoryId: a.id }).length, 3);        // 含子孙
  assert.equal(m.list({ categoryId: b.id }).length, 1);
  assert.equal(m.list({ categoryId: 'all' }).length, 4);
  assert.equal(m.list({ type: 'image', categoryId: 'all' }).length, 1);
  assert.equal(m.list({ q: '密码', categoryId: 'all' }).length, 1);
  assert.equal(m.list({ q: '公司', categoryId: 'all' }).length, 1); // note 命中
  assert.equal(m.list({ categoryId: null }).length, 0);        // 未分类
  // 删除分类（提级到 null）后条目变未分类
  const z = m.addCategory('临时', null);
  m.addItem({ type: 'text', text: '游离', categoryId: z.id });
  m.removeCategory(z.id, false);
  assert.equal(m.list({ categoryId: null }).length, 1);
});

test('list 倒序：最新在前', () => {
  const m = mkStore();
  const i1 = m.addItem({ type: 'text', text: 'first' });
  const i2 = m.addItem({ type: 'text', text: 'second' });
  const arr = m.list({ categoryId: 'all' });
  assert.equal(arr[0].id, i2.id);
  assert.equal(arr[1].id, i1.id);
});

test('counts / touchCategory / recent 容量 4', () => {
  const m = mkStore();
  m.addItem({ type: 'text', text: 'a', categoryId: 'cat-life' });
  m.addItem({ type: 'text', text: 'b', categoryId: 'cat-work' });
  assert.deepEqual(m.counts(), { all: 2, uncategorized: 0 });
  m.touchCategory('cat-life'); m.touchCategory('cat-work');
  m.touchCategory('cat-idea'); m.touchCategory('cat-life');
  const c1 = m.addCategory('C1', null);
  const c2 = m.addCategory('C2', null);
  const c3 = m.addCategory('C3', null);
  const c4 = m.addCategory('C4', null);
  const c5 = m.addCategory('C5', null);
  m.touchCategory(c1.id); m.touchCategory(c2.id); m.touchCategory(c3.id);
  m.touchCategory(c4.id); m.touchCategory(c5.id);
  assert.equal(m.recentCatIds.length, 4);
  assert.equal(m.recentCatIds[0], c5.id); // LRU 头部最新
});

test('持久化与重载：数据不丢，损坏自动回退 .bak', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-persist-'));
  const m1 = new MemoStore(dir);
  const cat = m1.addCategory('级', null);
  const it = m1.addItem({ type: 'text', text: '要留住的', categoryId: cat.id });
  const m2 = new MemoStore(dir);
  assert.deepEqual(m2.pathOf(cat.id), ['级']);
  assert.equal(m2.item(it.id).text, '要留住的');
  // 主文件损坏 → 回退 .bak（bak 为上一写入版本：原子 rename 保证主文件
  // 正常时不会半写，bak 只在磁盘级损坏时兜底——此时至多丢最后一次写入）
  fs.writeFileSync(m2.memoFile, '{broken json', 'utf8');
  const m3 = new MemoStore(dir);
  assert.ok(m3._cat(cat.id) || m3.item(it.id), 'bak 兜底应至少保住上一版数据');
  // 完全损坏：回退默认（数据自愈保证内置根分类存在）
  fs.writeFileSync(m3.memoFile, 'x', 'utf8');
  fs.writeFileSync(m3.memoFile + '.bak', 'y', 'utf8');
  const m4 = new MemoStore(dir);
  assert.ok(m4._cat(ROOT_CATEGORY_ID));
});

test('去重窗口边界：老条目（超窗）不判重', () => {
  const m = mkStore();
  const it = m.addItem({ type: 'text', text: '窗口外' });
  it.createdAt = new Date(Date.now() - DEDUP_WINDOW_MS - 1000).toISOString();
  m.persist();
  const again = m.addItem({ type: 'text', text: '窗口外' });
  assert.ok(again && !again.duplicate);
});
