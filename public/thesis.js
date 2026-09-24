/* thesis.js —— 学位论文阅读（独立模块）
 *
 * 与文献中心完全分开：数据走 /api/theses 系列，阅读器是独立实现（不改 app.js 里那套 pr 阅读器），
 * 因此文献中心的行为不受任何影响。app.js 只负责在切到本视图时调一次 ThesisView.mount()。
 *
 * 三块内容：
 *   ① 列表：以表格管理学位论文（AI 读封面页填字段、分类、自动进度、手点评级、按年份/时间/评级排序）
 *   ② 阅读器：左侧章节书签栏 + 中间 PDF 连续滚动 + 右侧「解析结果 / AI 对话」，保留笔记模式
 *      （笔记支持 Ctrl+V 粘贴截图；扫描件页可用「识别文字」把图上的文字摘出来）
 *   ③ 写作支撑：摘录素材库、章节速读、综述条目、答辩演练、对比阅读、关联我的大论文
 *
 * 长文档问答的做法见 src/thesisContext.js：不塞全文，而是「档案卡 + 当前位置 + 检索命中 + 近 8 轮」。
 */
(function () {
  'use strict';

  // ==================== 常量 ====================

  // 默认 12 列 = 用户勾选的那 12 项（学位类型 / 年份 就在默认列里，可在「字段配置」里关掉）
  const BASE_COLS = [
    { key: 'file', label: '文献', cls: 'th-col-file' },
    { key: 'title', label: '标题', cls: 'th-col-title' },
    { key: 'authors', label: '作者' },
    { key: 'school', label: '学校' },
    { key: 'degreeType', label: '学位类型' },
    { key: 'year', label: '年份' },
    { key: 'collectionId', label: '分类' },
    { key: 'progress', label: '阅读进度', cls: 'th-col-num' },
    { key: 'rating', label: '评级', cls: 'th-col-num' },
    { key: 'importedAt', label: '导入时间' },
    { key: 'myThoughts', label: '我的思考' },
    { key: 'referenceValue', label: '参考价值' },
  ];

  // 可选列全部并入默认列，这里留空以便将来再加「默认不显示」的字段
  const EXTRA_COLS = [];

  const LABELS = {
    title: '标题', authors: '作者', school: '学校', degreeType: '学位类型', year: '年份',
    myThoughts: '我的思考', referenceValue: '参考价值',
  };

  // 表格里可就地编辑的字段；标题改成点击打开「解析详情」（与文献中心一致）
  const INLINE_EDITABLE = new Set(['myThoughts', 'referenceValue']);

  // 「解析详情」抽屉里按这个顺序展示
  const DETAIL_ROWS = ['title', 'authors', 'school', 'degreeType', 'year', 'myThoughts', 'referenceValue'];

  // 能参与排序的列 → 排序键（表头可点，与工具栏的下拉是同一套状态）
  const COL_SORT = {
    title: 'title', year: 'year', rating: 'rating', progress: 'progress', importedAt: 'importedAt',
  };
  const SORT_KEYS = new Set(['title', 'year', 'rating', 'progress', 'importedAt']);
  const SORT_LABELS = {
    importedAt: '导入时间', year: '年份', rating: '评级', progress: '阅读进度', title: '标题',
  };
  // 切换排序键时的默认方向：时间 / 年份 / 评级 / 进度都是「新的、高的、多的在前」更常用；
  // 标题按拼音 A→Z 更自然
  const SORT_DEFAULT_DIR = { title: 'asc' };

  const LS = {
    // 换过 key：字段从 22 个砍到 12 个之后，老用户 localStorage 里存的是旧的 10 列名单，
    // 沿用会让「学位类型 / 年份」永远不出现，所以直接换 key 让默认值生效一次
    cols: 'thesisCols2',
    sort: 'thesisSort',
    model: 'aiModel:thesis',
    budget: 'thesisBudget',
    attach: 'thesisAttachSection',
    noteRatio: 'thesisNoteRatio',
  };

  const BUDGETS = [
    { v: 20000, label: '精简 20k' },
    { v: 40000, label: '标准 40k' },
    { v: 80000, label: '充裕 80k' },
  ];

  // ==================== 状态 ====================

  const S = {
    mounted: false,
    items: [], collections: [], summary: null,
    filter: { collectionId: '__all__', progress: '', q: '' },
    selected: new Set(),
    cols: null,
    sort: 'importedAt', sortDir: 'desc',
    bigPaper: null,
    quotes: [],
    modelChoices: [],
    visionReady: false,   // 有没有可用视觉模型 —— 决定解析要不要花时间渲染页面图
    detailId: '',
    busy: false,
  };

  // 阅读器状态
  const R = {
    id: '', record: null, doc: null, numPages: 0, scale: 1.2, pageW: 0, pageH: 0,
    page: 1, outline: [], outlineSource: '', chat: [], note: '', noteLoaded: false,
    tab: 'analysis', noteMode: false, busy: false, observer: null, scrollRaf: 0,
    saveTimer: 0, noteTimer: 0, renderTimer: 0, quotes: [],
    // 渲染队列：只渲染视口附近、且**一次只跑一页**，见 pumpRenderQueue
    queue: [], queued: new Set(), pumping: false, tasks: new Map(),
    recycleObs: null, noteView: 'edit', noteRatio: 0.44,
    pendingScale: 0, scaleTimer: 0,
    // 文字识别（OCR）：on = 正在页面上框选
    ocrOn: false,
  };

  // ==================== 工具 ====================

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function toast(msg, isErr) {
    const el = document.createElement('div');
    el.className = 'th-toast' + (isErr ? ' err' : '');
    el.textContent = String(msg || '');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isErr ? 5600 : 2600);
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
    return data;
  }

  /** 逐帧消费后端 SSE（server.js 用的是 `data: {json}\n\n` 格式） */
  async function streamPost(path, body, onEvent) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      let msg = `请求失败（${res.status}）`;
      try { msg = JSON.parse(t).error || msg; } catch (_) { /* ignore */ }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let obj = null;
        try { obj = JSON.parse(payload); } catch (_) { continue; }
        onEvent(obj);
      }
    }
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function readJson(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
  }

  function markdown(text) {
    const src = String(text || '');
    let html;
    try {
      html = window.marked?.parse ? window.marked.parse(src) : esc(src).replace(/\n/g, '<br>');
    } catch { html = esc(src).replace(/\n/g, '<br>'); }
    // ADD_DATA_URI_TAGS：笔记里粘贴的截图是内联 data: URL，DOMPurify 默认会把它当
    // 不可信协议清掉 —— 那样预览里图片就是空白。img 本就该允许内联图。
    if (window.DOMPurify) {
      html = window.DOMPurify.sanitize(html, {
        ADD_ATTR: ['data-page'], ADD_DATA_URI_TAGS: ['img'],
      });
    }
    // 把【章节 · p.12】变成可点的出处
    return html.replace(/【([^】]{1,80}?)·\s*p\.(\d+)】/g,
      (m, where, page) => `<span class="src" data-page="${page}">【${where}· p.${page}】</span>`);
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function progressOf(it) {
    return it.progress || { percent: 0, label: '未阅读', readPage: 0, numPages: it.numPages || 0 };
  }

  // ==================== 视图骨架 ====================

  function buildDom() {
    const view = $('#viewThesis');
    if (!view) return;
    view.classList.add('th-view');
    view.innerHTML = `
      <div class="th-head">
        <div class="th-head-row">
          <div class="th-title"><h2>🎓 学位论文阅读</h2><span id="thSummary"></span></div>
          <div class="tb-spacer"></div>
          <button class="tb-btn accent" id="thBtnImport">⬆ 导入学位论文 PDF</button>
          <button class="tb-btn" id="thBtnCols">▦ 字段配置</button>
          <button class="tb-btn" id="thBtnQuotes">📌 素材库</button>
          <button class="tb-btn" id="thBtnBig">🎯 我的大论文</button>
          <input type="file" id="thFileInput" accept="application/pdf" multiple class="hidden" />
        </div>
        <div class="th-chips" id="thChips"></div>
      </div>
      <div class="th-toolbar">
        <input type="search" id="thSearch" class="tb-input th-search" placeholder="搜索标题 / 作者 / 学校 / 年份…" />
        <select id="thProgressFilter" class="tb-select">
          <option value="">进度：全部</option>
          <option value="未阅读">未阅读</option>
          <option value="阅读中">阅读中</option>
          <option value="已阅读">已阅读</option>
        </select>
        <select id="thSort" class="tb-select" title="排序依据">
          <option value="importedAt">按导入时间</option>
          <option value="progress">按阅读进度</option>
          <option value="rating">按评级</option>
          <option value="title">按标题</option>
          <option value="year">按年份</option>
        </select>
        <button class="tb-btn" id="thSortDir" title="切换升序 / 降序">↓ 降序</button>
        <div class="tb-spacer"></div>
        <button class="tb-btn" id="thBtnCompare">⇄ 对比阅读</button>
        <button class="tb-btn" id="thBtnBatchParse">▶ 批量解析选中</button>
        <button class="tb-btn" id="thBtnDelete">🗑 删除选中</button>
      </div>
      <div class="th-bulk hidden" id="thBulk"></div>
      <div class="th-table-wrap" id="thWrap"></div>
      <div id="thColsPop" class="th-colspop hidden"></div>
    `;
  }

  // ==================== 列表渲染 ====================

  function visibleCols() {
    if (!S.cols) S.cols = readJson(LS.cols, null) || BASE_COLS.map((c) => c.key);
    const byKey = new Map([...BASE_COLS, ...EXTRA_COLS.map((c) => ({ ...c, extra: true }))].map((c) => [c.key, c]));
    const cols = S.cols.map((k) => byKey.get(k)).filter(Boolean);
    return cols.length ? cols : BASE_COLS;
  }

  /** 比较函数：语义为「降序」，调用方乘 ±1 换方向（表头与下拉共用） */
  function cmpDesc(a, b, key) {
    if (key === 'progress') return progressOf(b).percent - progressOf(a).percent;
    if (key === 'rating') return (Number(b.rating) || 0) - (Number(a.rating) || 0);
    if (key === 'title') return String(b.title || '').localeCompare(String(a.title || ''), 'zh');
    if (key === 'year') return (Number(b.year) || 0) - (Number(a.year) || 0);
    return String(b.importedAt || '').localeCompare(String(a.importedAt || ''));
  }

  /**
   * 切换排序。同一列再点一次 = 反转方向（表头的习惯用法）。
   *
   * 为什么要「同列再点反转、换列用默认方向」：用户点表头时的意图是「按这列看」，
   * 换列却沿用上列的方向会让「按年份」默认变成最老的在前，很反直觉。
   */
  function setSort(key, { toggle = false } = {}) {
    if (!SORT_KEYS.has(key)) return;
    if (toggle && S.sort === key) {
      S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      S.sort = key;
      S.sortDir = SORT_DEFAULT_DIR[key] || 'desc';
    }
    writeJson(LS.sort, { key: S.sort, dir: S.sortDir });
    syncSortUi();
    renderTable();
  }

  /** 把排序状态同步到工具栏的两个控件上（下拉 + 方向按钮） */
  function syncSortUi() {
    const sel = $('#thSort');
    if (sel) sel.value = S.sort;
    const btn = $('#thSortDir');
    if (btn) {
      const asc = S.sortDir === 'asc';
      btn.textContent = asc ? '↑ 升序' : '↓ 降序';
      btn.title = `当前按${SORT_LABELS[S.sort] || ''}${asc ? '升序' : '降序'}（点击切换）`;
    }
  }

  function filtered() {
    const q = S.filter.q.trim().toLowerCase();
    let list = S.items.filter((it) => {
      if (S.filter.collectionId !== '__all__' && (it.collectionId || '') !== S.filter.collectionId) return false;
      const p = progressOf(it);
      if (S.filter.progress && p.label !== S.filter.progress) return false;
      if (!q) return true;
      const hay = [it.title, it.authors, it.school, it.degreeType, it.year, it.originalName, it.myThoughts]
        .join(' ').toLowerCase();
      return hay.includes(q);
    });
    const sort = SORT_KEYS.has(S.sort) ? S.sort : 'importedAt';
    const sign = S.sortDir === 'asc' ? -1 : 1;
    list = [...list].sort((a, b) => sign * cmpDesc(a, b, sort));
    return list;
  }

  function renderChips() {
    const box = $('#thChips');
    if (!box) return;
    const counts = new Map();
    for (const it of S.items) {
      const k = it.collectionId || '';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const chip = (key, label, n) => `<div class="th-chip${S.filter.collectionId === key ? ' active' : ''}" data-col="${esc(key)}">
        ${esc(label)}<span class="th-chip-n">${n}</span></div>`;
    box.innerHTML = [
      chip('__all__', '全部', S.items.length),
      chip('', '未分类', counts.get('') || 0),
      ...S.collections.map((c) => chip(c.id, c.name, counts.get(c.id) || 0)),
      '<div class="th-chip th-chip-add" id="thAddCol">＋ 新建分类</div>',
    ].join('');
  }

  function starHtml(it) {
    const rating = Number(it.rating) || 0;
    const stars = [1, 2, 3, 4, 5]
      .map((i) => `<span class="th-star${i <= rating ? ' on' : ''}" data-v="${i}" title="${i} 星">★</span>`)
      .join('');
    return `<span class="th-stars" data-id="${esc(it.id)}" title="点第几颗星就是几星（再点同一颗取消）">${stars}</span>`;
  }

  /** 星级悬停预览：停在 3 颗上就只点亮前 3 颗，让人看清自己要打几分 */
  function starPreview(root) {
    if (!root) return;
    root.addEventListener('mouseover', (e) => {
      const star = e.target.closest?.('.th-star');
      if (!star) return;
      const box = star.closest('.th-stars');
      const v = Number(star.dataset.v) || 0;
      $$('.th-star', box).forEach((s) => s.classList.toggle('preview', Number(s.dataset.v) <= v));
    });
    root.addEventListener('mouseout', (e) => {
      const star = e.target.closest?.('.th-star');
      if (!star) return;
      const box = star.closest('.th-stars');
      // 只在真正离开这一组星时才清掉预览（星与星之间移动不算离开）
      if (box && !box.contains(e.relatedTarget)) $$('.th-star', box).forEach((s) => s.classList.remove('preview'));
    });
  }

  function progressHtml(it) {
    const p = progressOf(it);
    const cls = p.label === '已阅读' ? 's2' : (p.label === '阅读中' ? 's1' : 's0');
    const tip = p.numPages ? `${p.readPage}/${p.numPages} 页` : '页数未知';
    return `<div class="th-prog" title="${tip}">
        <div class="th-prog-bar"><div class="th-prog-fill" style="width:${p.percent}%"></div></div>
        <span class="th-prog-label ${cls}">${esc(p.label)}</span>
      </div>`;
  }

  /** 「这次解析是怎么做的」—— 顺便告诉用户喂给了模型几页（省 token 的可见证据） */
  function parseMethodLabel(it) {
    const base = { vision: '视觉模型看图', text: '文本读取' }[it?.source] || '';
    if (!base) return '';
    const n = Number(it?.parsePages) || 0;
    return n ? `${base} · 前 ${n} 页` : base;
  }

  function cellHtml(it, key) {
    if (key === 'file') {
      const name = it.originalName || '未上传附件';
      const meta = it.numPages ? `${it.numPages} 页` : '';
      const st = it.status || 'pending';
      const stLabel = { pending: '待解析', parsing: '解析中', done: '已解析', error: '解析失败' }[st] || st;
      const idx = it.indexStatus === 'ready' ? '<span class="th-badge idx">已建索引</span>' : '';
      return `<div class="th-file">
          <span class="th-file-name" data-open="${esc(it.id)}">${esc(name)}</span>
          <span class="th-file-meta"><span class="th-badge ${esc(st)}">${esc(stLabel)}</span> ${esc(meta)} ${idx}</span>
        </div>`;
    }
    if (key === 'progress') return progressHtml(it);
    if (key === 'rating') return starHtml(it);
    if (key === 'collectionId') {
      const name = S.collections.find((c) => c.id === it.collectionId)?.name || '';
      return `<span class="th-muted" data-col-pick="${esc(it.id)}" style="cursor:pointer">${esc(name || '未分类')}</span>`;
    }
    if (key === 'importedAt') return `<span class="th-muted">${esc(fmtDate(it.importedAt))}</span>`;
    if (key === 'title') {
      const v = it.title || '';
      // 与文献中心一致：点标题看「解析详情」，而不是就地改标题
      return `<div class="th-title-cell${v ? '' : ' th-muted'}" data-detail="${esc(it.id)}"
        title="点击查看解析详情">${esc(v || '（待解析）')}</div>`;
    }
    const v = String(it[key] || '');
    if (INLINE_EDITABLE.has(key)) {
      return `<div class="th-cell-edit th-truncate${v ? '' : ' th-muted'}" contenteditable="true" data-id="${esc(it.id)}" data-f="${key}">${esc(v || '双击填写')}</div>`;
    }
    return v ? `<div class="th-truncate">${esc(v)}</div>` : '<span class="th-muted">—</span>';
  }

  function renderTable() {
    const wrap = $('#thWrap');
    if (!wrap) return;
    const cols = visibleCols();
    const list = filtered();
    const sum = S.summary || {};
    const sm = $('#thSummary');
    if (sm) {
      const bp = sum.byProgress || {};
      sm.textContent = `共 ${sum.total || 0} 篇 · 未阅读 ${bp['未阅读'] || 0} · 阅读中 ${bp['阅读中'] || 0} · 已阅读 ${bp['已阅读'] || 0} · 素材 ${sum.quotes || 0} 条`;
    }
    if (!list.length) {
      wrap.innerHTML = `<div class="th-empty"><div class="th-empty-icon">🎓</div>
        <p>${S.items.length ? '没有符合筛选条件的论文' : '还没有学位论文'}</p>
        <p class="th-muted">点击「⬆ 导入学位论文 PDF」；导入后会自动读封面填好标题、作者、学校、学位类型、年份。点标题可看解析详情。</p></div>`;
      renderBulk();
      return;
    }
    const head = `<tr>
      <th class="th-col-pick"><input type="checkbox" id="thChkAll" ${list.every((it) => S.selected.has(it.id)) ? 'checked' : ''} /></th>
      ${cols.map((c) => {
        const sk = COL_SORT[c.key];
        if (!sk) return `<th class="${c.cls || ''}">${esc(c.label)}</th>`;
        const active = sk === S.sort;
        const arrow = active ? (S.sortDir === 'asc' ? '↑' : '↓') : '↕';
        const tip = active
          ? `当前按${c.label}${S.sortDir === 'asc' ? '升序' : '降序'}，点击反转`
          : `点击按${c.label}排序`;
        return `<th class="${c.cls || ''} th-sortable${active ? ' th-sorted' : ''}" data-sortkey="${esc(sk)}" title="${esc(tip)}">${esc(c.label)}<span class="th-sort-ind">${arrow}</span></th>`;
      }).join('')}
      <th></th>
    </tr>`;
    const rows = list.map((it) => `<tr data-id="${esc(it.id)}" class="${S.selected.has(it.id) ? 'sel' : ''}">
      <td class="th-col-pick"><input type="checkbox" data-chk="${esc(it.id)}" ${S.selected.has(it.id) ? 'checked' : ''} /></td>
      ${cols.map((c) => `<td class="${c.cls || ''}">${cellHtml(it, c.key)}</td>`).join('')}
      <td class="th-col-num"><button class="tb-btn ghost" data-read="${esc(it.id)}" title="打开阅读器">📖</button></td>
    </tr>`).join('');
    wrap.innerHTML = `<table class="th-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
    renderBulk();
  }

  function renderBulk() {
    const bar = $('#thBulk');
    if (!bar) return;
    const n = S.selected.size;
    bar.classList.toggle('hidden', n === 0);
    if (!n) { bar.innerHTML = ''; return; }
    const opts = ['<option value="">移动到分类…</option>', '<option value="">未分类</option>']
      .concat(S.collections.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`));
    bar.innerHTML = `<span>已选 <b>${n}</b> 篇</span>
      <select class="tb-select" id="thBulkCol">${opts.join('')}</select>
      <button class="tb-btn" id="thBulkClear">取消选择</button>`;
  }

  // ==================== 列表交互 ====================

  async function refresh() {
    const data = await api('/api/theses');
    S.items = data.items || [];
    S.collections = data.collections || [];
    S.summary = data.summary || null;
    renderChips();
    renderTable();
  }

  async function loadModelChoices() {
    if (S.modelChoices.length) return S.modelChoices;
    try {
      // 用 /api/models/choices（专门给「单个对话切换模型」用的接口，已按可用性过滤并置顶激活模型）；
      // 顺带拿 /api/models 的 activeVision 判断有没有视觉模型可用
      const [choices, models] = await Promise.all([api('/api/models/choices'), api('/api/models')]);
      S.modelChoices = (choices?.choices || []).map((m) => ({
        id: m.id, label: m.label, active: !!m.isActive, vision: !!m.vision,
      }));
      S.visionReady = !!models?.activeVision?.id;
    } catch (_) { S.modelChoices = []; }
    return S.modelChoices;
  }

  function modelSelectHtml(id) {
    const saved = (() => { try { return localStorage.getItem(LS.model) || ''; } catch { return ''; } })();
    const current = S.modelChoices.some((m) => m.id === saved) ? saved : (S.modelChoices.find((m) => m.active)?.id || S.modelChoices[0]?.id || '');
    return `<select id="${id}">${S.modelChoices.map((m) => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.label)}${m.active ? ' ★' : ''}</option>`).join('')}</select>`;
  }

  function pickedModel() {
    const sel = $('#thrModel');
    const v = sel?.value || '';
    if (v) { try { localStorage.setItem(LS.model, v); } catch (_) { /* ignore */ } }
    return v;
  }

  function bindList() {
    $('#thBtnImport')?.addEventListener('click', () => $('#thFileInput')?.click());
    $('#thFileInput')?.addEventListener('change', async (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      if (files.length) await importFiles(files);
    });

    $('#thSearch')?.addEventListener('input', (e) => { S.filter.q = e.target.value || ''; renderTable(); });
    $('#thProgressFilter')?.addEventListener('change', (e) => { S.filter.progress = e.target.value; renderTable(); });
    $('#thSort')?.addEventListener('change', (e) => setSort(e.target.value));
    $('#thSortDir')?.addEventListener('click', () => setSort(S.sort, { toggle: true }));

    $('#thChips')?.addEventListener('click', async (e) => {
      const chip = e.target.closest('.th-chip');
      if (!chip) return;
      if (chip.id === 'thAddCol') {
        const name = await askText({ title: '新建分类', hint: '给这一批论文分个类，例如「组织行为 / 消费者行为」', placeholder: '分类名称' });
        if (name === null || !name.trim()) return;
        try {
          const col = await api('/api/thesis-collections', { method: 'POST', body: { name: name.trim() } });
          S.collections.push(col);
          renderChips();
        } catch (err) { toast(err.message, true); }
        return;
      }
      S.filter.collectionId = chip.dataset.col;
      renderChips();
      renderTable();
    });

    // 表头点击排序（与工具栏的下拉是同一套状态；同列再点反转方向）
    $('#thWrap')?.addEventListener('click', async (e) => {
      const th = e.target.closest('[data-sortkey]');
      if (th) { setSort(th.dataset.sortkey, { toggle: true }); return; }
    });
    // 星级悬停预览：鼠标停在第 N 颗就只点亮前 N 颗。
    // 以前只靠 CSS 的 `.th-stars:hover .th-star` 把 5 颗一次全染金，用户看不出自己
    // 要打几分（也就会以为「只能标 5 星」）。抽屉里那份在 detailDom() 里单独绑。
    starPreview($('#thWrap'));

    $('#thWrap')?.addEventListener('click', async (e) => {
      const t = e.target;
      // 标题 → 解析详情抽屉（与文献中心点标题的行为对齐）
      const detail = t.closest('[data-detail]');
      if (detail) { await openDetail(detail.dataset.detail); return; }
      const read = t.closest('[data-read]');
      if (read) { await openReader(read.dataset.read); return; }
      const open = t.closest('[data-open]');
      if (open) { await openReader(open.dataset.open); return; }

      const star = t.closest('.th-star');
      if (star) {
        const id = star.closest('.th-stars').dataset.id;
        const v = Number(star.dataset.v);
        const it = S.items.find((x) => x.id === id);
        const next = String(Number(it?.rating) === v ? 0 : v);
        await patchItem(id, { rating: next });
        return;
      }
      const pick = t.closest('[data-col-pick]');
      if (pick) {
        const id = pick.dataset.colPick;
        const name = await askText({
          title: '移到分类',
          hint: `已有：${S.collections.map((c) => c.name).join('、') || '（无）'}　留空 = 未分类`,
          placeholder: S.collections.find((c) => c.id === S.items.find((x) => x.id === id)?.collectionId)?.name || '',
        });
        if (name === null) return;
        const target = S.collections.find((c) => c.name === name.trim());
        if (name.trim() && !target) { toast('没有这个分类，请先用「＋ 新建分类」创建', true); return; }
        await patchItem(id, { collectionId: target ? target.id : '' });
      }
    });

    // 复选框 / 批量
    $('#thWrap')?.addEventListener('change', (e) => {
      if (e.target.id === 'thChkAll') {
        const list = filtered();
        if (e.target.checked) list.forEach((it) => S.selected.add(it.id));
        else list.forEach((it) => S.selected.delete(it.id));
        renderTable();
        return;
      }
      const chk = e.target.closest('[data-chk]');
      if (chk) {
        const id = chk.dataset.chk;
        if (chk.checked) S.selected.add(id); else S.selected.delete(id);
        chk.closest('tr')?.classList.toggle('sel', chk.checked);
        renderBulk();
      }
    });

    $('#thBulk')?.addEventListener('change', async (e) => {
      if (e.target.id !== 'thBulkCol') return;
      const val = e.target.value;
      const ids = [...S.selected];
      try {
        await api('/api/theses/batch-update', { method: 'POST', body: { ids, patch: { collectionId: val } } });
        toast(`已移动 ${ids.length} 篇`);
        S.selected.clear();
        await refresh();
      } catch (err) { toast(err.message, true); }
    });
    $('#thBulk')?.addEventListener('click', (e) => {
      if (e.target.id === 'thBulkClear') { S.selected.clear(); renderTable(); }
    });

    $('#thBtnBatchParse')?.addEventListener('click', async () => {
      const ids = [...S.selected];
      if (!ids.length) { toast('先勾选要解析的论文', true); return; }
      const recs = ids.map((id) => S.items.find((x) => x.id === id)).filter(Boolean);
      await parseMany(recs);
      await refresh();
    });

    $('#thBtnDelete')?.addEventListener('click', async () => {
      const ids = [...S.selected];
      if (!ids.length) { toast('先勾选要删除的论文', true); return; }
      if (!confirm(`确定删除选中的 ${ids.length} 篇学位论文及其附图、素材摘录？此操作不可撤销。`)) return;
      try {
        await api('/api/theses/batch-delete', { method: 'POST', body: { ids } });
        S.selected.clear();
        await refresh();
        toast('已删除');
      } catch (err) { toast(err.message, true); }
    });

    $('#thBtnCompare')?.addEventListener('click', () => openCompare());
    $('#thBtnQuotes')?.addEventListener('click', () => openQuotesDrawer());
    $('#thBtnBig')?.addEventListener('click', () => openBigPaper());
    $('#thBtnCols')?.addEventListener('click', () => toggleColsPop());
    // 点外部 / Esc 关掉「字段配置」（上一版这个弹层点哪都关不掉）
    document.addEventListener('mousedown', (e) => {
      if (!colsPopOpen) return;
      if (e.target?.closest?.('#thColsPop') || e.target?.closest?.('#thBtnCols')) return;
      closeColsPop();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && colsPopOpen) closeColsPop();
    });

    // 就地编辑：blur 时保存
    $('#thWrap')?.addEventListener('focusout', async (e) => {
      const cell = e.target.closest?.('.th-cell-edit');
      if (!cell) return;
      const id = cell.dataset.id;
      const field = cell.dataset.f;
      const value = String(cell.innerText || '').trim();
      const it = S.items.find((x) => x.id === id);
      if (!it || String(it[field] || '') === value) return;
      await patchItem(id, { [field]: value });
    });
  }

  async function patchItem(id, patch) {
    try {
      const updated = await api(`/api/theses/${id}`, { method: 'PATCH', body: patch });
      const idx = S.items.findIndex((x) => x.id === id);
      if (idx >= 0) S.items[idx] = updated;
      renderTable();
      if (S.detailId === id) renderDetail();
      if (R.id === id) R.record = updated;
      return updated;
    } catch (err) { toast(err.message, true); return null; }
  }

  // ==================== 解析详情（点标题打开，参考文献中心的抽屉做法） ====================

  const AI_FIELD_KEYS = ['title', 'authors', 'school', 'degreeType', 'year'];

  function detailDom() {
    let el = $('#thDetail');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'thDetail';
    el.className = 'th-drawer hidden';
    el.innerHTML = `
      <div class="th-drawer-mask" id="thDetailMask"></div>
      <aside class="th-drawer-panel">
        <div class="th-drawer-head">
          <button class="tb-btn" id="thDetailClose">← 返回列表</button>
          <button class="tb-btn ghost" id="thDetailPrev" title="上一篇（按当前列表顺序）">‹</button>
          <button class="tb-btn ghost" id="thDetailNext" title="下一篇">›</button>
          <span class="th-drawer-file" id="thDetailFile"></span>
          <div class="sp"></div>
          <button class="tb-btn" id="thDetailReparse" title="重读封面（有视觉模型就看图）">↻ 重新解析</button>
          <button class="tb-btn accent" id="thDetailRead">📖 阅读 PDF</button>
        </div>
        <div class="th-drawer-body" id="thDetailBody"></div>
      </aside>`;
    document.body.appendChild(el);
    starPreview($('#thDetailBody'));
    $('#thDetailClose')?.addEventListener('click', closeDetail);
    $('#thDetailMask')?.addEventListener('click', closeDetail);
    $('#thDetailPrev')?.addEventListener('click', () => stepDetail(-1));
    $('#thDetailNext')?.addEventListener('click', () => stepDetail(1));
    $('#thDetailReparse')?.addEventListener('click', reparseDetail);
    $('#thDetailRead')?.addEventListener('click', () => { const id = S.detailId; closeDetail(); openReader(id); });
    // 抽屉里的字段是 contenteditable：失焦即存（与表格里的就地编辑同一套逻辑）
    // patchItem 内部会顺带 renderDetail()，这里不用再刷一次
    $('#thDetailBody')?.addEventListener('focusout', async (e) => {
      const cell = e.target.closest?.('[data-df]');
      if (!cell) return;
      const id = cell.dataset.id;
      const field = cell.dataset.df;
      const value = String(cell.innerText || '').trim();
      const it = S.items.find((x) => x.id === id);
      if (!it || String(it[field] || '') === value) return;
      await patchItem(id, { [field]: value });
    });
    $('#thDetailBody')?.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-dfcol]');
      if (!sel) return;
      await patchItem(S.detailId, { collectionId: sel.value });
    });
    $('#thDetailBody')?.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-dfdel]');
      if (del) {
        const id = del.dataset.dfdel;
        if (!confirm('删除这篇学位论文及其附图、素材摘录？此操作不可撤销。')) return;
        await api(`/api/theses/${id}`, { method: 'DELETE' });
        S.selected.delete(id);
        closeDetail();
        await refresh();
        toast('已删除');
        return;
      }
      const star = e.target.closest('.th-star');
      if (star) {
        const id = S.detailId;
        const v = Number(star.dataset.v);
        const it = S.items.find((x) => x.id === id);
        await patchItem(id, { rating: String(Number(it?.rating) === v ? 0 : v) });
        renderDetail();
        return;
      }
      const act = e.target.closest('[data-dfact]');
      if (act) {
        const id = S.detailId;
        closeDetail();
        await openReader(id);
        return;
      }
    });
    return el;
  }

  async function openDetail(id) {
    S.detailId = id;
    if (!S.items.some((x) => x.id === id)) {
      try { const one = await api(`/api/theses/${id}`); S.items.push(one); } catch (_) { /* ignore */ }
    }
    detailDom().classList.remove('hidden');
    renderDetail();
  }

  function closeDetail() {
    S.detailId = '';
    $('#thDetail')?.classList.add('hidden');
  }

  function stepDetail(delta) {
    const list = filtered();
    if (!list.length) return;
    const i = list.findIndex((x) => x.id === S.detailId);
    const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))];
    if (next) { S.detailId = next.id; renderDetail(); }
  }

  async function reparseDetail() {
    const it = S.items.find((x) => x.id === S.detailId);
    if (!it) return;
    if (!it.filename) { toast('这篇还没有上传 PDF 附件', true); return; }
    const btn = $('#thDetailReparse');
    if (btn) { btn.disabled = true; btn.textContent = '↻ 解析中…'; }
    toast(S.visionReady ? '正在看封面页解析（不够会自动补看第 2–3 页）…' : '正在读封面页解析…');
    try {
      const updated = await parseOne(it);
      const idx = S.items.findIndex((x) => x.id === updated.id);
      if (idx >= 0) S.items[idx] = updated;
      if (updated.status !== 'done') toast(updated.error || '解析失败', true);
      else toast('解析完成');
      renderDetail();
    } catch (e) { toast(e.message, true); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '↻ 重新解析'; } }
  }

  function renderDetail() {
    const box = $('#thDetailBody');
    const it = S.items.find((x) => x.id === S.detailId);
    if (!box || !it) return;
    const el = detailDom();
    if (el.classList.contains('hidden')) el.classList.remove('hidden');
    const p = progressOf(it);
    const colName = S.collections.find((c) => c.id === it.collectionId)?.name || '未分类';
    const st = it.status || 'pending';
    const stLabel = { pending: '待解析', parsing: '解析中', done: '已解析', error: '解析失败' }[st] || st;
    const methodLabel = parseMethodLabel(it);
    $('#thDetailFile').textContent = it.originalName || '（未上传附件）';

    const fieldRow = (key, label, hint) => {
      const v = String(it[key] || '');
      const ai = AI_FIELD_KEYS.includes(key);
      return `<div class="th-drawer-field">
        <div class="th-drawer-label">${esc(label)}${ai ? '' : ' <span class="th-muted">（我填的）</span>'}</div>
        <div class="th-drawer-val${v ? '' : ' th-muted'}" contenteditable="true"
          data-df="${esc(key)}" data-id="${esc(it.id)}">${esc(v || (hint || '（空，点击填写）'))}</div>
      </div>`;
    };

    box.innerHTML = `
      <h2 class="th-drawer-title">${esc(it.title || it.originalName || '（待解析）')}</h2>
      <div class="th-drawer-meta">
        <span class="th-badge ${esc(st)}">${esc(stLabel)}</span>
        ${it.numPages ? `<span class="th-muted">${it.numPages} 页</span>` : ''}
        <span class="th-muted">${esc(p.numPages ? `${p.readPage}/${p.numPages} 页` : '')}</span>
        <span class="th-muted">导入于 ${esc(fmtDate(it.importedAt))}</span>
        ${methodLabel ? `<span class="th-muted">· ${esc(methodLabel)}</span>` : ''}
      </div>
      ${it.status === 'error' && it.error ? `<div class="th-drawer-warn">解析失败：${esc(it.error)}</div>` : ''}

      <div class="th-drawer-sec">
        <div class="th-drawer-sec-title">书目信息（AI 读封面自动填，可直接改）</div>
        ${fieldRow('title', '标题')}
        <div class="th-drawer-two">
          ${fieldRow('authors', '作者', '（空）')}
          ${fieldRow('school', '学校', '（空）')}
        </div>
        <div class="th-drawer-two">
          ${fieldRow('degreeType', '学位类型', '（空）')}
          ${fieldRow('year', '年份', '（空）')}
        </div>
        <div class="th-drawer-two">
          <div class="th-drawer-field">
            <div class="th-drawer-label">分类</div>
            <select class="th-drawer-select" data-dfcol>
              <option value="" ${it.collectionId ? '' : 'selected'}>未分类</option>
              ${S.collections.map((c) => `<option value="${esc(c.id)}" ${c.id === it.collectionId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="th-drawer-field">
            <div class="th-drawer-label">评级 <span class="th-muted">（手点）</span></div>
            <div>${starHtml(it)}</div>
          </div>
        </div>
      </div>

      <div class="th-drawer-sec">
        <div class="th-drawer-sec-title">我的记录</div>
        ${fieldRow('myThoughts', '我的思考', '这篇给我的启发、能用在哪儿…')}
        ${fieldRow('referenceValue', '参考价值', '高 / 中 / 低，一句话理由')}
      </div>

      <div class="th-drawer-sec">
        <div class="th-drawer-sec-title">阅读与写作</div>
        <div class="th-drawer-actions">
          <button class="tb-btn" data-dfact="read">📖 打开阅读器（章节书签 + AI 对话 + 笔记）</button>
        </div>
        <p class="th-muted" style="font-size:12px;line-height:1.7;margin:6px 0 0">
          研究问题、方法、结论这类内容不在这里硬填 —— 学位论文信息密度高，靠 3 页摘要挤出来的摘要很容易失真。
          在阅读器里用「本章速读 / 综述条目 / 答辩演练」按真实正文生成更可靠。
        </p>
      </div>

      <div class="th-drawer-sec">
        <div class="th-drawer-foot">
          <button class="tb-btn danger" data-dfdel="${esc(it.id)}">🗑 删除这篇论文</button>
        </div>
      </div>
    `;
  }

  // ---------- 「字段配置」弹层 ----------
  //
  // ⚠️ 上一版的坑：这个弹层复用了共用样式 `.pop`（`position:fixed` 但没给 top/left），
  // 而且**没有任何关闭途径** —— 点开之后点空白、按 Esc、再点按钮都关不掉，只能刷新页面。
  // 现在：锚定在按钮下方，并支持「再点按钮 / 点外部 / Esc / ✕」四种关闭方式。

  let colsPopOpen = false;

  function closeColsPop() {
    const pop = $('#thColsPop');
    if (!pop) return;
    pop.classList.add('hidden');
    colsPopOpen = false;
    $('#thBtnCols')?.classList.remove('active');
  }

  function toggleColsPop() {
    if (colsPopOpen) closeColsPop();
    else openColsPop();
  }

  function openColsPop() {
    const pop = $('#thColsPop');
    if (!pop) return;
    renderColsPop();
    pop.classList.remove('hidden');
    colsPopOpen = true;
    $('#thBtnCols')?.classList.add('active');
    const btn = $('#thBtnCols');
    if (btn) {
      const r = btn.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      pop.style.right = `${Math.round(Math.max(12, window.innerWidth - r.right))}px`;
    }
  }

  function renderColsPop() {
    const pop = $('#thColsPop');
    if (!pop) return;
    const all = [...BASE_COLS, ...EXTRA_COLS];
    const cur = new Set(visibleCols().map((c) => c.key));
    pop.innerHTML = `
      <div class="th-colspop-head">
        <b>显示哪些列</b>
        <span class="th-muted">共 ${all.length} 列</span>
        <span class="sp"></span>
        <button class="tb-btn ghost" id="thColsReset">恢复默认</button>
        <button class="tb-btn ghost th-colspop-x" id="thColsClose" title="关闭（Esc）">✕</button>
      </div>
      <div class="th-colspop-body">
        ${all.map((c) => `<label class="th-colspop-item"><input type="checkbox" data-col="${esc(c.key)}" ${cur.has(c.key) ? 'checked' : ''} /> ${esc(c.label)}</label>`).join('')}
      </div>
      <div class="th-colspop-foot">勾掉不想看的列即可；至少保留一列，改完立即生效。</div>`;

    // 监听只挂一次（挂在弹层自己身上做事件委托）：
    // 每次都 addEventListener 会在反复开合后叠出一堆重复的提交，历史版本就踩过这个坑
    if (pop.dataset.bound) return;
    pop.dataset.bound = '1';
    pop.addEventListener('change', (e) => {
      if (!e.target.closest('input[data-col]')) return;
      const keys = $$('input[data-col]', pop).filter((i) => i.checked).map((i) => i.dataset.col);
      S.cols = keys.length ? keys : BASE_COLS.map((c) => c.key);
      writeJson(LS.cols, S.cols);
      renderTable();
    });
    pop.addEventListener('click', (e) => {
      if (e.target.closest('#thColsClose')) { closeColsPop(); return; }
      if (e.target.closest('#thColsReset')) {
        S.cols = BASE_COLS.map((c) => c.key);
        writeJson(LS.cols, S.cols);
        renderTable();
        renderColsPop();
      }
    });
  }

  // ==================== 导入 ====================

  async function importFiles(files) {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
    if (!pdfs.length) { toast('请选择 PDF 文件', true); return; }
    const ids = [];
    toast(`正在导入 ${pdfs.length} 个文件…`);
    for (const f of pdfs) {
      try {
        const rec = await api('/api/theses', {
          method: 'POST',
          body: { title: f.name.replace(/\.pdf$/i, ''), collectionId: S.filter.collectionId === '__all__' ? '' : S.filter.collectionId },
        });
        const fd = new FormData();
        fd.append('file', f, f.name);
        const res = await fetch(`/api/theses/${rec.id}/attachment`, { method: 'POST', body: fd });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '上传失败');
        ids.push(rec.id);
      } catch (err) {
        toast(`${f.name}：${err.message}`, true);
      }
    }
    await refresh();
    if (!ids.length) return;
    const recs = ids.map((id) => S.items.find((x) => x.id === id)).filter(Boolean);
    await parseMany(recs);
    await refresh();
  }

  // ==================== 解析（优先看图） ====================

  // 解析用的 pdf.js 文档，短时间复用，避免「批量解析」时每篇都重新打开一遍。
  // cache 按页缓存已渲染好的 JPEG：两段式解析（先第 1 页、不够再补 2–3 页）时
  // 第 1 页不必重渲一遍。
  let headDoc = { url: '', doc: null, cache: new Map() };

  /**
   * 把论文前 n 页渲染成 JPEG。
   * 学位论文封面版式五花八门（艺术字、竖排、印章、扫描件），纯文本层经常把校名读串行；
   * 交给视觉模型看图最稳。参数取舍：宽 1500px 足够认字（2200px 会让请求体大到拖慢速度），
   * JPEG 0.82 在清晰度与体积间取平衡。
   */
  async function collectHeadImages(rec, n = 3) {
    const lib = await loadPdfJs();
    const url = `/uploads/${encodeURIComponent(rec.filename)}`;
    if (headDoc.url !== url || !headDoc.doc) {
      try { headDoc.doc?.destroy?.(); } catch (_) { /* ignore */ }
      headDoc = { url, doc: await lib.getDocument({ url }).promise, cache: new Map() };
    }
    const doc = headDoc.doc;
    const out = [];
    const total = Math.min(n, doc.numPages || n);
    for (let i = 1; i <= total; i += 1) {
      const hit = headDoc.cache.get(i);
      if (hit) { out.push({ page: i, image: hit }); continue; }
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2.6, 1500 / Math.max(base.width, 1));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const ctx = canvas.getContext('2d');
      // 先铺白底：PDF 的透明区域在 JPEG 里会变成黑块，视觉模型会以为那是一整块墨
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const image = canvas.toDataURL('image/jpeg', 0.82);
      headDoc.cache.set(i, image);
      out.push({ page: i, image });
    }
    return out;
  }

  /**
   * 解析一篇：**先只送第 1 页**，省 token 也省渲染时间。
   *
   * 后端如果发现封面页认出来的字段太少（标题 + 另外 4 个里不到 2 个），
   * 会在响应里回一个 `needMorePages` —— 这时才渲染第 2–3 页再解析一次，
   * 并把这次的结果落库。绝大多数论文止步于第 1 页。
   */
  async function parseOne(rec) {
    let pages = [];
    if (S.visionReady && rec?.filename) {
      try { pages = await collectHeadImages(rec, 1); }
      catch (e) { console.warn('[thesis] 页面截图失败，改用文本解析：', e.message); }
    }
    let out = await api(`/api/theses/${rec.id}/parse`, { method: 'POST', body: { pages } });
    if (out?.needMorePages && S.visionReady && rec?.filename) {
      try {
        const more = await collectHeadImages(rec, 3);
        if (more.length > pages.length) {
          out = await api(`/api/theses/${rec.id}/parse`, { method: 'POST', body: { pages: more } });
        }
      } catch (e) { console.warn('[thesis] 补第 2–3 页失败，沿用封面页结果：', e.message); }
    }
    return out;
  }

  /** 批量解析：并发 2（渲染页面图是 CPU 活，开太多会让界面发卡） */
  async function parseMany(recs) {
    const list = (recs || []).filter((r) => r?.filename);
    if (!list.length) { toast('这些论文还没有 PDF 附件', true); return []; }
    const how = S.visionReady ? '视觉模型读封面页' : '文本读封面页';
    let done = 0;
    toast(`正在解析 ${list.length} 篇（${how}）…`);
    const results = new Array(list.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) {
        const i = cursor;
        cursor += 1;
        try { results[i] = await parseOne(list[i]); }
        catch (e) { results[i] = { id: list[i].id, status: 'error', error: e.message }; }
        done += 1;
        const broken = list.length > 1 ? `（${done}/${list.length}）` : '';
        toast(`解析中${broken}：${(results[i]?.title || list[i].originalName || '').slice(0, 28)}`);
      }
    };
    await Promise.all([worker(), worker()]);
    const bad = results.filter((r) => r?.status !== 'done');
    if (bad.length) {
      toast(`${results.length - bad.length} 篇解析成功，${bad.length} 篇失败：${bad[0]?.error || '未知原因'}`, true);
    } else {
      toast(`解析完成：${results.length} 篇`);
    }
    return results;
  }

  // ==================== 阅读器：骨架 ====================

  function buildReaderDom() {
    if ($('#thr')) return;
    const el = document.createElement('div');
    el.id = 'thr';
    el.className = 'thr hidden';
    el.innerHTML = `
      <div class="thr-top">
        <button id="thrBack">← 返回</button>
        <span class="thr-name" id="thrName"></span>
        <span class="thr-here" id="thrHere"></span>
        <div class="thr-spacer"></div>
        <span id="thrModelSlot"></span>
        <button id="thrFit" title="适宽显示">↔ 适宽</button>
        <button id="thrZoomOut" title="缩小">－</button>
        <button id="thrZoomIn" title="放大">＋</button>
        <span style="font-size:12px;color:var(--side-muted)">第</span>
        <input id="thrPageInput" value="1" title="输入页码后回车跳转" />
        <span style="font-size:12px;color:var(--side-muted)">/ <b id="thrPageTotal">0</b> 页</span>
        <button id="thrOcr" title="识别这一页（或框选的区域）上的文字 —— 扫描件也能摘录">🈯 识别文字</button>
        <button id="thrNoteMode" title="笔记模式：原文 ｜ 笔记">📝 笔记模式</button>
        <button id="thrQuotesBtn" title="摘录素材库">📌 素材</button>
        <button id="thrOutlineToggle" title="折叠 / 展开书签栏">☰</button>
      </div>
      <div class="thr-body">
        <aside class="thr-outline" id="thrOutline">
          <div class="thr-out-head">
            <input class="tb-input thr-out-search" id="thrOutSearch" type="search" placeholder="搜索章节 / 书签" />
            <div class="thr-out-actions">
              <button class="tb-btn" id="thrAddBookmark">＋ 在当前位置加书签</button>
            </div>
          </div>
          <div class="thr-out-list" id="thrOutList"></div>
        </aside>
        <div class="thr-stage" id="thrStage">
          <div class="thr-scroll" id="thrScroll"><div class="thr-pages" id="thrPages"></div></div>
        </div>
        <aside class="thr-side" id="thrSide">
          <div class="thr-tabs">
            <div class="thr-tab active" data-tab="analysis">解析结果</div>
            <div class="thr-tab" data-tab="chat">AI 对话</div>
          </div>
          <div class="thr-pane" data-pane="analysis">
            <div class="thr-note-cmds">
              <button class="tb-btn" id="thrDigest">⚡ 本章速读</button>
              <button class="tb-btn" id="thrReview">📝 综述条目</button>
              <button class="tb-btn" id="thrDefense">🎤 答辩演练</button>
              <button class="tb-btn" id="thrRebuild" title="重新读取 PDF 并识别章节（换过附件或想重来时用）">↻ 重建索引</button>
            </div>
            <div class="thr-fields" id="thrFields"></div>
          </div>
          <div class="thr-pane hidden" data-pane="chat">
            <div class="thr-chat-list" id="thrChatList"></div>
            <div class="thr-chat-foot">
              <div class="thr-chat-opts">
                <label><input type="checkbox" id="thrAttach" checked /> 附上本节正文</label>
                <span>上下文</span>
                <select id="thrBudget">${BUDGETS.map((b) => `<option value="${b.v}">${b.label}</option>`).join('')}</select>
                <button class="tb-btn ghost" id="thrClearChat" style="padding:1px 6px">清空对话</button>
              </div>
              <div class="thr-input-row">
                <textarea class="thr-input" id="thrInput" placeholder="问关于这篇学位论文的问题…（选中正文可自动引用；回车发送，Shift+回车换行）"></textarea>
                <button class="thr-send" id="thrSend">发送</button>
              </div>
            </div>
          </div>
        </aside>
        <div class="thr-note-resizer" id="thrNoteResizer" title="拖动调整笔记栏宽度"></div>
        <aside class="thr-note" id="thrNotePane">
          <div class="thr-note-head">
            <div class="thr-seg" id="thrNoteSeg">
              <button class="thr-seg-btn active" data-noteview="edit">编辑</button>
              <button class="thr-seg-btn" data-noteview="preview">预览</button>
            </div>
            <button class="tb-btn ghost" id="thrNoteImg" title="插入图片（也可以直接 Ctrl+V 粘贴截图）">🖼 插图</button>
            <span class="sp"></span>
            <span class="thr-note-state" id="thrNoteState"></span>
            <button class="tb-btn ghost" id="thrNoteExport">导出 .md</button>
            <input type="file" id="thrNoteFile" accept="image/*" multiple class="hidden" />
          </div>
          <div class="thr-note-body" id="thrNoteBody">
            <textarea class="thr-md" id="thrMd" placeholder="读到这里想到什么就写下来。AI 生成的「本章速读 / 综述条目 / 答辩演练」也会追加到这里。"></textarea>
            <div class="thr-md-preview pr-md-content hidden" id="thrMdPreview"></div>
          </div>
        </aside>
      </div>
      <div class="thr-selbar" id="thrSelbar">
        <button id="thrSelAsk">用这段提问</button>
        <button id="thrSelQuote">加入素材库</button>
        <button id="thrSelTask">追加到笔记</button>
      </div>
    `;
    document.body.appendChild(el);
    bindReader();
  }

  // ==================== 阅读器：打开 / 关闭 ====================

  async function openReader(id) {
    closeDetail();
    buildReaderDom();
    R.noteRatio = Number(readJson(LS.noteRatio, 0.44)) || 0.44;
    R.noteView = 'edit';
    const rec = S.items.find((x) => x.id === id) || await api(`/api/theses/${id}`).catch(() => null);
    if (!rec) { toast('论文不存在', true); return; }
    R.id = id;
    R.record = rec;
    R.outline = [];
    R.page = Math.max(1, Number(rec.lastPage) || 1);
    R.chat = [];
    R.note = '';
    R.noteLoaded = false;
    R.tab = 'analysis';
    R.noteMode = false;
    $('#thrName').textContent = rec.title || rec.originalName || '未命名';
    $('#thrPageTotal').textContent = String(rec.numPages || 0);
    $('#thr').classList.remove('hidden', 'note-mode');
    $('#thrMd').value = '';
    $('#thrMdPreview').innerHTML = '';
    setNoteView('edit');
    setNoteState('');
    switchTab('analysis');
    renderFields();
    renderChat();
    await loadModelChoices();
    $('#thrModelSlot').innerHTML = modelSelectHtml('thrModel');
    try { $('#thrBudget').value = String(readJson(LS.budget, 40000)); } catch (_) { /* ignore */ }
    $('#thrAttach').checked = readJson(LS.attach, true) !== false;

    // 书签栏 + 对话记录先出来，PDF 与索引并行加载
    await Promise.all([loadOutline(), loadChatHistory(), loadQuotes()]);
    try {
      await loadDoc();
      await buildPages();
      goPage(R.page, false);
      updateHere();
    } catch (err) {
      $('#thrPages').innerHTML = `<div class="th-out-empty">PDF 打开失败：${esc(err.message)}</div>`;
    }
  }

  function closeReader() {
    R.observer?.disconnect();
    R.observer = null;
    R.recycleObs?.disconnect();
    R.recycleObs = null;
    // 先把在渲的页停掉再销毁文档，否则会抛一堆「文档已销毁」的 noise
    clearQueue();
    R.pumping = false;
    try { R.doc?.destroy?.(); } catch (_) { /* ignore */ }
    R.doc = null;
    $('#thr')?.classList.add('hidden');
    $('#thr')?.classList.remove('note-mode');
    $('#thrSelbar').style.display = 'none';
    cancelOcr();
    hideOcrPanel();
    // 关之前把还在防抖队列里的东西落盘，避免「刚写的笔记 / 刚翻到的页」丢掉
    if (R.id) {
      clearTimeout(R.noteTimer);
      saveNote();
      saveReadPos(true);
    }
    R.id = '';
    R.record = null;
  }

  // ==================== 阅读器：PDF ====================

  let pdfjsPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) {
      if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
      return Promise.resolve(window.pdfjsLib);
    }
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/pdf.min.js';
        s.onload = () => {
          const lib = window.pdfjsLib;
          if (!lib) { reject(new Error('pdf.js 未正确加载')); return; }
          lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
          resolve(lib);
        };
        s.onerror = () => reject(new Error('pdf.js 加载失败'));
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }

  async function loadDoc() {
    const rec = R.record;
    if (!rec?.filename) throw new Error('这篇还没有上传 PDF 附件');
    const lib = await loadPdfJs();
    const url = `/uploads/${encodeURIComponent(rec.filename)}`;
    R.doc = await lib.getDocument({ url }).promise;
    R.numPages = R.doc.numPages || rec.numPages || 0;
    $('#thrPageTotal').textContent = String(R.numPages);
  }

  async function buildPages() {
    const wrap = $('#thrPages');
    clearQueue();
    wrap.innerHTML = '';
    // 清空容器会把 scrollTop 归零并触发一次 scroll —— 那一刻 R.doc 已是新文档、
    // 但页高还是上一轮的值，按滚动位置推算会把页码算成 1 并落库（「回到上次位置」因此失效）。
    // 把 pageH 归零，currentVisiblePage() 就会在重建期间直接返回当前页码、不误判。
    R.pageH = 0;
    const first = await R.doc.getPage(1);
    const base = first.getViewport({ scale: 1 });
    const scroll = $('#thrScroll');
    R.scale = Math.min(2.6, Math.max(0.5, (scroll.clientWidth - 44) / base.width));
    const vp = first.getViewport({ scale: R.scale });
    // 取整：小数高度会让每一页都产生亚像素布局，几百页叠起来就是滚动掉帧
    R.pageW = Math.round(vp.width);
    R.pageH = Math.round(vp.height);
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= R.numPages; i += 1) {
      const el = document.createElement('div');
      el.className = 'thr-page placeholder';
      el.dataset.page = String(i);
      el.style.width = `${R.pageW}px`;
      el.style.height = `${R.pageH}px`;
      frag.appendChild(el);
    }
    wrap.appendChild(frag);
    observePages();
  }

  // ==================== 阅读器：PDF 渲染调度 ====================
  //
  // 三条约束共同决定「滑动卡不卡」，缺一条都会出事：
  //   ① **串行渲染**：pdf.js 的 render 是 CPU 密集的，十几页同时开渲会把主线程占满 →
  //      手感就是「滑不动 / 卡住」。改成队列 + 一次一页。
  //   ② **就近优先**：跳页时排在队首的应该是用户要看的那一页，而不是 IO 回调的先后顺序。
  //   ③ **离屏回收**：学位论文 100–300 页，每页一张位图常驻会让内存爆掉，GC 一跑就掉帧。
  //      超出视口一定距离就把 canvas 扔掉、换回占位块（页高不变，所以滚动条不跳）。

  const PRELOAD_MARGIN = '600px 0px';
  const KEEP_MARGIN = '2400px 0px';

  function observePages() {
    R.observer?.disconnect();
    R.recycleObs?.disconnect();
    const root = $('#thrScroll');
    const pages = $$('.thr-page', $('#thrPages'));
    R.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) enqueueRender(Number(e.target.dataset.page));
    }, { root, rootMargin: PRELOAD_MARGIN });
    R.recycleObs = new IntersectionObserver((entries) => {
      for (const e of entries) if (!e.isIntersecting) recyclePage(e.target);
    }, { root, rootMargin: KEEP_MARGIN });
    for (const el of pages) { R.observer.observe(el); R.recycleObs.observe(el); }
  }

  /** 入队（同一页只排一次；已渲好的跳过） */
  function enqueueRender(n) {
    if (!n) return;
    const el = $(`.thr-page[data-page="${n}"]`);
    if (!el || el.dataset.done === '1' || R.queued.has(n)) return;
    R.queued.add(n);
    R.queue.push(n);
    pumpRenderQueue();
  }

  async function pumpRenderQueue() {
    if (R.pumping) return;
    R.pumping = true;
    try {
      while (R.queue.length) {
        const center = R.page;
        R.queue.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
        const n = R.queue.shift();
        R.queued.delete(n);
        await renderPage(n);
      }
    } finally { R.pumping = false; }
  }

  /** 回收离屏页：撤掉渲染任务与 canvas，页高保持不变 */
  function recyclePage(el) {
    if (!el || el.dataset.done !== '1') return;
    const n = Number(el.dataset.page);
    try { R.tasks.get(n)?.cancel?.(); } catch (_) { /* ignore */ }
    R.tasks.delete(n);
    el.dataset.done = '';
    el.innerHTML = '';
    el.classList.add('placeholder');
  }

  function clearQueue() {
    for (const t of R.tasks.values()) { try { t.cancel?.(); } catch (_) { /* ignore */ } }
    R.tasks.clear();
    R.queue.length = 0;
    R.queued.clear();
  }

  async function renderPage(n) {
    const el = $(`.thr-page[data-page="${n}"]`);
    if (!el || el.dataset.done === '1' || !R.doc) return;
    try {
      const page = await R.doc.getPage(n);
      const vp = page.getViewport({ scale: R.scale });
      // DPR 上限 1.5：学位论文是 A4 大页，2x 时单页位图能到 20MB 量级，
      // 内存与绘制的代价都远超肉眼收益。1.5 在 Retina 上文字依然清晰。
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.round(vp.width)}px`;
      canvas.style.height = `${Math.round(vp.height)}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.scale(dpr, dpr);
      const task = page.render({ canvasContext: ctx, viewport: vp });
      R.tasks.set(n, task);
      await task.promise;
      R.tasks.delete(n);
      if (!R.doc || !el.isConnected) return;
      el.innerHTML = '';
      el.appendChild(canvas);
      const no = document.createElement('div');
      no.className = 'thr-pgno';
      no.textContent = String(n);
      el.appendChild(no);
      el.classList.remove('placeholder');
      el.dataset.done = '1';
    } catch (e) {
      R.tasks.delete(n);
      // 「取消」是正常路径（切缩放、关阅读器都会触发），不当错误刷屏
      if (!/cancel/i.test(String(e?.message || ''))) console.warn(`[thesis] 第 ${n} 页渲染失败：`, e?.message);
    }
  }

  async function rebuildPages() {
    clearQueue();
    $$('.thr-page', $('#thrPages')).forEach((el) => {
      el.dataset.done = '';
      el.innerHTML = '';
      el.classList.add('placeholder');
      el.style.width = `${R.pageW}px`;
      el.style.height = `${R.pageH}px`;
    });
    observePages();
  }

  function currentVisiblePage() {
    const scroll = $('#thrScroll');
    if (!scroll || !R.pageH) return R.page;
    const mid = scroll.scrollTop + scroll.clientHeight / 2;
    const n = Math.floor(mid / (R.pageH + 14)) + 1;
    return Math.min(R.numPages || 1, Math.max(1, n));
  }

  function goPage(n, smooth = true) {
    const scroll = $('#thrScroll');
    const target = Math.min(R.numPages || 1, Math.max(1, Number(n) || 1));
    const top = Math.max(0, (target - 1) * (R.pageH + 14) + 14 - 8);
    // 先更新页码再滚动：渲染队列是按「离当前页最近」排优先级的，
    // 顺序反了会把跳转目标排在队尾（用户盯着空白页等）
    R.page = target;
    if (smooth) scroll.scrollTo({ top, behavior: 'auto' });
    else scroll.scrollTop = top;
    $('#thrPageInput').value = String(target);
    updateHere();
    highlightOutline();
    saveReadPos();
  }

  async function setScale(next) {
    R.scale = Math.min(3, Math.max(0.4, next));
    const first = await R.doc.getPage(1);
    const vp = first.getViewport({ scale: R.scale });
    R.pageW = Math.round(vp.width);
    R.pageH = Math.round(vp.height);
    await rebuildPages();
    goPage(R.page, false);
    // 缩放后视口里的页要立刻重渲（IO 只在交叉状态变化时才回调，不会自己重来一次）
    const from = Math.max(1, R.page - 1);
    for (let i = from; i <= Math.min(R.numPages, R.page + 2); i += 1) enqueueRender(i);
  }

  function updateHere() {
    const ch = R.outline.find((c) => c.page <= R.page && R.page <= c.endPage);
    // 取最深层级的那个（子节比章更精确）
    const deep = R.outline.filter((c) => c.page <= R.page && R.page <= c.endPage)
      .sort((a, b) => (b.level || 1) - (a.level || 1))[0] || ch;
    $('#thrHere').innerHTML = `第 <b>${R.page}</b> 页${deep ? ` · <b>${esc(deep.title)}</b>` : ''}`;
    $('#thrPageInput').value = String(R.page);
  }

  function saveReadPos(immediate) {
    clearTimeout(R.saveTimer);
    const run = () => {
      if (!R.id) return;
      api(`/api/theses/${R.id}`, { method: 'PATCH', body: { readPage: R.page, lastPage: R.page } })
        .then((updated) => {
          const idx = S.items.findIndex((x) => x.id === R.id);
          if (idx >= 0 && updated) S.items[idx] = { ...S.items[idx], ...updated };
        })
        .catch(() => { /* 位置记不上不是大事 */ });
    };
    if (immediate) run();
    else R.saveTimer = setTimeout(run, 900);
  }

  // ==================== 阅读器：书签栏 ====================

  async function loadOutline() {
    try {
      const data = await api(`/api/theses/${R.id}/outline`);
      R.outline = data.items || [];
      R.outlineSource = data.source || '';
      if (!R.outline.length) {
        // 还没有索引：后台建一次（首次会慢几秒），建好再刷新书签栏
        renderOutline('正在识别章节结构…');
        streamPost(`/api/theses/${R.id}/index`, {}, (ev) => {
          if (ev.message) renderOutline(ev.message);
          if (ev.error) renderOutline(`章节识别失败：${ev.error}`);
          if (ev.done) loadOutline();
        }).catch(() => {});
        return;
      }
    } catch (err) {
      R.outline = [];
      renderOutline(err.message);
      return;
    }
    renderOutline();
  }

  function bookmarks() {
    return Array.isArray(R.record?.bookmarks) ? R.record.bookmarks : [];
  }

  function renderOutline(placeholder) {
    const box = $('#thrOutList');
    if (!box) return;
    if (placeholder) { box.innerHTML = `<div class="thr-out-empty">${esc(placeholder)}</div>`; return; }
    const q = ($('#thrOutSearch')?.value || '').trim().toLowerCase();
    const marks = bookmarks().slice().sort((a, b) => a.page - b.page);
    const srcTip = { bookmark: '来自 PDF 内嵌书签', toc: '来自目录页', heading: '由标题推断', fallback: '未识别到章节，按每 10 页分组' }[R.outlineSource] || '';
    const parts = [];
    if (marks.length) {
      parts.push('<div class="thr-out-group">我的书签</div>');
      for (const b of marks) {
        if (q && !String(b.note || '').toLowerCase().includes(q)) continue;
        parts.push(`<div class="thr-out-item" data-page="${b.page}" data-bm="${esc(b.id)}">
          <span class="t">${esc(b.note || `第 ${b.page} 页`)}</span>
          <span class="p">${b.page}</span>
          <button class="del" title="删除书签">✕</button></div>`);
      }
    }
    parts.push(`<div class="thr-out-group">章节目录${srcTip ? ` · ${esc(srcTip)}` : ''}</div>`);
    const items = R.outline.filter((c) => !q || String(c.title).toLowerCase().includes(q));
    if (!items.length) {
      parts.push(`<div class="thr-out-empty">${R.outline.length ? '没有匹配的章节' : '尚未识别到章节。点上方「＋ 在当前位置加书签」也能自己标。'}</div>`);
    }
    for (const c of items) {
      parts.push(`<div class="thr-out-item lv${c.level || 1}" data-page="${c.page}">
        <span class="t" title="${esc(c.title)}">${esc(c.title)}</span>
        <span class="p">${c.page}</span></div>`);
    }
    box.innerHTML = parts.join('');
    highlightOutline();
  }

  function highlightOutline() {
    const box = $('#thrOutList');
    if (!box) return;
    let best = null;
    for (const el of $$('.thr-out-item[data-page]', box)) {
      const p = Number(el.dataset.page);
      el.classList.remove('active');
      if (p <= R.page && (!best || p >= Number(best.dataset.page))) best = el;
    }
    if (best) {
      best.classList.add('active');
      const list = $('#thrOutList');
      const top = best.offsetTop;
      if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 40) {
        list.scrollTop = Math.max(0, top - list.clientHeight / 2);
      }
    }
  }

  /**
   * 轻量文本输入弹窗。
   * 刻意不用 window.prompt：Electron 的渲染进程里 prompt 被禁用（调用会直接抛错），
   * 打包版点「加书签」就会炸；换成自绘弹窗后浏览器 / 桌面版行为一致，也能被自动化驱动。
   * @returns {Promise<string|null>} 取消返回 null
   */
  function askText({ title = '输入', hint = '', value = '', placeholder = '' } = {}) {
    return new Promise((resolve) => {
      let el = $('#thAsk');
      if (!el) {
        el = document.createElement('div');
        el.id = 'thAsk';
        el.className = 'th-modal hidden';
        el.innerHTML = `<div class="th-modal-box th-ask-box">
          <div class="th-modal-head"><h3 id="thAskTitle">输入</h3></div>
          <div class="th-modal-body">
            <div class="th-ask-hint" id="thAskHint"></div>
            <input class="th-ask-input" id="thAskInput" />
          </div>
          <div class="th-modal-foot">
            <button class="tb-btn" id="thAskCancel">取消</button>
            <button class="tb-btn accent" id="thAskOk">确定</button>
          </div>
        </div>`;
        document.body.appendChild(el);
      }
      const input = $('#thAskInput');
      $('#thAskTitle').textContent = title;
      $('#thAskHint').textContent = hint;
      input.value = value || '';
      input.placeholder = placeholder || '';
      el.classList.remove('hidden');
      setTimeout(() => { input.focus(); input.select(); }, 30);

      const cleanup = () => {
        el.classList.add('hidden');
        input.removeEventListener('keydown', onKey);
        $('#thAskOk').removeEventListener('click', done);
        $('#thAskCancel').removeEventListener('click', cancel);
      };
      const done = () => { const v = input.value; cleanup(); resolve(v); };
      const cancel = () => { cleanup(); resolve(null); };
      const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); done(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      };
      input.addEventListener('keydown', onKey);
      $('#thAskOk').addEventListener('click', done);
      $('#thAskCancel').addEventListener('click', cancel);
    });
  }

  // ==================== 书签（我的书签） ====================

  async function addBookmark() {
    const ch = R.outline.filter((c) => c.page <= R.page && R.page <= c.endPage)
      .sort((a, b) => (b.level || 1) - (a.level || 1))[0];
    const fallback = ch?.title || `第 ${R.page} 页`;
    const note = await askText({
      title: '加书签',
      hint: `第 ${R.page} 页${ch?.title ? ` · ${ch.title}` : ''}（留空就用章节名）`,
      placeholder: fallback,
    });
    if (note === null) return;
    const list = bookmarks().slice();
    list.push({ id: `b${Date.now().toString(36)}`, page: R.page, note: (note || '').trim() || fallback });
    const updated = await api(`/api/theses/${R.id}`, { method: 'PATCH', body: { bookmarks: list } });
    R.record = updated;
    const idx = S.items.findIndex((x) => x.id === R.id);
    if (idx >= 0) S.items[idx] = { ...S.items[idx], ...updated };
    renderOutline();
  }

  async function removeBookmark(id) {
    const list = bookmarks().filter((b) => b.id !== id);
    const updated = await api(`/api/theses/${R.id}`, { method: 'PATCH', body: { bookmarks: list } });
    R.record = updated;
    renderOutline();
  }

  // ==================== 阅读器：字段面板 ====================

  function renderFields() {
    const box = $('#thrFields');
    if (!box) return;
    const it = R.record || {};
    const userFields = new Set(['myThoughts', 'referenceValue']);
    const value = (it2, k) => `<div class="thr-field">
        <div class="thr-field-label">${esc(LABELS[k] || k)}${userFields.has(k) ? ' <span class="th-muted">（我填的）</span>' : ''}</div>
        <div class="thr-field-value${String(it2[k] || '') ? '' : ' th-muted'}" contenteditable="true" data-f="${esc(k)}">${String(it2[k] || '') ? esc(it2[k]) : '（空，可点击填写）'}</div>
      </div>`;
    box.innerHTML = `
      <div class="thr-fields-hint">
        <span class="th-badge ${esc(it.status || 'pending')}">${
          { pending: '待解析', parsing: '解析中', done: '已解析', error: '解析失败' }[it.status || 'pending'] || ''
        }</span>
        ${it.source ? `<span class="th-muted">${esc(parseMethodLabel(it))}</span>` : ''}
        ${it.numPages ? `<span class="th-muted">${it.numPages} 页</span>` : ''}
        <span class="sp"></span>
        <button class="tb-btn ghost" id="thrReparse" title="重读封面（配置了视觉模型就看图）">↻ 重读封面</button>
      </div>
      ${it.status === 'error' && it.error ? `<div class="thr-fields-err">${esc(it.error)}</div>` : ''}
      ${['title', 'authors', 'school', 'degreeType', 'year'].map((k) => value(it, k)).join('')}
      <div class="thr-fields-sep">我填的</div>
      ${['myThoughts', 'referenceValue'].map((k) => value(it, k)).join('')}
      <p class="th-muted" style="font-size:11.5px;line-height:1.7;margin:12px 0 0">
        研究问题 / 方法 / 结论不在这里硬填：学位论文信息密度高，靠封面 3 页挤出来的摘要容易失真。
        用上面的「本章速读 / 综述条目 / 答辩演练」，它们是基于真实正文检索生成的。
      </p>`;
    $('#thrReparse')?.addEventListener('click', reparseCurrent);
  }

  /** 阅读器里「重读封面」：与列表、详情抽屉走同一条解析链路 */
  async function reparseCurrent() {
    if (!R.record?.filename) { toast('这篇还没有上传 PDF 附件', true); return; }
    const btn = $('#thrReparse');
    if (btn) { btn.disabled = true; btn.textContent = '↻ 解析中…'; }
    toast(S.visionReady ? '正在看封面页解析（不够会自动补看第 2–3 页）…' : '正在读封面页解析…');
    try {
      const updated = await parseOne(R.record);
      R.record = updated;
      const idx = S.items.findIndex((x) => x.id === updated.id);
      if (idx >= 0) S.items[idx] = updated;
      if (updated.status !== 'done') toast(updated.error || '解析失败', true);
      else { renderFields(); toast('解析完成'); }
    } catch (e) { toast(e.message, true); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '↻ 重读封面'; } }
  }

  async function saveField(field, value) {
    const patch = { [field]: value };
    const updated = await patchItem(R.id, patch);
    if (updated) {
      R.record = updated;
      const idx = S.items.findIndex((x) => x.id === R.id);
      if (idx >= 0) S.items[idx] = updated;
    }
  }

  // ==================== 阅读器：标签页 / 笔记模式 ====================

  function switchTab(name) {
    R.tab = name;
    $$('.thr-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.thr-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== name));
    if (name === 'chat') setTimeout(() => $('#thrInput')?.focus(), 30);
  }

  /**
   * 笔记模式：改成「左 PDF ｜ 右笔记」两栏（参考文献中心是「PDF ｜ 划词翻译 ｜ 笔记」三栏，
   * 本模块不做翻译，所以省掉中间那栏），分栏宽度可拖。
   *
   * 之前是「书签栏 + PDF + 右侧面板 + 笔记」四栏硬挤在一行 —— 窄屏上笔记只剩一百多像素，
   * 文字每行 9 个字还被裁掉，等于没法用。进笔记模式就把书签栏和右侧面板收起来（CSS 负责），
   * 把宽度让给 PDF 和笔记。
   */
  async function toggleNoteMode() {
    R.noteMode = !R.noteMode;
    $('#thr').classList.toggle('note-mode', R.noteMode);
    if (R.noteMode) {
      await ensureNote();
      applyNoteRatio();
      setNoteView(R.noteView || 'edit');
      // 让出宽度后 PDF 的适宽比例变了，重新算一次缩放
      if (R.doc) { try { await fitScale(); } catch (_) { /* ignore */ } }
    } else if (R.doc) {
      try { await fitScale(); } catch (_) { /* ignore */ }
    }
  }

  /** 笔记栏宽度按比例存 localStorage，下次进来还是用户调好的样子 */
  function applyNoteRatio() {
    const note = $('#thrNotePane');
    if (!note) return;
    const r = Math.min(0.7, Math.max(0.25, Number(R.noteRatio) || 0.44));
    R.noteRatio = r;
    note.style.flex = `0 0 ${(r * 100).toFixed(2)}%`;
  }

  function bindNoteResizer() {
    const bar = $('#thrNoteResizer');
    const body = $('.thr-body');
    if (!bar || !body) return;
    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const rect = body.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
      R.noteRatio = Math.min(0.7, Math.max(0.25, 1 - x / Math.max(1, rect.width)));
      applyNoteRatio();
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('thr-resizing');
      writeJson(LS.noteRatio, R.noteRatio);
      // 拖完宽度变了，PDF 的适宽比例也要跟着重算
      if (R.doc) fitScale().catch(() => {});
    };
    const start = (e) => {
      dragging = true;
      document.body.classList.add('thr-resizing');
      e.preventDefault();
    };
    bar.addEventListener('mousedown', start);
    bar.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('mouseup', stop);
    document.addEventListener('touchend', stop);
  }

  function setNoteView(view) {
    R.noteView = view === 'preview' ? 'preview' : 'edit';
    $$('#thrNoteSeg .thr-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.noteview === R.noteView));
    const md = $('#thrMd');
    const prev = $('#thrMdPreview');
    if (!md || !prev) return;
    const showPrev = R.noteView === 'preview';
    md.classList.toggle('hidden', showPrev);
    prev.classList.toggle('hidden', !showPrev);
    if (showPrev) {
      prev.innerHTML = md.value.trim()
        ? markdown(md.value)
        : '<div class="thr-out-empty">笔记还是空的。切到「编辑」写下第一句，或在阅读器里选中正文 →「追加到笔记」。</div>';
    }
  }

  /** 把 PDF 缩放到水平铺满（笔记模式切换、窗口缩放时都要重算） */
  async function fitScale() {
    if (!R.doc) return;
    const first = await R.doc.getPage(1);
    const base = first.getViewport({ scale: 1 });
    const w = $('#thrScroll')?.clientWidth || 0;
    if (w > 80) await setScale((w - 44) / base.width);
  }

  async function ensureNote() {
    if (R.noteLoaded) return;
    R.noteLoaded = true;
    try {
      const data = await api(`/api/paper-notes/${R.id}`);
      R.note = data.md || '';
    } catch (_) { R.note = ''; }
    const md = $('#thrMd');
    if (md && !md.value) md.value = R.note;
    setNoteState('已保存');
  }

  function setNoteState(text) {
    const el = $('#thrNoteState');
    if (el) el.textContent = text || '';
  }

  /**
   * 存笔记。
   *
   * ⚠️ 必须等 ensureNote() 把后端内容读进来之后才允许写回。
   * 否则会出现两种数据事故（v1.19.0 就有）：
   *   · 打开一篇有笔记的论文、但没进笔记模式 → textarea 还是空的 → 关闭阅读器时把笔记清成空；
   *   · 更糟的是换论文时 textarea 里留着**上一篇**的笔记 → 会被写到当前这篇名下。
   */
  async function saveNote() {
    if (!R.id || !R.noteLoaded) return;
    const md = $('#thrMd');
    if (!md) return;
    R.note = md.value;
    setNoteState('保存中…');
    try {
      await api(`/api/paper-notes/${R.id}`, { method: 'PUT', body: { md: R.note } });
      setNoteState('已保存');
    } catch (_) { setNoteState('保存失败'); }
  }

  function appendNote(text, heading) {
    const md = $('#thrMd');
    if (!md) return;
    const block = `${md.value.trim() ? '\n\n' : ''}${heading ? `## ${heading}\n\n` : ''}${text}`;
    md.value = `${md.value}${block}`;
    saveNote();
    toast('已追加到笔记');
  }

  // ---------- 笔记里插图片 ----------
  //
  // 与文献中心的 Markdown 笔记保持同一套做法：图片以**内联 data URL** 写进 Markdown，
  // 随笔记一起存进 paper-notes.json。好处是不需要额外的上传接口与文件清理；
  // 代价是图片会直接占笔记体积，所以给单张加一个上限、超了就明确跳过。
  const NOTE_IMG_MAX = 8 * 1024 * 1024;

  /** 从 FileList / DataTransfer.files 里挑出图片 */
  function noteImageFiles(files) {
    return [...(files || [])].filter((f) => f && /^image\//.test(f.type));
  }

  function noteFileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('图片读取失败'));
      r.readAsDataURL(file);
    });
  }

  /** 把一批图片插到笔记光标处（Markdown 图片语法），并立刻落盘 */
  async function insertNoteImages(files) {
    await ensureNote();
    const md = $('#thrMd');
    if (!md) return;
    if (R.noteView !== 'edit') setNoteView('edit');
    let text = md.value;
    let cursor = Number.isFinite(md.selectionStart) ? md.selectionStart : text.length;
    let inserted = 0;
    for (const f of files) {
      if (f.size > NOTE_IMG_MAX) { toast(`${f.name || '剪贴板图片'} 超过 8MB，已跳过`, true); continue; }
      let url = '';
      try { url = await noteFileToDataUrl(f); } catch (_) { toast('图片读取失败', true); continue; }
      const alt = (f.name || '图片').replace(/\.[^.]+$/, '') || '图片';
      const snippet = `![${alt}](${url})`;
      const res = window.PaperNoteUtils?.insertSnippet
        ? window.PaperNoteUtils.insertSnippet(text, snippet, cursor, cursor)
        : { text: `${text}${text.trim() ? '\n\n' : ''}${snippet}`, cursor: text.length + snippet.length };
      text = res.text;
      cursor = res.cursor;
      inserted += 1;
    }
    if (!inserted) return;
    md.value = text;
    md.focus();
    md.setSelectionRange(cursor, cursor);
    R.note = text;
    setNoteState('未保存');
    clearTimeout(R.noteTimer);
    await saveNote();
    if (R.noteView === 'preview') setNoteView('preview');
    toast(`已插入 ${inserted} 张图片`);
  }

  // ==================== 阅读器：AI 对话 ====================

  function renderChat() {
    const box = $('#thrChatList');
    if (!box) return;
    if (!R.chat.length) {
      box.innerHTML = `<div class="thr-msg system">问关于这篇学位论文的问题即可。我会先检索相关章节再作答，并在句末标出【章节 · p.页码】——点一下可以跳到那一页。也可以直接问「这章的方法能不能用在我的第 4 章」。</div>`;
      return;
    }
    box.innerHTML = R.chat.map((m) => {
      if (m.role === 'system') return `<div class="thr-msg system">${esc(m.content)}</div>`;
      if (m.role === 'user') return `<div class="thr-msg user">${esc(m.content)}</div>`;
      if (m.error) return `<div class="thr-msg error">${esc(m.content)}</div>`;
      const stats = m.stats
        ? `<div class="th-muted" style="font-size:11px;margin-top:5px">本次上下文 ${m.stats.usedChars} 字 / 预算 ${m.stats.budgetChars} 字 · 命中 ${m.stats.hitCount} 段${m.stats.truncated ? '（已截断）' : ''} · 回到 p.${(m.stats.hitPages || [])[0] || '-'}</div>`
        : '';
      return `<div class="thr-msg assistant">${markdown(m.content)}${stats}</div>`;
    }).join('');
    box.querySelectorAll('.src').forEach((el) => {
      el.addEventListener('click', () => goPage(Number(el.dataset.page)));
    });
    box.scrollTop = box.scrollHeight;
  }

  async function loadChatHistory() {
    try {
      const data = await api(`/api/paper-chat/${R.id}`);
      R.chat = (data.messages || []).map((m) => ({ role: m.role, content: m.content }));
    } catch (_) { R.chat = []; }
    renderChat();
  }

  async function persistChat() {
    try {
      await api(`/api/paper-chat/${R.id}`, {
        method: 'PUT',
        body: { messages: R.chat.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.content })) },
      });
    } catch (_) { /* ignore */ }
  }

  let streaming = false;

  async function sendChat() {
    const input = $('#thrInput');
    const text = String(input?.value || '').trim();
    if (!text || streaming) return;
    if (!R.record?.filename) { toast('这篇还没有上传 PDF 附件', true); return; }
    input.value = '';
    const history = R.chat.filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));
    R.chat.push({ role: 'user', content: text });
    const holder = { role: 'assistant', content: '' };
    R.chat.push(holder);
    renderChat();
    streaming = true;
    $('#thrSend').disabled = true;
    const paint = () => { clearTimeout(R.renderTimer); R.renderTimer = setTimeout(renderChat, 70); };

    try {
      await streamPost(`/api/theses/${R.id}/chat`, {
        query: text,
        page: R.page,
        budget: Number($('#thrBudget')?.value) || 40000,
        attachSection: !!$('#thrAttach')?.checked,
        profileId: pickedModel(),
        history,
      }, (ev) => {
        if (ev.stage) { holder.content = ''; R.chat.splice(R.chat.length - 1, 0, { role: 'system', content: ev.message || '正在准备内容…' }); renderChat(); return; }
        if (ev.stats) { holder.stats = ev.stats; return; }
        if (ev.error) { holder.error = true; holder.content = ev.error; renderChat(); return; }
        if (ev.delta) {
          // 第一个 delta 到来时把「准备中」的系统提示去掉
          const lastSys = R.chat.findIndex((m) => m.role === 'system');
          if (lastSys >= 0) R.chat.splice(lastSys, 1);
          holder.content += ev.delta;
          paint();
        }
      });
      if (!holder.content) { holder.error = true; holder.content = 'AI 没有返回内容。可在「AI 设置」里换一个模型再试。'; }
    } catch (err) {
      holder.error = true;
      holder.content = err.message;
    }
    clearTimeout(R.renderTimer);
    renderChat();
    streaming = false;
    $('#thrSend').disabled = false;
    persistChat();
  }

  async function runTask(task, opts = {}) {
    if (streaming) { toast('上一件事还没做完', true); return; }
    if (!R.record?.filename) { toast('这篇还没有上传 PDF 附件', true); return; }
    const labelMap = { 'chapter-digest': '本章速读', 'review-entry': '综述条目', 'defense': '答辩问答演练' };
    const label = labelMap[task] || task;
    const needNote = opts.toNote !== false;
    switchTab('chat');
    R.chat.push({ role: 'system', content: `正在生成「${label}」…` });
    renderChat();
    let text = '';
    streaming = true;
    $('#thrSend').disabled = true;
    const paint = () => { clearTimeout(R.renderTimer); R.renderTimer = setTimeout(renderChat, 70); };
    const holder = { role: 'assistant', content: '' };
    R.chat.push(holder);
    try {
      await streamPost(`/api/theses/${R.id}/summarize`, {
        task, page: R.page, chapterId: opts.chapterId || '', profileId: pickedModel(),
      }, (ev) => {
        if (ev.stage) return;
        if (ev.error) { holder.error = true; holder.content = ev.error; renderChat(); return; }
        if (ev.delta) {
          const i = R.chat.findIndex((m) => m.role === 'system' && String(m.content).startsWith('正在生成'));
          if (i >= 0) R.chat.splice(i, 1);
          text += ev.delta;
          holder.content = text;
          paint();
        }
      });
      if (!text) { holder.error = true; holder.content = 'AI 没有返回内容。'; }
    } catch (err) {
      holder.error = true;
      holder.content = err.message;
    }
    clearTimeout(R.renderTimer);
    renderChat();
    streaming = false;
    $('#thrSend').disabled = false;
    if (text && needNote) {
      await ensureNote();
      appendNote(text, label);
    }
    persistChat();
  }

  // ==================== 阅读器：选中文本 ====================

  function selectionText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const text = String(sel.toString() || '').trim();
    if (text.length < 2) return '';
    // 只认阅读器里的选区（PDF 文字层 / 对话内容），避免误触其它区域
    const node = sel.anchorNode;
    if (!(node instanceof Node) || !$('#thr')?.contains(node)) return '';
    return text.slice(0, 4000);
  }

  function showSelbar(x, y) {
    const bar = $('#thrSelbar');
    if (!bar) return;
    bar.style.display = 'flex';
    const w = 260;
    bar.style.left = `${Math.min(window.innerWidth - w - 10, Math.max(10, x))}px`;
    bar.style.top = `${Math.max(10, y - 40)}px`;
  }

  function hideSelbar() { const b = $('#thrSelbar'); if (b) b.style.display = 'none'; }

  // ==================== 阅读器：事件绑定 ====================

  function bindReader() {
    $('#thrBack')?.addEventListener('click', closeReader);
    $('#thrOutlineToggle')?.addEventListener('click', () => $('#thrOutline')?.classList.toggle('collapsed'));
    $('#thrNoteMode')?.addEventListener('click', toggleNoteMode);
    $('#thrQuotesBtn')?.addEventListener('click', () => openQuotesDrawer());
    $('#thrOcr')?.addEventListener('click', () => startOcr());
    $('#thrZoomIn')?.addEventListener('click', () => setScale(R.scale + 0.15));
    $('#thrZoomOut')?.addEventListener('click', () => setScale(R.scale - 0.15));
    $('#thrFit')?.addEventListener('click', () => fitScale());

    $('#thrPageInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); goPage(Number(e.target.value)); e.target.blur(); }
    });

    $('#thrScroll')?.addEventListener('scroll', () => {
      if (R.scrollRaf) return;
      R.scrollRaf = requestAnimationFrame(() => {
        R.scrollRaf = 0;
        // 关闭阅读器时容器被隐藏，scrollTop 会被浏览器归零并触发一次 scroll；
        // 若不拦住，这里会把页码记成 1，900ms 后覆盖掉刚存好的「读到第几页」。
        if (!R.doc) return;
        const n = currentVisiblePage();
        if (n !== R.page) {
          R.page = n;
          updateHere();
          highlightOutline();
          saveReadPos();
          // 位置变了，队列里的优先级排序跟着变；顺手把「刚进视野但没赶上 IO」的页补上
          enqueueRender(n);
          pumpRenderQueue();
        }
      });
    }, { passive: true });

    $('#thrScroll')?.addEventListener('wheel', (e) => {
      // Ctrl+滚轮 = 缩放，普通滚动交给浏览器。
      // 缩放要防抖：一次滚轮能连发十几个事件，每次都重建整本页面会直接卡死。
      if (!e.ctrlKey) return;
      e.preventDefault();
      R.pendingScale = Math.min(3, Math.max(0.4, (R.pendingScale || R.scale) + (e.deltaY < 0 ? 0.1 : -0.1)));
      clearTimeout(R.scaleTimer);
      R.scaleTimer = setTimeout(() => { setScale(R.pendingScale); R.pendingScale = 0; }, 180);
    }, { passive: false });

    // 书签栏
    $('#thrOutList')?.addEventListener('click', (e) => {
      const del = e.target.closest('.del');
      if (del) { e.stopPropagation(); removeBookmark(del.closest('.thr-out-item').dataset.bm); return; }
      const item = e.target.closest('.thr-out-item');
      if (item?.dataset.page) goPage(Number(item.dataset.page));
    });
    $('#thrOutSearch')?.addEventListener('input', () => renderOutline());
    $('#thrAddBookmark')?.addEventListener('click', addBookmark);

    // 标签页 / 任务
    $$('.thr-tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    $('#thrDigest')?.addEventListener('click', () => runTask('chapter-digest'));
    $('#thrReview')?.addEventListener('click', () => runTask('review-entry'));
    $('#thrDefense')?.addEventListener('click', () => runTask('defense'));
    $('#thrRebuild')?.addEventListener('click', async () => {
      if (!confirm('重新读取 PDF 并识别章节结构？已建的索引会被覆盖（笔记与对话不受影响）。')) return;
      toast('正在重建索引…');
      await streamPost(`/api/theses/${R.id}/index`, { force: true }, (ev) => {
        if (ev.message) $('#thrOutList').innerHTML = `<div class="thr-out-empty">${esc(ev.message)}</div>`;
        if (ev.error) toast(ev.error, true);
      });
      await loadOutline();
      toast('索引已重建');
    });

    // 对话
    $('#thrSend')?.addEventListener('click', sendChat);
    $('#thrInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    $('#thrBudget')?.addEventListener('change', (e) => writeJson(LS.budget, Number(e.target.value)));
    $('#thrAttach')?.addEventListener('change', (e) => writeJson(LS.attach, e.target.checked));
    $('#thrClearChat')?.addEventListener('click', async () => {
      if (!confirm('清空这篇论文的 AI 对话记录？')) return;
      R.chat = [];
      renderChat();
      try { await api(`/api/paper-chat/${R.id}`, { method: 'DELETE' }); } catch (_) { /* ignore */ }
    });
    $('#thrChatList')?.addEventListener('click', (e) => {
      const src = e.target.closest('.src');
      if (src) goPage(Number(src.dataset.page));
    });

    // 字段编辑
    $('#thrFields')?.addEventListener('focusout', async (e) => {
      const cell = e.target.closest?.('.thr-field-value');
      if (!cell) return;
      const field = cell.dataset.f;
      const value = String(cell.innerText || '').trim();
      if (String(R.record?.[field] || '') === value) return;
      await saveField(field, value);
    });

    // 笔记
    // 笔记用独立定时器：和「记录阅读位置」共用同一个槽时，滚动会把防抖中的
    // 笔记保存取消掉（字就丢了），这是真会丢数据的坑。
    $('#thrMd')?.addEventListener('input', () => {
      clearTimeout(R.noteTimer);
      setNoteState('未保存');
      R.noteTimer = setTimeout(saveNote, 1200);
    });
    $('#thrMd')?.addEventListener('blur', saveNote);
    // 笔记里插图片：Ctrl+V 直接粘贴截图，或用「🖼 插图」选文件。
    // 学位论文常是扫描件，截图往往是唯一能进笔记的「原文」形态。
    $('#thrMd')?.addEventListener('paste', async (e) => {
      const cd = e.clipboardData;
      const fromItems = [...(cd?.items || [])]
        .filter((it) => it.kind === 'file' && /^image\//.test(it.type))
        .map((it) => { try { return it.getAsFile(); } catch (_) { return null; } })
        .filter(Boolean);
      const files = fromItems.length ? fromItems : noteImageFiles(cd?.files);
      if (!files.length) return;          // 不是图片就交给浏览器默认粘贴
      e.preventDefault();
      await insertNoteImages(files);
    });
    $('#thrNoteImg')?.addEventListener('click', () => $('#thrNoteFile')?.click());
    $('#thrNoteFile')?.addEventListener('change', async (e) => {
      const files = noteImageFiles(e.target.files);
      e.target.value = '';
      if (files.length) await insertNoteImages(files);
    });
    $$('#thrNoteSeg .thr-seg-btn').forEach((b) => {
      b.addEventListener('click', () => setNoteView(b.dataset.noteview));
    });
    bindNoteResizer();
    $('#thrNoteExport')?.addEventListener('click', () => {
      const name = (R.record?.title || '学位论文笔记').replace(/[\\/:*?"<>|]/g, '_');
      download(`${name}-笔记.md`, $('#thrMd')?.value || '');
    });

    // 划词
    $('#thr')?.addEventListener('mouseup', () => {
      setTimeout(() => {
        const text = selectionText();
        if (!text) { hideSelbar(); return; }
        const sel = window.getSelection();
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        showSelbar(rect.left, rect.top);
      }, 10);
    });
    $('#thr')?.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#thrSelbar')) hideSelbar();
    });

    $('#thrSelAsk')?.addEventListener('click', () => {
      const text = selectionText();
      hideSelbar();
      if (!text) return;
      switchTab('chat');
      const input = $('#thrInput');
      input.value = `关于这段（第 ${R.page} 页）：\n“${text}”\n\n`;
      input.focus();
    });
    $('#thrSelQuote')?.addEventListener('click', async () => {
      const text = selectionText();
      hideSelbar();
      if (!text) return;
      await quoteCurrent(text);
    });
    $('#thrSelTask')?.addEventListener('click', async () => {
      const text = selectionText();
      hideSelbar();
      if (!text) return;
      await ensureNote();
      appendNote(`> ${text}\n\n—— 第 ${R.page} 页`, '摘录');
      if (!R.noteMode) await toggleNoteMode();
      else { applyNoteRatio(); setNoteView('edit'); }
    });
  }

  // ==================== 素材库 ====================

  async function quoteCurrent(text) {
    const ch = R.outline.filter((c) => c.page <= R.page && R.page <= c.endPage)
      .sort((a, b) => (b.level || 1) - (a.level || 1))[0];
    try {
      await api('/api/thesis-quotes', {
        method: 'POST',
        body: {
          thesisId: R.id,
          text,
          page: R.page,
          chapterTitle: ch?.title || '',
          source: 'reader',
        },
      });
      await loadQuotes();
      toast('已加入素材库');
    } catch (err) { toast(err.message, true); }
  }

  // ==================== 文字识别（扫描件也能摘录） ====================
  //
  // 为什么需要：学位论文里有相当一部分是**扫描件** —— 整页就是一张图，PDF 里没有文字层，
  // 划词划不动，于是「加入素材库」完全无从下手（用户反馈的正是这个）。
  // 这里补一条 OCR 通道：在页面上框一块（或直接点一下 = 整页），把图交给视觉模型转录成文字，
  // 再走原来的「加入素材库 / 追加到笔记 / 用这段提问」。

  /** 进入框选识别：在当前页上盖一层蒙版，等用户拖出一个框 */
  async function startOcr() {
    if (R.ocrOn) { cancelOcr(); return; }
    if (!R.doc) { toast('先打开一篇论文', true); return; }
    if (!S.visionReady) {
      toast('文字识别需要视觉模型：请到「AI 解析设置」为一条模型填好 Key，并在「图像能力」里开启图片支持', true);
      return;
    }
    const n = R.page || 1;
    const el = $(`.thr-page[data-page="${n}"]`);
    if (!el) { toast('没找到当前页', true); return; }
    // 目标页可能已被离屏回收，先确保它渲染出来（框选要落在位图上才有意义）
    if (el.dataset.done !== '1') await renderPage(n);
    if (el.dataset.done !== '1') { toast('这一页还没渲染出来，稍后再试', true); return; }

    hideOcrPanel();
    R.ocrOn = true;
    $('#thrOcr')?.classList.add('active');
    const layer = document.createElement('div');
    layer.className = 'thr-ocr-layer';
    layer.innerHTML = `<div class="thr-ocr-rect hidden"></div>
      <div class="thr-ocr-hint">拖动框选要摘录的区域 · 直接点一下识别整页 · Esc 取消</div>`;
    el.appendChild(layer);

    let start = null;
    const rectEl = $('.thr-ocr-rect', layer);
    const onMove = (e) => {
      if (!start) return;
      const b = layer.getBoundingClientRect();
      const x1 = Math.max(0, Math.min(start.x, e.clientX) - b.left);
      const y1 = Math.max(0, Math.min(start.y, e.clientY) - b.top);
      const x2 = Math.min(b.width, Math.max(start.x, e.clientX) - b.left);
      const y2 = Math.min(b.height, Math.max(start.y, e.clientY) - b.top);
      rectEl.style.left = `${x1}px`;
      rectEl.style.top = `${y1}px`;
      rectEl.style.width = `${Math.max(0, x2 - x1)}px`;
      rectEl.style.height = `${Math.max(0, y2 - y1)}px`;
    };
    const onDown = (e) => {
      start = { x: e.clientX, y: e.clientY };
      rectEl.classList.remove('hidden');
      onMove(e);
    };
    const onUp = async (e) => {
      layer.removeEventListener('mousemove', onMove);
      layer.removeEventListener('mouseup', onUp);
      if (!start) return;
      const b = layer.getBoundingClientRect();
      const x = Math.min(start.x, e.clientX) - b.left;
      const y = Math.min(start.y, e.clientY) - b.top;
      const w = Math.abs(e.clientX - start.x);
      const h = Math.abs(e.clientY - start.y);
      start = null;
      finishOcrSelect();
      layer.remove();
      // 只点了一下（没拖动）→ 识别整页；拖出了框 → 只识别框里那块
      const region = (w < 14 || h < 14) ? null : { x, y, w, h };
      await runOcr(n, region);
    };
    layer.addEventListener('mousedown', onDown);
    layer.addEventListener('mousemove', onMove);
    layer.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', escOcr, true);
    toast('拖动框选要识别的区域；直接点一下 = 识别整页');
  }

  function escOcr(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelOcr();
  }

  function finishOcrSelect() {
    R.ocrOn = false;
    $('#thrOcr')?.classList.remove('active');
    window.removeEventListener('keydown', escOcr, true);
  }

  function cancelOcr() {
    finishOcrSelect();
    $$('.thr-ocr-layer').forEach((el) => el.remove());
  }

  async function runOcr(page, region) {
    try {
      toast('正在识别…');
      const image = await cropPageJpeg(page, region);
      if (!image) { toast('这块范围太小，重新框一次', true); return; }
      const r = await api(`/api/theses/${R.id}/ocr`, { method: 'POST', body: { page, image } });
      showOcrPanel(r?.text || '', { page });
    } catch (e) {
      toast(e.message || '识别失败', true);
    }
  }

  /**
   * 把某一页（或页面上的一块）画成 JPEG 交给 OCR。
   *
   * 刻意**重新渲染一遍**而不是从屏幕上那张 canvas 里裁：屏幕位图受 DPR 1.5 与适宽比例
   * 双重限制，A4 页大概只有 100DPI，脚注、表格里的小数字会糊到认不出来。
   * 这里按 2–3 倍重渲一次，只多花百来毫秒，识别率差很多。
   */
  async function cropPageJpeg(pageNo, region) {
    if (!R.doc) return '';
    const page = await R.doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(3, Math.max(2, R.scale)) });
    const full = document.createElement('canvas');
    full.width = Math.max(1, Math.round(vp.width));
    full.height = Math.max(1, Math.round(vp.height));
    const ctx = full.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, full.width, full.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (!region) return full.toDataURL('image/jpeg', 0.9);

    // 屏幕坐标 → 位图坐标（页在屏幕上的 CSS 尺寸是 R.pageW × R.pageH）
    const sx = full.width / Math.max(1, R.pageW);
    const sy = full.height / Math.max(1, R.pageH);
    const pad = 8; // 往外放一点，免得把字边切掉
    const x = Math.max(0, (region.x - pad) * sx);
    const y = Math.max(0, (region.y - pad) * sy);
    const w = Math.min(full.width - x, (region.w + pad * 2) * sx);
    const h = Math.min(full.height - y, (region.h + pad * 2) * sy);
    if (w < 4 || h < 4) return '';
    const cut = document.createElement('canvas');
    cut.width = Math.max(1, Math.round(w));
    cut.height = Math.max(1, Math.round(h));
    const cctx = cut.getContext('2d');
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, cut.width, cut.height);
    cctx.drawImage(full, x, y, w, h, 0, 0, cut.width, cut.height);
    return cut.toDataURL('image/jpeg', 0.9);
  }

  function ocrPanelDom() {
    let el = $('#thOcr');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'thOcr';
    el.className = 'th-ocr hidden';
    el.innerHTML = `
      <div class="th-ocr-head">
        <b>🈯 文字识别</b>
        <span class="th-muted" id="thOcrMeta"></span>
        <span class="sp"></span>
        <button class="tb-btn ghost" id="thOcrCopy">复制</button>
        <button class="tb-btn ghost" id="thOcrClose" title="关闭">✕</button>
      </div>
      <textarea class="th-ocr-text" id="thOcrText" placeholder="识别出的文字会出现在这里，可以直接改…"></textarea>
      <div class="th-ocr-acts">
        <button class="tb-btn accent" id="thOcrQuote">📌 加入素材库</button>
        <button class="tb-btn" id="thOcrNote">📝 追加到笔记</button>
        <button class="tb-btn" id="thOcrAsk">💬 用这段提问</button>
        <button class="tb-btn" id="thOcrAgain">🈯 重新框选</button>
      </div>`;
    document.body.appendChild(el);
    $('#thOcrClose').addEventListener('click', hideOcrPanel);
    $('#thOcrCopy').addEventListener('click', async () => {
      const t = $('#thOcrText').value.trim();
      if (!t) { toast('还没有识别结果', true); return; }
      try { await navigator.clipboard.writeText(t); toast('已复制'); }
      catch (_) { $('#thOcrText').select(); toast('已选中，按 Ctrl+C 复制'); }
    });
    $('#thOcrQuote').addEventListener('click', async () => {
      const t = $('#thOcrText').value.trim();
      if (!t) { toast('还没有识别结果', true); return; }
      await quoteCurrent(t);
      hideOcrPanel();
    });
    $('#thOcrNote').addEventListener('click', async () => {
      const t = $('#thOcrText').value.trim();
      if (!t) { toast('还没有识别结果', true); return; }
      const p = Number($('#thOcr').dataset.page) || R.page;
      await ensureNote();
      appendNote(blockquoteText(t), `摘录 · 第 ${p} 页（文字识别）`);
      hideOcrPanel();
      if (!R.noteMode) await toggleNoteMode();
      else { applyNoteRatio(); setNoteView('edit'); }
    });
    $('#thOcrAsk').addEventListener('click', () => {
      const t = $('#thOcrText').value.trim();
      if (!t) { toast('还没有识别结果', true); return; }
      const p = Number($('#thOcr').dataset.page) || R.page;
      hideOcrPanel();
      switchTab('chat');
      const input = $('#thrInput');
      input.value = `关于这段（第 ${p} 页）：\n“${t}”\n\n`;
      input.focus();
    });
    $('#thOcrAgain').addEventListener('click', () => { hideOcrPanel(); startOcr(); });
    return el;
  }

  function showOcrPanel(text, { page } = {}) {
    const el = ocrPanelDom();
    el.dataset.page = String(page || R.page || 1);
    el.classList.remove('hidden');
    $('#thOcrMeta').textContent = `第 ${el.dataset.page} 页 · 识别结果可直接改`;
    $('#thOcrText').value = text || '';
    if (!text) toast('这一块里没识别出文字', true);
  }

  function hideOcrPanel() { $('#thOcr')?.classList.add('hidden'); }

  /** 把多行文字变成 Markdown 引用块（摘录要能一眼看出「这是原文」） */
  function blockquoteText(text) {
    return String(text || '').split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n');
  }

  async function loadQuotes() {
    try { S.quotes = (await api('/api/thesis-quotes')).filter((q) => q.thesisId === R.id); }
    catch (_) { S.quotes = []; }
  }

  function openQuotesDrawer() {
    let el = $('#thQuotes');
    if (!el) {
      el = document.createElement('div');
      el.id = 'thQuotes';
      el.className = 'th-quotes hidden';
      el.innerHTML = `
        <div class="th-quotes-head">
          <b>📌 摘录素材库</b><span class="sp"></span>
          <button class="tb-btn" id="thqExport">导出 Markdown</button>
          <button class="tb-btn" id="thqClose">✕</button>
        </div>
        <div class="th-quotes-list" id="thqList"></div>`;
      document.body.appendChild(el);
      $('#thqClose').addEventListener('click', () => el.classList.add('hidden'));
      $('#thqExport').addEventListener('click', () => { window.location.href = '/api/thesis-quotes/export'; });
      $('#thqList').addEventListener('click', async (e) => {
        const del = e.target.closest('[data-del]');
        if (del) {
          await api(`/api/thesis-quotes/${del.dataset.del}`, { method: 'DELETE' });
          renderQuotes();
          return;
        }
        const jump = e.target.closest('[data-jump]');
        if (jump) {
          const id = jump.dataset.jump;
          const page = Number(jump.dataset.page) || 1;
          if (R.id !== id) await openReader(id);
          goPage(page);
        }
      });
    }
    el.classList.remove('hidden');
    renderQuotes();
  }

  async function renderQuotes() {
    const box = $('#thqList');
    if (!box) return;
    let list = [];
    try { list = await api('/api/thesis-quotes'); } catch (_) { list = []; }
    if (!list.length) {
      box.innerHTML = '<div class="thr-out-empty">还没有摘录。在阅读器里选中正文 →「加入素材库」即可，摘录会自动带上章节与页码。</div>';
      return;
    }
    const groups = new Map();
    for (const q of list) {
      const k = q.thesisTitle || '未命名';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(q);
    }
    box.innerHTML = [...groups.entries()].map(([title, items]) => `
      <div class="thr-out-group">${esc(title)}（${items.length}）</div>
      ${items.map((q) => `<div class="th-quote">
        <div class="th-quote-text">${esc(q.text)}</div>
        <div class="th-quote-src">
          <span class="link" data-jump="${esc(q.thesisId)}" data-page="${q.page}">${esc([q.chapterTitle, q.page ? `p.${q.page}` : ''].filter(Boolean).join(' · ') || '阅读器')}</span>
          <span class="sp" style="flex:1"></span>
          <button class="tb-btn ghost" data-del="${esc(q.id)}" style="padding:0 5px">删除</button>
        </div>
        ${q.note ? `<div class="th-quote-note">${esc(q.note)}</div>` : ''}
      </div>`).join('')}
    `).join('');
  }

  // ==================== 对比阅读 ====================

  function openCompare() {
    const ids = [...S.selected];
    const preset = ids.length >= 2 ? ids : S.items.slice(0, 2).map((x) => x.id);
    let el = $('#thCompare');
    if (!el) {
      el = document.createElement('div');
      el.id = 'thCompare';
      el.className = 'th-modal hidden';
      el.innerHTML = `<div class="th-modal-box">
        <div class="th-modal-head"><h3>⇄ 对比阅读</h3><span class="sp"></span><span id="thCmpModel"></span><button class="tb-btn" id="thCmpClose">✕</button></div>
        <div class="th-modal-body" id="thCmpBody"></div>
        <div class="th-modal-foot"><button class="tb-btn" id="thCmpExport" disabled>导出 Markdown</button><button class="tb-btn accent" id="thCmpRun">开始对比</button></div>
      </div>`;
      document.body.appendChild(el);
      $('#thCmpClose').addEventListener('click', () => el.classList.add('hidden'));
      $('#thCmpExport').addEventListener('click', () => download('学位论文对比.md', $('#thCmpBody').innerText || ''));
      $('#thCmpRun').addEventListener('click', runCompare);
    }
    el.classList.remove('hidden');
    loadModelChoices().then(() => { $('#thCmpModel').innerHTML = modelSelectHtml('thCmpModel'); });
    const chosen = new Set(preset);
    $('#thCmpBody').innerHTML = `<p class="th-muted">勾选 2–5 篇（已解析出字段的效果最好），再点「开始对比」。</p>
      ${S.items.map((it) => `<label class="pop-item" style="display:block;padding:5px 2px">
        <input type="checkbox" data-cmp="${esc(it.id)}" ${chosen.has(it.id) ? 'checked' : ''} />
        ${esc(it.title || it.originalName || '未命名')} <span class="th-muted">${esc(it.year || '')}</span></label>`).join('')}`;
    $('#thCmpExport').disabled = true;
  }

  async function runCompare() {
    const ids = $$('#thCmpBody input[data-cmp]').filter((i) => i.checked).map((i) => i.dataset.cmp);
    if (ids.length < 2) { toast('至少选 2 篇', true); return; }
    if (ids.length > 5) { toast('最多 5 篇', true); return; }
    const body = $('#thCmpBody');
    const btn = $('#thCmpRun');
    btn.disabled = true;
    let text = '';
    body.innerHTML = '<p class="th-muted">正在生成对比表…</p>';
    try {
      const sel = $('#thCmpModel')?.value || '';
      await streamPost('/api/theses/compare', { ids, profileId: sel }, (ev) => {
        if (ev.error) { body.innerHTML = `<p style="color:var(--red)">${esc(ev.error)}</p>`; return; }
        if (ev.delta) {
          text += ev.delta;
          clearTimeout(R.renderTimer);
          R.renderTimer = setTimeout(() => { body.innerHTML = `<div class="md-render">${markdown(text)}</div>`; }, 90);
        }
      });
      clearTimeout(R.renderTimer);
      body.innerHTML = `<div class="md-render">${markdown(text || '（没有生成内容）')}</div>`;
      $('#thCmpExport').disabled = !text;
    } catch (err) {
      body.innerHTML = `<p style="color:var(--red)">${esc(err.message)}</p>`;
    }
    btn.disabled = false;
  }

  // ==================== 我的大论文 ====================

  async function openBigPaper() {
    try { S.bigPaper = await api('/api/thesis-bigpaper'); } catch (_) { S.bigPaper = {}; }
    let el = $('#thBig');
    if (!el) {
      el = document.createElement('div');
      el.id = 'thBig';
      el.className = 'th-modal hidden';
      el.innerHTML = `<div class="th-modal-box" style="width:min(620px,92vw)">
        <div class="th-modal-head"><h3>🎯 我的大论文</h3><span class="sp"></span><button class="tb-btn" id="thBigClose">✕</button></div>
        <div class="th-modal-body">
          <p class="th-muted" style="margin-top:0">填好之后，AI 对话会自动带上这些信息，
          于是你可以直接问「这篇的方法能不能用在我的第四章」。</p>
          <div class="th-form-row"><label>题目</label><input id="thBigTitle" /></div>
          <div class="th-form-row"><label>当前阶段</label><input id="thBigStage" placeholder="例如：第三章 研究设计写作中" /></div>
          <div class="th-form-row"><label>框架</label><textarea id="thBigFramework" placeholder="1 绪论&#10;2 文献综述&#10;3 研究设计"></textarea></div>
          <div class="th-form-row"><label>备注</label><input id="thBigNotes" placeholder="例如：数据还没收齐" /></div>
        </div>
        <div class="th-modal-foot"><button class="tb-btn accent" id="thBigSave">保存</button></div>
      </div>`;
      document.body.appendChild(el);
      $('#thBigClose').addEventListener('click', () => el.classList.add('hidden'));
      $('#thBigSave').addEventListener('click', async () => {
        try {
          S.bigPaper = await api('/api/thesis-bigpaper', {
            method: 'PUT',
            body: {
              title: $('#thBigTitle').value,
              stage: $('#thBigStage').value,
              framework: $('#thBigFramework').value,
              notes: $('#thBigNotes').value,
            },
          });
          toast('已保存，下次提问会带上它');
          el.classList.add('hidden');
        } catch (err) { toast(err.message, true); }
      });
    }
    el.classList.remove('hidden');
    $('#thBigTitle').value = S.bigPaper.title || '';
    $('#thBigStage').value = S.bigPaper.stage || '';
    $('#thBigFramework').value = S.bigPaper.framework || '';
    $('#thBigNotes').value = S.bigPaper.notes || '';
  }

  // ==================== 对外接口 ====================

  /** 收起所有自建浮层（切到别的视图时由 app.js 调用） */
  function closeAll() {
    closeDetail();
    closeColsPop();
    $('#thQuotes')?.classList.add('hidden');
    $('#thCompare')?.classList.add('hidden');
    $('#thBig')?.classList.add('hidden');
    if (R.id) closeReader();
  }

  async function mount() {
    if (!S.mounted) {
      S.mounted = true;
      buildDom();
      bindList();
    }
    closeAll();
    try {
      // 排序偏好：跟着用户上次的选择走（换列用默认方向，所以这里只存键 + 方向）
      const saved = readJson(LS.sort, null);
      if (saved && SORT_KEYS.has(saved.key)) {
        S.sort = saved.key;
        S.sortDir = saved.dir === 'asc' ? 'asc' : 'desc';
      }
      syncSortUi();
      await refresh();
      await loadModelChoices();
    } catch (err) {
      const wrap = $('#thWrap');
      if (wrap) wrap.innerHTML = `<div class="th-empty">加载失败：${esc(err.message)}</div>`;
    }
  }

  window.ThesisView = { mount, close: closeAll, open: (id) => openReader(id) };
})();
