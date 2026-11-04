/**
 * 阅读热力（Reading Heat）——按页记录停留时长，取代「未阅读 / 阅读中 / 已阅读」三态。
 *
 * 计时规则：只有窗口真正处于前台才计时，即
 *   document.visibilityState === 'visible' && document.hasFocus()
 * 切到别的标签、最小化、锁屏都会立刻结算并停表，回来再重新起表。
 * 每秒给「当前页」加 1 秒；按页聚合后写到文献记录的 readingHeat 字段，
 * 同时在 localStorage 留一份离线缓存，避免网络失败时丢掉这一段阅读。
 */
(function () {
  'use strict';

  const CACHE_KEY = 'sciterminal.readingHeatCache';
  const MODE_KEY = 'sciterminal.readingHeatMode';
  const TICK_MS = 1000;
  const FLUSH_TICKS = 15;          // 每 15 秒落一次盘
  // 冷 → 热：浅蓝 / 蓝 / 青 / 黄 / 橙 / 红（与 style.css 的 .heat-lv* 一一对应）
  const LEVELS = ['#e9edf3', '#b9dcfa', '#68b7ef', '#37a3c9', '#f0b03c', '#e8613c'];

  let store = {};
  let mode = 'both';               // both | title | column
  let api = {};
  let timer = 0;
  let active = false;
  let ctx = null;                  // { docId, page, ticks }
  let flushing = false;

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
    catch (_) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 隐私模式 */ }
  }
  try {
    store = readJson(CACHE_KEY, {}) || {};
    const m = localStorage.getItem(MODE_KEY);
    if (['both', 'title', 'column'].includes(m)) mode = m;
  } catch (_) { /* ignore */ }

  const foreground = () => document.visibilityState === 'visible' && document.hasFocus();

  function ensure(docId) {
    if (!store[docId]) store[docId] = { pages: {}, total: 0, updatedAt: 0 };
    const h = store[docId];
    if (!h.pages || typeof h.pages !== 'object') h.pages = {};
    return h;
  }

  function recalc(h) {
    h.total = Object.values(h.pages).reduce((n, v) => n + (Number(v) || 0), 0);
    h.updatedAt = Date.now();
  }

  /** 服务端数据合并回内存：取两边较大的那份，离线时段的阅读不会被覆盖掉。 */
  function sync(items) {
    for (const it of Array.isArray(items) ? items : []) {
      const remote = it.readingHeat;
      if (!remote || !remote.pages) continue;
      const h = ensure(it.id);
      for (const [p, sec] of Object.entries(remote.pages)) {
        h.pages[p] = Math.max(Number(h.pages[p]) || 0, Number(sec) || 0);
      }
      if (Number(h.updatedAt) < Number(remote.updatedAt || 0)) h.updatedAt = Number(remote.updatedAt);
      recalc(h);
    }
    writeJson(CACHE_KEY, store);
  }

  function flush() {
    if (!ctx?.docId) return;
    const docId = ctx.docId;
    const h = ensure(docId);
    recalc(h);
    writeJson(CACHE_KEY, store);
    if (flushing) return;
    flushing = true;
    fetch('/api/literature/' + encodeURIComponent(docId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readingHeat: { pages: h.pages, total: h.total, updatedAt: h.updatedAt } }),
      keepalive: true,
    }).catch(() => {}).finally(() => { flushing = false; });
  }

  function tick() {
    if (!active) return;
    const docId = api.getDocId?.();
    if (!docId) { flush(); ctx = null; return; }
    if (!ctx || ctx.docId !== docId) {
      if (ctx) flush();
      ctx = { docId, page: null, ticks: 0 };
    }
    // 窗口不在前台：不计时，也不把「后台那一秒」算到任何一页上
    if (!foreground()) { ctx.page = null; return; }
    const page = Math.max(1, Math.round(Number(api.getPage?.()) || 1));
    const h = ensure(docId);
    h.pages[page] = (Number(h.pages[page]) || 0) + TICK_MS / 1000;
    recalc(h);
    ctx.page = page;
    ctx.ticks++;
    if (ctx.ticks % FLUSH_TICKS === 0) flush();
    api.onTick?.(h, page);
  }

  function start(hooks) {
    api = hooks || api || {};
    if (active) return;
    active = true;
    ctx = null;
    timer = setInterval(tick, TICK_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('beforeunload', flush);
  }

  function stop() {
    if (!active) return;
    active = false;
    clearInterval(timer);
    timer = 0;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('beforeunload', flush);
    flush();
    ctx = null;
  }

  function onVisibility() { if (document.visibilityState !== 'visible') { flush(); if (ctx) ctx.page = null; } }
  function onBlur() { flush(); if (ctx) ctx.page = null; }
  function onFocus() { if (ctx) ctx.page = null; }

  function heatOf(docId) { return store[docId] || { pages: {}, total: 0, updatedAt: 0 }; }
  function total(docId) { return Number(heatOf(docId).total) || 0; }

  /**
   * 热力分档。
   *
   * 只看绝对秒数的话，通读一篇论文也就每页 1~2 分钟，全落在最浅两档，整列看着是灰的
   * —— 用户以为「热力没上色」。所以改用「相对本篇最久的一页」+ 绝对下限双判据：
   * 只要某一页停过几秒就至少是浅蓝，停留最久的几页一定进到黄 / 橙 / 红。
   */
  function level(sec, maxSec) {
    const s = Number(sec) || 0;
    if (s <= 0) return 0;
    if (s < 15) return 1;                       // 刚点开的一格：只上最浅的色
    const m = Number(maxSec) || 0;
    const r = m > 0 ? s / m : 0;
    if (s >= 1800 || (r >= 0.85 && s >= 120)) return 5;
    if (s >= 900 || (r >= 0.6 && s >= 60)) return 4;
    if (s >= 300 || (r >= 0.4 && s >= 45)) return 3;
    if (s >= 90 || (r >= 0.18 && s >= 20)) return 2;
    return 1;
  }

  /** 一篇文献里停留最久的一页（相对分档的基准） */
  function maxPage(docId) {
    const pages = heatOf(docId).pages || {};
    let max = 0;
    for (const v of Object.values(pages)) max = Math.max(max, Number(v) || 0);
    return max;
  }

  function format(sec) {
    const s = Math.round(Number(sec) || 0);
    if (s < 60) return s + '秒';
    if (s < 3600) return Math.floor(s / 60) + '分' + (s % 60 ? String(s % 60) + '秒' : '');
    return Math.floor(s / 3600) + '小时' + (Math.floor((s % 3600) / 60) || '') + (Math.floor((s % 3600) / 60) ? '分' : '');
  }

  /** 标题底色（按整篇总时长）；mode=column 时不着底色。 */
  function titleStyle(docId) {
    if (mode === 'column') return '';
    const lv = level(total(docId));
    if (!lv) return '';
    return ` style="background:${LEVELS[lv]}22"`;
  }

  /** 按页热力条：一格 = 一页，颜色按该页停留时长分档。 */
  function barHtml(docId, maxPages) {
    const h = heatOf(docId);
    const keys = Object.keys(h.pages).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
    const last = Math.max(maxPages || 0, keys.length ? keys[keys.length - 1] : 0);
    const count = Math.min(Math.max(last, 12), 48);
    const max = maxPage(docId);
    let cells = '';
    for (let p = 1; p <= count; p++) {
      const sec = Number(h.pages[p]) || 0;
      cells += `<i class="heat-tick heat-lv${level(sec, max)}" title="第 ${p} 页 · ${format(sec)}"></i>`;
    }
    return cells;
  }

  /** 文献库「阅读热力」单元格：独立成列时显示。 */
  function cellHtml(it) {
    if (mode === 'title') return '<div class="heat-hidden" title="已折叠为标题底色">·</div>';
    const h = heatOf(it.id);
    const pages = Object.keys(h.pages).filter((p) => Number(h.pages[p]) > 0).length;
    return `<div class="heat-cell" title="按页停留时长，仅在窗口前台时计时；共 ${pages} 页 / ${format(h.total)}">
      <span class="heat-bar">${barHtml(it.id)}</span>
      <span class="heat-total">${format(h.total)}</span>
    </div>`;
  }

  function outlineStyle(page) {
    if (mode === 'column') return '';
    const docId = api.getDocId?.();
    if (!docId) return '';
    const lv = level(heatOf(docId).pages?.[page], maxPage(docId));
    return lv ? ` style="background:${LEVELS[lv]}26"` : '';
  }

  function setMode(next) {
    if (!['both', 'title', 'column'].includes(next)) return;
    mode = next;
    try { localStorage.setItem(MODE_KEY, mode); } catch (_) { /* ignore */ }
    api.onModeChange?.(mode);
  }

  function summary() {
    const all = Object.entries(store);
    const totalSec = all.reduce((n, [, h]) => n + (Number(h.total) || 0), 0);
    const today = Date.now() - 86400000;
    const todaySec = all.reduce((n, [, h]) => n + (Number(h.updatedAt) >= today ? Number(h.total) || 0 : 0), 0);
    let hottest = { page: 0, sec: 0 };
    for (const [, h] of all) {
      for (const [p, s] of Object.entries(h.pages || {})) {
        if (Number(s) > hottest.sec) hottest = { page: Number(p), sec: Number(s) };
      }
    }
    return { docs: all.length, totalSec, todaySec, hottest };
  }

  window.ReadingHeat = {
    start, stop, flush, sync, heatOf, total, level, format,
    titleStyle, barHtml, cellHtml, outlineStyle, setMode, summary,
    isForeground: foreground,   // 导出给单测验证「仅前台计时」
    get mode() { return mode; },
    get active() { return active; },
  };
})();
