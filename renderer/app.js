'use strict';
/**
 * 磁吸便签渲染层逻辑
 * - 生产：window.snapnote（preload 桥）
 * - 无头验证：window.__SNAPNOTE_MOCK__（由测试注入，接口同构）
 */
(function () {
  const api = window.snapnote || window.__SNAPNOTE_MOCK__;
  if (!api) { document.body.textContent = 'no bridge'; return; }

  const $ = (sel) => document.querySelector(sel);
  const body = document.body;
  const stage = $('#stage');
  const handle = $('#handle');
  const handleBadge = $('#handleBadge');
  const handleDot = $('#handleDot');
  const noteSub = $('#noteSub');
  const taskList = $('#taskList');
  const emptyState = $('#emptyState');
  const taskInput = $('#taskInput');
  const chipsBox = $('#chips');
  const customRow = $('#customRow');
  const customTime = $('#customTime');
  const customClear = $('#customClear');

  let state = { tasks: [], settings: {}, mode: 'handle', hotkeyActive: true };
  let chipAt = null;          // 当前选中胶囊的 ISO 时间
  let chipsCache = [];

  // ---------------- 时间工具（与 electron/lib/timeparse.js 同规则） ----------------
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtHM = (d) => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  function isOverdue(t) { return !!t.dueAt && !t.done && new Date(t.dueAt).getTime() <= Date.now(); }
  function isTodayTask(t) { return !!t.dueAt && !t.done && sameDay(new Date(t.dueAt), new Date()); }

  function buildChips() {
    const n = new Date();
    const tonight = new Date(n); tonight.setHours(20, 0, 0, 0);
    let tonightLabel = '今晚 20:00';
    if (tonight.getTime() <= n.getTime()) { tonight.setHours(21, 0, 0, 0); tonightLabel = '今晚 21:00'; }
    const tomorrow = startOfDay(n); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
    const after = startOfDay(n); after.setDate(after.getDate() + 2); after.setHours(9, 0, 0, 0);
    return [
      { label: '1 小时后', at: new Date(n.getTime() + 3600000).toISOString() },
      { label: tonightLabel, at: tonight.toISOString() },
      { label: '明天 09:00', at: tomorrow.toISOString() },
      { label: '后天 09:00', at: after.toISOString() },
      { label: '自定义…', at: 'custom' },
    ];
  }

  function fmtDue(iso) {
    const d = new Date(iso), n = new Date(), hm = fmtHM(d);
    if (sameDay(d, n)) return hm;
    const dayDiff = Math.round((startOfDay(d) - startOfDay(n)) / 86400000);
    if (dayDiff === 1) return '明天 ' + hm;
    if (dayDiff === 2) return '后天 ' + hm;
    if (dayDiff > 0 && dayDiff <= 7) return '周' + '日一二三四五六'[d.getDay()] + ' ' + hm;
    const ymd = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    return d.getFullYear() === n.getFullYear() ? ymd + ' ' + hm : d.getFullYear() + '-' + ymd + ' ' + hm;
  }

  // ---------------- 渲染 ----------------
  function setMode(m) {
    state.mode = m;
    body.classList.toggle('mode-handle', m === 'handle');
    body.classList.toggle('mode-note', m === 'note');
    if (m === 'note') setTimeout(() => { try { taskInput.focus(); } catch (e) {} }, 60);
  }

  function renderHandle() {
    const count = state.tasks.filter(t => !t.done && (isTodayTask(t) || isOverdue(t))).length;
    handleBadge.textContent = count;
    handleBadge.dataset.zero = count === 0 ? '1' : '0';
    handleDot.classList.toggle('quiet', count === 0);
  }

  function renderNote() {
    const undone = state.tasks.filter(t => !t.done);
    const done = state.tasks.filter(t => t.done);
    const overdueN = state.tasks.filter(isOverdue).length;
    noteSub.textContent = overdueN > 0
      ? `注意：有 ${overdueN} 项已过期`
      : '记下要做的事，到点我会提醒你';
    noteSub.classList.toggle('warn', overdueN > 0);

    const frag = document.createDocumentFragment();
    if (undone.length === 0 && done.length === 0) {
      emptyState.style.display = '';
      frag.appendChild(emptyState.cloneNode(true));
    } else {
      emptyState.style.display = 'none';
      if (undone.length) {
        if (done.length) frag.appendChild(sectionEl('进行中'));
        for (const t of undone) frag.appendChild(taskEl(t));
      } else {
        frag.appendChild(sectionEl('已全部完成'));
      }
      if (done.length) {
        frag.appendChild(sectionEl('已完成'));
        for (const t of done) frag.appendChild(taskEl(t));
      }
    }
    taskList.innerHTML = '';
    taskList.appendChild(frag);
    taskList.scrollTop = taskList.scrollHeight; // 最新输入在底部可见
  }

  function sectionEl(text) {
    const d = document.createElement('div');
    d.className = 'sect';
    d.textContent = text;
    return d;
  }

  function taskEl(t) {
    const row = document.createElement('div');
    row.className = 'task' + (t.done ? ' done' : '');
    row.dataset.id = t.id;

    const check = document.createElement('button');
    check.className = 'tcheck';
    check.title = t.done ? '恢复为未完成' : '标记完成';
    check.addEventListener('click', () => api.toggleTask(t.id));

    const main = document.createElement('div');
    main.className = 'tmain';
    const title = document.createElement('div');
    title.className = 'ttitle';
    title.textContent = t.title;

    const meta = document.createElement('div');
    meta.className = 'tmeta';
    if (t.dueAt) {
      const pill = document.createElement('span');
      pill.className = 'duepill' + (isOverdue(t) ? ' overdue' : (isTodayTask(t) ? '' : ' later'));
      pill.textContent = fmtDue(t.dueAt) + (isOverdue(t) ? ' · 已过期' : '');
      meta.appendChild(pill);
    }
    const del = document.createElement('button');
    del.className = 'tdel';
    del.title = '删除';
    del.textContent = '删除';
    del.addEventListener('click', () => row.classList.add('dragging') || api.removeTask(t.id));

    main.appendChild(title);
    meta.appendChild(del);
    main.appendChild(meta);
    row.appendChild(check);
    row.appendChild(main);
    return row;
  }

  function renderChips() {
    chipsCache = buildChips();
    chipsBox.innerHTML = '';
    chipAt = null;
    chipsCache.forEach((c) => {
      const el = document.createElement('button');
      el.className = 'chip' + (c.at === 'custom' ? ' chip-plain' : '');
      el.textContent = c.label;
      el.addEventListener('click', () => {
        if (c.at === 'custom') {
          customRow.hidden = false;
          if (!customTime.value) {
            const d = new Date(Date.now() + 3600000);
            customTime.value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
          }
          chipAt = null;
          markActive(null);
          return;
        }
        customRow.hidden = true;
        chipAt = (chipAt === c.at) ? null : c.at;
        markActive(chipAt ? c.label : null);
      });
      el.dataset.label = c.label;
      chipsBox.appendChild(el);
    });
  }

  function markActive(label) {
    chipsBox.querySelectorAll('.chip').forEach(el =>
      el.classList.toggle('active', el.dataset.label === label));
  }

  function render() { renderHandle(); renderNote(); }

  function push(data) {
    state = data;
    render();
  }

  // ---------------- 录入 ----------------
  async function submitTask() {
    const title = taskInput.value.trim();
    if (!title) return;
    let dueAt = chipAt;
    if (!dueAt && !customRow.hidden && customTime.value) {
      const d = new Date(customTime.value);
      if (!isNaN(d.getTime())) dueAt = d.toISOString();
    }
    await api.addTask(title, dueAt || null);
    taskInput.value = '';
    taskInput.focus();
    customRow.hidden = true;
    customTime.value = '';
    renderChips();
  }

  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitTask(); }
    if (e.key === 'Escape') { e.preventDefault(); api.dock(); }
  });
  customClear.addEventListener('click', () => {
    customRow.hidden = true; customTime.value = ''; markActive(null);
  });
  $('#btnDock').addEventListener('click', () => api.dock());
  $('#btnSettings').addEventListener('click', () => api.openSettings());

  // 悬停保活 / 离开重置失焦倒计时（PRD FR-03）
  stage.addEventListener('mouseenter', () => api.keepalive());
  stage.addEventListener('mouseleave', () => api.idle());

  handle.addEventListener('click', () => api.expand());

  // ---------------- 到点提醒反馈 ----------------
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 220].forEach((delay) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.12, ctx.currentTime + delay / 1000);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (delay + 180) / 1000);
        o.start(ctx.currentTime + delay / 1000);
        o.stop(ctx.currentTime + (delay + 200) / 1000);
      });
    } catch (e) { /* 无音频环境时静默 */ }
  }

  if (api.onDueAlert) api.onDueAlert(() => {
    body.classList.add('due-flash');
    setTimeout(() => body.classList.remove('due-flash'), 2600);
    if (state.settings.sound) beep();
  });

  // ---------------- 初始化 ----------------
  if (api.onViewMode) api.onViewMode(setMode);
  if (api.onPush) api.onPush(push);
  renderChips();

  (async function init() {
    try {
      const data = await api.ready();
      push(data);
      setMode(data.mode || 'handle');
    } catch (e) { /* 桥异常时保持默认 */ }
  })();
})();
