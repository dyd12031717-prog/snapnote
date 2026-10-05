#!/usr/bin/env node
'use strict';
/**
 * 全流程端到端自测（v1.5.3+）——真实 Electron、真实窗口、真实 IPC，非 mock。
 *
 * 背景教训：当日两个线上 bug（图片收集静默失败、下载 99% 回 0%）都是
 * "87 项单测全绿但集成链路断"——单测覆盖逻辑，本脚本覆盖**用户旅程**。
 *
 * 旅程覆盖：
 *   A. 启动自检        便签窗口 / 托盘 / payload 结构
 *   B. 任务全流程      添加(每日/普通) → 列表 → 完成 → 恢复 → 删除
 *   C. 备忘录全流程    开窗 → 多级分类 → 条目 CRUD → 敏感遮罩 → 搜索 → 拖拽移动
 *   D. 剪贴板捕获      真写剪贴板 → 气泡弹出 → 归档 → 条目落地（端到端核心）
 *   E. 设置            快捷键改键 → 生效；捕获开关
 *   F. 持久化          重启应用 → 任务/备忘录数据完好
 *   G. 更新链路        开发态禁用断言 + GitHub Release 可达 + 下载源 Range 探活
 *
 * 运行：node scripts/e2e_full.js（需 Xvfb；CI windows 直接可跑）
 * 硬退出：任何步骤挂死 90s 总超时强制 exit（当日 e2e_update 教训）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 9223;
const DISPLAY = process.env.E2E_DISPLAY || ':105';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
let proc = null;
let wsGlobal = null;

function ok(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

// ---------------- CDP 基础 ----------------
async function targets() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json' }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function findTarget(match, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ts = await targets().catch(() => []);
    const hit = ts.find(t => match(t));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

async function cdp(target) {
  const WebSocket = await import('ws').catch(() => null);
  if (!WebSocket) throw new Error('需要 ws 模块：npm i -D ws');
  const Ws = WebSocket.default || WebSocket;
  const ws = new Ws(target.webSocketDebuggerUrl, { origin: `http://127.0.0.1:${PORT}` });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return ws;
}

function evaluate(ws, expr, awaitPromise = true) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMsg = (data) => {
      try {
        const m = JSON.parse(String(data));
        if (m.id === id) {
          ws.off('message', onMsg);
          const r = m.result && m.result.result;
          if (m.error || (r && r.subtype === 'error')) reject(new Error((m.error && m.error.message) || (r && r.description)));
          else resolve(r ? r.value : undefined);
        }
      } catch (e) { /* 非 JSON 帧 */ }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise },
    }));
    setTimeout(() => { ws.off('message', onMsg); reject(new Error('evaluate 超时')); }, 20000);
  });
}

// ---------------- 应用生命周期 ----------------
async function launchElectron(userData) {
  proc = spawn('npx', ['electron', '.', '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DISPLAY,
      SNAPNOTE_FAST: '1',
      SNAPNOTE_USER_DATA: userData,
      SNAPNOTE_E2E_CLIPBRIDGE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const errLog = [];
  proc.stderr.on('data', d => errLog.push(String(d)));
  proc.on('exit', (code) => { if (!exiting) console.log(`  (electron exit ${code})`); });
  // 等调试端口就绪
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const ts = await targets().catch(() => null);
    if (ts && ts.length) return { proc, errLog };
    await sleep(400);
  }
  throw new Error('Electron 20 秒内未就绪：' + errLog.slice(-5).join('\n'));
}

function killElectron() {
  if (proc && !proc.killed) {
    try { proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
  proc = null;
}

let exiting = false;

// ---------------- 旅程 ----------------
async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-full-'));

  // ===== A. 启动自检 =====
  console.log('\n[A] 启动自检');
  await launchElectron(userData);
  const note = await findTarget(t => (t.url || '').includes('index.html'));
  ok('便签窗口加载', !!note);
  const noteWs = await cdp(note);
  wsGlobal = noteWs;
  const payload = await evaluate(noteWs, 'window.snapnote ? window.snapnote.ready() : null');
  ok('payload 结构完整（tasks/settings/memo/update）',
    payload && Array.isArray(payload.tasks) && payload.settings && payload.memo && payload.update,
    `tasks=${payload.tasks.length} captureOn=${payload.memo && payload.memo.captureOn}`);
  ok('备忘录捕获默认开启', payload && payload.memo && payload.memo.captureOn === true);

  // ===== B. 任务全流程 =====
  console.log('\n[B] 任务全流程（真实 IPC → Store → 落盘）');
  const t0count = payload.tasks.length;
  await evaluate(noteWs, `window.snapnote.addTask('e2e-普通任务', null, null)`);
  const due = new Date(Date.now() + 3600e3).toISOString();
  await evaluate(noteWs, `window.snapnote.addTask('e2e-每日任务', ${JSON.stringify(due)}, 'daily')`);
  let p2 = await evaluate(noteWs, 'window.snapnote.ready()');
  ok('添加两个任务（普通+每日）', p2.tasks.length === t0count + 2);
  const daily = p2.tasks.find(t => t.title === 'e2e-每日任务');
  ok('每日任务 repeat 透传', daily && daily.repeat === 'daily');
  const domTasks = await evaluate(noteWs, `document.querySelectorAll('#taskList .task').length`);
  ok('DOM 渲染任务行', Number(domTasks) >= 2, `DOM 行数 ${domTasks}`);
  // 完成 → 恢复 → 删除
  await evaluate(noteWs, `window.snapnote.toggleTask(${JSON.stringify(daily.id)})`);
  p2 = await evaluate(noteWs, 'window.snapnote.ready()');
  ok('勾选完成', p2.tasks.find(t => t.id === daily.id).done === true);
  await evaluate(noteWs, `window.snapnote.toggleTask(${JSON.stringify(daily.id)})`);
  await evaluate(noteWs, `window.snapnote.removeTask(${JSON.stringify(daily.id)})`);
  p2 = await evaluate(noteWs, 'window.snapnote.ready()');
  ok('恢复后删除', !p2.tasks.find(t => t.id === daily.id));
  ok('任务数据落盘', fs.existsSync(path.join(userData, 'tasks.json')));

  // ===== C. 备忘录全流程 =====
  console.log('\n[C] 备忘录全流程');
  await evaluate(noteWs, "document.getElementById('btnMemo').click()");
  const memo = await findTarget(t => (t.url || '').includes('memo.html'), 10000);
  ok('备忘录窗口打开（便签 ✒ 按钮点击）', !!memo);
  const memoWs = await cdp(memo);
  let state = await evaluate(memoWs, 'window.snapnote.memoState()');
  ok('默认分类树（≥4 项含快速收集）',
    state.categories.length >= 4 && state.categories.some(c => c.name === '快速收集'));
  // 多级分类
  const catA = await evaluate(memoWs, `window.snapnote.memoAddCategory('e2e-一级', null)`);
  const catB = await evaluate(memoWs, `window.snapnote.memoAddCategory('e2e-二级', ${JSON.stringify(catA.id)})`);
  ok('两级分类创建', catA.id && catB.id && catB.parentId === catA.id);
  await evaluate(memoWs, `window.snapnote.memoAddCategory('e2e-三级', ${JSON.stringify(catB.id)})`);
  // 条目 CRUD + 敏感
  const item = await evaluate(memoWs, `window.snapnote.memoAddItem({type:'text', text:'e2e-密码 abc123', categoryId: ${JSON.stringify(catB.id)}, sensitive: true})`);
  const item2 = await evaluate(memoWs, `window.snapnote.memoAddItem({type:'text', text:'e2e-笔记内容', categoryId: ${JSON.stringify(catA.id)}})`);
  ok('条目创建（敏感+普通）', item.id && item2.id);
  let items = await evaluate(memoWs, `window.snapnote.memoItems({categoryId: ${JSON.stringify(catA.id)}, q: ''})`);
  ok('父分类列表含子孙条目', items.length === 2);
  // 搜索
  items = await evaluate(memoWs, `window.snapnote.memoItems({categoryId: 'all', q: '密码'})`);
  ok('全文搜索命中', items.length === 1 && items[0].sensitive === true);
  // 移动到未分类
  await evaluate(memoWs, `window.snapnote.memoMoveItem(${JSON.stringify(item.id)}, null)`);
  items = await evaluate(memoWs, `window.snapnote.memoItems({categoryId: null, q: ''})`);
  ok('移动到未分类（显式 null 语义）', items.some(i => i.id === item.id));
  // 敏感遮罩 DOM（切到全部视图）
  await evaluate(memoWs, `document.querySelector('.node[data-id=all], .node') ? (location.reload(), 'reloading') : null`).catch(() => null);
  await sleep(1500);
  const memo2 = await findTarget(t => (t.url || '').includes('memo.html'), 8000);
  const memoWs2 = await cdp(memo2);
  const maskCount = await evaluate(memoWs2, `document.querySelectorAll('.item .mask').length`);
  ok('敏感条目 DOM 遮罩渲染', Number(maskCount) >= 1, `遮罩 ${maskCount} 个`);
  // 删除
  await evaluate(memoWs2, `window.snapnote.memoRemoveItem(${JSON.stringify(item.id)})`);
  items = await evaluate(memoWs2, `window.snapnote.memoItems({categoryId: null, q: ''})`);
  ok('条目删除', !items.some(i => i.id === item.id));
  ok('备忘录数据落盘（与任务隔离）',
    fs.existsSync(path.join(userData, 'memo.json')) && fs.existsSync(path.join(userData, 'tasks.json')));
  try { memoWs.close(); memoWs2.close(); } catch (e) { /* ignore */ }

  // ===== D. 剪贴板捕获（端到端核心旅程） =====
  console.log('\n[D] 剪贴板捕获气泡（复制 → 弹 → 归档 → 落地）');
  const captureBefore = (await evaluate(noteWs, 'window.snapnote.ready()')).memo.count;
  // 无头环境 navigator.clipboard 无用户激活被拒——走 E2E 剪贴板写桥
  // （SNAPNOTE_E2E_CLIPBRIDGE 门控，主进程视角与真实复制同一条系统剪贴板）
  const clipText = 'e2e-剪贴板捕获的内容 ' + Date.now();
  await evaluate(noteWs, `window.snapnote.e2eWriteClipboard(${JSON.stringify(clipText)})`);
  const bubble = await findTarget(t => (t.url || '').includes('capture.html'), 6000);
  ok('复制后 6 秒内弹出捕获气泡', !!bubble);
  if (bubble) {
    const bubWs = await cdp(bubble);
    const capPayload = await evaluate(bubWs, `document.body.innerText.slice(0, 120)`).catch(() => null);
    ok('气泡预览内容正确', /e2e-剪贴板捕获/.test(String(capPayload)), String(capPayload).slice(0, 40));
    // v1.6.2 自研下拉：可展开、级联项齐全、可选中、可滚动（menu overflow-y auto）
    const miCount = await evaluate(bubWs, `document.querySelectorAll('.mi').length`).catch(() => 0);
    ok('分类下拉项齐全（≥4 项含快速收集）', Number(miCount) >= 4, `菜单 ${miCount} 项`);
    await evaluate(bubWs, `document.getElementById('selbox').click()`);
    await sleep(250);
    const menuOpen = await evaluate(bubWs, `document.getElementById('selWrap').classList.contains('open')`).catch(() => false);
    ok('下拉菜单展开', menuOpen === true);
    const scrollable = await evaluate(bubWs, `(() => { const m = document.getElementById('selMenu'); return m.scrollHeight >= m.clientHeight && getComputedStyle(m).overflowY.includes('auto'); })()`).catch(() => false);
    ok('菜单可滚动（overflow-y: auto）', scrollable === true);
    const pickRes = await evaluate(bubWs, `(() => {
      const items = document.querySelectorAll('.mi');
      const target = items[Math.min(1, items.length - 1)];
      target.click();
      return { picked: !!target.dataset.id, cur: document.getElementById('selCur').textContent };
    })()`).catch(() => null);
    ok('下拉点选生效（回填触发条）', !!(pickRes && pickRes.picked && pickRes.cur && pickRes.cur.length > 0), pickRes && pickRes.cur);
    // 点归档（选中的分类）
    await evaluate(bubWs, "document.getElementById('ok') ? document.getElementById('ok').click() : null").catch(() => null);
    await sleep(800);
    const captureAfter = (await evaluate(noteWs, 'window.snapnote.ready()')).memo.count;
    ok('归档落地（便签徽章计数 +1）', captureAfter === captureBefore + 1, `${captureBefore}→${captureAfter}`);
    // 归档内容与复制一致（防"误存路径"类回归）
    const archItems = await evaluate(noteWs, 'window.snapnote.memoItems({categoryId: "cat-root", q: ""})').catch(() => []);
    const archText = Array.isArray(archItems) && archItems[0] && archItems[0].text;
    ok('归档内容与复制一致', archText === clipText, String(archText).slice(0, 30));
    try { bubWs.close(); } catch (e) { /* ignore */ }
  }

  // ===== E. 设置（改键 + 捕获开关） =====
  console.log('\n[E] 设置生效链路');
  const newSettings = await evaluate(noteWs, `window.snapnote.setSettings({memoOpenHotkey: 'Ctrl+Alt+P', memoCapture: false})`);
  ok('改键与捕获开关返回生效', newSettings.memoOpenHotkey === 'Ctrl+Alt+P' && newSettings.memoCapture === false);
  const p3 = await evaluate(noteWs, 'window.snapnote.ready()');
  ok('状态推送同步（捕获关 → payload 反映）', p3.memo.captureOn === false);
  await evaluate(noteWs, `window.snapnote.setSettings({memoCapture: true})`);

  // ===== F. 持久化（重启） =====
  console.log('\n[F] 重启持久化');
  killElectron();
  await sleep(800);
  await launchElectron(userData);
  const note2 = await findTarget(t => (t.url || '').includes('index.html'));
  ok('应用重启成功', !!note2);
  const noteWs3 = await cdp(note2);
  const pAfter = await evaluate(noteWs3, 'window.snapnote.ready()');
  ok('任务数据重启存活', pAfter.tasks.some(t => t.title === 'e2e-普通任务'));
  ok('备忘录数据重启存活（计数一致）', pAfter.memo.count === captureBefore + 1,
    `count=${pAfter.memo.count}`);

  // ===== G. 更新链路探活 =====
  console.log('\n[G] 更新链路（开发态断言 + 真实网络探活）');
  const upd = pAfter.update;
  ok('开发态更新器禁用（防误升级，设计行为）', upd && upd.enabled === false);
  // 真实 GitHub Release 可达性（网络探活，非应用内链路）
  const reach = await new Promise((resolve) => {
    const req = httpsGet('https://api.github.com/repos/dyd12031717-prog/snapnote/releases/latest', (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ code: res.statusCode, tag: JSON.parse(d).tag_name }); } catch (e) { resolve({ code: res.statusCode }); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
  ok('GitHub latest Release 可达', reach && reach.code === 200 && /^v/.test(String(reach.tag)), reach && reach.tag);
  // 下载源 Range 探活（续传能力——v1.5.3 修复的直接验证）
  const zipUrl = 'https://github.com/dyd12031717-prog/snapnote/releases/download/' + (reach ? reach.tag : 'v1.5.3')
    + '/SnapNote-Portable-' + (reach ? String(reach.tag).slice(1) : '1.5.3') + '-win-x64.zip';
  for (const m of ['https://gh-proxy.com/', 'https://ghfast.top/']) {
    const r206 = await new Promise((resolve) => {
      const req = httpsGet(m + zipUrl, (res) => resolve(res.statusCode), { Range: 'bytes=0-1023' });
      req.on('error', () => resolve(null));
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.end();
    });
    ok(`镜像 ${m.replace('https://', '')} Range 续传可用（206）`, r206 === 206, `HTTP ${r206}`);
  }

  killElectron();
  try { noteWs.close(); noteWs3.close(); } catch (e) { /* ignore */ }

  // ===== 汇总 =====
  const pass = results.filter(r => r.pass).length;
  console.log(`\n========================`);
  console.log(`全流程自测：${pass}/${results.length} 通过 ${pass === results.length ? '✅ E2E_FULL_OK' : '❌ E2E_FULL_FAIL'}`);
  if (pass !== results.length) {
    console.log('失败项：');
    results.filter(r => !r.pass).forEach(r => console.log('  ✘ ' + r.name));
  }
}

function httpsGet(url, cb, headers, depth) {
  const https = require('https');
  const req = https.request(url, {
    headers: Object.assign({ 'User-Agent': 'SnapNote-E2E' }, headers || {}),
  }, (res) => {
    // 跟随一层重定向（镜像可能 302 到 CDN）
    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && (depth || 0) < 2) {
      res.resume();
      return httpsGet(res.headers.location, cb, headers, (depth || 0) + 1);
    }
    cb(res);
  });
  req.on('error', () => cb(null));
  req.setTimeout(8000, () => { req.destroy(); cb(null); });
  return req;
}

// 总超时硬退出（当日 e2e_update 挂死教训：绝不赌自然退出）
setTimeout(() => {
  console.error('\nE2E_FULL_FAIL: 硬超时 120 秒，强制退出（挂死步骤见上文最后输出）');
  killElectron();
  process.exit(1);
}, 120000);

process.on('exit', () => { exiting = true; killElectron(); });

main().then(
  () => { process.exit(process.exitCode || 0); },
  (e) => { console.error('\nE2E_FULL_FAIL:', e.message); killElectron(); process.exit(1); },
);
