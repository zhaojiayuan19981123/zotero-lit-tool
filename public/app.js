// app.js —— 文献管理前端：Zotero 式侧边栏 + 多维表格 + 左右布局 PDF 阅读器
(() => {
  'use strict';

  // ============ 字段定义 ============
  const FIXED_COLS = [
    { key: 'attachment', label: '文献PDF上传', type: 'attach', w: 130 },
    { key: 'readingProgress', label: '阅读进度', type: 'progress', w: 96 },
    { key: 'rating', label: '评级', type: 'rating', w: 112 },
    { key: 'journalRank', label: '期刊等级', type: 'rank', w: 170 },
  ];
  const CONTENT_COLS = {
    title: { key: 'title', label: '标题', type: 'title', ai: true, w: 200 },
    authors: { key: 'authors', label: '作者', type: 'text', ai: true, w: 150 },
    journal: { key: 'journal', label: '期刊/会议', type: 'text', ai: true, w: 150 },
    year: { key: 'year', label: '年份', type: 'text', ai: true, w: 64 },
    doi: { key: 'doi', label: 'DOI', type: 'text', ai: true, w: 120 },
    keywords: { key: 'keywords', label: '关键词', type: 'text', ai: true, w: 160 },
    abstract: { key: 'abstract', label: '摘要(中文)', type: 'md', ai: true, w: 240 },
    background: { key: 'background', label: '研究背景', type: 'md', ai: true, w: 260 },
    summary: { key: 'summary', label: '一段话总结', type: 'md', ai: true, w: 280 },
    innovation: { key: 'innovation', label: '创新点', type: 'md', ai: true, w: 240 },
    theory: { key: 'theory', label: '理论', type: 'md', ai: true, w: 220 },
    method: { key: 'method', label: '研究方法', type: 'md', ai: true, w: 200 },
    researchDesign: { key: 'researchDesign', label: '研究设计', type: 'md', ai: true, w: 260 },
    constructs: { key: 'constructs', label: '构念', type: 'md', ai: true, w: 240 },
    results: { key: 'results', label: '实验结果', type: 'md', ai: true, w: 260 },
    conclusion: { key: 'conclusion', label: '结论', type: 'md', ai: true, w: 260 },
    criticalThinking: { key: 'criticalThinking', label: '批判性思考', type: 'md', ai: true, w: 260 },
    model: { key: 'model', label: '模型', type: 'md', ai: true, w: 220 },
    paramDiscussion: { key: 'paramDiscussion', label: '参数讨论', type: 'md', ai: true, w: 260 },
  };
  // 两个文库各自的字段排布（界面分开，不一致）
  const TYPE_ORDER = {
    empirical: ['title', 'authors', 'journal', 'year', 'doi', 'keywords', 'abstract', 'background',
      'theory', 'method', 'researchDesign', 'constructs', 'results', 'conclusion', 'criticalThinking', 'summary', 'innovation'],
    model: ['title', 'authors', 'journal', 'year', 'doi', 'keywords', 'abstract', 'background',
      'model', 'method', 'paramDiscussion', 'results', 'summary', 'innovation'],
  };
  const LIB_META = {
    empirical: { label: '实证类文库', icon: '🧪' },
    model: { label: '模型类文库', icon: '🧮' },
  };

  const STATUS_LABEL = { done: '已完成', parsing: '解析中', pending: '待解析', error: '解析失败' };
  const PROGRESS_LIST = ['未阅读', '阅读中', '已阅读'];
  const HIGHLIGHT_COLORS = { yellow: '#ffe08a', green: '#b5e6b5', blue: '#a8d4f5', pink: '#f7b8d0' };

  // ============ 状态 ============
  let items = [];
  let collections = [];
  let settings = {};
  let visible = new Set(Object.keys(CONTENT_COLS));
  let tab = 'all';
  let sortOrder = 'desc';
  let rowHeight = 'm';
  let currentId = null;
  let cellUploadId = null;
  // 当前文库（侧边栏选中）：类型 + 分类（null = 全部文献）
  let lib = { type: 'empirical', collectionId: null };
  let colWidths = {}; // 用户调节的列宽 { key: px }
  // 工作台状态（首页 / 项目 / 任务 / 论文 / 研究记录 / AI 助手）
  let view = 'home';
  let profile = {};
  let projects = [];
  let tasks = [];
  let notes = [];
  let papers = [];        // 论文：kind = 'journal'（小论文）| 'thesis'（大论文）
  let paperTab = 'journal'; // 论文进度子页签
  let chatMsgs = [];       // 当前会话的消息
  let conversations = [];  // 全部会话 [{id,title,updatedAt,messageCount,compressed}]
  let activeConvId = null; // 当前会话 id
  let activeSummary = '';  // 当前会话的早期对话摘要
  let convLoaded = false;
  let chatBusy = false;
  // 科研日历状态
  let calYear = new Date().getFullYear();
  let calMonth = new Date().getMonth(); // 0-based
  let calSelected = null; // 'YYYY-MM-DD'

  const $ = (id) => document.getElementById(id);
  const el = {
    searchInput: $('searchInput'), statusFilter: $('statusFilter'), sortField: $('sortField'),
    theadRow: $('theadRow'), tbody: $('tbody'), emptyState: $('emptyState'), statBadge: $('statBadge'),
    gridWrap: $('gridWrap'), fieldsPop: $('fieldsPop'), toast: $('toast'),
    fileInput: $('fileInput'), cellFileInput: $('cellFileInput'),
    drawer: $('drawer'), drawerMask: $('drawerMask'), drawerBody: $('drawerBody'), drawerFilename: $('drawerFilename'),
    settingsModal: $('settingsModal'), editModal: $('editModal'), editBody: $('editBody'),
    colModal: $('colModal'),
  };

  // ============ 工具 ============
  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }
  function isAbortError(e) { return e && (e.name === 'AbortError' || e.code === 20); }
  let toastTimer = null;
  function toast(msg, type = '') {
    el.toast.textContent = msg;
    el.toast.className = 'toast ' + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 3200);
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadItems() { items = await api('/api/literature'); render(); }
  async function loadSettings() {
    settings = await api('/api/settings');
    fillSettingsForm();
    // 启动时恢复已保存的主题配色（无保存则用默认紫）
    renderThemePresets();
    applyTheme(settings.themeColor || DEFAULT_THEME, false);
  }
  async function loadCollections() { collections = await api('/api/collections'); renderLibBar(); }

  // ============ 文献中心：文库切换条 ============
  function renderLibBar() {
    for (const type of ['empirical', 'model']) {
      const root = document.querySelector(`[data-rootlib="${type}"]`);
      if (root) {
        root.classList.toggle('active', lib.type === type);
        const n = items.filter((i) => (i.docType || 'empirical') === type).length;
        root.querySelector('[data-rootcount]').textContent = n || '';
      }
    }
    const cols = collections.filter((c) => c.docType === lib.type);
    $('colChips').innerHTML = cols.map((c) => {
      const n = items.filter((i) => i.collectionId === c.id).length;
      return `<div class="col-chip${lib.collectionId === c.id ? ' active' : ''}" data-collection="${c.id}" data-colname="${esc(c.name)}">
        📁 ${esc(c.name)} <span class="side-count">${n || ''}</span>
        <span class="chip-ops">
          <button data-rename="${c.id}" title="重命名">✎</button>
          <button data-delcol="${c.id}" title="删除">🗑</button>
        </span>
      </div>`;
    }).join('');
    // 底部阅读进度统计
    $('cntDone').textContent = items.filter((i) => i.readingProgress === '已阅读').length;
    $('cntReading').textContent = items.filter((i) => i.readingProgress === '阅读中').length;
    $('cntUnread').textContent = items.filter((i) => (i.readingProgress || '未阅读') === '未阅读').length;
  }

  function selectLib(type, collectionId) {
    lib = { type, collectionId: collectionId || null };
    renderLibBar();
    render();
  }

  function bindLibBar() {
    // 点击文库根切换 / 新建分类
    $('libBar').addEventListener('click', (e) => {
      const root = e.target.closest('[data-rootlib]');
      if (root) { selectLib(root.dataset.rootlib, null); return; }
      if (e.target.closest('#btnAddCol')) { openColModal('create', lib.type); return; }
    });
    // 分类 chip：选择 / 重命名 / 删除
    $('colChips').addEventListener('click', (e) => {
      const ren = e.target.closest('[data-rename]');
      if (ren) { e.stopPropagation(); openColModal('rename', null, ren.dataset.rename); return; }
      const del = e.target.closest('[data-delcol]');
      if (del) {
        e.stopPropagation();
        const col = collections.find((c) => c.id === del.dataset.delcol);
        if (col && confirm(`确认删除分类「${col.name}」？分类下的文献将移回「全部文献」。`)) {
          api('/api/collections/' + col.id, { method: 'DELETE' })
            .then(() => { if (lib.collectionId === col.id) lib.collectionId = null; return loadCollections(); })
            .then(loadItems)
            .then(() => toast('分类已删除', 'success'))
            .catch((err) => toast(err.message, 'error'));
        }
        return;
      }
      const chip = e.target.closest('.col-chip');
      if (chip) selectLib(lib.type, chip.dataset.collection);
    });
    // 拖动文献行到分类 chip → 归类；拖到文库根 → 移出分类
    const chipWrap = $('colChips');
    chipWrap.addEventListener('dragover', (e) => {
      const t = e.target.closest('.col-chip'); if (t) { e.preventDefault(); t.classList.add('dragover'); }
    });
    chipWrap.addEventListener('dragleave', (e) => {
      const t = e.target.closest('.col-chip'); if (t) t.classList.remove('dragover');
    });
    chipWrap.addEventListener('drop', async (e) => {
      const t = e.target.closest('.col-chip'); if (!t) return;
      e.preventDefault(); t.classList.remove('dragover');
      const id = e.dataTransfer?.getData('text/lit-id');
      if (!id) return;
      try {
        await api('/api/literature/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionId: t.dataset.collection }) });
        await loadItems(); await loadCollections();
        toast(`已移入「${t.dataset.colname}」`, 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
    const bar = $('libBar');
    bar.addEventListener('dragover', (e) => {
      const root = e.target.closest('[data-rootlib]');
      if (root) { e.preventDefault(); root.classList.add('dragover'); }
    });
    bar.addEventListener('dragleave', (e) => {
      const root = e.target.closest('[data-rootlib]'); if (root) root.classList.remove('dragover');
    });
    bar.addEventListener('drop', async (e) => {
      const root = e.target.closest('[data-rootlib]');
      if (!root) return;
      e.preventDefault(); root.classList.remove('dragover');
      const id = e.dataTransfer?.getData('text/lit-id');
      if (!id) return;
      try {
        await api('/api/literature/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collectionId: null }) });
        await loadItems(); await loadCollections();
        toast('已移出分类', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // 分类新建/重命名弹窗
  let colModalMode = 'create', colModalType = 'empirical', colModalId = null;
  function openColModal(mode, type, id) {
    colModalMode = mode; colModalType = type; colModalId = id || null;
    $('colModalTitle').textContent = mode === 'create' ? '新建分类' : '重命名分类';
    $('colModalInput').value = mode === 'rename' ? (collections.find((c) => c.id === id)?.name || '') : '';
    el.colModal.classList.remove('hidden');
    setTimeout(() => $('colModalInput').focus(), 50);
  }
  async function saveColModal() {
    const name = $('colModalInput').value.trim();
    if (!name) { toast('请输入分类名称', 'error'); return; }
    try {
      if (colModalMode === 'create') {
        await api('/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, docType: colModalType }) });
      } else {
        await api('/api/collections/' + colModalId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      }
      el.colModal.classList.add('hidden');
      await loadCollections();
      toast('已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ============ 列构建 ============
  function buildColumns() {
    const cols = [...FIXED_COLS];
    for (const key of TYPE_ORDER[lib.type]) {
      if (!visible.has(key)) continue;
      const c = CONTENT_COLS[key];
      const label = (key === 'method' && lib.type === 'model') ? '求解方法' : c.label;
      cols.push({ ...c, label });
    }
    cols.push({ key: 'status', label: '解析状态', type: 'status', w: 92 });
    cols.push({ key: 'actions', label: '操作', type: 'actions', w: 84 });
    return cols.map((c) => ({ ...c, w: colWidths[c.key] || c.w }));
  }

  // ============ 渲染 ============
  function filteredItems() {
    let list = items.filter((i) => (i.docType || 'empirical') === lib.type);
    if (lib.collectionId) list = list.filter((i) => i.collectionId === lib.collectionId);
    if (tab !== 'all') list = list.filter((i) => (i.readingProgress || '未阅读') === tab);
    const st = el.statusFilter.value;
    if (st !== 'all') list = list.filter((i) => i.status === st);
    const q = el.searchInput.value.trim().toLowerCase();
    if (q) list = list.filter((i) => Object.values(CONTENT_COLS).map((c) => i[c.key] || '').join(' ').toLowerCase().includes(q));
    const f = el.sortField.value;
    list.sort((a, b) => {
      let va = a[f] ?? '', vb = b[f] ?? '';
      if (f === 'year' || f === 'rating') { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; return sortOrder === 'asc' ? va - vb : vb - va; }
      va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
      return sortOrder === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    return list;
  }

  function render() {
    renderHead(); renderBody();
    const scope = items.filter((i) => (i.docType || 'empirical') === lib.type);
    const done = scope.filter((i) => i.status === 'done').length;
    const libName = lib.collectionId
      ? collections.find((c) => c.id === lib.collectionId)?.name || '分类'
      : LIB_META[lib.type].label;
    el.statBadge.textContent = `${libName} · ${scope.length} 条 · 已完成 ${done}`;
  }

  function renderHead() {
    const cols = buildColumns();
    el.theadRow.innerHTML =
      `<th class="cell-check"><input type="checkbox" disabled /></th>` +
      `<th class="cell-num">#</th>` +
      cols.map((c) => `
        <th style="min-width:${c.w}px" data-col="${c.key}"><div class="th-inner" title="${esc(c.label)}">
          <span class="th-ico">${typeIcon(c.type)}</span><span class="th-name">${esc(c.label)}</span>
          ${c.ai ? '<span class="col-ai">AI 生成</span>' : ''}
        </div><span class="col-resize" data-resize="${c.key}"></span></th>`).join('');
  }
  function typeIcon(t) { return { title: 'ⓐ', attach: '📎', progress: '◔', rating: '☆', text: '⃝', md: '≡', status: '◉', actions: '⚙', rank: '🏅' }[t] || '⃝'; }

  function renderBody() {
    const list = filteredItems();
    const cols = buildColumns();
    el.tbody.innerHTML = '';
    el.emptyState.classList.toggle('hidden', list.length > 0);
    if (!list.length) return;
    list.forEach((it, idx) => {
      const tr = document.createElement('tr');
      tr.dataset.id = it.id;
      tr.draggable = true;
      if (it.status === 'parsing') tr.classList.add('uploading');
      tr.innerHTML = `<td class="cell-check"><input type="checkbox" data-check /></td>` +
        `<td class="cell-num">${idx + 1}</td>` +
        cols.map((c) => `<td>${renderCell(c, it)}</td>`).join('');
      tr.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/lit-id', it.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      el.tbody.appendChild(tr);
    });
  }

  function renderCell(c, it) {
    switch (c.type) {
      case 'title': {
        const v = it.title || '';
        return `<div class="clamp cell-title" data-open="${it.id}" title="点击查看全文解析">${esc(v) || '<span class="cell-empty">（未命名）</span>'}</div>`;
      }
      case 'attach': return attachCell(it);
      case 'progress': {
        const p = it.readingProgress || '未阅读';
        return `<button class="progress-badge progress-${p}" data-progress="${it.id}" title="点击切换阅读进度">◔ ${p}</button>`;
      }
      case 'rating': {
        const r = Math.round(it.rating || 0);
        return `<span class="stars" data-rating="${it.id}">` + [1, 2, 3, 4, 5].map((n) => `<button class="star ${n <= r ? 'on' : ''}" data-star="${n}" title="${n} 星">★</button>`).join('') + `</span>`;
      }
      case 'status': return `<span class="badge badge-${it.status}" title="${esc(it.error || STATUS_LABEL[it.status])}">${STATUS_LABEL[it.status] || it.status}</span>`;
      case 'actions':
        return `<div class="row-actions">
          <button class="icon-btn" data-act="parse" title="重新解析">↻</button>
          <button class="icon-btn" data-act="open" title="查看解析">⤢</button>
          <button class="icon-btn" data-act="read" title="阅读 PDF">📖</button>
          <button class="icon-btn danger" data-act="del" title="删除">🗑</button></div>`;
      case 'rank': {
        const v = it.journalRank || '';
        if (!v) return it.journalRankError ? `<span class="cell-empty" title="${esc(it.journalRankError)}" style="color:var(--orange)">查询失败</span>` : '<span class="cell-empty">—</span>';
        return `<div class="clamp rank-cell" title="${esc(v)}">${rankChips(it.journalRankDetail)}</div>`;
      }
      case 'md': {
        const v = it[c.key] || '';
        if (!v) return '<span class="cell-empty">—</span>';
        return `<div class="clamp">${mdInline(v)}</div>`;
      }
      default: {
        const v = it[c.key] || '';
        if (!v) return '<span class="cell-empty">—</span>';
        return `<div class="clamp cell-text" title="${esc(v)}">${esc(v)}</div>`;
      }
    }
  }

  function attachCell(it) {
    if (it.status === 'parsing') return `<div class="cell-spinner" title="AI 解析中…"></div>`;
    if (!it.filename) return `<div class="cell-attach" data-upload="${it.id}" title="点击或拖入 PDF 上传"><div class="attach-empty">＋</div></div>`;
    const url = '/uploads/' + encodeURIComponent(it.filename);
    const thumb = it.thumb ? `<img src="${it.thumb}" alt="" loading="lazy" />` : `<div class="pdf-icon"></div>`;
    return `<div class="cell-attach" data-upload="${it.id}" title="${esc(it.originalName)}（点击替换 / 拖入重新上传）">
      <div class="attach-box">${thumb}<button class="attach-del" data-delattach="${it.id}" title="移除附件">✕</button></div>
      <div class="attach-name"><a href="${url}" target="_blank" data-pdflink>${esc(it.originalName)}</a></div></div>`;
  }

  function mdLines(v) { return String(v).split('\n').map((l) => l.trim()).filter(Boolean); }
  function mdInline(v) {
    return mdLines(v).map((line) => {
      const b = esc(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      if (/^[-•*]\s*/.test(line)) return `<div class="md-line"><span class="dot">•</span><span>${b.replace(/^[-•*]\s*/, '')}</span></div>`;
      return `<div>${b}</div>`;
    }).join('');
  }
  function mdFull(v) {
    const out = []; let inList = false;
    for (const line of mdLines(v)) {
      const plain = esc(line).replace(/\*\*(.+?)\*\*/g, '<b class="md-label">$1</b>');
      if (/^[-•*]\s*/.test(line)) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${plain.replace(/^[-•*]\s*/, '')}</li>`); }
      else { if (inList) { out.push('</ul>'); inList = false; } out.push(`<p>${plain}</p>`); }
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }
  function rankChips(detail) {
    if (!Array.isArray(detail) || !detail.length) return esc('—');
    return detail.map((d) => `<span class="rank-chip">${esc(d.label)} <b>${esc(d.value)}</b></span>`).join('');
  }

  // ============ PDF 缩略图 ============
  let pdfjsPromise = null;
  function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = new Promise((resolve, reject) => {
        const w = window;
        if (w.pdfjsLib) return resolve(w.pdfjsLib);
        const s = document.createElement('script');
        s.src = '/vendor/pdf.min.js';
        s.onload = () => { const lib2 = w.pdfjsLib || w['pdfjs-dist/build/pdf']; lib2.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js'; resolve(lib2); };
        s.onerror = () => {
          const s2 = document.createElement('script');
          s2.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
          s2.onload = () => { const lib2 = w.pdfjsLib || w['pdfjs-dist/build/pdf']; lib2.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; resolve(lib2); };
          s2.onerror = () => reject(new Error('pdf.js 加载失败'));
          document.head.appendChild(s2);
        };
        document.head.appendChild(s);
      });
    }
    return pdfjsPromise;
  }
  async function makeThumb(filename) {
    try {
      const lib2 = await loadPdfJs();
      const doc = await lib2.getDocument({ url: '/uploads/' + encodeURIComponent(filename) }).promise;
      const page = await doc.getPage(1);
      const v1 = page.getViewport({ scale: 1 });
      const scale = 216 / v1.width;
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      return c.toDataURL('image/jpeg', 0.72);
    } catch (e) { return null; }
  }
  async function ensureThumb(record) {
    if (!record.filename || record.thumb) return;
    const thumb = await makeThumb(record.filename);
    if (thumb) {
      await api('/api/literature/' + record.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thumb }) });
      const it = items.find((x) => x.id === record.id);
      if (it) { it.thumb = thumb; render(); }
    }
  }

  // ============ 上传 ============
  function bindUpload() {
    $('btnUploadTop').addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => { if (el.fileInput.files.length) handleBatchUpload(el.fileInput.files); el.fileInput.value = ''; });
    // 整页拖拽上传（带视觉反馈）
    const overlay = $('dragOverlay');
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; overlay.classList.remove('hidden'); }
    });
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) overlay.classList.add('hidden'); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      overlay.classList.add('hidden');
      const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.pdf$/i.test(f.name));
      if (files.length && !e.target.closest('.cell-attach')) handleBatchUpload(files);
    });
  }
  async function handleBatchUpload(fileList) {
    const pdfs = [...fileList].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) { toast('请选择 PDF 文件', 'error'); return; }
    const form = new FormData();
    pdfs.forEach((f) => form.append('files', f));
    form.append('docType', lib.type);
    if (lib.collectionId) form.append('collectionId', lib.collectionId);
    toast(`正在上传 ${pdfs.length} 个 PDF…`);
    try {
      const data = await api('/api/upload', { method: 'POST', body: form });
      await loadItems(); await loadCollections();
      if (data.failed.length) toast(`${data.failed.length} 个文件上传失败`, 'error');
      await parseIds(data.created.map((c) => c.id));
      data.created.forEach((c) => ensureThumb(c));
    } catch (e) { toast('上传失败：' + e.message, 'error'); }
  }
  async function uploadToCell(id, file) {
    if (!/\.pdf$/i.test(file.name)) { toast('仅支持 PDF 文件', 'error'); return; }
    const tr = el.tbody.querySelector(`tr[data-id="${id}"]`); tr?.classList.add('uploading');
    try {
      const form = new FormData(); form.append('file', file);
      const updated = await api(`/api/literature/${id}/attachment`, { method: 'POST', body: form });
      const idx = items.findIndex((x) => x.id === id); if (idx >= 0) items[idx] = updated;
      render(); toast('上传成功，开始 AI 解析…');
      await parseIds([id]);
      ensureThumb(updated);
    } catch (e) { toast('上传失败：' + e.message, 'error'); render(); }
  }

  // ============ 解析 ============
  async function parseIds(ids, docType) {
    try {
      await api('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, docType: docType || undefined }) });
      await loadItems();
      const errs = items.filter((i) => ids.includes(i.id) && i.status === 'error');
      if (errs.length) toast(`解析完成，${errs.length} 篇失败`, 'error'); else toast('AI 解析完成，字段已自动写入', 'success');
    } catch (e) { toast('解析失败：' + e.message, 'error'); await loadItems(); }
  }

  // ============ 表格事件 ============
  function bindGrid() {
    el.tbody.addEventListener('click', (e) => {
      const star = e.target.closest('[data-star]');
      if (star) { setRating(star.closest('[data-rating]').dataset.rating, parseInt(star.dataset.star, 10)); return; }
      const pb = e.target.closest('[data-progress]'); if (pb) { cycleProgress(pb.dataset.progress); return; }
      const del = e.target.closest('[data-delattach]'); if (del) { e.preventDefault(); removeAttachment(del.dataset.delattach); return; }
      if (e.target.closest('[data-pdflink]')) return;
      const up = e.target.closest('[data-upload]'); if (up) { cellUploadId = up.dataset.upload; el.cellFileInput.value = ''; el.cellFileInput.click(); return; }
      const act = e.target.closest('[data-act]');
      if (act) {
        const id = act.closest('tr').dataset.id;
        if (act.dataset.act === 'open') openDrawer(id);
        else if (act.dataset.act === 'read') openPdfReader(id);
        else if (act.dataset.act === 'parse') { toast('开始重新解析…'); parseIds([id]); }
        else if (act.dataset.act === 'del') deleteItem(id);
        return;
      }
      const open = e.target.closest('[data-open]'); if (open) openDrawer(open.dataset.open);
    });
    el.tbody.addEventListener('dragover', (e) => { const c = e.target.closest('.cell-attach'); if (c) { e.preventDefault(); c.classList.add('dragover'); } });
    el.tbody.addEventListener('dragleave', (e) => { const c = e.target.closest('.cell-attach'); if (c) c.classList.remove('dragover'); });
    el.tbody.addEventListener('drop', (e) => {
      const cell = e.target.closest('.cell-attach'); if (!cell) return;
      e.preventDefault(); e.stopPropagation(); cell.classList.remove('dragover');
      const file = [...(e.dataTransfer?.files || [])].find((f) => /\.pdf$/i.test(f.name));
      if (file) uploadToCell(cell.dataset.upload, file);
    });
    el.cellFileInput.addEventListener('change', () => { const f = el.cellFileInput.files[0]; if (f && cellUploadId) uploadToCell(cellUploadId, f); el.cellFileInput.value = ''; });
  }

  async function setRating(id, n) {
    const it = items.find((x) => x.id === id);
    const next = it && it.rating === n ? 0 : n;
    const updated = await api('/api/literature/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: next }) });
    const idx = items.findIndex((x) => x.id === id); if (idx >= 0) items[idx] = updated; render();
  }
  async function cycleProgress(id) {
    const it = items.find((x) => x.id === id);
    const cur = it?.readingProgress || '未阅读';
    const next = PROGRESS_LIST[(PROGRESS_LIST.indexOf(cur) + 1) % PROGRESS_LIST.length];
    const updated = await api('/api/literature/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readingProgress: next }) });
    const idx = items.findIndex((x) => x.id === id); if (idx >= 0) items[idx] = updated; render();
  }
  async function removeAttachment(id) {
    if (!confirm('确认移除该附件？解析内容将一并清空。')) return;
    const updated = await api(`/api/literature/${id}/attachment`, { method: 'DELETE' });
    const idx = items.findIndex((x) => x.id === id); if (idx >= 0) items[idx] = updated; render(); toast('附件已移除', 'success');
  }
  async function deleteItem(id) {
    if (!confirm('确认删除该文献记录及其 PDF？')) return;
    await api('/api/literature/' + id, { method: 'DELETE' });
    if (currentId === id) closeDrawer();
    await loadItems(); await loadCollections(); toast('已删除', 'success');
  }

  // ============ 阅读抽屉 ============
  function openDrawer(id) { currentId = id; el.drawer.classList.remove('hidden'); el.drawerMask.classList.remove('hidden'); renderDrawer(); }
  function closeDrawer() { currentId = null; el.drawer.classList.add('hidden'); el.drawerMask.classList.add('hidden'); }
  function prevId() { const list = filteredItems(); const i = list.findIndex((x) => x.id === currentId); return i > 0 ? list[i - 1].id : null; }
  function nextId() { const list = filteredItems(); const i = list.findIndex((x) => x.id === currentId); return i >= 0 && i < list.length - 1 ? list[i + 1].id : null; }

  function renderDrawer() {
    const it = items.find((x) => x.id === currentId);
    if (!it) { closeDrawer(); return; }
    el.drawerFilename.textContent = it.originalName || '';
    $('btnPrev').disabled = !prevId();
    $('btnNext').disabled = !nextId();
    $('btnOpenPdf').disabled = !it.filename;
    $('btnRead').disabled = !it.filename;

    const sections = TYPE_ORDER[it.docType || lib.type]
      .filter((k) => !['title', 'authors', 'journal', 'year', 'doi', 'keywords'].includes(k));
    const chip = (l, v) => (v ? `<span class="meta-chip"><b>${l}：</b>${esc(v)}</span>` : '');
    const col = collections.find((c) => c.id === it.collectionId);

    el.drawerBody.innerHTML = `
      <h2 class="drawer-title">${esc(it.title || '（未命名文献）')}</h2>
      <div class="drawer-meta">
        ${chip('作者', it.authors)} ${chip('期刊/会议', it.journal)} ${chip('年份', it.year)} ${chip('DOI', it.doi)} ${chip('关键词', it.keywords)}
        ${col ? `<span class="meta-chip"><b>分类：</b>${esc(col.name)}</span>` : ''}
        <span class="badge badge-source">${it.docType === 'model' ? '模型类' : '实证类'}</span>
        <button class="progress-badge progress-${it.readingProgress || '未阅读'}" data-dprogress>◔ ${it.readingProgress || '未阅读'}</button>
        <span class="stars" data-drating>${[1, 2, 3, 4, 5].map((n) => `<button class="star ${n <= Math.round(it.rating || 0) ? 'on' : ''}" data-dstar="${n}">★</button>`).join('')}</span>
        ${it.status !== 'done' ? `<span class="badge badge-${it.status}" title="${esc(it.error || '')}">${STATUS_LABEL[it.status]}</span>` : ''}
      </div>
      ${it.error ? `<div class="modal-desc">⚠ 解析失败：${esc(it.error)}</div>` : ''}
      ${it.journalRankDetail && it.journalRankDetail.length ? `
        <section style="margin-bottom:18px"><h4 style="margin:0 0 8px;font-size:13px;color:var(--primary);display:flex;align-items:center;gap:6px"><span style="width:4px;height:14px;background:var(--primary);border-radius:2px"></span>期刊等级<span class="col-ai">easyScholar</span></h4>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${rankChips(it.journalRankDetail)}</div></section>` : ''}
      ${sections.map((k) => it[k] ? `
        <section style="margin-bottom:18px"><h4 style="margin:0 0 6px;font-size:13px;color:var(--primary);display:flex;align-items:center;gap:6px"><span style="width:4px;height:14px;background:var(--primary);border-radius:2px"></span>${CONTENT_COLS[k] ? (k === 'method' && it.docType === 'model' ? '求解方法' : CONTENT_COLS[k].label) : k}</h4>
        <div class="md">${mdFull(it[k])}</div></section>` : '').join('')}`;
  }

  // ============ 字段配置 ============
  function renderFieldsPop() {
    el.fieldsPop.innerHTML = TYPE_ORDER[lib.type].map((k) => `
      <label><input type="checkbox" data-col="${k}" ${visible.has(k) ? 'checked' : ''} /> ${esc(k === 'method' && lib.type === 'model' ? '求解方法' : CONTENT_COLS[k].label)}</label>`).join('');
    el.fieldsPop.classList.toggle('hidden');
    const rect = $('btnFields').getBoundingClientRect();
    el.fieldsPop.style.top = (rect.bottom + 6) + 'px';
    el.fieldsPop.style.left = rect.left + 'px';
  }

  // ============ 编辑 ============
  function openEdit() {
    const it = items.find((x) => x.id === currentId); if (!it) return;
    const fields = TYPE_ORDER[it.docType || lib.type].map((k) => [k, k === 'method' && it.docType === 'model' ? '求解方法' : CONTENT_COLS[k].label]);
    el.editBody.innerHTML = fields.map(([key, label]) => `
      <label class="field"><span>${label}</span><textarea data-key="${key}" rows="3">${esc(it[key] || '')}</textarea></label>`).join('');
    el.editModal.classList.remove('hidden');
  }
  async function saveEdit() {
    const patch = {};
    el.editBody.querySelectorAll('[data-key]').forEach((n) => { patch[n.dataset.key] = n.value; });
    const updated = await api('/api/literature/' + currentId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const idx = items.findIndex((x) => x.id === currentId); if (idx >= 0) items[idx] = updated;
    el.editModal.classList.add('hidden'); render(); renderDrawer(); toast('已保存', 'success');
  }

  // ============ 世图科研下载助手 ============
  let wlItems = [];            // 解析结果 [{ title, url, checked, done, imported }]
  const wlImportedKeys = new Set(); // 本会话已导入标记（doi 或 title 小写）

  // 解析「标题：xxx 链接地址：xxx」文本（标题与链接可跨行或同行，支持多条）
  function parseWorldlibText(text) {
    const out = [];
    const re = /标题\s*[：:]\s*([\s\S]*?)链接地址\s*[：:]\s*(https?:\/\/[^\s]+)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const title = m[1].trim();
      const url = m[2].trim().replace(/[),.;，。；]+$/, '');
      if (title && url) out.push({ title, url, checked: true, done: false, imported: false });
    }
    return out;
  }

  function renderWlList() {
    const box = $('wlList');
    $('btnWlDownloadAll').disabled = !wlItems.length;
    $('btnWlImport').disabled = !wlItems.length;
    if (!wlItems.length) {
      box.innerHTML = '<div class="wl-empty">尚未解析任何条目。把从世图科研复制的「标题 + 链接地址」文本粘贴到上方，点「解析列表」。</div>';
      return;
    }
    box.innerHTML = wlItems.map((it, i) => {
      const imported = it.imported || wlImportedKeys.has(it.title.toLowerCase());
      return `<div class="wl-item">
        <input type="checkbox" data-wlchk="${i}" ${it.checked ? 'checked' : ''} />
        <span class="wl-item-title" title="${esc(it.title)}">${esc(it.title)}</span>
        <span class="wl-item-url" title="${esc(it.url)}">${esc(it.url)}</span>
        <span class="wl-item-actions">
          ${it.done ? '<span class="wl-done">✓ 已下载</span>' : `<button class="tb-btn" data-wldl="${i}">⬇ 下载</button>`}
          ${imported ? '<span class="wl-imported">📥 已导入</span>' : ''}
        </span>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-wlchk]').forEach((c) => c.addEventListener('change', () => { wlItems[parseInt(c.dataset.wlchk, 10)].checked = c.checked; }));
    box.querySelectorAll('[data-wldl]').forEach((b) => b.addEventListener('click', () => {
      const it = wlItems[parseInt(b.dataset.wldl, 10)];
      wlDownloadOne(it);
      renderWlList();
    }));
  }

  // 下载单条：跳转系统浏览器（Electron 主进程会把 window.open 转交系统浏览器），
  // 由浏览器把 PDF 下载到默认下载文件夹
  function wlDownloadOne(it) {
    if (!it?.url) return;
    window.open(it.url, '_blank');
    it.done = true;
  }

  async function wlDownloadAll() {
    const list = wlItems.filter((x) => !x.done);
    if (!list.length) { toast('所有条目都已下载过', 'success'); return; }
    toast(`开始下载 ${list.length} 篇，请在浏览器默认下载文件夹查看`, 'success');
    for (const it of list) {
      wlDownloadOne(it);
      renderWlList();
      await new Promise((r) => setTimeout(r, 700)); // 间隔打开，避免浏览器卡顿
    }
  }

  async function wlImport() {
    const sel = wlItems.filter((x) => x.checked && !x.imported);
    if (!sel.length) { toast('请先勾选要导入的文献', 'error'); return; }
    try {
      const res = await api('/api/worldlib/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: sel.map((x) => ({ title: x.title, url: x.url })) }),
      });
      (res.records || []).forEach((r) => wlImportedKeys.add(String(r.doi || r.title).toLowerCase()));
      sel.forEach((x) => { x.imported = true; });
      renderWlList();
      await loadItems();
      toast(`已导入 ${res.imported} 篇到文献中心${res.skipped?.length ? `，跳过 ${res.skipped.length} 篇重复` : ''}。可在文献中心上传对应 PDF 附件`, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ============ 主题配色（一键换色 + 自定义色值） ============
  const DEFAULT_THEME = '#81308C';
  const THEME_PRESETS = [
    { name: '紫韵·默认', primary: '#81308C' },
    { name: '马卡龙粉', primary: '#e8709a' },
    { name: '莓果红', primary: '#c94f6d' },
    { name: '蜜桃橙', primary: '#e07b39' },
    { name: '琥珀金', primary: '#c98a12' },
    { name: '薄荷绿', primary: '#2fa376' },
    { name: '湖水青', primary: '#2a9db5' },
    { name: '天空蓝', primary: '#3f7fd6' },
    { name: '深邃蓝', primary: '#4a5fc1' },
    { name: '葡萄紫', primary: '#7a5cd6' },
    { name: '岩灰紫', primary: '#6d6a8f' },
    { name: '石墨灰', primary: '#5b6470' },
  ];

  function hexToHsl(hex) {
    const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0; const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: s * 100, l: l * 100 };
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
    return '#' + to(f(0)) + to(f(8)) + to(f(4));
  }

  // 由主色推导整套协调的界面色（背景、边框、浅底都带同一色相）
  function deriveTheme(primary) {
    const c = hexToHsl(primary);
    if (!c) return null;
    const cl = (v) => Math.max(0, Math.min(100, v));
    return {
      '--primary': primary,
      '--primary-hover': hslToHex(c.h, cl(c.s + 4), cl(c.l * 0.82)),
      '--primary-light': hslToHex(c.h, cl(c.s - 6), cl(c.l * 1.18 + 6)),
      '--primary-soft': hslToHex(c.h, cl(c.s * 0.55), 96),
      '--bg': hslToHex(c.h, cl(c.s * 0.28), 97.6),
      '--head-bg': hslToHex(c.h, cl(c.s * 0.22), 98.6),
      '--border': hslToHex(c.h, cl(c.s * 0.30), 91),
      '--gray-soft': hslToHex(c.h, cl(c.s * 0.16), 94.5),
    };
  }

  function applyTheme(primary, persist) {
    const vars = deriveTheme(primary);
    if (!vars) { toast('色值格式不正确，请输入如 #81308C 的色号', 'error'); return; }
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    $('themeColorPicker').value = primary;
    $('themeColorInput').value = primary;
    document.querySelectorAll('.theme-swatch').forEach((s) => s.classList.toggle('active', s.dataset.color === primary.toLowerCase()));
    if (persist) {
      api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ themeColor: primary }) })
        .then((s) => { settings = s; })
        .catch(() => {});
    }
  }

  function renderThemePresets() {
    const box = $('themePresets');
    box.innerHTML = THEME_PRESETS.map((t) => `
      <div class="theme-swatch" data-color="${t.primary}" title="${esc(t.name)}（${t.primary}）">
        <span class="theme-dot" style="background:${t.primary}"></span>
        <span>${esc(t.name)}</span>
      </div>`).join('');
    box.querySelectorAll('.theme-swatch').forEach((s) => s.addEventListener('click', () => applyTheme(s.dataset.color, true)));
  }

  // ============ 设置 ============
  function fillSettingsForm() {
    $('setProvider').value = settings.aiProvider || 'siliconflow';
    $('setBaseURL').value = settings.baseURL || '';
    $('setApiKey').value = settings.apiKey || '';
    $('setModel').value = settings.model || '';
    $('setLanguage').value = settings.language || 'zh';
    $('setEasyKey').value = settings.easyScholarKey || '';
    $('setTranslateProvider').value = settings.translateProvider || 'siliconflow';
    $('setDeeplKey').value = settings.deeplKey || '';
    $('setDataDir').value = settings.dataDir || '';
  }
  async function saveSettingsFromForm() {
    const next = {
      aiProvider: $('setProvider').value,
      baseURL: $('setBaseURL').value.trim(),
      apiKey: $('setApiKey').value.trim(),
      model: $('setModel').value.trim(),
      language: $('setLanguage').value,
      easyScholarKey: $('setEasyKey').value.trim(),
      translateProvider: $('setTranslateProvider').value,
      deeplKey: $('setDeeplKey').value.trim(),
      dataDir: $('setDataDir').value.trim(),
    };
    try {
      settings = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      el.settingsModal.classList.add('hidden');
      toast('设置已保存' + (settings.dataDir ? '，数据目录已切换' : ''), 'success');
      await loadItems(); await loadCollections();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    document.querySelectorAll('.view-tabs .tab').forEach((t) => t.addEventListener('click', () => {
      document.querySelectorAll('.view-tabs .tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active'); tab = t.dataset.tab; render();
    }));

    $('btnAddRecord').addEventListener('click', async () => {
      const body = { docType: lib.type };
      if (lib.collectionId) body.collectionId = lib.collectionId;
      await api('/api/literature', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      await loadItems(); await loadCollections(); toast('已添加空白记录，可拖入 PDF 或直接编辑', 'success');
    });

    $('btnFields').addEventListener('click', (e) => { e.stopPropagation(); renderFieldsPop(); });
    el.fieldsPop.addEventListener('change', (e) => {
      const key = e.target.dataset.col; if (!key) return;
      if (e.target.checked) visible.add(key); else visible.delete(key); render();
    });
    document.addEventListener('click', (e) => {
      if (!el.fieldsPop.classList.contains('hidden') && !el.fieldsPop.contains(e.target) && e.target !== $('btnFields')) el.fieldsPop.classList.add('hidden');
    });

    el.searchInput.addEventListener('input', render);
    el.statusFilter.addEventListener('change', render);
    el.sortField.addEventListener('change', render);
    $('btnSortOrder').addEventListener('click', () => {
      sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
      $('btnSortOrder').textContent = sortOrder === 'asc' ? '↑ 升序' : '↓ 降序'; render();
    });
    document.querySelectorAll('.rh-btn').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.rh-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); rowHeight = b.dataset.rh; el.gridWrap.className = 'grid-wrap rh-' + rowHeight;
    }));

    $('btnParseAll').addEventListener('click', () => {
      const pending = filteredItems().filter((i) => i.status !== 'done');
      if (!pending.length) { toast('没有待解析的文献', 'error'); return; }
      toast(`开始解析 ${pending.length} 篇…`); parseIds(pending.map((i) => i.id));
    });
    $('btnExport').addEventListener('click', () => window.open('/api/export?format=csv', '_blank'));

    // 列宽拖拽调节
    let resizing = null;
    el.theadRow.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('[data-resize]');
      if (!handle) return;
      e.preventDefault();
      const th = handle.closest('th');
      resizing = { key: handle.dataset.resize, startX: e.clientX, startW: th.getBoundingClientRect().width, th, handle };
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const w = Math.max(60, resizing.startW + (e.clientX - resizing.startX));
      colWidths[resizing.key] = Math.round(w);
      resizing.th.style.minWidth = w + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing.handle.classList.remove('active');
      document.body.style.cursor = '';
      resizing = null;
    });

    $('btnDrawerClose').addEventListener('click', closeDrawer);
    el.drawerMask.addEventListener('click', closeDrawer);
    $('btnPrev').addEventListener('click', () => { const id = prevId(); if (id) { currentId = id; renderDrawer(); } });
    $('btnNext').addEventListener('click', () => { const id = nextId(); if (id) { currentId = id; renderDrawer(); } });
    $('btnReparse').addEventListener('click', () => { toast('开始重新解析…'); parseIds([currentId]); });
    $('btnEdit').addEventListener('click', openEdit);
    $('btnRead').addEventListener('click', () => openPdfReader(currentId));
    $('btnOpenPdf').addEventListener('click', () => {
      const it = items.find((x) => x.id === currentId);
      if (it?.filename) window.open('/uploads/' + encodeURIComponent(it.filename), '_blank');
    });
    el.drawerBody.addEventListener('click', (e) => {
      const ds = e.target.closest('[data-dstar]'); if (ds) { setRating(currentId, parseInt(ds.dataset.dstar, 10)); renderDrawer(); return; }
      if (e.target.closest('[data-dprogress]')) cycleProgress(currentId).then(renderDrawer);
    });

    $('btnSettingsClose').addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    $('btnSettingsCancel').addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    $('btnSettingsSave').addEventListener('click', saveSettingsFromForm);

    // 审稿意见一键翻译
    $('btnTranslateReview').addEventListener('click', translateReview);
    $('btnReviewTransToggle').addEventListener('click', () => {
      const wrap = $('reviewTransWrap');
      const expanded = wrap.classList.toggle('expanded');
      $('btnReviewTransToggle').textContent = expanded ? '收起' : '展开全文';
    });

    // 世图科研下载助手
    $('btnWlParse').addEventListener('click', () => {
      const text = $('wlInput').value.trim();
      if (!text) { toast('请先粘贴「标题 + 链接地址」文本', 'error'); return; }
      const parsed = parseWorldlibText(text);
      if (!parsed.length) { toast('未解析到有效条目，请检查格式（标题：… / 链接地址：…）', 'error'); return; }
      // 与已有列表合并去重（按 url）
      const exist = new Set(wlItems.map((x) => x.url));
      let added = 0;
      for (const it of parsed) {
        if (exist.has(it.url)) continue;
        if (wlImportedKeys.has(it.title.toLowerCase())) it.imported = true;
        wlItems.push(it); added++;
      }
      renderWlList();
      toast(`解析完成，新增 ${added} 条${parsed.length - added ? `（重复跳过 ${parsed.length - added} 条）` : ''}`, 'success');
    });
    $('btnWlClear').addEventListener('click', () => { $('wlInput').value = ''; wlItems = []; renderWlList(); });
    $('btnWlDownloadAll').addEventListener('click', wlDownloadAll);
    $('btnWlImport').addEventListener('click', wlImport);

    // 主题配色
    $('themeColorPicker').addEventListener('input', () => {
      $('themeColorInput').value = $('themeColorPicker').value;
    });
    const applyThemeFromInput = () => applyTheme($('themeColorInput').value.trim(), true);
    $('btnThemeApply').addEventListener('click', applyThemeFromInput);
    $('themeColorInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyThemeFromInput(); });
    $('btnThemeReset').addEventListener('click', () => applyTheme(DEFAULT_THEME, true));
    $('setProvider').addEventListener('change', () => {
      if ($('setProvider').value === 'siliconflow') {
        if (!$('setBaseURL').value.trim() || /api\.openai\.com/.test($('setBaseURL').value)) $('setBaseURL').value = 'https://api.siliconflow.cn/v1';
        if (!$('setModel').value.trim()) $('setModel').value = 'deepseek-ai/DeepSeek-V4-Flash';
      }
    });

    // 分类弹窗
    $('btnColClose').addEventListener('click', () => el.colModal.classList.add('hidden'));
    $('btnColCancel').addEventListener('click', () => el.colModal.classList.add('hidden'));
    $('btnColSave').addEventListener('click', saveColModal);
    $('colModalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveColModal(); });

    $('btnEditClose').addEventListener('click', () => el.editModal.classList.add('hidden'));
    $('btnEditCancel').addEventListener('click', () => el.editModal.classList.add('hidden'));
    $('btnEditSave').addEventListener('click', saveEdit);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!el.editModal.classList.contains('hidden')) el.editModal.classList.add('hidden');
        else if (!el.colModal.classList.contains('hidden')) el.colModal.classList.add('hidden');
        else if (!el.settingsModal.classList.contains('hidden')) el.settingsModal.classList.add('hidden');
        else if (!$('profileModal').classList.contains('hidden')) $('profileModal').classList.add('hidden');
        else if (!$('projModal').classList.contains('hidden')) $('projModal').classList.add('hidden');
        else if (!$('noteModal').classList.contains('hidden')) $('noteModal').classList.add('hidden');
        else if (!$('paperModal').classList.contains('hidden')) $('paperModal').classList.add('hidden');
        else if (!$('thesisModal').classList.contains('hidden')) $('thesisModal').classList.add('hidden');
        else if (!el.drawer.classList.contains('hidden')) closeDrawer();
      }
    });
  }

  // ==================== PDF 阅读器（连续页面 + 右侧翻译面板） ====================
  const pr = {
    open: false, doc: null, scale: 1.4, pageNum: 1, totalPages: 1,
    recordId: null, highlightColor: 'yellow', currentSelection: null,
    pageSizes: [],   // [{w,h}] 每页 scale=1 尺寸
    rendered: new Set(), // 已渲染页码
    observer: null,
  };

  function openPdfReader(id) {
    const it = items.find((x) => x.id === id);
    if (!it?.filename) { toast('该文献还没有 PDF 附件', 'error'); return; }
    pr.recordId = id;
    pr.open = true;
    $('pdfReader').classList.remove('hidden');
    $('prFilename').textContent = it.originalName || '';
    $('prTransResult').innerHTML = '<div class="pr-trans-placeholder">翻译结果将显示在这里。<br />在左侧 PDF 中选中文字后会自动翻译。</div>';
    $('prSourceText').value = '';
    loadPdfDocument('/uploads/' + encodeURIComponent(it.filename));
  }

  function closePdfReader() {
    pr.open = false;
    pr.doc = null;
    pr.rendered.clear();
    if (pr.observer) { pr.observer.disconnect(); pr.observer = null; }
    $('pdfReader').classList.add('hidden');
    $('prPages').innerHTML = '';
  }

  async function loadPdfDocument(url) {
    try {
      const lib2 = await loadPdfJs();
      const doc = await lib2.getDocument({ url }).promise;
      pr.doc = doc;
      pr.totalPages = doc.numPages;
      pr.pageNum = 1;
      pr.rendered.clear();
      $('prPageTotal').textContent = doc.numPages;
      $('prPageInput').max = doc.numPages;
      $('prPageInput').value = 1;
      // 预取每页尺寸，建立占位
      pr.pageSizes = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        const v = p.getViewport({ scale: 1 });
        pr.pageSizes.push({ w: v.width, h: v.height });
      }
      buildPlaceholders();
      renderNotesList();
    } catch (e) { toast('PDF 加载失败：' + e.message, 'error'); }
  }

  function buildPlaceholders() {
    const container = $('prPages');
    container.innerHTML = '';
    if (pr.observer) pr.observer.disconnect();
    for (let i = 1; i <= pr.totalPages; i++) {
      const size = pr.pageSizes[i - 1];
      const wrap = document.createElement('div');
      wrap.className = 'pr-page-wrap';
      wrap.dataset.page = i;
      wrap.style.width = (size.w * pr.scale) + 'px';
      wrap.style.height = (size.h * pr.scale) + 'px';
      const ph = document.createElement('div');
      ph.className = 'pr-placeholder';
      ph.textContent = i;
      wrap.appendChild(ph);
      container.appendChild(wrap);
    }
    // 懒渲染：进入视口附近时渲染真实页面
    pr.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          const pageNum = parseInt(en.target.dataset.page, 10);
          if (!pr.rendered.has(pageNum)) renderPageInto(en.target, pageNum);
        }
      }
    }, { root: $('prPages'), rootMargin: '600px 0px' });
    container.querySelectorAll('.pr-page-wrap').forEach((w) => pr.observer.observe(w));
    // 当前页码高亮跟踪
    container.addEventListener('scroll', updateCurrentPage, { passive: true });
  }

  function updateCurrentPage() {
    const container = $('prPages');
    const mid = container.scrollTop + container.clientHeight / 3;
    let cur = 1;
    container.querySelectorAll('.pr-page-wrap').forEach((w) => {
      if (w.offsetTop <= mid) cur = parseInt(w.dataset.page, 10);
    });
    if (cur !== pr.pageNum) {
      pr.pageNum = cur;
      $('prPageInput').value = cur;
    }
  }

  async function renderPageInto(wrap, pageNum) {
    if (!pr.doc || pr.rendered.has(pageNum)) return;
    pr.rendered.add(pageNum);
    try {
      const page = await pr.doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: pr.scale });
      const dpr = window.devicePixelRatio || 1;

      wrap.innerHTML = '';
      wrap.style.width = viewport.width + 'px';
      wrap.style.height = viewport.height + 'px';

      // 高清画布（按 devicePixelRatio 渲染）
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = viewport.width + 'px';
      canvas.style.height = viewport.height + 'px';
      const ctx = canvas.getContext('2d');
      await page.render({
        canvasContext: ctx, viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
      }).promise;
      wrap.appendChild(canvas);

      // 文本层（划词）
      const textLayer = document.createElement('div');
      textLayer.className = 'pr-text-layer';
      await buildTextLayer(page, viewport, textLayer);
      wrap.appendChild(textLayer);

      // 高亮/笔记层
      const hlLayer = document.createElement('div');
      hlLayer.className = 'pr-highlight-layer';
      hlLayer.style.width = viewport.width + 'px';
      hlLayer.style.height = viewport.height + 'px';
      renderAnnotations(hlLayer, pageNum, pr.scale);
      wrap.appendChild(hlLayer);
    } catch (e) {
      pr.rendered.delete(pageNum);
    }
  }

  async function buildTextLayer(page, viewport, layerDiv) {
    const content = await page.getTextContent();
    const scale = viewport.scale;
    // 用离屏 canvas 量测每个文本片段在 sans-serif 下的实际渲染宽度，
    // 再用 scaleX 拉伸到 PDF 原始宽度，让选区矩形与画布字形对齐
    const measure = document.createElement('canvas').getContext('2d');
    for (const item of content.items) {
      if (!item.str) continue;
      const tx = item.transform;
      const fontHeight = Math.hypot(tx[2], tx[3]);
      const angle = Math.atan2(tx[1], tx[0]);
      const div = document.createElement('span');
      div.textContent = item.str;
      div.style.left = (tx[4] * scale) + 'px';
      div.style.top = (viewport.height - tx[5] * scale - fontHeight * scale) + 'px';
      div.style.fontSize = (fontHeight * scale) + 'px';
      div.style.fontFamily = 'sans-serif';
      const transforms = [];
      if (Math.abs(angle) > 0.001) transforms.push(`rotate(${angle}rad)`);
      const targetWidth = (item.width || 0) * scale;
      if (targetWidth > 0) {
        measure.font = `${fontHeight * scale}px sans-serif`;
        const measured = measure.measureText(item.str).width;
        if (measured > 0) transforms.push(`scaleX(${(targetWidth / measured).toFixed(4)})`);
      }
      if (transforms.length) div.style.transform = transforms.join(' ');
      layerDiv.appendChild(div);
    }
  }

  function rebuildAllPages() {
    if (!pr.doc) return;
    pr.rendered.clear();
    buildPlaceholders();
  }

  function renderAnnotations(layer, pageNum, scale) {
    const it = items.find((x) => x.id === pr.recordId);
    const anns = (it?.annotations || []).filter((a) => a.page === pageNum);
    for (const a of anns) {
      const [x1, y1, x2, y2] = a.rect;
      if (a.type === 'highlight') {
        const div = document.createElement('div');
        div.style.position = 'absolute';
        div.style.left = (x1 * scale) + 'px';
        div.style.top = (y1 * scale) + 'px';
        div.style.width = ((x2 - x1) * scale) + 'px';
        div.style.height = ((y2 - y1) * scale) + 'px';
        div.style.background = HIGHLIGHT_COLORS[a.color] || '#ffe08a';
        div.style.opacity = '0.45';
        layer.appendChild(div);
      } else if (a.type === 'note') {
        const m = document.createElement('div');
        m.className = 'pr-note-marker';
        m.style.left = (x1 * scale) + 'px';
        m.style.top = (y1 * scale) + 'px';
        m.style.background = '#e8a213';
        m.title = a.note || '';
        m.addEventListener('click', (e) => { e.stopPropagation(); showNotePopover(a, e.clientX, e.clientY); });
        layer.appendChild(m);
      }
    }
  }

  function renderNotesList() {
    const it = items.find((x) => x.id === pr.recordId);
    const anns = it?.annotations || [];
    $('prNotesCount').textContent = anns.length || 0;
    const list = $('prNotesList');
    if (!anns.length) { list.innerHTML = '<div class="pr-loading">暂无笔记或高亮</div>'; return; }
    list.innerHTML = anns.map((a, i) => `
      <div class="pr-note-item">
        <button class="pr-note-del" data-annidx="${i}" title="删除">✕</button>
        ${a.type === 'highlight' ? '<span class="badge badge-source">高亮</span>' : '<span class="badge badge-done">笔记</span>'}
        <div class="pr-note-quote">${esc((a.text || '').slice(0, 100))}</div>
        ${a.note ? `<div class="pr-note-text">${esc(a.note)}</div>` : ''}
        <div class="pr-note-meta">第 ${a.page} 页 · <a href="#" data-goto="${a.page}" style="color:var(--primary)">跳转</a></div>
      </div>`).join('');
    list.querySelectorAll('[data-goto]').forEach((l) => l.addEventListener('click', (e) => {
      e.preventDefault();
      const target = $('prPages').querySelector(`.pr-page-wrap[data-page="${l.dataset.goto}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    list.querySelectorAll('[data-annidx]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(b.dataset.annidx, 10);
      const it2 = items.find((x) => x.id === pr.recordId);
      const anns2 = [...(it2?.annotations || [])];
      anns2.splice(idx, 1);
      await saveAnnotations(anns2);
      rerenderVisiblePage(pr.pageNum);
      renderNotesList();
    }));
  }

  function rerenderVisiblePage(pageNum) {
    const wrap = $('prPages').querySelector(`.pr-page-wrap[data-page="${pageNum}"]`);
    if (wrap && pr.rendered.has(pageNum)) {
      pr.rendered.delete(pageNum);
      renderPageInto(wrap, pageNum);
    }
  }

  async function saveAnnotations(anns) {
    const updated = await api('/api/literature/' + pr.recordId, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ annotations: anns }),
    });
    const idx = items.findIndex((x) => x.id === pr.recordId);
    if (idx >= 0) items[idx] = updated;
  }

  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return null;
    const text = sel.toString().trim();
    const wrap = findPageWrap(sel.anchorNode);
    if (!wrap) return null;
    const pageNum = parseInt(wrap.dataset.page, 10);
    const rects = [...sel.getRangeAt(0).getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return null;
    const wrapRect = wrap.getBoundingClientRect();
    const scale = pr.scale;
    const normRects = rects.map((r) => ({
      x1: (r.left - wrapRect.left) / scale, y1: (r.top - wrapRect.top) / scale,
      x2: (r.right - wrapRect.left) / scale, y2: (r.bottom - wrapRect.top) / scale,
    }));
    return { text, pageNum, rects: normRects, clientRects: rects };
  }

  function findPageWrap(node) {
    let n = node;
    while (n) {
      if (n.nodeType === 1 && n.classList && n.classList.contains('pr-page-wrap')) return n;
      n = n.parentElement;
    }
    return null;
  }

  function showSelectionToolbar(clientRects) {
    const tb = $('prSelectionToolbar');
    const last = clientRects[clientRects.length - 1];
    tb.style.left = (last.left + last.width / 2 - 50) + 'px';
    tb.style.top = (last.bottom + 8) + 'px';
    tb.classList.remove('hidden');
  }
  function hideSelectionToolbar() { $('prSelectionToolbar').classList.add('hidden'); }

  // 划词 → 自动填充右侧翻译面板并立即翻译（无需点击「译」）
  let translateAbort = null;
  function translateSelection(text) {
    $('prSourceText').value = text;
    doPanelTranslate();
  }

  async function doPanelTranslate() {
    const text = $('prSourceText').value.trim();
    const box = $('prTransResult');
    if (!text) { toast('请先选中或输入要翻译的文本', 'error'); return; }
    // 新翻译开始前取消上一次未完成的请求，避免旧结果覆盖新结果
    if (translateAbort) translateAbort.abort();
    translateAbort = new AbortController();
    const { signal } = translateAbort;
    const target = $('prLangTo').value;
    box.innerHTML = '<div class="pr-loading">翻译中…</div>';
    try {
      const data = await api('/api/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, target }), signal,
      });
      if (signal.aborted) return;
      box.innerHTML = `<div class="pr-trans-text">${esc(data.translation)}</div>`;
    } catch (e) {
      if (isAbortError(e)) return;
      box.innerHTML = `<div class="pr-trans-error">⚠ ${esc(e.message)}</div>`;
    }
  }

  function doHighlight() {
    const sel = pr.currentSelection;
    if (!sel) return;
    const x1 = Math.min(...sel.rects.map((r) => r.x1)), y1 = Math.min(...sel.rects.map((r) => r.y1));
    const x2 = Math.max(...sel.rects.map((r) => r.x2)), y2 = Math.max(...sel.rects.map((r) => r.y2));
    addAnnotation({ id: 'a' + Date.now(), page: sel.pageNum, type: 'highlight', color: pr.highlightColor, rect: [x1, y1, x2, y2], text: sel.text, note: '', createdAt: new Date().toISOString() });
  }

  function doNote() {
    const sel = pr.currentSelection;
    if (!sel) return;
    const pop = $('prPopover');
    showPopover(pop, '添加笔记', `<div class="pr-note-quote" style="margin-bottom:8px">${esc(sel.text.slice(0, 150))}</div><textarea id="prNoteText" placeholder="输入你的笔记…"></textarea>`, [
      { text: '保存', cls: 'btn-primary', onClick: () => {
        const note = $('prNoteText').value.trim();
        if (!note) { toast('笔记内容为空', 'error'); return; }
        const x1 = Math.min(...sel.rects.map((r) => r.x1)), y1 = Math.min(...sel.rects.map((r) => r.y1));
        const x2 = Math.max(...sel.rects.map((r) => r.x2)), y2 = Math.max(...sel.rects.map((r) => r.y2));
        addAnnotation({ id: 'a' + Date.now(), page: sel.pageNum, type: 'note', color: '', rect: [x1, y1, x2, y2], text: sel.text, note, createdAt: new Date().toISOString() });
      } },
    ]);
  }

  async function addAnnotation(ann) {
    const it = items.find((x) => x.id === pr.recordId);
    const anns = [...(it?.annotations || []), ann];
    await saveAnnotations(anns);
    hideSelectionToolbar();
    hidePopover();
    rerenderVisiblePage(ann.page);
    renderNotesList();
    toast('已保存', 'success');
  }

  function showNotePopover(a, x, y) {
    showPopover($('prPopover'), '笔记', `<div class="pr-note-quote">${esc(a.text || '')}</div><div class="pr-note-text">${esc(a.note || '')}</div>`, [], { left: x, top: y });
  }

  function showPopover(pop, title, bodyHtml, buttons = [], pos = {}) {
    pop.innerHTML = `
      <div class="pr-popover-head"><span>${esc(title)}</span><button class="modal-close" data-popclose>✕</button></div>
      <div class="pr-popover-body">${bodyHtml}</div>
      ${buttons.length ? `<div class="pr-popover-foot">${buttons.map((b) => `<button class="btn ${b.cls || ''}" data-popbtn="${b.text}">${esc(b.text)}</button>`).join('')}</div>` : ''}`;
    const tb = $('prSelectionToolbar');
    const tbRect = tb.classList.contains('hidden') ? { left: 300, bottom: 300 } : tb.getBoundingClientRect();
    pop.style.left = (pos.left != null ? pos.left : Math.max(10, tbRect.left)) + 'px';
    pop.style.top = (pos.top != null ? pos.top : Math.min(window.innerHeight - 250, tbRect.bottom + 8)) + 'px';
    pop.classList.remove('hidden');
    pop.querySelector('[data-popclose]')?.addEventListener('click', hidePopover);
    pop.querySelectorAll('[data-popbtn]').forEach((btn) => btn.addEventListener('click', () => {
      const b = buttons.find((x) => x.text === btn.dataset.popbtn);
      hidePopover(); b?.onClick?.();
    }));
  }
  function hidePopover() { $('prPopover').classList.add('hidden'); }

  function fitWidth() {
    if (!pr.doc) return;
    const container = document.querySelector('.pr-main');
    const avail = container.clientWidth - 64;
    const size = pr.pageSizes[0];
    if (size) {
      pr.scale = Math.max(0.5, Math.min(4, avail / size.w));
      $('prZoomLabel').textContent = Math.round(pr.scale * 100) + '%';
      rebuildAllPages();
    }
  }

  function bindPdfReader() {
    $('prClose').addEventListener('click', closePdfReader);
    $('prPageInput').addEventListener('change', () => {
      const n = parseInt($('prPageInput').value, 10);
      if (n >= 1 && n <= pr.totalPages) {
        const target = $('prPages').querySelector(`.pr-page-wrap[data-page="${n}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    $('prZoomOut').addEventListener('click', () => { pr.scale = Math.max(0.5, pr.scale - 0.2); $('prZoomLabel').textContent = Math.round(pr.scale * 100) + '%'; rebuildAllPages(); });
    $('prZoomIn').addEventListener('click', () => { pr.scale = Math.min(4, pr.scale + 0.2); $('prZoomLabel').textContent = Math.round(pr.scale * 100) + '%'; rebuildAllPages(); });
    $('prFitWidth').addEventListener('click', fitWidth);

    document.querySelectorAll('.pr-color').forEach((c) => c.addEventListener('click', () => {
      document.querySelectorAll('.pr-color').forEach((x) => x.classList.remove('active'));
      c.classList.add('active'); pr.highlightColor = c.dataset.color;
    }));

    // 划词 → 工具条 + 自动翻译
    document.addEventListener('mouseup', () => {
      if (!pr.open) return;
      setTimeout(() => {
        const sel = captureSelection();
        if (sel) {
          pr.currentSelection = sel;
          showSelectionToolbar(sel.clientRects);
          translateSelection(sel.text); // 选中后自动在右侧显示翻译，无需点击「译」
        } else {
          hideSelectionToolbar();
        }
      }, 10);
    });

    $('prSelectionToolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sel]');
      if (!btn) return;
      const sel = pr.currentSelection;
      if (!sel) return;
      if (btn.dataset.sel === 'translate') translateSelection(sel.text);
      else if (btn.dataset.sel === 'highlight') doHighlight();
      else if (btn.dataset.sel === 'note') doNote();
    });

    // 右侧翻译面板
    $('prDoTranslate').addEventListener('click', doPanelTranslate);
    $('prSourceText').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doPanelTranslate();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pr.open) { hidePopover(); hideSelectionToolbar(); }
    });
  }

  // ==================== 工作台（路由 + 工作管理 + AI 助手） ====================
  const QUICK_PROMPTS = {
    innovation: '请结合我的文献知识库与进行中的项目，帮我构思论文的创新点。给出 3-5 个候选创新点，说明每个的可行性、与现有文献的差异、以及可验证的方式。',
    submission: '请结合我的小论文投稿状态（各篇处于哪个阶段、停留时长、返修截止时间、期刊等级），给出投稿与转投策略：哪些需要催稿、哪些准备转投、备选期刊如何排序，并提醒我注意返修 30 天时限。',
    thesis: '请结合我的大论文（学位论文）当前阶段、章节完成情况与里程碑节点，诊断进度风险：指出滞后环节、接下来两周应重点推进的章节，并给出与开题/中期/答辩时间线的匹配建议。',
    weekly: '请根据我的项目进度、近期完成的任务与研究记录、阅读的文献、小论文投稿动态，生成一份本周科研周报，包含：本周进展、遇到的问题、下周计划。',
    gap: '请基于我的文献知识库，分析当前研究领域可能存在的研究空白（research gap）与值得跟进的后续方向，并指出支撑该判断的文献编号。',
    review: '请基于我的文献知识库，为我的论文搭建一个文献综述框架：按主题分组，每组给出代表文献（引用编号）与各主题间的关系，最后指出综述的落脚点。',
    plan: '请结合我的项目进度与未完成任务，帮我制定未来两周的科研计划：按天拆解，标注优先级与预估耗时。',
  };

  function todayStr(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const t = new Date(dateStr + 'T23:59:59') - new Date();
    return Math.ceil(t / 86400000);
  }
  function clipTitle(s, n = 30) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  async function switchView(v) {
    view = v;
    document.querySelectorAll('.nav-item[data-view]').forEach((n) => n.classList.toggle('active', n.dataset.view === v));
    const map = { home: 'viewHome', library: 'viewLibrary', projects: 'viewProjects', tasks: 'viewTasks', papers: 'viewPapers', notes: 'viewNotes', ai: 'viewAI', worldlib: 'viewWorldlib' };
    for (const [key, id] of Object.entries(map)) $(id).classList.toggle('hidden', key !== v);
    const isLib = v === 'library';
    $('searchInput').classList.toggle('hidden', !isLib);
    $('btnParseAll').classList.toggle('hidden', !isLib);
    $('btnExport').classList.toggle('hidden', !isLib);
    if (v === 'home') renderHome();
    if (v === 'projects') renderProjects();
    if (v === 'tasks') renderTasks();
    if (v === 'papers') { renderPaperTab(); }
    if (v === 'worldlib') renderWlList();
    if (v === 'notes') renderNotes();
    if (v === 'ai') {
      renderChatMeta();
      if (!convLoaded) {
        await loadConversations();
        if (!activeConvId && conversations.length) await openConversation(conversations[0].id);
      }
    }
  }

  // ---------- 首页 Dashboard ----------
  function greetWord() {
    const h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 12) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  function renderHome() {
    // 问候横幅（个人资料同步）
    const sub = [profile.school, profile.field, profile.grade].filter(Boolean).join(' · ');
    $('homeAvatar').textContent = profile.avatar || '🎓';
    $('profileAvatar').textContent = profile.avatar || '🎓';
    $('homeGreet').textContent = `${greetWord()}，${profile.name || '研究生'}`;
    $('profileName').textContent = profile.name || '研究生';
    $('homeSub').textContent = sub || '完善个人资料后显示学校 / 专业 / 年级';
    $('profileSub').textContent = sub || '完善个人资料';
    const pct = Math.round(profile.progress || 0);
    $('homeProgressLabel').textContent = pct + '%';
    $('homeProgressBar').style.width = pct + '%';

    // 横幅统计
    const t0 = todayStr();
    const journalPapers = papers.filter((p) => p.kind === 'journal');
    $('hbLit').textContent = items.length;
    $('hbJournal').textContent = journalPapers.length;
    $('hbUnderway').textContent = journalPapers.filter((p) => ['投稿中', '初审', '外审', '返修', '复审', '校样'].includes(p.status)).length;
    $('hbToday').textContent = tasks.filter((t) => t.status !== 'done' && t.due && t.due <= t0).length;

    // 今日工作计划（今天到期 + 未截止的前 5 条）
    const todayTasks = tasks.filter((t) => t.status !== 'done' && t.due && t.due <= t0)
      .concat(tasks.filter((t) => t.status !== 'done' && !t.due).slice(0, 5));
    $('todayDate').textContent = t0;
    $('todayList').innerHTML = todayTasks.length ? todayTasks.map((t) => `
      <div class="check-item">
        <input type="checkbox" data-todaydone="${t.id}" />
        <span class="check-title" title="${esc(t.title)}">${esc(t.title)}</span>
        ${t.due ? `<span class="check-due${t.due < t0 ? ' over' : ''}">${t.due < t0 ? '逾期 ' : ''}${t.due.slice(5)}</span>` : ''}
        <button class="check-del" data-todaydel="${t.id}" title="删除">✕</button>
      </div>`).join('')
      : '<div class="pr-loading">今天没有安排，去「任务安排」添加一个吧 ☕</div>';

    // 科研动态（自动时间线）
    const feed = [];
    for (const it of items) {
      if (it.createdAt) feed.push({ ts: it.createdAt, ico: '📄', text: `上传文献「${clipTitle(it.title || it.originalName || '未命名', 22)}」` });
      if (it.parsedAt) feed.push({ ts: it.parsedAt, ico: '🤖', text: `AI 解析完成「${clipTitle(it.title || it.originalName || '未命名', 22)}」` });
    }
    for (const p of projects) if (p.createdAt) feed.push({ ts: p.createdAt, ico: '📂', text: `创建项目「${clipTitle(p.name, 22)}」` });
    for (const p of journalPapers) {
      if (p.createdAt) feed.push({ ts: p.createdAt, ico: '📮', text: `添加小论文「${clipTitle(p.title, 22)}」→ ${p.status}` });
      for (const h of (p.history || []).slice(1)) {
        if (h.date) feed.push({ ts: `${h.date}T09:00:00`, ico: '📮', text: `《${clipTitle(p.title, 18)}》状态更新：${h.status}` });
      }
    }
    for (const t of tasks) if (t.completedAt) feed.push({ ts: t.completedAt, ico: '✅', text: `完成任务「${clipTitle(t.title, 22)}」` });
    for (const n of notes) if (n.createdAt) feed.push({ ts: n.createdAt, ico: '🧪', text: `新建研究记录「${clipTitle(n.title, 22)}」${n.studyNo ? '（' + n.studyNo + '）' : ''}` });
    feed.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    $('feedList').innerHTML = feed.length
      ? feed.slice(0, 12).map((f) => `<div class="feed-item"><span class="feed-ico">${f.ico}</span><span class="feed-text" title="${esc(f.text)}">${esc(f.text)}</span><span class="feed-time">${fmtTime(f.ts)}</span></div>`).join('')
      : '<div class="pr-loading">暂无动态，去上传文献或创建项目吧</div>';

    // 本周阅读进度
    const recent = items.filter((i) => i.filename).slice(0, 8);
    $('readingList').innerHTML = recent.length ? recent.map((i) => {
      const p = i.readingProgress || '未阅读';
      const w = p === '已阅读' ? 100 : p === '阅读中' ? 50 : 6;
      const color = p === '已阅读' ? 'var(--green)' : p === '阅读中' ? 'var(--orange)' : '#ddd4e4';
      return `<div class="reading-item"><div class="reading-title"><b title="${esc(i.title || '')}">${esc(clipTitle(i.title || i.originalName || '未命名', 26))}</b><span style="color:${color};flex-shrink:0">${p}</span></div><div class="reading-bar"><span style="width:${w}%;background:${color}"></span></div></div>`;
    }).join('') : '<div class="pr-loading">还没有上传 PDF 文献</div>';

    // 重要节点倒计时（任务 / 返修截止 / 大论文章节节点 / 项目）
    const cds = [];
    for (const t of tasks) {
      if (t.status !== 'done' && t.due) {
        const d = daysUntil(t.due);
        if (d != null && d >= 0) cds.push({ d, label: t.title, kind: '任务截止' });
      }
    }
    for (const p of journalPapers) {
      if (p.revisionDeadline && !['已见刊', '拒稿', '撤稿'].includes(p.status)) {
        const d = daysUntil(p.revisionDeadline);
        if (d != null && d >= 0) cds.push({ d, label: `返修截止：《${clipTitle(p.title, 18)}》`, kind: p.status === '返修' ? '返修' : '论文节点' });
      }
    }
    for (const p of papers) {
      if (p.kind === 'thesis') {
        for (const m of (p.milestones || [])) {
          if (m.label && m.date && !m.done) {
            const d = daysUntil(m.date);
            if (d != null && d >= 0) cds.push({ d, label: m.label, kind: '大论文节点' });
          }
        }
        if (p.targetDate) {
          const d = daysUntil(p.targetDate);
          if (d != null && d >= 0) cds.push({ d, label: `学位论文完成：《${clipTitle(p.title, 14)}》`, kind: '答辩目标' });
        }
      }
    }
    for (const p of projects) {
      if (p.status !== '已完成' && p.endDate) {
        const d = daysUntil(p.endDate);
        if (d != null && d >= 0) cds.push({ d, label: p.name, kind: '项目节点' });
      }
    }
    cds.sort((a, b) => a.d - b.d);
    $('countdownList').innerHTML = cds.length
      ? cds.slice(0, 5).map((c) => `<div class="countdown-item"><span class="countdown-days${c.d <= 7 ? ' urgent' : ''}">${c.d}天</span><span class="countdown-label" title="${esc(c.label)}">${esc(clipTitle(c.label, 24))}</span><span class="side-count">${c.kind}</span></div>`).join('')
      : '<div class="pr-loading">暂无临近节点</div>';

    renderCalendar();
  }

  // ---------- 科研日历 ----------
  const CAL_TYPES = {
    task: { color: '#d9820a', label: '任务' },
    deadline: { color: '#e5484d', label: '返修截止' },
    submit: { color: '#81308C', label: '投稿' },
    milestone: { color: '#a94bb5', label: '论文节点' },
    project: { color: '#0ea5a4', label: '项目' },
  };
  function calEventsByDate() {
    const map = {};
    const push = (d, type, label) => { if (!d) return; (map[d] = map[d] || []).push({ type, label }); };
    for (const t of tasks) if (t.status !== 'done' && t.due) push(t.due, 'task', t.title);
    for (const p of papers) {
      if (p.kind === 'journal') {
        if (p.revisionDeadline && !['已见刊', '拒稿', '撤稿'].includes(p.status)) push(p.revisionDeadline, 'deadline', `返修截止：《${clipTitle(p.title, 16)}》`);
        if (p.submitDate) push(p.submitDate, 'submit', `投稿：《${clipTitle(p.title, 16)}》`);
      } else {
        for (const m of (p.milestones || [])) if (m.label && m.date) push(m.date, 'milestone', `${m.label}${m.done ? '（已完成）' : ''}`);
        if (p.targetDate) push(p.targetDate, 'milestone', `学位论文完成目标：《${clipTitle(p.title, 12)}》`);
      }
    }
    for (const p of projects) if (p.status !== '已完成' && p.endDate) push(p.endDate, 'project', `项目节点：${clipTitle(p.name, 16)}`);
    return map;
  }

  function renderCalendar() {
    const y = calYear, m = calMonth;
    $('calTitle').textContent = `${y}年${m + 1}月`;
    const startWeek = (new Date(y, m, 1).getDay() + 6) % 7; // 周一=0
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const events = calEventsByDate();
    const t0 = todayStr();
    const cells = [];
    for (let i = startWeek - 1; i >= 0; i--) cells.push({ d: prevDays - i, out: true });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ d, out: false });
    const trail = (7 - (cells.length % 7)) % 7;
    for (let d = 1; d <= trail; d++) cells.push({ d, out: true });

    $('calGrid').innerHTML = cells.map((c) => {
      const mm = String(m + 1).padStart(2, '0'), dd = String(c.d).padStart(2, '0');
      let dateKey;
      if (c.out) {
        const isPrev = c.d > 15; // 补位里大于 15 的是上个月
        const nm = isPrev ? m - 1 : m + 1;
        const ny = y + Math.floor(nm / 12);
        const norm = ((nm % 12) + 12) % 12;
        dateKey = `${ny}-${String(norm + 1).padStart(2, '0')}-${dd}`;
      } else {
        dateKey = `${y}-${mm}-${dd}`;
      }
      const evs = events[dateKey] || [];
      const dots = evs.slice(0, 3).map((e) => `<i class="cal-dot" style="background:${CAL_TYPES[e.type]?.color || '#999'}"></i>`).join('');
      const more = evs.length > 3 ? `<i class="cal-more">+${evs.length - 3}</i>` : '';
      const cls = ['cal-cell', c.out ? 'out' : '', dateKey === t0 ? 'today' : '', calSelected === dateKey ? 'selected' : ''].filter(Boolean).join(' ');
      return `<div class="${cls}" data-date="${dateKey}" title="${esc(evs.map((e) => e.label).join('；'))}">
        <span class="cal-num">${c.d}</span><span class="cal-dots">${dots}${more}</span>
      </div>`;
    }).join('');
    renderCalDayEvents();
  }

  function renderCalDayEvents() {
    const key = calSelected || todayStr();
    const events = (calEventsByDate()[key] || []);
    const box = $('calDayEvents');
    const head = `<div class="cal-day-head">${calSelected ? '📆 ' + key : '📆 今天 · ' + key}<span class="side-count">${events.length} 项</span></div>`;
    box.innerHTML = head + (events.length
      ? events.map((e) => `<div class="cal-event"><i class="cal-dot" style="background:${CAL_TYPES[e.type]?.color || '#999'}"></i><span class="cal-event-label" title="${esc(e.label)}">${esc(e.label)}</span><span class="cal-tag" style="color:${CAL_TYPES[e.type]?.color}">${CAL_TYPES[e.type]?.label || ''}</span></div>`).join('')
      : '<div class="pr-loading">这一天没有安排 🎉</div>');
  }

  // ---------- 项目管理 ----------
  function renderProjects() {
    const wrap = $('projCards');
    if (!projects.length) {
      wrap.innerHTML = `<div class="empty-state proj-empty"><div class="empty-icon">📂</div><p>还没有项目</p><p class="empty-hint">点击「＋ 新建项目」，把文献、任务、实验记录围绕课题组织起来</p></div>`;
      return;
    }
    wrap.innerHTML = projects.map((p) => {
      const litN = (p.literatureIds || []).length;
      const taskN = tasks.filter((t) => t.projectId === p.id && t.status !== 'done').length;
      const noteN = notes.filter((n) => n.projectId === p.id).length;
      return `<div class="card proj-card" data-proj="${p.id}" title="点击编辑项目">
        <div class="proj-card-top">
          <div class="proj-name">${esc(p.name)}</div>
          <span class="proj-status status-${esc(p.status)}">${esc(p.status)}</span>
        </div>
        <div class="proj-meta">
          ${p.advisor ? `<span class="meta-chip">👨‍🏫 ${esc(p.advisor)}</span>` : ''}
          ${p.field ? `<span class="meta-chip">🔬 ${esc(p.field)}</span>` : ''}
          ${p.startDate ? `<span class="meta-chip">📅 ${esc(p.startDate)}${p.endDate ? ' ~ ' + esc(p.endDate) : ''}</span>` : ''}
        </div>
        ${p.description ? `<div style="font-size:12.5px;color:var(--text-2);margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2">${esc(p.description)}</div>` : ''}
        <div class="proj-progress-row"><div class="proj-progress-bar"><span style="width:${p.progress || 0}%"></span></div><span class="proj-progress-num">${p.progress || 0}%</span></div>
        <div class="proj-links"><span>📚 文献 <b>${litN}</b></span><span>✅ 待办任务 <b>${taskN}</b></span><span>📝 记录 <b>${noteN}</b></span></div>
      </div>`;
    }).join('');
  }

  let projModalId = null;
  function openProjModal(id) {
    projModalId = id || null;
    const p = id ? projects.find((x) => x.id === id) : null;
    $('projModalTitle').textContent = p ? '编辑项目' : '新建项目';
    $('projName').value = p?.name || '';
    $('projAdvisor').value = p?.advisor || '';
    $('projField').value = p?.field || '';
    $('projStatus').value = p?.status || '进行中';
    $('projStart').value = p?.startDate || '';
    $('projEnd').value = p?.endDate || '';
    $('projProgress').value = p?.progress || 0;
    $('projProgressVal').textContent = p?.progress || 0;
    $('projDesc').value = p?.description || '';
    const litIds = new Set(p?.literatureIds || []);
    const pool = items.slice(0, 80);
    $('projLitPick').innerHTML = pool.length
      ? pool.map((it) => `<label><input type="checkbox" data-litpick="${it.id}" ${litIds.has(it.id) ? 'checked' : ''} />${esc(clipTitle(it.title || it.originalName || '未命名', 34))}</label>`).join('')
      : '<div class="lit-empty">文献中心还没有文献，可稍后在项目编辑中关联</div>';
    $('btnProjDelete').classList.toggle('hidden', !p);
    $('projModal').classList.remove('hidden');
  }
  async function saveProjModal() {
    const name = $('projName').value.trim();
    if (!name) { toast('请输入项目名称', 'error'); return; }
    const literatureIds = [...$('projLitPick').querySelectorAll('[data-litpick]:checked')].map((n) => n.dataset.litpick);
    const body = {
      name, advisor: $('projAdvisor').value.trim(), field: $('projField').value.trim(),
      status: $('projStatus').value, startDate: $('projStart').value, endDate: $('projEnd').value,
      progress: Number($('projProgress').value) || 0, description: $('projDesc').value.trim(),
      literatureIds,
    };
    try {
      if (projModalId) {
        const updated = await api('/api/projects/' + projModalId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const idx = projects.findIndex((x) => x.id === projModalId); if (idx >= 0) projects[idx] = updated;
      } else {
        const created = await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        projects.unshift(created);
      }
      $('projModal').classList.add('hidden');
      renderProjects(); renderChatMeta();
      toast('项目已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function deleteProj() {
    if (!projModalId) return;
    if (!confirm('确认删除该项目？（任务与实验记录会保留，仅解除关联）')) return;
    try {
      await api('/api/projects/' + projModalId, { method: 'DELETE' });
      projects = projects.filter((p) => p.id !== projModalId);
      $('projModal').classList.add('hidden');
      renderProjects(); renderHome();
      toast('项目已删除', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- 任务安排 ----------
  function taskItemHtml(t) {
    const proj = projects.find((p) => p.id === t.projectId);
    const t0 = todayStr();
    const over = t.status !== 'done' && t.due && t.due < t0;
    return `<div class="task-item${t.status === 'done' ? ' done' : ''}" data-task="${t.id}">
      <input type="checkbox" data-tasktoggle="${t.id}" ${t.status === 'done' ? 'checked' : ''} />
      <span class="task-title" title="${esc(t.title)}">${esc(t.title)}</span>
      ${proj ? `<span class="task-chip" style="background:var(--primary-soft);color:var(--primary)">📂 ${esc(clipTitle(proj.name, 12))}</span>` : ''}
      <span class="task-chip tp-${esc(t.priority)}">${esc(t.priority)}优先</span>
      ${t.due ? `<span class="task-due${over ? ' over' : ''}">${over ? '逾期 ' : ''}${t.due}</span>` : ''}
      <button class="task-del" data-taskdel="${t.id}" title="删除">🗑</button>
    </div>`;
  }

  function renderTasks() {
    const opts = ['<option value="">不关联项目</option>'].concat(projects.map((p) => `<option value="${p.id}">${esc(clipTitle(p.name, 18))}</option>`)).join('');
    $('taskProject').innerHTML = opts;
    const t0 = todayStr();
    const open = tasks.filter((t) => t.status !== 'done');
    const groups = [
      { title: '⚠ 已逾期', cls: 'overdue', list: open.filter((t) => t.due && t.due < t0) },
      { title: '☀ 今天', cls: '', list: open.filter((t) => t.due === t0) },
      { title: '📅 未来 7 天', cls: '', list: open.filter((t) => t.due && t.due > t0 && daysUntil(t.due) <= 7) },
      { title: '🗓 以后 / 无截止', cls: '', list: open.filter((t) => !t.due || (t.due > t0 && daysUntil(t.due) > 7)) },
      { title: '✅ 已完成（最近 10 条）', cls: '', list: tasks.filter((t) => t.status === 'done').slice(0, 10) },
    ];
    $('taskGroups').innerHTML = groups.map((g) => `
      <div class="task-group">
        <div class="task-group-title ${g.cls}">${g.title}<span class="side-count">${g.list.length}</span></div>
        ${g.list.length ? g.list.map(taskItemHtml).join('') : '<div class="pr-loading" style="text-align:left;padding:4px 2px">（无）</div>'}
      </div>`).join('');
  }

  async function addTask(title, due, priority, projectId) {
    title = String(title || '').trim();
    if (!title) { toast('请输入任务内容', 'error'); return; }
    try {
      const created = await api('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, due: due || null, priority: priority || '中', projectId: projectId || null }) });
      tasks.unshift(created);
      renderTasks(); renderChatMeta();
      toast('任务已添加', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function toggleTask(id) {
    const t = tasks.find((x) => x.id === id); if (!t) return;
    const status = t.status === 'done' ? 'todo' : 'done';
    try {
      const updated = await api('/api/tasks/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      const idx = tasks.findIndex((x) => x.id === id); if (idx >= 0) tasks[idx] = updated;
      renderTasks(); renderHome();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function deleteTask(id) {
    try {
      await api('/api/tasks/' + id, { method: 'DELETE' });
      tasks = tasks.filter((t) => t.id !== id);
      renderTasks(); renderHome();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- 论文管理（小论文投稿流水线 + 大论文阶段进度） ----------
  const JOURNAL_STATUSES = ['构思中', '撰写中', '导师审阅', '投稿中', '初审', '外审', '返修', '复审', '录用', '校样', '已见刊', '拒稿', '撤稿'];
  const PIPELINE = ['构思中', '撰写中', '导师审阅', '投稿中', '初审', '外审', '返修', '复审', '录用', '校样', '已见刊'];
  const THESIS_STAGES = ['选题', '开题', '搭框架', '读文献', '找数据', '实证分析', '撰写初稿', '修改完善', '查重盲审', '答辩'];
  const STATUS_CLS = {
    '构思中': 'st-idea', '撰写中': 'st-write', '导师审阅': 'st-review', '投稿中': 'st-submit',
    '初审': 'st-review', '外审': 'st-review', '返修': 'st-revise', '复审': 'st-review',
    '录用': 'st-accept', '校样': 'st-accept', '已见刊': 'st-published', '拒稿': 'st-reject', '撤稿': 'st-reject',
  };

  function renderPaperTab() {
    const isJournal = paperTab === 'journal';
    document.querySelectorAll('#paperTabs .seg-tab').forEach((t) => t.classList.toggle('active', t.dataset.ptab === paperTab));
    $('paperCards').classList.toggle('hidden', !isJournal);
    $('thesisCards').classList.toggle('hidden', isJournal);
    $('btnAddPaper').textContent = isJournal ? '＋ 添加小论文' : '＋ 添加大论文';
    if (isJournal) { renderJournalPapers(); autoFillPaperRanks(); } else renderTheses();
  }

  // ----- 期刊等级自动补查：卡片上有期刊名但没有等级时，后台逐个查询（easyScholar 限速，串行执行） -----
  const wlRankFailed = new Set(); // 本次会话查询失败的期刊名（如未配置 Key），避免反复请求
  let wlRankRunning = false;
  async function autoFillPaperRanks() {
    if (wlRankRunning) return;
    const need = papers.filter((p) => p.kind === 'journal' && p.journal && !p.rank?.summary && !wlRankFailed.has(p.journal));
    if (!need.length) return;
    wlRankRunning = true;
    for (const p of need) {
      try {
        const rank = await api('/api/journal-rank?name=' + encodeURIComponent(p.journal));
        const updated = await api('/api/papers/' + p.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rank }) });
        const idx = papers.findIndex((x) => x.id === p.id);
        if (idx >= 0) papers[idx] = updated;
        // 原地更新卡片上的等级区，不整表重渲染（避免闪烁）
        const box = document.querySelector(`[data-rankfor="${p.id}"]`);
        if (box) box.innerHTML = rankChips(rank.items);
      } catch (e) {
        wlRankFailed.add(p.journal);
      }
    }
    wlRankRunning = false;
  }

  function statusBadge(s) {
    return `<span class="paper-status ${STATUS_CLS[s] || ''}">${esc(s)}</span>`;
  }

  function paperStepper(p) {
    if (p.status === '拒稿' || p.status === '撤稿') {
      const idx = p.submitDate ? PIPELINE.indexOf('投稿中') : 1;
      return `<div class="psteps">
        ${PIPELINE.map((s, i) => `<i class="pstep ${i <= idx ? 'done' : ''}"></i>`).join('')}
        <i class="pstep fail"></i>
      </div>`;
    }
    const idx = PIPELINE.indexOf(p.status);
    return `<div class="psteps">${PIPELINE.map((s, i) => `<i class="pstep ${i <= idx ? 'done' : ''}" title="${s}"></i>`).join('')}</div>`;
  }

  function renderJournalPapers() {
    const list = papers.filter((p) => p.kind === 'journal');
    const wrap = $('paperCards');
    if (!list.length) {
      wrap.innerHTML = `<div class="empty-state proj-empty"><div class="empty-icon">📮</div><p>还没有小论文记录</p><p class="empty-hint">点击「＋ 添加小论文」，跟踪从撰写、投稿、外审、返修到录用的完整流水线；期刊等级由 easyScholar 自动查询</p></div>`;
      return;
    }
    const t0 = todayStr();
    wrap.innerHTML = list.map((p) => {
      const proj = projects.find((x) => x.id === p.projectId);
      const hist = p.history || [];
      const last = hist[hist.length - 1];
      // 停留天数 = 当前状态已持续的时间。
      // 历史 ≥2 条 → 从最近一次状态变更日起算；
      // 仅 1 条（状态自创建/投稿起从未变更）→ 从投稿日起算（更早者），避免刚补录动态就显示 0 天。
      let stay = '';
      if (last?.date) {
        let startDate = last.date;
        if (hist.length <= 1 && p.submitDate && p.submitDate < last.date) startDate = p.submitDate;
        const d = Math.max(0, Math.floor((Date.now() - new Date(startDate + 'T00:00:00')) / 86400000));
        stay = `<span class="meta-chip">⏱ 当前状态已停留 ${d} 天</span>`;
      }
      // 返修截止提醒
      let ddl = '';
      if (p.revisionDeadline && !['已见刊', '拒稿', '撤稿'].includes(p.status)) {
        const d = daysUntil(p.revisionDeadline);
        if (d != null) {
          ddl = d < 0
            ? `<span class="ddl-chip over">⚠ 返修已逾期 ${-d} 天</span>`
            : `<span class="ddl-chip${d <= 7 ? ' urgent' : ''}">⏳ 返修截止 ${p.revisionDeadline}（剩 ${d} 天）</span>`;
        }
      }
      const rank = p.rank?.summary
        ? `<div class="paper-rank" data-rankfor="${p.id}">${rankChips(p.rank.items)}</div>`
        : (p.journal ? `<div class="paper-rank" data-rankfor="${p.id}"><span class="cell-empty">期刊等级自动查询中…</span></div>` : '');
      return `<div class="card paper-card" data-paper="${p.id}" title="点击编辑">
        <div class="paper-card-top">
          <div class="paper-title">《${esc(p.title)}》</div>
          ${statusBadge(p.status)}
        </div>
        <div class="paper-journal-row">
          <span class="meta-chip journal-chip">🎯 ${p.journal ? esc(p.journal) : '未定期刊'}</span>
          ${proj ? `<span class="meta-chip">📂 ${esc(clipTitle(proj.name, 14))}</span>` : ''}
          ${p.submitDate ? `<span class="meta-chip">📅 投稿 ${esc(p.submitDate)}</span>` : ''}
          ${stay}
        </div>
        ${rank}
        ${paperStepper(p)}
        <div class="paper-card-foot">
          ${ddl}
          <span class="paper-hist-summary" title="${esc(hist.map((h) => `${h.date} ${h.status}${h.note ? '：' + h.note : ''}`).join('\n'))}">🧾 ${hist.length} 条动态${hist.length ? ' · 最近：' + esc(clipTitle(last?.note || last?.status || '', 18)) : ''}</span>
        </div>
      </div>`;
    }).join('');
  }

  function renderTheses() {
    const list = papers.filter((p) => p.kind === 'thesis');
    const wrap = $('thesisCards');
    if (!list.length) {
      wrap.innerHTML = `<div class="empty-state proj-empty"><div class="empty-icon">🎓</div><p>还没有大论文记录</p><p class="empty-hint">点击「＋ 添加大论文」，按「搭框架 → 读文献 → 找数据 → 实证分析 → 撰写 → 答辩」跟踪学位论文进度</p></div>`;
      return;
    }
    wrap.innerHTML = list.map((p) => {
      const chapters = p.chapters || [];
      const doneN = chapters.filter((c) => c.done).length;
      const chapPct = chapters.length ? Math.round((doneN / chapters.length) * 100) : 0;
      const stageIdx = THESIS_STAGES.indexOf(p.stage);
      const nextMs = (p.milestones || []).filter((m) => m.label && m.date && !m.done)
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      let nextTxt = '';
      if (nextMs) {
        const d = daysUntil(nextMs.date);
        const urgent = d != null && d <= 7 ? ' urgent' : '';
        nextTxt = `<span class="ddl-chip${urgent}">🏁 下一节点：${esc(nextMs.label)} ${esc(nextMs.date)}${d != null ? `（剩 ${d} 天）` : ''}</span>`;
      }
      return `<div class="card paper-card thesis-card" data-thesis="${p.id}" title="点击编辑">
        <div class="paper-card-top">
          <div class="paper-title">《${esc(p.title)}》<span class="degree-chip">${esc(p.degree || '硕士')}学位论文</span></div>
          <span class="paper-status st-thesis">${esc(p.stage)}</span>
        </div>
        <div class="tsteps">${THESIS_STAGES.map((s, i) => `<span class="tstep${i < stageIdx ? ' done' : ''}${i === stageIdx ? ' cur' : ''}">${esc(s)}</span>`).join('')}</div>
        <div class="chap-progress-row">
          <span class="chap-progress-label">📑 章节 ${doneN}/${chapters.length || 0}</span>
          <div class="chap-progress-bar"><span style="width:${chapPct}%"></span></div>
          <b class="chap-progress-num">${chapPct}%</b>
        </div>
        <div class="paper-card-foot">
          ${nextTxt}
          ${p.targetDate ? `<span class="meta-chip">🎯 计划完成 ${esc(p.targetDate)}</span>` : ''}
          <span class="paper-hist-summary">🏁 节点 ${(p.milestones || []).filter((m) => m.done).length}/${(p.milestones || []).length} 已完成</span>
        </div>
      </div>`;
    }).join('');
  }

  // ----- 小论文弹窗 -----
  let paperModalId = null;
  let paperDraft = null; // 编辑中的历史副本 { history: [], rank }
  function openPaperModal(id) {
    paperModalId = id || null;
    const p = id ? papers.find((x) => x.id === id) : null;
    $('paperModalTitle').textContent = p ? '编辑小论文（投稿管理）' : '添加小论文';
    const statusOpts = JOURNAL_STATUSES.map((s) => `<option${p?.status === s ? ' selected' : ''}>${s}</option>`).join('');
    $('paperStatus').innerHTML = statusOpts;
    $('histStatus').innerHTML = JOURNAL_STATUSES.map((s) => `<option>${s}</option>`).join('');
    const projOpts = ['<option value="">不关联项目</option>'].concat(projects.map((x) => `<option value="${x.id}"${p?.projectId === x.id ? ' selected' : ''}>${esc(clipTitle(x.name, 18))}</option>`)).join('');
    $('paperProject').innerHTML = projOpts;
    $('paperTitle').value = p?.title || '';
    $('paperJournal').value = p?.journal || '';
    $('paperSubmitDate').value = p?.submitDate || '';
    $('paperDeadline').value = p?.revisionDeadline || '';
    $('paperBackup').value = p?.backupJournals || '';
    $('paperNotes').value = p?.notes || '';
    paperDraft = { history: JSON.parse(JSON.stringify(p?.history || [])), rank: p?.rank ? JSON.parse(JSON.stringify(p.rank)) : null, reviewTranslation: p?.reviewTranslation || null };
    if (!paperDraft.history.length) paperDraft.history = [{ status: $('paperStatus').value, date: todayStr(), note: '创建论文' }];
    $('paperRankChips').innerHTML = paperDraft.rank?.summary ? rankChips(paperDraft.rank.items) : '';
    // 已有译文则显示，否则收起
    const rtWrap = $('reviewTransWrap');
    if (paperDraft.reviewTranslation) {
      rtWrap.classList.remove('hidden');
      rtWrap.classList.remove('expanded');
      $('reviewTransBody').textContent = paperDraft.reviewTranslation;
      $('btnReviewTransToggle').textContent = '展开全文';
    } else {
      rtWrap.classList.add('hidden');
      $('reviewTransBody').textContent = '';
    }
    renderPaperHistory();
    $('btnPaperDelete').classList.toggle('hidden', !p);
    $('paperModal').classList.remove('hidden');
    setTimeout(() => $('paperTitle').focus(), 50);
  }

  function renderPaperHistory() {
    const box = $('paperHistory');
    $('paperHistCount').textContent = paperDraft.history.length;
    if (!paperDraft.history.length) { box.innerHTML = '<div class="pr-loading">暂无动态，用下方表单记录第一次状态</div>'; return; }
    box.innerHTML = [...paperDraft.history].reverse().map((h, ri) => {
      const i = paperDraft.history.length - 1 - ri;
      return `<div class="hist-item">
        <span class="hist-dot ${STATUS_CLS[h.status] || ''}"></span>
        <div class="hist-body">
          <div class="hist-head"><b>${esc(h.status)}</b><span class="hist-date">${esc(h.date)}</span>${i === paperDraft.history.length - 1 ? '<span class="side-count">当前</span>' : ''}
            <button class="hist-del" data-histdel="${i}" title="删除该条">✕</button></div>
          ${h.note ? `<div class="hist-note">${esc(h.note)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-histdel]').forEach((b) => b.addEventListener('click', () => {
      paperDraft.history.splice(parseInt(b.dataset.histdel, 10), 1);
      renderPaperHistory();
    }));
  }

  async function queryPaperRank() {
    const name = $('paperJournal').value.trim();
    if (!name) { toast('请先填写目标期刊名', 'error'); return; }
    const btn = $('btnQueryRank');
    btn.disabled = true; btn.textContent = '查询中…';
    try {
      const rank = await api('/api/journal-rank?name=' + encodeURIComponent(name));
      paperDraft.rank = rank;
      $('paperRankChips').innerHTML = `<span class="rank-ok">✓ ${esc(rank.summary)}</span>`;
      toast('期刊等级查询成功', 'success');
    } catch (e) {
      paperDraft.rank = null;
      $('paperRankChips').innerHTML = `<span class="rank-err">⚠ ${esc(e.message)}</span>`;
    } finally {
      btn.disabled = false; btn.textContent = '🏅 查等级';
    }
  }

  // ----- 审稿意见一键翻译：AI 把英文审稿意见整理成逐条中文（忠于原文，不增不减） -----
  async function translateReview() {
    const text = $('paperNotes').value.trim();
    if (!text) { toast('请先在「审稿意见 / 备注」中粘贴英文审稿意见', 'error'); return; }
    const btn = $('btnTranslateReview');
    const wrap = $('reviewTransWrap');
    const body = $('reviewTransBody');
    btn.disabled = true; btn.textContent = '翻译中…';
    wrap.classList.remove('hidden');
    body.classList.add('rt-loading');
    body.textContent = '正在用 AI 整理审稿意见（忠于原文、逐条中文、不增不减）…';
    try {
      const res = await api('/api/translate-review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      body.classList.remove('rt-loading');
      body.textContent = res.translation;
      paperDraft.reviewTranslation = res.translation;
      toast('翻译完成，保存论文后生效', 'success');
    } catch (e) {
      body.classList.remove('rt-loading');
      body.textContent = '翻译失败：' + e.message;
      toast(e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '🈯 一键翻译';
    }
  }

  async function savePaperModal() {
    const title = $('paperTitle').value.trim();
    if (!title) { toast('请输入论文标题', 'error'); return; }
    const status = $('paperStatus').value;
    const history = JSON.parse(JSON.stringify(paperDraft.history));
    // 状态与最后一条历史不一致时自动补一条动态
    if (!history.length || history[history.length - 1].status !== status) {
      history.push({ status, date: todayStr(), note: '状态更新' });
    }
    const body = {
      title, journal: $('paperJournal').value.trim(), status,
      projectId: $('paperProject').value || null,
      submitDate: $('paperSubmitDate').value, revisionDeadline: $('paperDeadline').value,
      backupJournals: $('paperBackup').value.trim(), notes: $('paperNotes').value,
      reviewTranslation: paperDraft.reviewTranslation || '',
      history, rank: paperDraft.rank,
    };
    try {
      if (paperModalId) {
        const updated = await api('/api/papers/' + paperModalId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const idx = papers.findIndex((x) => x.id === paperModalId); if (idx >= 0) papers[idx] = updated;
      } else {
        const created = await api('/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        papers.unshift(created);
      }
      $('paperModal').classList.add('hidden');
      renderPaperTab(); renderChatMeta();
      toast('论文已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deletePaperModal() {
    if (!paperModalId) return;
    if (!confirm('确认删除该小论文？（关联研究记录会保留，仅解除关联）')) return;
    try {
      await api('/api/papers/' + paperModalId, { method: 'DELETE' });
      papers = papers.filter((p) => p.id !== paperModalId);
      $('paperModal').classList.add('hidden');
      renderPaperTab(); renderChatMeta(); renderHome();
      toast('论文已删除', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ----- 大论文弹窗 -----
  let thesisModalId = null;
  function chapterRow(c = { title: '', done: false }, i) {
    return `<div class="chap-row" data-chaprow="${i}">
      <input type="checkbox" data-chapdone ${c.done ? 'checked' : ''} />
      <input class="tb-input" data-chaptitle value="${esc(c.title)}" placeholder="如：第${i + 1}章 绪论" />
      <button class="chap-del" data-chapdel title="删除">✕</button>
    </div>`;
  }
  function milestoneRow(m = { label: '', date: '', done: false }, i) {
    return `<div class="ms-row" data-msrow="${i}">
      <input class="tb-input" data-mslabel value="${esc(m.label)}" placeholder="节点名称，如：开题答辩" style="flex:2" />
      <input type="date" class="tb-select" data-msdate value="${esc(m.date)}" />
      <label class="ms-done"><input type="checkbox" data-msdone ${m.done ? 'checked' : ''} /> 完成</label>
      <button class="chap-del" data-msdel title="删除">✕</button>
    </div>`;
  }
  function renderChapterEditor(chapters) {
    $('thesisChapters').innerHTML = chapters.length ? chapters.map((c, i) => chapterRow(c, i)).join('') : '<div class="pr-loading ms-hint" style="text-align:left;padding:2px">还没有章节，点击下方按钮添加（或一键插入经管常用框架）</div>';
    $('thesisChapCount').textContent = chapters.length;
  }
  function renderMsEditor(milestones) {
    $('thesisMilestones').innerHTML = milestones.length ? milestones.map((m, i) => milestoneRow(m, i)).join('') : '<div class="pr-loading ms-hint" style="text-align:left;padding:2px">还没有节点，如：开题答辩 / 中期检查 / 预答辩 / 正式答辩</div>';
    $('thesisMsCount').textContent = milestones.length;
  }
  function collectChapters() {
    return [...$('thesisChapters').querySelectorAll('[data-chaprow]')].map((row) => ({
      title: row.querySelector('[data-chaptitle]').value.trim(),
      done: row.querySelector('[data-chapdone]').checked,
    })).filter((c) => c.title);
  }
  function collectMilestones() {
    return [...$('thesisMilestones').querySelectorAll('[data-msrow]')].map((row) => ({
      label: row.querySelector('[data-mslabel]').value.trim(),
      date: row.querySelector('[data-msdate]').value,
      done: row.querySelector('[data-msdone]').checked,
    })).filter((m) => m.label);
  }

  function openThesisModal(id) {
    thesisModalId = id || null;
    const p = id ? papers.find((x) => x.id === id) : null;
    $('thesisModalTitle').textContent = p ? '编辑大论文（学位论文进度）' : '添加大论文';
    $('thesisStage').innerHTML = THESIS_STAGES.map((s) => `<option${p?.stage === s ? ' selected' : ''}>${s}</option>`).join('');
    $('thesisDegree').value = p?.degree || '硕士';
    $('thesisTitle').value = p?.title || '';
    $('thesisTarget').value = p?.targetDate || '';
    $('thesisNotes').value = p?.notes || '';
    renderChapterEditor(p?.chapters || []);
    renderMsEditor(p?.milestones || []);
    $('btnThesisDelete').classList.toggle('hidden', !p);
    $('thesisModal').classList.remove('hidden');
    setTimeout(() => $('thesisTitle').focus(), 50);
  }

  async function saveThesisModal() {
    const title = $('thesisTitle').value.trim();
    if (!title) { toast('请输入学位论文题目', 'error'); return; }
    const body = {
      kind: 'thesis', title, degree: $('thesisDegree').value, stage: $('thesisStage').value,
      targetDate: $('thesisTarget').value, notes: $('thesisNotes').value,
      chapters: collectChapters(), milestones: collectMilestones(),
    };
    try {
      if (thesisModalId) {
        const updated = await api('/api/papers/' + thesisModalId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const idx = papers.findIndex((x) => x.id === thesisModalId); if (idx >= 0) papers[idx] = updated;
      } else {
        const created = await api('/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        papers.unshift(created);
      }
      $('thesisModal').classList.add('hidden');
      renderPaperTab(); renderChatMeta(); renderHome();
      toast('大论文已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteThesisModal() {
    if (!thesisModalId) return;
    if (!confirm('确认删除该大论文？')) return;
    try {
      await api('/api/papers/' + thesisModalId, { method: 'DELETE' });
      papers = papers.filter((p) => p.id !== thesisModalId);
      $('thesisModal').classList.add('hidden');
      renderPaperTab(); renderChatMeta(); renderHome();
      toast('大论文已删除', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- 研究记录（经管版：Study 划分） ----------
  const NOTE_TEMPLATE = `【实验目的】\n- \n\n【材料与方法】\n- \n\n【实验步骤】\n1. \n2. \n\n【结果与分析】\n- \n\n【结论与下一步】\n- `;
  const NOTE_ECON_TEMPLATE = `【研究问题】\n- \n\n【研究假设】\nH1：\nH2：\n\n【变量定义】\n- 被解释变量（Y）：\n- 核心解释变量（X）：\n- 调节 / 中介变量：\n- 控制变量：\n\n【数据来源】\n- 数据库：CSMAR / Wind / CFPS / 中国工业企业数据库 / 手动收集\n- 样本区间：\n- 样本筛选与处理（剔除 ST / 金融业、缩尾等）：\n\n【模型设定】\nY_it = α + βX_it + γControls_it + μ_i + λ_t + ε_it\n\n【实证方法】\n- 基准回归：\n- 内生性处理（IV / DID / PSM / GMM）：\n- 稳健性检验（替换变量 / 更换样本 / 调节效应）：\n\n【基准结果】\n- 核心系数 β = （t 值），显著性：\n- 经济含义：\n\n【结论与下一步】\n- `;

  function renderNotes() {
    const filter = $('noteProjFilter').value;
    const opts = ['<option value="">全部项目</option>'].concat(projects.map((p) => `<option value="${p.id}">${esc(clipTitle(p.name, 16))}</option>`)).join('');
    if ($('noteProjFilter').dataset.filled !== '1') { $('noteProjFilter').innerHTML = opts; $('noteProjFilter').dataset.filled = '1'; }
    $('noteProjFilter').value = filter;
    const list = filter ? notes.filter((n) => n.projectId === filter) : notes;
    $('noteCards').innerHTML = list.length ? list.map((n) => {
      const proj = projects.find((p) => p.id === n.projectId);
      const paper = papers.find((p) => p.id === n.paperId && p.kind === 'journal');
      return `<div class="card note-card" data-note="${n.id}" title="点击编辑">
        <div class="note-card-title"><span>${esc(n.title)}</span>${n.studyNo ? `<span class="study-chip">${esc(n.studyNo)}</span>` : ''}</div>
        <div class="note-card-meta"><span>🗓 ${fmtTime(n.createdAt)}</span>${proj ? `<span>📂 ${esc(clipTitle(proj.name, 14))}</span>` : ''}${paper ? `<span>📮 《${esc(clipTitle(paper.title, 14))}》</span>` : ''}</div>
        <div class="note-card-preview">${esc(n.content || '（空）')}</div>
      </div>`;
    }).join('') : `<div class="empty-state"><div class="empty-icon">🧪</div><p>暂无研究记录</p><p class="empty-hint">按 Study 划分记录实证过程（假设 / 变量 / 数据 / 回归 / 稳健性），AI 助手生成周报与诊断时会参考</p></div>`;
  }

  let noteModalId = null;
  function openNoteModal(id) {
    noteModalId = id || null;
    const n = id ? notes.find((x) => x.id === id) : null;
    $('noteModalTitle').textContent = n ? '编辑研究记录' : '新建研究记录';
    const projOpts = ['<option value="">不关联项目</option>'].concat(projects.map((p) => `<option value="${p.id}">${esc(clipTitle(p.name, 18))}</option>`)).join('');
    $('noteProject').innerHTML = projOpts;
    $('noteProject').value = n?.projectId || '';
    const journalPapers = papers.filter((p) => p.kind === 'journal');
    const paperOpts = ['<option value="">不关联小论文</option>'].concat(journalPapers.map((p) => `<option value="${p.id}">《${esc(clipTitle(p.title, 24))}》</option>`)).join('');
    $('notePaper').innerHTML = paperOpts;
    $('notePaper').value = n?.paperId || '';
    $('noteStudy').value = n?.studyNo || '';
    $('noteTitle').value = n?.title || '';
    $('noteContent').value = n?.content || '';
    $('noteModal').classList.remove('hidden');
    setTimeout(() => $('noteTitle').focus(), 50);
  }
  async function saveNoteModal() {
    const title = $('noteTitle').value.trim();
    if (!title) { toast('请输入记录标题', 'error'); return; }
    const body = {
      title, content: $('noteContent').value,
      projectId: $('noteProject').value || null,
      paperId: $('notePaper').value || null,
      studyNo: $('noteStudy').value || '',
    };
    try {
      if (noteModalId) {
        const updated = await api('/api/notes/' + noteModalId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const idx = notes.findIndex((x) => x.id === noteModalId); if (idx >= 0) notes[idx] = updated;
      } else {
        const created = await api('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        notes.unshift(created);
      }
      $('noteModal').classList.add('hidden');
      renderNotes(); renderChatMeta();
      toast('记录已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  async function deleteNote(id) {
    if (!confirm('确认删除该研究记录？')) return;
    try {
      await api('/api/notes/' + id, { method: 'DELETE' });
      notes = notes.filter((n) => n.id !== id);
      renderNotes(); renderChatMeta();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- 个人资料 ----------
  function openProfileModal() {
    $('profName').value = profile.name || '';
    $('profSchool').value = profile.school || '';
    $('profField').value = profile.field || '';
    $('profGrade').value = profile.grade || '';
    $('profAvatar').value = profile.avatar || '🎓';
    $('profProgress').value = profile.progress || 0;
    $('profProgressVal').textContent = profile.progress || 0;
    $('profileModal').classList.remove('hidden');
    setTimeout(() => $('profName').focus(), 50);
  }
  async function saveProfileModal() {
    try {
      profile = await api('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: $('profName').value, school: $('profSchool').value.trim(), field: $('profField').value.trim(),
        grade: $('profGrade').value.trim(), avatar: $('profAvatar').value.trim() || '🎓', progress: Number($('profProgress').value) || 0,
      }) });
      $('profileModal').classList.add('hidden');
      renderHome();
      toast('个人资料已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- AI 助手 ----------
  function renderChatMeta() {
    $('kbLit').textContent = items.filter((i) => i.status === 'done').length;
    $('kbProj').textContent = projects.length;
    $('kbPaper').textContent = papers.filter((p) => p.kind === 'journal').length;
    $('kbThesis').textContent = papers.filter((p) => p.kind === 'thesis').length;
    $('kbNote').textContent = notes.length;
  }
  // ---------- 多会话管理 ----------
  function relTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = todayStr();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (day === today) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return day.slice(5);
  }
  async function loadConversations() {
    conversations = await api('/api/chat/conversations').catch(() => []);
    convLoaded = true;
    renderConvList();
  }
  function renderConvList() {
    const box = $('convList');
    if (!conversations.length) {
      box.innerHTML = '<div class="conv-empty">暂无会话<br />点击上方「＋ 新对话」开始</div>';
      return;
    }
    box.innerHTML = conversations.map((c) => `
      <div class="conv-item${c.id === activeConvId ? ' active' : ''}" data-conv="${c.id}" title="${esc(c.title)}">
        <span class="conv-item-title">${esc(c.title)}${c.compressed ? ' 🗜' : ''}</span>
        <span class="conv-item-time">${relTime(c.updatedAt)}</span>
        <span class="conv-item-ops">
          <button data-convren="${c.id}" title="重命名">✎</button>
          <button data-convdel="${c.id}" title="删除会话">🗑</button>
        </span>
      </div>`).join('');
  }
  async function openConversation(id) {
    if (chatBusy) { toast('AI 正在回复中，请稍候…', 'error'); return; }
    try {
      const conv = await api('/api/chat/conversations/' + id);
      activeConvId = conv.id;
      activeSummary = conv.summary || '';
      chatMsgs = Array.isArray(conv.messages) ? conv.messages : [];
      renderChatMsgs();
      renderConvList();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function newConversation(silent = false) {
    if (chatBusy) { toast('AI 正在回复中，请稍候…', 'error'); return null; }
    try {
      const conv = await api('/api/chat/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      conversations.unshift({ id: conv.id, title: conv.title, updatedAt: conv.updatedAt, messageCount: 0, compressed: false });
      activeConvId = conv.id;
      activeSummary = '';
      chatMsgs = [];
      renderChatMsgs();
      renderConvList();
      if (!silent) $('chatInput').focus();
      return conv.id;
    } catch (e) { toast(e.message, 'error'); return null; }
  }
  async function renameConversation(id) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    const name = prompt('重命名会话：', conv.title);
    if (name === null || !name.trim()) return;
    try {
      await api('/api/chat/conversations/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: name.trim() }) });
      conv.title = name.trim().slice(0, 40);
      renderConvList();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function deleteConversationById(id) {
    if (!confirm('确认删除该会话？聊天记录不可恢复。')) return;
    try {
      await api('/api/chat/conversations/' + id, { method: 'DELETE' });
      conversations = conversations.filter((c) => c.id !== id);
      if (activeConvId === id) {
        activeConvId = null; chatMsgs = []; activeSummary = '';
        renderChatMsgs();
        if (conversations.length) await openConversation(conversations[0].id);
      }
      renderConvList();
      toast('会话已删除', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  function chatMd(v) { // 轻量 Markdown：## 标题 / 列表 / **粗体**
    const out = []; let inList = false;
    for (const raw of String(v).split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { if (inList) { out.push('</ul>'); inList = false; } continue; }
      const e = esc(line);
      if (/^#{1,4}\s/.test(line)) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<p><b>${e.replace(/^#{1,4}\s*/, '')}</b></p>`);
      } else if (/^[-*•]\s+/.test(line) || /^\d+[.、)）]\s*/.test(line)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${e.replace(/^([-*•]|\d+[.、)）])\s*/, '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</li>`);
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<p>${e.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`);
      }
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }
  function renderChatMsgs() {
    const box = $('chatMsgs');
    if (!chatMsgs.length) {
      box.innerHTML = `<div class="chat-welcome"><div class="chat-welcome-ico">🤖</div><b>AI 科研助手已就绪</b><p>基于你的文献知识库、项目与任务进行定制化对话。<br />支持多会话与上下文记忆，试试右侧快捷指令，或直接输入问题。</p></div>`;
      return;
    }
    const summaryHint = activeSummary ? '<div class="chat-summary-hint">🗜 早期对话已压缩为摘要，AI 仍保留其要点记忆</div>' : '';
    box.innerHTML = summaryHint + chatMsgs.map((m) =>
      `<div class="chat-bubble ${m.role === 'user' ? 'user' : 'assistant'}">${m.role === 'user' ? esc(m.content) : `<div class="md">${chatMd(m.content)}</div>`}</div>`).join('');
    box.scrollTop = box.scrollHeight;
  }
  async function sendChat(text) {
    text = String(text || '').trim();
    if (!text || chatBusy) return;
    if (!String(settings.apiKey || '').trim() && settings.aiProvider !== 'none') {
      // 未配置 key：直接提示去设置
      toast('请先在「AI 设置」中填写 API 密钥（硅基流动 DeepSeek）', 'error');
      openSettingsModal();
      return;
    }
    // 没有活动会话时自动创建一个
    if (!activeConvId) {
      const id = await newConversation(true);
      if (!id) return;
    }
    chatBusy = true;
    $('btnChatSend').disabled = true;
    chatMsgs.push({ id: 'local', role: 'user', content: text });
    renderChatMsgs();
    const box = $('chatMsgs');
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble assistant';
    bubble.innerHTML = '<span class="chat-cursor"></span>';
    box.appendChild(bubble);
    box.scrollTop = box.scrollHeight;
    let full = '';
    let errMsg = '';
    let compressed = false;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: activeConvId, content: text }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `请求失败 (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const p = s.slice(5).trim();
          if (p === '[DONE]') continue;
          try {
            const j = JSON.parse(p);
            if (j.error) errMsg = j.error;
            if (j.compressed) compressed = true;
            if (j.delta) {
              full += j.delta;
              bubble.innerHTML = `<div class="md">${chatMd(full)}</div><span class="chat-cursor"></span>`;
              box.scrollTop = box.scrollHeight;
            }
          } catch (_) { /* 不完整行忽略 */ }
        }
      }
    } catch (e) { errMsg = e.message; }
    if (errMsg) bubble.innerHTML = `<div class="md">⚠ ${esc(errMsg)}</div>`;
    else if (!full) bubble.innerHTML = '<div class="md">（模型没有返回内容，请稍后重试）</div>';
    else bubble.innerHTML = `<div class="md">${chatMd(full)}</div>`;
    if (full) chatMsgs.push({ id: 'local', role: 'assistant', content: full });
    box.scrollTop = box.scrollHeight;
    chatBusy = false;
    $('btnChatSend').disabled = false;
    // 刷新会话列表（标题/时间可能变化）；发生压缩时同步摘要状态
    if (compressed) {
      activeSummary = 'compressed';
      renderChatMsgs();
      toast('早期对话已自动压缩为摘要', 'success');
    }
    loadConversations();
  }

  // ---------- 工作台事件绑定 ----------
  function bindWorkbench() {
    // 侧边栏导航
    document.querySelectorAll('.nav-item[data-view]').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));
    $('btnNavSettings').addEventListener('click', openSettingsModal);
    $('btnSettings').addEventListener('click', openSettingsModal);

    // 首页
    $('profileCard').addEventListener('click', openProfileModal);
    $('btnHomeProfile').addEventListener('click', openProfileModal);
    $('btnProfileClose').addEventListener('click', () => $('profileModal').classList.add('hidden'));
    $('btnProfileCancel').addEventListener('click', () => $('profileModal').classList.add('hidden'));
    $('btnProfileSave').addEventListener('click', saveProfileModal);
    $('profProgress').addEventListener('input', () => { $('profProgressVal').textContent = $('profProgress').value; });
    document.querySelector('[data-goto-lib]').addEventListener('click', () => switchView('library'));

    async function addTodayTask() {
      const title = $('todayInput').value.trim();
      if (!title) return;
      $('todayInput').value = '';
      await addTask(title, todayStr(), '中', null);
      renderHome();
    }
    $('btnTodayAdd').addEventListener('click', addTodayTask);
    $('todayInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTodayTask(); });
    $('todayList').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-todaydone]');
      if (cb) toggleTask(cb.dataset.todaydone).then(renderHome);
    });
    $('todayList').addEventListener('click', (e) => {
      const del = e.target.closest('[data-todaydel]');
      if (del) deleteTask(del.dataset.todaydel).then(renderHome);
    });

    // 项目管理
    $('btnAddProject').addEventListener('click', () => openProjModal(null));
    $('projProgress').addEventListener('input', () => { $('projProgressVal').textContent = $('projProgress').value; });
    $('btnProjClose').addEventListener('click', () => $('projModal').classList.add('hidden'));
    $('btnProjCancel').addEventListener('click', () => $('projModal').classList.add('hidden'));
    $('btnProjSave').addEventListener('click', saveProjModal);
    $('btnProjDelete').addEventListener('click', deleteProj);
    $('projCards').addEventListener('click', (e) => {
      const card = e.target.closest('[data-proj]');
      if (card) openProjModal(card.dataset.proj);
    });

    // 任务安排
    $('btnTaskAdd').addEventListener('click', () => {
      addTask($('taskInput').value, $('taskDue').value, $('taskPriority').value, $('taskProject').value)
        .then(() => { $('taskInput').value = ''; });
    });
    $('taskInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addTask($('taskInput').value, $('taskDue').value, $('taskPriority').value, $('taskProject').value).then(() => { $('taskInput').value = ''; });
    });
    $('taskGroups').addEventListener('change', (e) => {
      const cb = e.target.closest('[data-tasktoggle]');
      if (cb) toggleTask(cb.dataset.tasktoggle);
    });
    $('taskGroups').addEventListener('click', (e) => {
      const del = e.target.closest('[data-taskdel]');
      if (del) deleteTask(del.dataset.taskdel);
    });

    // 实验记录（研究记录）
    $('btnAddNote').addEventListener('click', () => openNoteModal(null));
    $('noteProjFilter').addEventListener('change', renderNotes);
    $('btnNoteClose').addEventListener('click', () => $('noteModal').classList.add('hidden'));
    $('btnNoteCancel').addEventListener('click', () => $('noteModal').classList.add('hidden'));
    $('btnNoteSave').addEventListener('click', saveNoteModal);
    $('btnNoteTemplateEcon').addEventListener('click', () => {
      const ta = $('noteContent');
      if (ta.value.trim()) { if (!confirm('当前内容将被模板替换，继续？')) return; }
      ta.value = NOTE_ECON_TEMPLATE;
    });
    $('btnNoteTemplate').addEventListener('click', () => {
      const ta = $('noteContent');
      if (ta.value.trim()) { if (!confirm('当前内容将被模板替换，继续？')) return; }
      ta.value = NOTE_TEMPLATE;
    });
    $('noteCards').addEventListener('click', (e) => {
      const card = e.target.closest('[data-note]');
      if (card) openNoteModal(card.dataset.note);
    });

    // 论文进度（小论文 / 大论文）
    $('paperTabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-ptab]');
      if (t) { paperTab = t.dataset.ptab; renderPaperTab(); }
    });
    $('btnAddPaper').addEventListener('click', () => (paperTab === 'journal' ? openPaperModal(null) : openThesisModal(null)));
    $('paperCards').addEventListener('click', (e) => {
      const card = e.target.closest('[data-paper]');
      if (card) openPaperModal(card.dataset.paper);
    });
    $('thesisCards').addEventListener('click', (e) => {
      const card = e.target.closest('[data-thesis]');
      if (card) openThesisModal(card.dataset.thesis);
    });
    // 小论文弹窗
    $('btnPaperClose').addEventListener('click', () => $('paperModal').classList.add('hidden'));
    $('btnPaperCancel').addEventListener('click', () => $('paperModal').classList.add('hidden'));
    $('btnPaperSave').addEventListener('click', savePaperModal);
    $('btnPaperDelete').addEventListener('click', deletePaperModal);
    $('btnQueryRank').addEventListener('click', queryPaperRank);
    $('btnHistAdd').addEventListener('click', () => {
      const status = $('histStatus').value;
      const date = $('histDate').value || todayStr();
      const note = $('histNote').value.trim();
      paperDraft.history.push({ status, date, note });
      // 记录动态后同步主状态下拉
      $('paperStatus').value = status;
      $('histNote').value = '';
      $('histDate').value = todayStr();
      renderPaperHistory();
    });
    $('histNote').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('btnHistAdd').click(); }
    });
    // 大论文弹窗
    $('btnThesisClose').addEventListener('click', () => $('thesisModal').classList.add('hidden'));
    $('btnThesisCancel').addEventListener('click', () => $('thesisModal').classList.add('hidden'));
    $('btnThesisSave').addEventListener('click', saveThesisModal);
    $('btnThesisDelete').addEventListener('click', deleteThesisModal);
    // 章节 / 重要节点：添加时清除占位提示、正确编号、滚动到新行并聚焦；输入框回车快速添加下一条
    function addRowTo(containerId, rowHtml, focusSel) {
      const wrap = $(containerId);
      const hint = wrap.querySelector('.ms-hint');
      if (hint) hint.remove();
      const idx = wrap.querySelectorAll('[data-chaprow],[data-msrow]').length;
      wrap.insertAdjacentHTML('beforeend', rowHtml(idx));
      const last = wrap.lastElementChild;
      last.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      const input = last.querySelector(focusSel);
      if (input) input.focus();
    }
    $('btnChapAdd').addEventListener('click', () => addRowTo('thesisChapters', (i) => chapterRow({ title: '', done: false }, i), '[data-chaptitle]'));
    $('btnChapPreset').addEventListener('click', () => {
      if ($('thesisChapters').querySelector('[data-chaprow]') && !confirm('将替换现有章节列表，继续？')) return;
      const preset = ['第1章 绪论', '第2章 文献综述与理论基础', '第3章 研究设计（假设与模型）', '第4章 实证分析（数据与结果）', '第5章 研究结论与政策建议'];
      renderChapterEditor(preset.map((t) => ({ title: t, done: false })));
    });
    $('thesisChapters').addEventListener('click', (e) => {
      const del = e.target.closest('[data-chapdel]');
      if (del) del.closest('[data-chaprow]').remove();
    });
    $('thesisChapters').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-chaptitle]')) {
        e.preventDefault();
        addRowTo('thesisChapters', (i) => chapterRow({ title: '', done: false }, i), '[data-chaptitle]');
      }
    });
    $('btnMsAdd').addEventListener('click', () => addRowTo('thesisMilestones', (i) => milestoneRow({ label: '', date: '', done: false }, i), '[data-mslabel]'));
    $('thesisMilestones').addEventListener('click', (e) => {
      const del = e.target.closest('[data-msdel]');
      if (del) del.closest('[data-msrow]').remove();
    });
    $('thesisMilestones').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('[data-mslabel]')) {
        e.preventDefault();
        addRowTo('thesisMilestones', (i) => milestoneRow({ label: '', date: '', done: false }, i), '[data-mslabel]');
      }
    });

    // 科研日历
    $('calPrev').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); });
    $('calNext').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); });
    $('calToday').addEventListener('click', () => {
      const now = new Date(); calYear = now.getFullYear(); calMonth = now.getMonth(); calSelected = todayStr(); renderCalendar();
    });
    $('calGrid').addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-cell');
      if (!cell || cell.classList.contains('out')) return;
      calSelected = cell.dataset.date;
      renderCalendar();
    });

    // AI 助手：多会话
    document.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => sendChat(QUICK_PROMPTS[b.dataset.quick])));
    $('btnNewChat').addEventListener('click', () => newConversation());
    $('convList').addEventListener('click', (e) => {
      const ren = e.target.closest('[data-convren]');
      if (ren) { e.stopPropagation(); renameConversation(ren.dataset.convren); return; }
      const del = e.target.closest('[data-convdel]');
      if (del) { e.stopPropagation(); deleteConversationById(del.dataset.convdel); return; }
      const item = e.target.closest('[data-conv]');
      if (item && item.dataset.conv !== activeConvId) openConversation(item.dataset.conv);
    });
    $('btnChatSend').addEventListener('click', () => { const v = $('chatInput').value; $('chatInput').value = ''; sendChat(v); });
    $('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = $('chatInput').value; $('chatInput').value = ''; sendChat(v); }
    });
    $('btnClearChat').addEventListener('click', async () => {
      if (!confirm('确认清空全部会话？所有聊天记录将删除且不可恢复。')) return;
      try { await api('/api/chat/history', { method: 'DELETE' }); conversations = []; activeConvId = null; chatMsgs = []; activeSummary = ''; renderChatMsgs(); renderConvList(); toast('全部对话已清空', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    });
  }

  function openSettingsModal() {
    fillSettingsForm();
    $('settingsModal').classList.remove('hidden');
  }

  async function loadWorkbenchData() {
    profile = await api('/api/profile').catch(() => ({}));
    projects = await api('/api/projects').catch(() => []);
    tasks = await api('/api/tasks').catch(() => []);
    notes = await api('/api/notes').catch(() => []);
    papers = await api('/api/papers').catch(() => []);
  }

  // ============ 新手引导（首次使用） ============
  const OB_KEY = 'littable_onboarded_v1';
  const OB_STEPS = [
    {
      emoji: '👋', title: '欢迎使用一站式科研终端',
      desc: '这是为经管类硕博同学打造的<b>一站式科研助手</b>：文献管理、AI 解析、论文进度、科研日历一应俱全。接下来花 2 分钟，手把手带你完成初始设置、认识每个功能。',
      points: [
        { ico: '⚙️', html: '先带你<b>完善个人资料</b>、<b>配置 AI 密钥</b>（这是使用 AI 功能的前提）' },
        { ico: '🧭', html: '再逐个认识 <b>7 大功能模块</b>，知道每块能做什么' },
        { ico: '⏭️', html: '随时可点「跳过引导」，之后也能在 <b>设置</b> 里重新查看' },
      ],
      target: null, center: true,
    },
    {
      emoji: '🎓', title: '第 1 步 · 完善个人资料',
      desc: '点击左下角的<b>个人资料卡片</b>，填写你的姓名、学校、专业和年级。这些信息会显示在首页横幅，学业进度条也会跟着更新。',
      points: [
        { ico: '👤', html: '<b>用户名</b>：你希望在软件里显示的名字' },
        { ico: '🏫', html: '<b>学校 / 院系</b> 和 <b>专业方向</b>：如「XX大学 经济学院 · 应用经济学」' },
        { ico: '📈', html: '<b>学业进度</b>：拖动滑块设定当前毕业进度（0-100%）' },
        { ico: '😊', html: '<b>头像</b>：填一个 emoji 即可，如 🎓 📊 ✨' },
      ],
      target: '#profileCard', view: 'home',
    },
    {
      emoji: '🔑', title: '第 2 步 · 配置 AI（关键！）',
      desc: '点击侧边栏底部的<b>「⚙ 设置」</b>按钮打开 AI 设置。AI 解析、AI 助手、划词翻译都依赖这里的密钥，<b>建议优先配置</b>。',
      points: [
        { ico: '🌐', html: '<b>AI 提供方</b>：默认选「硅基流动 SiliconFlow（DeepSeek）」，免费注册即可用' },
        { ico: '🔐', html: '<b>API 密钥</b>：到 <code>siliconflow.cn</code> 注册后，在「API 密钥」页复制 <code>sk-xxxx</code> 填到这里' },
        { ico: '🤖', html: '<b>模型名称</b>：保持默认 <code>deepseek-ai/DeepSeek-V4-Flash</code> 即可' },
        { ico: '💡', html: '不配置也能用，但只能<b>离线规则提取</b>，AI 解析和 AI 助手不可用' },
      ],
      target: '#btnNavSettings', view: 'home',
    },
    {
      emoji: '📊', title: '第 3 步 · 期刊等级 & 翻译',
      desc: '仍在「⚙ 设置」里，往下还有两项可选配置，让文献管理更强大。',
      points: [
        { ico: '🏅', html: '<b>easyScholar SecretKey</b>：在 easyScholar 官网免费申请，填后点「期刊等级」按钮可自动查询中科院 / ABS / SSCI 分区' },
        { ico: '🈶', html: '<b>翻译提供方</b>：默认用上方 API Key（DeepSeek）；不想配密钥可改选「免费接口」' },
        { ico: '💾', html: '<b>数据保存目录</b>：默认存在<b>安装目录下</b>，想换位置再填，如 <code>D:\\文献库</code>，留空用默认' },
        { ico: '💡', html: '填完点弹窗底部<b>「保存设置」</b>生效' },
      ],
      target: '#btnNavSettings', view: 'home',
    },
    {
      emoji: '📚', title: '文献中心 · 你的核心工作区',
      desc: '这是最常用的模块，管理你读过的所有文献。',
      points: [
        { ico: '⬆️', html: '<b>批量上传 PDF</b>（或拖入窗口）：AI 自动提取标题、作者、摘要、<b>研究背景 / 方法 / 创新点</b>等字段' },
        { ico: '🧪', html: '<b>实证类 / 模型类文库</b>：按研究范式分区，字段自动适配' },
        { ico: '📑', html: '<b>期刊等级</b>：填了 easyScholar 密钥后一键查分区' },
        { ico: '📖', html: '点文献行右侧<b>「阅读」</b>进入 PDF 阅读器：<b>左划词、右翻译</b>，支持高亮和笔记' },
      ],
      target: '.nav-item[data-view="library"]', view: 'library',
    },
    {
      emoji: '📂', title: '项目管理 · 拆解大课题',
      desc: '把研究方向拆成一个个项目，让文献、任务、记录互相联动。',
      points: [
        { ico: '➕', html: '点<b>「＋ 新建项目」</b>，填写项目名称、阶段与说明' },
        { ico: '🔗', html: '为项目<b>关联文献</b>、拆解子任务，进度一目了然' },
        { ico: '🧭', html: '研究记录也能挂到项目下，按项目归档' },
      ],
      target: '.nav-item[data-view="projects"]', view: 'projects',
    },
    {
      emoji: '✅', title: '任务安排 · 待办与计划',
      desc: '用任务清单管理科研节奏，配合首页日历不遗漏任何 Deadline。',
      points: [
        { ico: '✍️', html: '顶部输入框<b>回车快速添加</b>任务，可设<b>优先级</b>和<b>截止日期</b>' },
        { ico: '📅', html: '任务会同步到<b>首页科研日历</b>与「今日待办」' },
        { ico: '☑️', html: '完成后勾选，按项目 / 日期分组查看' },
      ],
      target: '.nav-item[data-view="tasks"]', view: 'tasks',
    },
    {
      emoji: '📮', title: '论文进度 · 投稿 + 学位论文',
      desc: '两个子页签分别管理<b>小论文投稿</b>和<b>大论文进度</b>。',
      points: [
        { ico: '📨', html: '<b>小论文 · 投稿管理</b>：跟踪每篇论文的投稿状态（投稿中 → 外审 → 返修 → 录用），记录时间线' },
        { ico: '🎓', html: '<b>大论文 · 学位论文</b>：划分章节、设置<b>重要节点</b>（如开题、中期、答辩）并倒计时' },
        { ico: '⏳', html: '重要节点会自动显示在首页「倒计时」卡片' },
      ],
      target: '.nav-item[data-view="papers"]', view: 'papers',
    },
    {
      emoji: '🧪', title: '研究记录 · 灵感与实验',
      desc: '随时记录研究想法、实验数据、读书笔记，按 Study 划分。',
      points: [
        { ico: '📝', html: '点<b>「＋ 新建研究记录」</b>，选择记录类型（想法 / 实验 / 笔记等）' },
        { ico: '🧬', html: '内置<b>经管实证研究模板</b>，按 Study 组织多条记录' },
        { ico: '🔍', html: '支持按项目筛选，研究脉络清晰可追溯' },
      ],
      target: '.nav-item[data-view="notes"]', view: 'notes',
    },
    {
      emoji: '🤖', title: 'AI 助手 · 智能对话',
      desc: '像 GPT 一样的多会话对话，还能结合你的文献库提问。',
      points: [
        { ico: '💬', html: '点<b>「＋ 新对话」</b>开启多个会话，左侧可随时切换、重命名、删除' },
        { ico: '🧠', html: '同一对话<b>记住上下文</b>；对话过长会自动<b>压缩摘要</b>，不丢关键信息' },
        { ico: '📚', html: '引用<b>知识库 / 文献库</b>提问，让 AI 帮你查资料、理思路、改表达' },
      ],
      target: '.nav-item[data-view="ai"]', view: 'ai',
    },
    {
      emoji: '🎉', title: '准备就绪，开始科研之旅！',
      desc: '你已经了解了所有功能。建议现在就去：① 配置 AI 密钥 ② 上传第一篇文献试试。',
      points: [
        { ico: '🔑', html: '没配 AI 密钥？去 <b>⚙ 设置 → AI 提供方</b> 补上' },
        { ico: '📄', html: '去 <b>文献中心</b> 上传第一篇 PDF，体验 AI 自动解析' },
        { ico: '🔄', html: '想重看本引导？<b>⚙ 设置 → 重新查看新手引导</b>' },
      ],
      target: null, center: true,
    },
  ];

  let obActive = false;
  let obIndex = 0;

  function obEls() {
    return {
      root: $('onboarding'), backdrop: $('obBackdrop'), spot: $('obSpot'), card: $('obCard'),
      badge: $('obStepBadge'), emoji: $('obEmoji'), title: $('obTitle'), desc: $('obDesc'),
      points: $('obPoints'),
      bar: $('obProgressBar'), dots: $('obDots'), next: $('obNext'), prev: $('obPrev'), skip: $('obSkip'),
    };
  }

  function obMarkDone() {
    try { localStorage.setItem(OB_KEY, '1'); } catch (_) { /* ignore */ }
  }

  function obShouldShow() {
    try { return localStorage.getItem(OB_KEY) !== '1'; } catch (_) { return true; }
  }

  // 定位高亮框到目标元素，卡片跟随其位置（避免超出视口）
  function obPosition() {
    const o = obEls();
    const step = OB_STEPS[obIndex];
    const spot = o.spot, card = o.card;
    if (!step.target || step.center) {
      // 居中欢迎/完成页：隐藏高亮框，卡片居中
      spot.style.opacity = '0';
      card.style.left = '50%';
      card.style.top = '50%';
      card.style.transform = 'translate(-50%, -50%)';
      card.classList.add('ob-center');
      return;
    }
    card.classList.remove('ob-center');
    const target = document.querySelector(step.target);
    if (!target) {
      spot.style.opacity = '0';
      card.style.left = '50%'; card.style.top = '50%'; card.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.style.opacity = '1';
    spot.style.left = (r.left - pad) + 'px';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';

    // 卡片位置：优先放目标右侧，放不下则放左侧；垂直方向用实际卡片高度 clamp
    const cardW = 440, gap = 18;
    let left = r.right + gap;
    let top = r.top;
    if (left + cardW > window.innerWidth - 16) left = r.left - cardW - gap;
    if (left < 16) left = 16;
    const cardH = card.offsetHeight || 320;
    top = Math.max(12, Math.min(top, window.innerHeight - cardH - 12));
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    card.style.transform = 'none';
  }

  function obRenderDots() {
    const o = obEls();
    o.dots.innerHTML = OB_STEPS.map((_, i) => `<span class="ob-dot${i === obIndex ? ' active' : ''}"></span>`).join('');
  }

  function obRender() {
    const o = obEls();
    const step = OB_STEPS[obIndex];
    const total = OB_STEPS.length;
    o.badge.textContent = `${obIndex + 1} / ${total}`;
    o.emoji.textContent = step.emoji;
    o.title.textContent = step.title;
    o.desc.innerHTML = step.desc;
    // 要点列表
    if (step.points && step.points.length) {
      o.points.innerHTML = step.points.map((p) => `<li data-ico="${p.ico}">${p.html}</li>`).join('');
      o.points.classList.remove('hidden');
    } else {
      o.points.innerHTML = '';
      o.points.classList.add('hidden');
    }
    o.bar.style.width = Math.round(((obIndex + 1) / total) * 100) + '%';
    const isFirst = obIndex === 0;
    const isLast = obIndex === total - 1;
    o.prev.classList.toggle('hidden', isFirst);
    o.skip.classList.toggle('hidden', isLast);
    o.next.textContent = isLast ? '开始使用' : '下一步';
    obRenderDots();
    obPosition();
  }

  function obStart() {
    obActive = true;
    obIndex = 0;
    const o = obEls();
    o.root.classList.remove('hidden');
    obRender();
  }

  function obStop() {
    obActive = false;
    obEls().root.classList.add('hidden');
  }

  function obFinish() {
    obMarkDone();
    obStop();
  }

  function obGoto(i) {
    if (i < 0 || i >= OB_STEPS.length) return;
    obIndex = i;
    const step = OB_STEPS[i];
    // 若该步绑定了视图，先切换到对应视图，确保界面可见
    if (step.view) switchView(step.view);
    // 等待视图切换/渲染后再定位高亮
    requestAnimationFrame(() => requestAnimationFrame(obRender));
  }

  function obBind() {
    const o = obEls();
    o.next.addEventListener('click', () => {
      if (obIndex >= OB_STEPS.length - 1) { obFinish(); return; }
      obGoto(obIndex + 1);
    });
    o.prev.addEventListener('click', () => obGoto(obIndex - 1));
    o.skip.addEventListener('click', obFinish);
    window.addEventListener('resize', () => { if (obActive) obPosition(); });
    const replayBtn = $('btnReplayOnboarding');
    if (replayBtn) replayBtn.addEventListener('click', () => {
      el.settingsModal.classList.add('hidden');
      obIndex = 0;
      obStart();
    });
  }

  function maybeStartOnboarding() {
    obBind();
    if (obShouldShow()) {
      // 稍微延后，等首屏渲染完成
      setTimeout(obStart, 350);
    }
  }

  // 供「设置」中重新查看引导
  window.__replayOnboarding = () => {
    obIndex = 0;
    obStart();
  };

  // ============ 初始化 ============
  async function init() {
    bindUpload();
    bindGrid();
    bindLibBar();
    bindEvents();
    bindWorkbench();
    bindPdfReader();
    await Promise.all([loadItems(), loadSettings(), loadCollections(), loadWorkbenchData()]);
    items.filter((i) => i.filename && !i.thumb).slice(0, 10).forEach((i) => ensureThumb(i));
    renderLibBar();
    switchView('home');
    maybeStartOnboarding();
  }

  init();
})();
