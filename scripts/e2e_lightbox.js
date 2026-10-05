#!/usr/bin/env node
'use strict';
/**
 * v1.6.1 图片查看器专项 e2e：真实 Electron + Xvfb + CDP 驱动完整用户旅程。
 *
 * 旅程：预置图片条目 → 开备忘录 → 点卡片开详情 → 点大图唤起查看器 →
 *       滚轮缩放（断言 transform）→ 拖动平移 → Esc 关闭 → 关闭钮关闭 →
 *       缩略图不可拖出（draggable=false 断言）。
 * 截图（查看器打开态）存 /tmp/lb_shot.png 供 VLM 审查。
 *
 * 运行：node scripts/e2e_lightbox.js（需 Xvfb :105 与 ws 模块）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PORT = 9226;
const DISPLAY = process.env.E2E_DISPLAY || ':105';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc = null, exiting = false;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? '✔' : '✖'} ${name}${extra ? '（' + extra + '）' : ''}`);
  cond ? pass++ : fail++;
}

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
    const hit = (await targets().catch(() => [])).find(match);
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}
async function cdp(target) {
  const WebSocket = await import('ws').catch(() => null);
  const Ws = (WebSocket && (WebSocket.default || WebSocket)) || require('ws');
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
          r && r.exceptionDetails ? reject(new Error(JSON.stringify(r.exceptionDetails).slice(0, 300))) : resolve(r && r.value);
        }
      } catch (e) { /* 非 JSON 帧 */ }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise } }));
    setTimeout(() => { ws.off('message', onMsg); reject(new Error('evaluate 超时')); }, 20000);
  });
}
function screenshot(ws, file) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    const onMsg = (data) => {
      try {
        const m = JSON.parse(String(data));
        if (m.id === id) {
          ws.off('message', onMsg);
          fs.writeFileSync(file, Buffer.from(m.result.data, 'base64'));
          resolve(file);
        }
      } catch (e) { /* */ }
    };
    ws.on('message', onMsg);
    setTimeout(() => { ws.off('message', onMsg); reject(new Error('截图超时')); }, 15000);
  });
}

async function launchElectron(userData) {
  proc = spawn('npx', ['electron', '.', '--no-sandbox',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*'], {
    cwd: ROOT,
    env: { ...process.env, DISPLAY, SNAPNOTE_FAST: '1', SNAPNOTE_USER_DATA: userData },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const errLog = [];
  proc.stderr.on('data', d => errLog.push(String(d)));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if ((await targets().catch(() => [])).length) return { errLog };
    await sleep(400);
  }
  throw new Error('Electron 20 秒内未就绪：' + errLog.slice(-5).join('\n'));
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-lb-'));
  // 预置图片资产：hash.png + hash_t.jpg（thumb 用同图即可——只验证查看器链路）
  const png = fs.readFileSync('/tmp/e2e_lb.png');
  const hash = crypto.createHash('sha256').update(png).digest('hex');
  const assets = path.join(userData, 'memo-assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, hash + '.png'), png);
  fs.writeFileSync(path.join(assets, hash + '_t.jpg'), png);

  await launchElectron(userData);
  const note = await findTarget(t => (t.url || '').includes('index.html'), 20000);
  ok('便签窗口就绪', !!note);
  const noteWs = await cdp(note);
  // 等 DOM/按钮真实就绪（target 出现 ≠ app.js 已执行——过早 click 无效）
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const has = await evaluate(noteWs, "!!document.getElementById('btnMemo')").catch(() => false);
    if (has) break;
    await sleep(300);
  }
  await evaluate(noteWs, "document.getElementById('btnMemo').click()");
  const memo = await findTarget(t => (t.url || '').includes('memo.html'), 10000);
  ok('备忘录窗口打开', !!memo);
  const ws = await cdp(memo);

  // 造图片条目（imageHash 指向预置资产）
  const item = await evaluate(ws, `window.snapnote.memoAddItem({type:'image', imageHash:'${hash}', imageW:900, imageH:620, source:'manual'})`);
  ok('图片条目已造', !!(item && item.id), item && item.id);
  await evaluate(ws, `window.snapnote.memoAddItem({type:'image', imageHash:'${hash}', imageW:900, imageH:620})`).catch(() => {}); // 去重窗口内第二条预期 duplicate，忽略结果
  await sleep(600); // 等列表渲染

  // 1) 卡片缩略图不可拖出
  const dragAttr = await evaluate(ws, `document.querySelector('.item .imgbox img') && document.querySelector('.item .imgbox img').getAttribute('draggable')`);
  ok('缩略图 draggable=false（不再被拖走）', dragAttr === 'false', `draggable=${dragAttr}`);

  // 2) 点卡片 → 详情 + 大图 + hint
  await evaluate(ws, `document.querySelector('.item .body').dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
  await sleep(300);
  const detailOpen = await evaluate(ws, `document.getElementById('detail').classList.contains('open')`);
  ok('详情打开', detailOpen === true);
  const bigImg = await evaluate(ws, `!!document.querySelector('.bigimg img') && document.querySelector('.bigimg img').src`);
  ok('详情大图存在', typeof bigImg === 'string' && bigImg.length > 0, String(bigImg).slice(0, 60));
  const hint = await evaluate(ws, `document.querySelector('.bigimg .hint') && document.querySelector('.bigimg .hint').textContent`);
  ok('「点击图片放大查看」提示', hint === '点击图片放大查看');

  // 3) 点大图 → 查看器
  await evaluate(ws, `document.querySelector('.bigimg img').dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
  await sleep(250);
  const lbOpen = await evaluate(ws, `document.getElementById('lightbox').classList.contains('open')`);
  const lbSrc = await evaluate(ws, `document.querySelector('#lightbox img').src`);
  ok('点击大图唤起查看器', lbOpen === true);
  ok('查看器载入同源大图', typeof lbSrc === 'string' && lbSrc.includes('.png'));
  await screenshot(ws, '/tmp/lb_shot_open.png');

  // 4) 滚轮缩放（cancelable 才能 preventDefault）
  await evaluate(ws, `document.getElementById('lightbox').dispatchEvent(new WheelEvent('wheel', {deltaY:-120, clientX:600, clientY:400, bubbles:true, cancelable:true}))`);
  await sleep(120);
  const tr1 = await evaluate(ws, `document.querySelector('#lightbox img').style.transform`);
  ok('滚轮放大生效（≈118%）', /scale\(1\.18/.test(String(tr1)), tr1);
  const zoomPct = await evaluate(ws, `document.querySelector('#lightbox .lbZoom').textContent`);
  ok('缩放百分比角标', zoomPct === '118%', zoomPct);
  // 缩回一档 → 回 100%
  await evaluate(ws, `document.getElementById('lightbox').dispatchEvent(new WheelEvent('wheel', {deltaY:120, clientX:600, clientY:400, bubbles:true, cancelable:true}))`);
  await sleep(120);
  const tr2 = await evaluate(ws, `document.querySelector('#lightbox img').style.transform`);
  ok('反向滚轮回到 100%', /scale\(1(\.0+)?\)/.test(String(tr2)), tr2);

  // 5) 拖动平移
  const el = await evaluate(ws, `(function(){
    const im = document.querySelector('#lightbox img');
    im.dispatchEvent(new PointerEvent('pointerdown', {clientX:500, clientY:300, pointerId:1, bubbles:true, cancelable:true}));
    im.dispatchEvent(new PointerEvent('pointermove', {clientX:560, clientY:340, pointerId:1, bubbles:true, cancelable:true}));
    im.dispatchEvent(new PointerEvent('pointerup', {pointerId:1, bubbles:true}));
    return im.style.transform;
  })()`);
  ok('拖动平移（+60,+40）', /translate\(60px,\s*40px\)/.test(String(el)), el);

  // 6) Esc 关闭
  await evaluate(ws, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await sleep(150);
  ok('Esc 关闭查看器', (await evaluate(ws, `document.getElementById('lightbox').classList.contains('open')`)) === false);

  // 7) 重开 → 关闭钮
  await evaluate(ws, `window.__openLightbox(document.querySelector('.bigimg img').src)`);
  await sleep(150);
  ok('重开查看器', (await evaluate(ws, `document.getElementById('lightbox').classList.contains('open')`)) === true);
  await evaluate(ws, `document.querySelector('#lightbox .lbClose').click()`);
  await sleep(150);
  ok('右上角 ✕ 关闭', (await evaluate(ws, `document.getElementById('lightbox').classList.contains('open')`)) === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  exiting = true;
  try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) { try { proc.kill('SIGKILL'); } catch (x) { /* */ } }
  await sleep(600);
  process.exit(fail ? 1 : 0);
}

setTimeout(() => { console.error('E2E_LIGHTBOX_FAIL: 硬超时 3 分钟'); try { proc && process.kill(-proc.pid, 'SIGKILL'); } catch (e) {} process.exit(1); }, 180000).unref();
main().catch((e) => { console.error('E2E_LIGHTBOX_FAIL:', e.message); try { proc && process.kill(-proc.pid, 'SIGKILL'); } catch (x) {} process.exit(1); });
