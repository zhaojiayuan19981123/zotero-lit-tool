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
    importedAt: { key: 'importedAt', label: '导入时间', type: 'time', w: 118 },
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
    thoughts: { key: 'thoughts', label: '我的思考', type: 'md', w: 220 },
    model: { key: 'model', label: '模型', type: 'md', ai: true, w: 220 },
    paramDiscussion: { key: 'paramDiscussion', label: '参数讨论', type: 'md', ai: true, w: 260 },
  };
  // 两个文库各自的字段排布（界面分开，不一致）
  const TYPE_ORDER = {
    empirical: ['importedAt', 'title', 'authors', 'journal', 'year', 'doi', 'keywords', 'abstract', 'background',
      'theory', 'method', 'researchDesign', 'constructs', 'results', 'conclusion', 'criticalThinking', 'thoughts', 'summary', 'innovation'],
    model: ['importedAt', 'title', 'authors', 'journal', 'year', 'doi', 'keywords', 'abstract', 'background',
      'model', 'method', 'paramDiscussion', 'results', 'thoughts', 'summary', 'innovation'],
  };
  const LIB_META = {
    empirical: { label: '实证类文库', icon: '🧪' },
    model: { label: '模型类文库', icon: '🧮' },
  };

  const STATUS_LABEL = { done: '已完成', parsing: '解析中', pending: '待解析', error: '解析失败' };
  const PROGRESS_LIST = ['未阅读', '阅读中', '已阅读'];
  const HIGHLIGHT_COLORS = { yellow: '#ffe08a', green: '#b5e6b5', blue: '#a8d4f5', pink: '#f7b8d0' };
  const UNCLASSIFIED = '__uncategorized__';

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
  let colWidths = {}; // 用户调节的列宽 { key: px }（持久化到后端 settings，跨启动保留）
  const selectedIds = new Set(); // 文献中心勾选的记录 id（批量操作的目标集合）
  let lastCheckedId = null; // Shift 区间选择的锚点
  let colWidthsSaveTimer = null;
  function persistColWidths() {
    clearTimeout(colWidthsSaveTimer);
    colWidthsSaveTimer = setTimeout(() => {
      api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ colWidths }) }).catch(() => {});
    }, 400);
  }
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
  // 多模型：供应商目录 + 已配置的模型列表 + 当前激活项（顶栏切换用）
  let providers = [];       // [{id,name,baseURL,keyHint,models:[{id,name,vision}]}]
  let profiles = [];        // 已保存的模型配置
  let activeProfileId = '';
  let activeModelInfo = null; // {id,label,providerName,model,vision}
  let activeVisionInfo = null; // 「两段式看图」实际生效的视觉模型（后端已按「指定 → 自动兜底」判定）
  let editingProfileId = null; // 设置弹窗里正在编辑的配置 id（null = 新增）
  // 科研日历状态
  let calYear = new Date().getFullYear();
  let calMonth = new Date().getMonth(); // 0-based
  let calSelected = null; // 'YYYY-MM-DD'
  let ideas = [];
  let ideasLoaded = false;
  let editingIdeaId = null;
  const incubatingIdeaIds = new Set();
  const ideaErrors = new Map();
  let markdownNotes = [];
  let markdownNotesLoaded = false;
  let activeMarkdownNoteId = null;
  let markdownSaveTimer = null;
  let reviews = [];
  let reviewsLoaded = false;
  let activeReviewId = null;
  let reviewSaveTimer = null;
  const reviewingIds = new Set();
  const reviewErrors = new Map();
  let calendarData = { events: [], preferences: { lunar: true, solarTerms: true, festivals: true } };
  let classMoveIds = [];
  let updateStatus = null;
  let updatePollTimer = null;
  let updateActionBusy = false;

  const $ = (id) => document.getElementById(id);
  const el = {
    searchInput: $('searchInput'), statusFilter: $('statusFilter'), sortField: $('sortField'),
    theadRow: $('theadRow'), tbody: $('tbody'), emptyState: $('emptyState'), statBadge: $('statBadge'),
    bulkBar: $('bulkBar'), bulkCount: $('bulkCount'), bulkHint: $('bulkHint'),
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

  // ============ 流式请求（SSE） ============
  // 后端逐字返回 `data: {json}`，最后一条固定 `data: [DONE]`。
  // onEvent(obj) 每条回调一次；signal 用于「停止生成」。
  // 返回 { full, error, aborted }，不抛异常，调用方只需看返回值。
  async function streamSSE(path, body, { onEvent, signal } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (isAbortError(e)) return { full: '', aborted: true };
      return { full: '', error: '网络请求失败：' + e.message };
    }

    // 业务错误（缺 Key / 参数错）走普通 JSON，不走 SSE
    if (!res.ok && !/event-stream/i.test(res.headers.get('content-type') || '')) {
      const d = await res.json().catch(() => ({}));
      return { full: '', error: d.error || `请求失败 (${res.status})` };
    }
    if (!res.body) return { full: '', error: '当前环境不支持流式响应' };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let aborted = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let obj;
          try { obj = JSON.parse(payload); } catch (_) { continue; }
          if (obj.delta) full += obj.delta;
          if (onEvent) onEvent(obj);
        }
      }
    } catch (e) {
      if (isAbortError(e)) aborted = true;
      else return { full, error: '读取流式响应失败：' + e.message };
    }
    return { full, aborted };
  }

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

  // 全部用户可见 AI 内容与笔记预览共用同一个 Markdown 渲染器。
  // 原始 HTML 经过 DOMPurify 白名单过滤；公式由 KaTeX 渲染，表格使用 GFM 语法。
  if (window.marked?.use) {
    window.marked.use({
      gfm: true,
      breaks: true,
      extensions: [
        {
          name: 'blockKatex', level: 'block',
          start(src) { return src.indexOf('$$'); },
          tokenizer(src) {
            const match = /^\$\$\s*([\s\S]+?)\s*\$\$(?:\n|$)/.exec(src);
            return match ? { type: 'blockKatex', raw: match[0], text: match[1] } : undefined;
          },
          renderer(token) {
            try { return window.katex.renderToString(token.text, { displayMode: true, throwOnError: false, output: 'htmlAndMathml' }); }
            catch (_) { return `<pre>${esc(token.text)}</pre>`; }
          },
        },
        {
          name: 'inlineKatex', level: 'inline',
          start(src) { return src.indexOf('$'); },
          tokenizer(src) {
            const match = /^\$([^$\n]+?)\$/.exec(src);
            return match ? { type: 'inlineKatex', raw: match[0], text: match[1] } : undefined;
          },
          renderer(token) {
            try { return window.katex.renderToString(token.text, { displayMode: false, throwOnError: false, output: 'htmlAndMathml' }); }
            catch (_) { return `<code>${esc(token.text)}</code>`; }
          },
        },
      ],
    });
  }

  if (window.DOMPurify?.addHook) {
    window.DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
      if (data.attrName === 'style') {
        const allowed = String(data.attrValue || '').split(';').map((part) => part.trim()).filter((part) => {
          return /^(?:font-family\s*:\s*[\w\s,"'-]+|font-size\s*:\s*\d{1,2}(?:\.\d+)?(?:px|pt|em|rem|%)|text-align\s*:\s*(?:left|center|right|justify)|background-color\s*:\s*(?:#[0-9a-f]{3,8}|[a-z]+)|color\s*:\s*(?:#[0-9a-f]{3,8}|[a-z]+))$/i.test(part);
        });
        data.attrValue = allowed.join('; ');
        data.keepAttr = allowed.length > 0;
      }
      if (data.attrName === 'href' && !/^(?:https?:|mailto:|#|\/)/i.test(String(data.attrValue || ''))) data.keepAttr = false;
    });
  }

  function renderMarkdown(value) {
    const source = String(value || '');
    if (!window.marked?.parse || !window.DOMPurify) return esc(source).replace(/\n/g, '<br />');
    const html = window.marked.parse(source);
    const clean = window.DOMPurify.sanitize(html, {
      ADD_TAGS: ['mark', 'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'mspace', 'mtext'],
      ADD_ATTR: ['align', 'style', 'target', 'rel', 'encoding', 'xmlns', 'aria-hidden'],
    });
    const holder = document.createElement('template');
    holder.innerHTML = clean;
    holder.content.querySelectorAll('a[href]').forEach((link) => {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });
    return holder.innerHTML;
  }

  async function loadItems() { items = await api('/api/literature'); render(); }
  async function loadSettings() {
    settings = await api('/api/settings');
    fillSettingsForm();    // 恢复用户调节过的表格列宽
    if (settings.colWidths && typeof settings.colWidths === 'object' && !Array.isArray(settings.colWidths)) {
      colWidths = { ...settings.colWidths };
    }
    // 旧版本的默认紫色在 1.4.0 迁移为新的研究蓝；用户选择的其他自定义色保留。
    renderThemePresets();
    const savedTheme = String(settings.themeColor || '').toUpperCase();
    applyTheme(!savedTheme || savedTheme === '#81308C' ? DEFAULT_THEME : settings.themeColor, false);
    // 恢复全局字体与字号
    applyFont(settings.appFont || '');
    applyFontSize(settings.fontSize || 'medium');
    // 恢复行高偏好
    applyRowHeight(settings.rowHeight || 'm');
  }

  // 行高：s 紧凑 / m 标准 / l 宽松 / xl 特大（缩略图随档位缩放），持久化到设置
  function applyRowHeight(rh) {
    if (!['s', 'm', 'l', 'xl'].includes(rh)) rh = 'm';
    rowHeight = rh;
    el.gridWrap.className = 'grid-wrap rh-' + rh;
    document.querySelectorAll('.rh-btn').forEach((b) => b.classList.toggle('active', b.dataset.rh === rh));
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
    const sameType = items.filter((i) => (i.docType || 'empirical') === lib.type);
    const uncategorized = sameType.filter((i) => !i.collectionId).length;
    $('colChips').innerHTML = `<div class="col-chip${lib.collectionId === UNCLASSIFIED ? ' active' : ''}" data-collection="${UNCLASSIFIED}" data-colname="未分类">
      ▣ 未分类 <span class="side-count">${uncategorized || ''}</span>
    </div>` + cols.map((c) => {
      const n = sameType.filter((i) => i.collectionId === c.id).length;
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
      const id = e.dataTransfer?.getData('text/lit-id') || e.dataTransfer?.getData('text/plain');
      if (!id) return;
      try {
        await moveLiterature([id], t.dataset.collection);
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
      const id = e.dataTransfer?.getData('text/lit-id') || e.dataTransfer?.getData('text/plain');
      if (!id) return;
      try {
        const targetType = root.dataset.rootlib;
        const item = items.find((it) => it.id === id);
        if (item && (item.docType || 'empirical') !== targetType) {
          await api('/api/literature/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docType: targetType, collectionId: null }) });
          await Promise.all([loadItems(), loadCollections()]);
        } else await moveLiterature([id], null);
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

  async function moveLiterature(ids, collectionId) {
    const target = !collectionId || collectionId === UNCLASSIFIED ? null : collectionId;
    await api('/api/literature/batch-collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, collectionId: target }),
    });
    await Promise.all([loadItems(), loadCollections()]);
  }

  function openClassModal(ids) {
    classMoveIds = [...new Set((ids || []).filter(Boolean))];
    if (!classMoveIds.length) return;
    const picked = items.filter((item) => classMoveIds.includes(item.id));
    const types = [...new Set(picked.map((item) => item.docType || 'empirical'))];
    if (types.length !== 1) { toast('请一次只移动同一文库中的文献', 'error'); return; }
    const type = types[0];
    const cols = collections.filter((c) => c.docType === type);
    $('classTarget').innerHTML = '<option value="">未分类</option>' + cols.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    $('classModalHint').textContent = `将 ${classMoveIds.length} 篇${type === 'model' ? '模型类' : '实证类'}文献移动到：`;
    $('classModal').classList.remove('hidden');
  }

  async function saveClassMove() {
    try {
      await moveLiterature(classMoveIds, $('classTarget').value || null);
      $('classModal').classList.add('hidden');
      toast(`已移动 ${classMoveIds.length} 篇文献`, 'success');
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
    cols.push({ key: 'actions', label: '操作', type: 'actions', w: 122 });
    return cols.map((c) => ({ ...c, w: colWidths[c.key] || c.w }));
  }

  // ============ 渲染 ============
  function filteredItems() {
    let list = items.filter((i) => (i.docType || 'empirical') === lib.type);
    if (lib.collectionId === UNCLASSIFIED) list = list.filter((i) => !i.collectionId);
    else if (lib.collectionId) list = list.filter((i) => i.collectionId === lib.collectionId);
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
    renderHead(); renderBody(); renderBulkBar();
    const scope = filteredItems();
    const done = scope.filter((i) => i.status === 'done').length;
    const libName = lib.collectionId
      ? collections.find((c) => c.id === lib.collectionId)?.name || '分类'
      : LIB_META[lib.type].label;
    el.statBadge.textContent = `${libName} · ${scope.length} 条 · 已完成 ${done}`;
  }

  // ============ 批量选择 ============
  // 选中集合跨分类/筛选保留（用户勾选后再切 tab，勾选不会莫名丢失）；
  // 但渲染时只反映当前可见列表的选中情况。
  function renderBulkBar() {
    if (!el.bulkBar) return;
    const list = filteredItems();
    const visiblePicked = list.filter((i) => selectedIds.has(i.id)).length;
    el.bulkBar.classList.toggle('hidden', selectedIds.size === 0);
    if (el.bulkCount) el.bulkCount.textContent = String(selectedIds.size);
    if (el.bulkHint) {
      const extra = selectedIds.size - visiblePicked;
      el.bulkHint.textContent = extra > 0 ? `（其中 ${extra} 篇在当前筛选外）` : '';
    }
  }
  function setSelected(id, on) { if (on) selectedIds.add(id); else selectedIds.delete(id); render(); }
  function selectAllVisible(on) { filteredItems().forEach((i) => { if (on) selectedIds.add(i.id); else selectedIds.delete(i.id); }); render(); }
  function invertVisible() { filteredItems().forEach((i) => { if (selectedIds.has(i.id)) selectedIds.delete(i.id); else selectedIds.add(i.id); }); render(); }
  function clearSelection() { selectedIds.clear(); render(); }

  function renderHead() {
    const cols = buildColumns();
    // table-layout: fixed + colgroup：列宽完全由用户设置（可放大也可缩小，不受内容撑开）
    const grid = el.theadRow.closest('table');
    let colgroup = document.getElementById('gridCols');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      colgroup.id = 'gridCols';
      grid.insertBefore(colgroup, grid.firstChild);
    }
    const widths = [44, 40, ...cols.map((c) => c.w)];
    colgroup.innerHTML = widths.map((w) => `<col style="width:${w}px" />`).join('');
    grid.style.width = widths.reduce((a, b) => a + b, 0) + 'px';
    // 表头复选框反映当前「已选中 / 全选 / 半选」状态
    const list = filteredItems();
    const picked = list.filter((i) => selectedIds.has(i.id)).length;
    const allChecked = list.length > 0 && picked === list.length;
    const indeterminate = picked > 0 && !allChecked;
    el.theadRow.innerHTML =
      `<th class="cell-check"><input type="checkbox" id="chkAll" title="全选 / 取消全选当前列表"${allChecked ? ' checked' : ''} /></th>` +
      `<th class="cell-num">#</th>` +
      cols.map((c) => `
        <th data-col="${c.key}" title="${esc(c.label)}（拖动右缘调宽，双击手柄复位）"><div class="th-inner">
          <span class="th-ico">${typeIcon(c.type)}</span><span class="th-name">${esc(c.label)}</span>
          ${c.ai ? '<span class="col-ai">AI 生成</span>' : ''}
        </div><span class="col-resize" data-resize="${c.key}"></span></th>`).join('');
    // innerHTML 重建后 indeterminate 会丢失，必须重新赋一次
    const chkAll = el.theadRow.querySelector('#chkAll');
    if (chkAll) chkAll.indeterminate = indeterminate;
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
      if (selectedIds.has(it.id)) tr.classList.add('row-selected');
      tr.innerHTML = `<td class="cell-check"><input type="checkbox" data-check${selectedIds.has(it.id) ? ' checked' : ''} /></td>` +
        `<td class="cell-num">${idx + 1}</td>` +
        cols.map((c) => `<td>${renderCell(c, it)}</td>`).join('');
      tr.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/lit-id', it.id);
        e.dataTransfer.setData('text/plain', it.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      el.tbody.appendChild(tr);
    });
  }

  function renderCell(c, it) {
    switch (c.type) {
      case 'time': {
        const v = it.importedAt || it.createdAt || '';
        if (!v) return '<span class="cell-empty">—</span>';
        const d = new Date(v);
        if (isNaN(d)) return `<div class="clamp cell-text">${esc(v)}</div>`;
        const p2 = (n) => String(n).padStart(2, '0');
        return `<div class="clamp cell-text" title="导入时间：${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}">${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}</div>`;
      }
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
          <button class="icon-btn" data-act="collection" title="移动到分类">▣</button>
          <button class="icon-btn danger" data-act="del" title="删除">🗑</button></div>`;
      case 'rank': {
        const v = it.journalRank || '';
        const btn = it.journal
          ? `<button class="lit-rank-refresh${rankLoadingIds.has(it.id) ? ' spinning' : ''}" data-refreshrank="${it.id}" title="单独更新该文献的期刊等级（按当前期刊名重新查询）">${rankLoadingIds.has(it.id) ? '⟳' : '⟳ 更新'}</button>`
          : '';
        let body;
        if (!v) {
          body = it.journalRankError
            ? `<span class="cell-empty" title="${esc(it.journalRankError)}" style="color:var(--orange)">查询失败</span>`
            : '<span class="cell-empty">—</span>';
        } else {
          body = `<div class="clamp rank-cell" title="${esc(v)}">${rankChips(it.journalRankDetail)}</div>`;
        }
        return `<div class="rank-pos">${body}${btn}</div>`;
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
    return renderMarkdown(v);
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
      if (e.target.closest('#viewMarkdown, #mdDropZone, #viewReviewer, #reviewDropZone')) return;
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; overlay.classList.remove('hidden'); }
    });
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) overlay.classList.add('hidden'); });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      overlay.classList.add('hidden');
      if (e.target.closest('#viewMarkdown, #mdDropZone, #viewReviewer, #reviewDropZone')) return;
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
    if (lib.collectionId && lib.collectionId !== UNCLASSIFIED) form.append('collectionId', lib.collectionId);
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
      // 多篇并发解析：并发数按篇数自适应（最多 8），显著缩短批量解析时间
      const concurrency = Math.max(1, Math.min(8, ids.length));
      await api('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, docType: docType || undefined, concurrency }) });
      await loadItems();
      const errs = items.filter((i) => ids.includes(i.id) && i.status === 'error');
      if (errs.length) toast(`解析完成，${errs.length} 篇失败`, 'error'); else toast('AI 解析完成，字段已自动写入', 'success');
    } catch (e) { toast('解析失败：' + e.message, 'error'); await loadItems(); }
  }

  // ============ 表格事件 ============
  function bindGrid() {
    el.tbody.addEventListener('click', (e) => {
      // 行复选框：点击复选框本身只切换选中，不触发行内其他操作
      const chk = e.target.closest('[data-check]');
      if (chk) {
        e.stopPropagation();
        const id = chk.closest('tr').dataset.id;
        setSelected(id, chk.checked);
        return;
      }
      const rr = e.target.closest('[data-refreshrank]');
      if (rr) { e.stopPropagation(); refreshLitRank(rr.dataset.refreshrank); return; }
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
        else if (act.dataset.act === 'collection') openClassModal([id]);
        else if (act.dataset.act === 'del') deleteItem(id);
        return;
      }
      // 按住 Shift 点击行 = 区间选择；按住 Ctrl/Cmd 点击行 = 追加选择
      const tr = e.target.closest('tr[data-id]');
      if (tr && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const rowId = tr.dataset.id;
        if (e.shiftKey) {
          const list = filteredItems().map((i) => i.id);
          const anchor = lastCheckedId && list.indexOf(lastCheckedId) >= 0 ? lastCheckedId : rowId;
          const a = list.indexOf(anchor), b = list.indexOf(rowId);
          if (a >= 0 && b >= 0) for (let k = Math.min(a, b); k <= Math.max(a, b); k++) selectedIds.add(list[k]);
        } else {
          if (selectedIds.has(rowId)) selectedIds.delete(rowId); else selectedIds.add(rowId);
        }
        lastCheckedId = rowId;
        render();
        return;
      }
      const open = e.target.closest('[data-open]'); if (open) openDrawer(open.dataset.open);
    });
    // 表头全选框
    el.theadRow.addEventListener('click', (e) => {
      const all = e.target.closest('#chkAll');
      if (!all) return;
      e.stopPropagation();
      selectAllVisible(all.checked);
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
    selectedIds.delete(id);
    await loadItems(); await loadCollections(); toast('已删除', 'success');
  }

  // ============ 批量操作 ============
  function pickIdsOrWarn(minCount) {
    const ids = [...selectedIds];
    if (ids.length < (minCount || 1)) { toast('请先勾选要操作的文献', 'error'); return null; }
    return ids;
  }

  // 批量删除：真实删除记录 + 各自的 PDF 文件，删完清空选中
  async function batchDelete() {
    const ids = pickIdsOrWarn();
    if (!ids) return;
    const withPdf = items.filter((i) => ids.includes(i.id) && i.filePath).length;
    const ok = confirm(
      `确认删除选中的 ${ids.length} 篇文献？\n\n` +
      `· 记录将从文库中永久移除\n` +
      `· 其中 ${withPdf} 篇的 PDF 附件文件也会一并删除\n\n` +
      `此操作不可撤销，删除后如需恢复必须重新导入 PDF。`
    );
    if (!ok) return;
    try {
      const r = await api('/api/literature/batch-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      });
      if (currentId && r.deleted?.includes(currentId)) closeDrawer();
      r.deleted?.forEach((id) => selectedIds.delete(id));
      await loadItems(); await loadCollections();
      let msg = `已删除 ${r.deleted?.length || 0} 篇文献`;
      if (r.filesRemoved) msg += `，清理 PDF 文件 ${r.filesRemoved} 个`;
      if (r.notFound?.length) msg += `（${r.notFound.length} 篇已不存在）`;
      toast(msg, 'success');
    } catch (e) { toast('批量删除失败：' + e.message, 'error'); }
  }

  // 解析选中：只解析勾选的文献，且跳过已完成/解析中的（增量补齐）
  async function batchParse() {
    const ids = pickIdsOrWarn();
    if (!ids) return;
    const all = items.filter((i) => ids.includes(i.id));
    const todo = all.filter((i) => i.status !== 'done' && i.status !== 'parsing');
    const skipped = all.length - todo.length;
    if (!todo.length) {
      toast(`选中的 ${all.length} 篇都已解析完成。若需重跑请用「批量重新解析」`, 'error');
      return;
    }
    const ok = confirm(
      `将对选中的 ${todo.length} 篇文献执行 AI 解析。\n` +
      (skipped ? `（已跳过 ${skipped} 篇已完成/解析中的文献）\n` : '') +
      `\n解析会调用大模型接口，可能产生费用与等待时间。确认继续？`
    );
    if (!ok) return;
    toast(`开始解析 ${todo.length} 篇…`);
    await parseIds(todo.map((i) => i.id));
  }

  // 批量重新解析：忽略解析状态，强制重跑（含已完成的）
  async function batchReparse() {
    const ids = pickIdsOrWarn();
    if (!ids) return;
    const all = items.filter((i) => ids.includes(i.id));
    const parsing = all.filter((i) => i.status === 'parsing').length;
    const ok = confirm(
      `将对选中的 ${all.length} 篇文献强制重新解析。\n\n` +
      `· 已有的解析结果会被新一轮结果覆盖\n` +
      `· 你手动编辑过的字段也会被 AI 覆盖\n` +
      (parsing ? `· 其中 ${parsing} 篇正在解析中，将自动跳过\n` : '') +
      `\n确认继续？`
    );
    if (!ok) return;
    try {
      toast(`开始重新解析 ${all.length} 篇…`);
      const r = await api('/api/literature/batch-reparse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, docType: lib.type }),
      });
      await loadItems();
      const total = r.total ?? 0;
      const failed = r.failed ?? 0;
      const skippedTip = r.skipped?.length ? `，跳过 ${r.skipped.length} 篇（解析中）` : '';
      if (total === 0) toast(r.message || '没有可重新解析的文献', 'error');
      else if (failed) toast(`重新解析完成：成功 ${total - failed} 篇，失败 ${failed} 篇${skippedTip}`, 'error');
      else toast(`批量重新解析完成，共 ${total} 篇${skippedTip}`, 'success');
    } catch (e) { toast('批量重新解析失败：' + e.message, 'error'); await loadItems(); }
  }

  // 批量标记阅读进度
  async function batchProgress() {
    const ids = pickIdsOrWarn();
    if (!ids) return;
    const pick = prompt(`将选中的 ${ids.length} 篇标记为阅读进度：\n\n1 = 未阅读\n2 = 阅读中\n3 = 已阅读\n\n请输入 1 / 2 / 3`, '1');
    if (pick === null) return;
    const map = { 1: '未阅读', 2: '阅读中', 3: '已阅读' };
    const progress = map[String(pick).trim()];
    if (!progress) { toast('请输入 1、2 或 3', 'error'); return; }
    try {
      await api('/api/literature/batch-progress', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, readingProgress: progress }),
      });
      await loadItems();
      toast(`已将 ${ids.length} 篇标记为「${progress}」`, 'success');
    } catch (e) { toast('标记失败：' + e.message, 'error'); }
  }

  // 批量更新期刊等级：复用单条刷新接口，串行并显示进度
  async function batchRank() {
    const ids = pickIdsOrWarn();
    if (!ids) return;
    const targets = items.filter((i) => ids.includes(i.id) && String(i.journal || '').trim());
    const noJournal = ids.length - targets.length;
    if (!targets.length) { toast('选中的文献都没有期刊名，请先解析或手动填写「期刊/会议」', 'error'); return; }
    const ok = confirm(
      `将为选中的 ${targets.length} 篇文献重新查询期刊等级。\n` +
      (noJournal ? `（${noJournal} 篇没有期刊名，将跳过）\n` : '') +
      `\n查询需要逐条调用 easyScholar 接口，请稍候。确认继续？`
    );
    if (!ok) return;
    let done = 0, fail = 0;
    for (const it of targets) {
      try { const r = await refreshLitRank(it.id, { silent: true }); if (r) done++; else fail++; }
      catch (_) { fail++; }
      toast(`更新期刊等级… ${done + fail}/${targets.length}`);
    }
    await loadItems();
    if (fail) toast(`期刊等级更新完成：成功 ${done} 篇，失败 ${fail} 篇`, 'error');
    else toast(`期刊等级更新完成，共 ${done} 篇`, 'success');
  }

  // ============ 期刊等级：手动单独更新（文献中心） ============
  const rankLoadingIds = new Set(); // 正在刷新等级的记录 id（按钮转圈）
  async function refreshLitRank(id, opts = {}) {
    const silent = !!opts.silent;
    const it = items.find((x) => x.id === id);
    if (!it) return false;
    if (!String(it.journal || '').trim()) {
      if (!silent) toast('该文献没有期刊名，请先在「编辑」中填写「期刊/会议」字段', 'error');
      return false;
    }
    rankLoadingIds.add(id); render();
    try {
      const updated = await api(`/api/literature/${id}/refresh-rank`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const idx = items.findIndex((x) => x.id === id); if (idx >= 0) items[idx] = updated;
      if (!silent) toast(updated.journalRank ? `✅ 等级已更新：${updated.journalRank}` : '未查询到该期刊等级', updated.journalRank ? 'success' : 'error');
      return !!updated.journalRank;
    } catch (e) {
      const cur = items.find((x) => x.id === id);
      if (cur) cur.journalRankError = e.message;
      if (!silent) toast('更新失败：' + e.message, 'error');
      return false;
    } finally {
      rankLoadingIds.delete(id); render();
    }
  }
  // 批量：按当前筛选列表逐篇刷新等级（顺延请求，避免触发 easyScholar 限流）
  async function refreshAllRanks() {
    const list = filteredItems().filter((i) => String(i.journal || '').trim());
    if (!list.length) { toast('当前列表没有已识别期刊名的文献', 'error'); return; }
    let ok = 0, fail = 0;
    for (let i = 0; i < list.length; i++) {
      toast(`正在更新期刊等级 ${i + 1}/${list.length}…`);
      const success = await refreshLitRank(list[i].id, { silent: true });
      if (success) ok++; else fail++;
    }
    toast(`期刊等级更新完成：成功 ${ok} 篇${fail ? `，失败 ${fail} 篇（未配置密钥 / 期刊未被收录）` : ''}`, ok ? 'success' : 'error');
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
      .filter((k) => !['title', 'authors', 'journal', 'year', 'doi', 'keywords', 'importedAt'].includes(k));
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
      <section style="margin-bottom:18px"><h4 style="margin:0 0 8px;font-size:13px;color:var(--primary);display:flex;align-items:center;gap:6px"><span style="width:4px;height:14px;background:var(--primary);border-radius:2px"></span>💭 我的思考<span class="col-ai">手写</span></h4>
        <textarea id="drawerThoughts" class="drawer-thoughts" rows="4" placeholder="写下你自己的小想法：疑问、灵感、与课题的联系…">${esc(it.thoughts || '')}</textarea>
        <button id="btnSaveDrawerThoughts" class="btn btn-primary" style="margin-top:8px">保存思考</button>
      </section>
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
    const z = uiZoom(); // 字号缩放时坐标换算
    el.fieldsPop.style.top = ((rect.bottom + 6) / z) + 'px';
    el.fieldsPop.style.left = (rect.left / z) + 'px';
  }

  // ============ 编辑 ============
  function openEdit() {
    const it = items.find((x) => x.id === currentId); if (!it) return;
    // importedAt 为系统字段，不在编辑表单中出现
    const fields = TYPE_ORDER[it.docType || lib.type].filter((k) => k !== 'importedAt')
      .map((k) => [k, k === 'method' && it.docType === 'model' ? '求解方法' : CONTENT_COLS[k].label]);
    el.editBody.innerHTML = fields.map(([key, label]) => `
      <label class="field"><span>${label}</span><textarea data-key="${key}" rows="3">${esc(it[key] || '')}</textarea></label>`).join('');
    el.editModal.classList.remove('hidden');
  }
  async function saveEdit() {
    const patch = {};
    el.editBody.querySelectorAll('[data-key]').forEach((n) => { patch[n.dataset.key] = n.value; });
    const prev = items.find((x) => x.id === currentId);
    const journalChanged = prev && 'journal' in patch
      && String(prev.journal || '').trim() !== String(patch.journal || '').trim();
    const updated = await api('/api/literature/' + currentId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const idx = items.findIndex((x) => x.id === currentId); if (idx >= 0) items[idx] = updated;
    el.editModal.classList.add('hidden'); render(); renderDrawer(); toast('已保存', 'success');
    // 期刊名被修改：自动按新期刊名重新查询等级
    if (journalChanged && String(patch.journal || '').trim()) {
      toast('期刊名已修改，正在重新查询等级…');
      refreshLitRank(currentId);
    }
  }

  // ============ 世图科研下载助手 ============
  let wlItems = [];            // 解析结果 [{ title, url, checked, done, imported }]

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
      // 用「文献中心当前是否真的存在这篇」判断，而不是会话标记：
      // 这样用户误删后，条目会自动回到「可下载并导入」状态，能重新导入。
      const imported = wlInLibrary(it);
      let state = '';
      if (it.state === 'downloading') state = '<span class="wl-done">⏳ 下载中…</span>';
      else if (it.state === 'error') state = `<span class="wl-err" title="${esc(it.error || '')}">✗ 失败</span>`;
      else if (imported) {
        state = '<span class="wl-imported">📥 已在文献中心</span>'
          + `<button class="tb-btn" data-wlredl="${i}" title="重新下载 PDF 并覆盖导入（文献中心里已删除时可恢复）">↻ 重新导入</button>`;
      } else state = `<button class="tb-btn" data-wldl="${i}">⬇ 下载并导入</button>`;
      return `<div class="wl-item${it.state === 'error' ? ' wl-item-error' : ''}">
        <input type="checkbox" data-wlchk="${i}" ${it.checked ? 'checked' : ''} />
        <span class="wl-item-title" title="${esc(it.title)}">${esc(it.title)}</span>
        <span class="wl-item-url" title="${esc(it.url)}">${esc(it.url)}</span>
        <span class="wl-item-actions">
          ${state}
        </span>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-wlchk]').forEach((c) => c.addEventListener('change', () => { wlItems[parseInt(c.dataset.wlchk, 10)].checked = c.checked; }));
    box.querySelectorAll('[data-wldl]').forEach((b) => b.addEventListener('click', () => {
      const it = wlItems[parseInt(b.dataset.wldl, 10)];
      wlDownloadOne(it, true);
    }));
    // 重新导入：先把该条在文献中心的旧记录清掉（若还在），再重新下载写入
    box.querySelectorAll('[data-wlredl]').forEach((b) => b.addEventListener('click', () => {
      const it = wlItems[parseInt(b.dataset.wlredl, 10)];
      wlRedownloadOne(it);
    }));
  }

  // 判断某条世图条目当前是否已存在于文献中心（按标题 / DOI 匹配真实数据，非会话标记）
  function wlInLibrary(it) {
    const key = String(it?.title || '').trim().toLowerCase();
    if (!key) return false;
    return items.some((r) => {
      const t = String(r.title || '').trim().toLowerCase();
      const d = String(r.doi || '').trim().toLowerCase();
      return t === key || (d && d === key);
    });
  }

  // 重新导入：清理文献中心里同标题/同 DOI 的旧记录后重新下载
  async function wlRedownloadOne(it) {
    if (!it?.url || it.state === 'downloading') return;
    if (!confirm(`「${it.title.slice(0, 40)}」已在文献中心。\n\n重新导入会先删除文献中心里的同名旧记录（含其 PDF），再重新下载一份。\n\n确认继续？`)) return;
    // 删除文献中心里的同名旧记录
    const key = String(it.title || '').trim().toLowerCase();
    const stale = items.filter((r) => String(r.title || '').trim().toLowerCase() === key
      || (String(r.doi || '').trim().toLowerCase() && String(r.doi || '').trim().toLowerCase() === key));
    for (const r of stale) {
      try { await api('/api/literature/' + r.id, { method: 'DELETE' }); } catch (_) { /* ignore */ }
    }
    if (stale.length) await loadItems();
    await wlDownloadOne(it, true);
  }

  // 下载单条：由后端直接抓取 PDF（自动解析中转页拿到真实直链），下载完成后
  // 连同 PDF 附件一并写入文献中心，无需再跳浏览器手动下载
  async function wlDownloadOne(it, refresh) {
    if (!it?.url || it.state === 'downloading') return;
    it.state = 'downloading'; it.error = '';
    renderWlList();
    try {
      const res = await api('/api/worldlib/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: it.title, url: it.url, overwrite: true }),
      });
      it.state = 'done'; it.imported = true;
      if (refresh) await loadItems();
      toast(`「${it.title.slice(0, 24)}…」已下载 PDF 并导入文献中心`, 'success');
    } catch (e) {
      it.state = 'error'; it.error = e.message;
      toast(e.message, 'error');
    }
    renderWlList();
  }

  // 批量：逐条下载并导入（len 传 null 表示处理全部未完成条目）
  async function wlDownloadImport(onlyChecked) {
    // 以「文献中心真实是否存在」为准：误删过的条目会被视为待导入，可以补回来
    const all = wlItems.filter((x) => !wlInLibrary(x) && x.state !== 'downloading');
    const list = onlyChecked ? all.filter((x) => x.checked) : all;
    if (!list.length) {
      toast(onlyChecked ? '没有已勾选且需要导入的条目' : '所有条目都已在文献中心', 'error');
      return;
    }
    let ok = 0, fail = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      toast(`正在下载并导入 ${i + 1}/${list.length}：${it.title.slice(0, 20)}…`);
      await wlDownloadOne(it, false);
      if (it.state === 'done') ok++; else fail++;
    }
    await loadItems();
    const failMsg = fail ? `，失败 ${fail} 篇（可点击单条查看原因重试）` : '';
    toast(`完成：成功下载并导入 ${ok} 篇${failMsg}`, fail ? 'error' : 'success');
  }

  async function wlImport() { return wlDownloadImport(true); }

  // ============ 主题配色（稳定的学术底色 + 可定制主操作色） ============
  const DEFAULT_THEME = '#176B87';
  const THEME_PRESETS = [
    { name: '研究蓝', primary: '#176B87' },
    { name: '松柏绿', primary: '#28735D' },
    { name: '群青蓝', primary: '#315F9B' },
    { name: '珊瑚红', primary: '#C85C4A' },
    { name: '琥珀金', primary: '#A87518' },
    { name: '莓果红', primary: '#A94762' },
    { name: '理性紫', primary: '#70578F' },
    { name: '石墨灰', primary: '#52625B' },
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

  // 主色驱动操作区和侧边栏的同一套主题，语义色仍保持稳定。
  function deriveTheme(primary) {
    const c = hexToHsl(primary);
    if (!c) return null;
    const cl = (v) => Math.max(0, Math.min(100, v));
    return {
      '--primary': primary,
      '--primary-hover': hslToHex(c.h, cl(c.s + 4), cl(c.l * 0.82)),
      '--primary-light': hslToHex(c.h, cl(c.s - 6), cl(c.l * 1.18 + 6)),
      '--primary-soft': hslToHex(c.h, cl(c.s * 0.42), 95.5),
      '--btn-border': hslToHex(c.h, cl(c.s * 0.20), 84),
      '--side-1': hslToHex(c.h, cl(c.s * 0.42 + 18), 26),
      '--side-2': hslToHex(c.h, cl(c.s * 0.38 + 14), 18),
      '--side-text': hslToHex(c.h, cl(c.s * 0.20 + 12), 92),
      '--side-muted': hslToHex(c.h, cl(c.s * 0.20 + 10), 72),
      '--side-hover': `hsla(${Math.round(c.h)}, ${Math.round(cl(c.s * 0.42 + 12))}%, 86%, .12)`,
      '--side-active': `hsla(${Math.round(c.h)}, ${Math.round(cl(c.s * 0.42 + 12))}%, 92%, .19)`,
      '--side-border': `hsla(${Math.round(c.h)}, ${Math.round(cl(c.s * 0.3 + 8))}%, 96%, .18)`,
      '--side-marker': hslToHex(c.h, cl(c.s * 0.64 + 12), 72),
      '--accent-2': '#D7654F',
    };
  }

  function applyTheme(primary, persist) {
    const vars = deriveTheme(primary);
    if (!vars) { toast('色值格式不正确，请输入如 #176B87 的色号', 'error'); return; }
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

  // ============ 全局字体（英文统一 Times New Roman，中文可选宋体/黑体/楷体/行楷等） ============
  function applyFont(fontKey) {
    const root = document.documentElement;
    const f = String(fontKey || '').trim();
    if (!f) { root.style.removeProperty('--app-font'); return; }
    root.style.setProperty('--app-font', `"Times New Roman", "${f}", "Microsoft YaHei", "PingFang SC", sans-serif`);
  }

  // ============ 全局字号（小/标准/大/特大，body zoom 整体缩放） ============
  const FONT_SIZE_ZOOM = { small: 0.9, medium: 1, large: 1.15, xlarge: 1.3 };
  function applyFontSize(level) {
    const zoom = FONT_SIZE_ZOOM[level] || 1;
    document.body.style.zoom = zoom === 1 ? '' : String(zoom);
  }
  // body 有 zoom 时，getBoundingClientRect 返回的是缩放后坐标；写回 style.left/top 前需除回
  function uiZoom() { const z = parseFloat(document.body.style.zoom); return isNaN(z) || z <= 0 ? 1 : z; }

  // ============ 设置 ============
  function fillSettingsForm() {
    $('setLanguage').value = settings.language || 'zh';
    $('setEasyKey').value = settings.easyScholarKey || '';
    $('setTranslateProvider').value = settings.translateProvider || 'siliconflow';
    $('setDeeplKey').value = settings.deeplKey || '';
    $('setDataDir').value = settings.dataDir || '';
    $('setAppFont').value = settings.appFont || '';
    $('setFontSize').value = settings.fontSize || 'medium';
    $('setAiEnabled').checked = settings.aiProvider !== 'none';
    // 供应商下拉 + 已配置模型列表
    renderProviderOptions();
    renderProfileList();
    renderVisionOptions();
    closeMlEditor();
  }
  async function saveSettingsFromForm() {
    // 编辑中的那条若还没保存，先提示（避免用户以为已经存了）
    if (editingProfileId !== null && !$('mlEditor').classList.contains('hidden')) {
      const ok = confirm('还有一条模型配置正在编辑中且未保存，是否放弃并保存其他设置？');
      if (!ok) return;
    }
    const next = {
      aiProvider: $('setAiEnabled').checked ? (settings.aiProvider === 'none' ? 'siliconflow' : settings.aiProvider) : 'none',
      language: $('setLanguage').value,
      easyScholarKey: $('setEasyKey').value.trim(),
      translateProvider: $('setTranslateProvider').value,
      deeplKey: $('setDeeplKey').value.trim(),
      dataDir: $('setDataDir').value.trim(),
      appFont: $('setAppFont').value,
      fontSize: $('setFontSize').value,
      modelProfiles: profiles,
      activeProfileId,
      visionProfileId: $('setVisionProfile') ? $('setVisionProfile').value : (settings.visionProfileId || ''),
    };
    try {
      settings = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      el.settingsModal.classList.add('hidden');
      await loadModels();
      renderModelSwitcher();
      toast('设置已保存' + (settings.dataDir ? '，数据目录已切换' : ''), 'success');
      await loadItems(); await loadCollections();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ============ 多模型配置 ============
  async function loadModels() {
    try {
      const d = await api('/api/models');
      providers = d.providers || [];
      profiles = d.profiles || [];
      activeProfileId = d.activeProfileId || '';
      activeModelInfo = d.active || null;
      activeVisionInfo = d.activeVision || null;
      // 后端返回的才是权威值，回填到 settings，避免设置页渲染时用的是旧配置
      if (settings) settings.visionProfileId = d.visionProfileId || '';
    } catch (_) { /* 首次启动后端未就绪时忽略 */ }
  }

  function providerById(id) { return providers.find((p) => p.id === id) || null; }
  function modelMeta(providerId, modelId) {
    const p = providerById(providerId);
    const m = p?.models.find((x) => x.id === modelId);
    return m || null;
  }
  function profileTitle(p) {
    return p.label || modelMeta(p.provider, p.model)?.name || p.model || p.provider || '未命名模型';
  }

  // 顶栏切换器：显示当前激活的模型
  function renderModelSwitcher() {
    const txt = $('modelBtnText');
    const dot = $('modelDot');
    if (!txt || !dot) return;
    if (activeModelInfo) {
      txt.textContent = `${activeModelInfo.providerName} · ${activeModelInfo.model}`;
      dot.className = 'model-dot on';
    } else if (!profiles.length) {
      txt.textContent = '未配置模型';
      dot.className = 'model-dot warn';
    } else if (settings.aiProvider === 'none') {
      txt.textContent = 'AI 已关闭';
      dot.className = 'model-dot warn';
    } else {
      txt.textContent = '缺少 API 密钥';
      dot.className = 'model-dot warn';
    }
  }

  // 顶栏下拉面板：按供应商分组列出所有已配置模型
  function renderModelPanel() {
    const body = $('modelPanelBody');
    if (!body) return;
    $('modelPanelCount').textContent = profiles.length ? `共 ${profiles.length} 个` : '';
    if (!profiles.length) {
      body.innerHTML = `<div class="mp-empty">还没有配置任何模型。<br />点下面的「管理模型配置」添加，<br />可以同时配多个供应商的模型。</div>`;
      return;
    }
    const groups = new Map();
    for (const p of profiles) {
      const key = p.provider;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    let html = '';
    for (const [pid, list] of groups) {
      const pname = providerById(pid)?.name || '自定义';
      html += `<div class="mp-group-title">${esc(pname)}</div>`;
      for (const p of list) {
        const meta = modelMeta(p.provider, p.model);
        const isActive = p.id === activeProfileId && settings.aiProvider !== 'none';
        const vision = profileVision(p);
        html += `<button class="mp-item${isActive ? ' active' : ''}" data-mpid="${esc(p.id)}">
          <span class="mp-info">
            <span class="mp-name">${esc(profileTitle(p))}</span>
            <span class="mp-sub">${esc(p.model || '未填写模型名')}</span>
          </span>
          ${visionBadge(p)}
          ${isActive ? '<span class="mp-tag on">使用中</span>' : ''}
        </button>`;
      }
    }
    body.innerHTML = html;
    body.querySelectorAll('[data-mpid]').forEach((b) => b.addEventListener('click', () => switchActiveModel(b.dataset.mpid)));
  }

  async function switchActiveModel(id) {
    if (id === activeProfileId && settings.aiProvider !== 'none') { hideModelPanel(); return; }
    try {
      const d = await api('/api/models/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      activeProfileId = d.activeProfileId;
      activeModelInfo = d.active;
      settings.aiProvider = settings.aiProvider === 'none' ? 'siliconflow' : settings.aiProvider;
      renderModelSwitcher();
      renderModelPanel();
      const label = activeModelInfo ? `${activeModelInfo.providerName} · ${activeModelInfo.model}` : '未配置';
      toast('已切换到 ' + label, 'success');
    } catch (e) { toast(e.message, 'error'); }
    hideModelPanel();
  }

  function showModelPanel() {
    renderModelPanel();
    $('modelPanel').classList.remove('hidden');
  }
  function hideModelPanel() { $('modelPanel')?.classList.add('hidden'); }

  // ---- 设置弹窗内的模型列表 ----
  function renderProviderOptions() {
    const sel = $('mlProvider');
    if (!sel) return;
    if (!sel.options.length) {
      sel.innerHTML = providers.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    }
  }

  // 模型图片能力：允许用户覆盖内置目录判断。
  // auto = 目录判断；yes = 强制支持；no = 强制不支持。
  function normalizeVisionOverride(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    const v = String(value ?? '').trim().toLowerCase();
    if (['yes', 'true', '1', 'vision', 'supported'].includes(v)) return 'yes';
    if (['no', 'false', '0', 'text', 'unsupported'].includes(v)) return 'no';
    return 'auto';
  }
  function visionCapable() {
    return profiles.filter((p) => String(p.apiKey || '').trim() && profileVision(p));
  }
  function profileVisionState(p) {
    const mode = normalizeVisionOverride(p?.visionOverride);
    if (mode === 'yes') return true;
    if (mode === 'no') return false;
    const m = modelMeta(p?.provider, p?.model);
    return m ? !!m.vision : null;
  }
  function profileVision(p) { return profileVisionState(p) === true; }
  function visionBadge(p) {
    const mode = normalizeVisionOverride(p?.visionOverride);
    const state = profileVisionState(p);
    if (state === true) return `<span class="mp-tag vision">👁 看图${mode === 'yes' ? ' · 手动' : ''}</span>`;
    if (state === false) return '<span class="mp-tag text">文字模型</span>';
    return '<span class="mp-tag auto">待判断</span>';
  }
  function profileName(p) {
    return p.label || (providerById(p.provider)?.name || p.provider) + ' · ' + (p.model || '');
  }
  function renderVisionOptions() {
    const sel = $('setVisionProfile');
    if (!sel) return;
    const able = visionCapable();
    const cur = settings.visionProfileId || '';
    sel.innerHTML = [
      `<option value="">自动选择（${able.length ? able.length + ' 个可用' : '暂无可用'}）</option>`,
      ...able.map((p) => `<option value="${esc(p.id)}">${esc(profileName(p))}</option>`),
    ].join('');
    // 指定的那条被删掉 / 改坏了，就退回「自动」，避免下拉框显示空白
    sel.value = able.some((p) => p.id === cur) ? cur : '';
    if (sel.value !== cur) settings.visionProfileId = sel.value;

    const hint = $('setVisionHint');
    if (!hint) return;
    const active = profiles.find((p) => p.id === activeProfileId);
    const activeVision = active ? profileVision(active) : false;
    if (!able.length) {
      hint.className = 'ml-vision-hint warn';
      hint.textContent = '还没有可用的视觉模型：先在上方添加一个支持视觉的模型（如 Kimi-K2.7-Code、Qwen3.8-27B、GLM-4.5V）并填写密钥。';
    } else if (activeVision) {
      hint.className = 'ml-vision-hint ok';
      hint.textContent = `当前模型「${profileName(active)}」本身就能看图，发图时会直接识别，无需转述。此项留作备用。`;
    } else {
      // 以「后端实际会用哪个」为准，而不是前端自己猜，避免两边判断不一致
      const real = activeVisionInfo || able[0];
      const isDesignated = !!settings.visionProfileId && settings.visionProfileId === real?.id;
      hint.className = 'ml-vision-hint ok';
      hint.textContent = `发图提问时将先由「${real.label || real.model}」转述图片内容，再交给当前模型回答`
        + `（${isDesignated ? '按你的指定' : '自动选择'}）。`;
    }
  }

  function renderProfileList() {
    const box = $('mlList');
    if (!box) return;
    $('mlCount').textContent = String(profiles.length);
    if (!profiles.length) {
      box.innerHTML = '<div class="ml-empty">还没有模型。点「＋ 添加模型」手动配置，或点「⚡ 一键添加常用模型」快速开始。</div>';
      return;
    }
    box.innerHTML = profiles.map((p) => {
      const on = p.id === activeProfileId;
      const meta = modelMeta(p.provider, p.model);
      const keyState = String(p.apiKey || '').trim() ? '' : ' · <span style="color:#c0392b">未填密钥</span>';
      return `<div class="ml-item${on ? ' active' : ''}">
        <div class="ml-item-main">
          <div class="ml-item-name">
            ${esc(profileTitle(p))}
            ${on ? '<span class="ml-badge">使用中</span>' : '<span class="ml-badge none">待用</span>'}
            ${visionBadge(p)}
          </div>
          <div class="ml-item-sub">${esc(providerById(p.provider)?.name || '自定义')} · ${esc(p.model || '未填模型名')}${keyState}</div>
        </div>
        <div class="ml-item-acts">
          ${on ? '' : `<button type="button" class="tb-btn" data-mluse="${esc(p.id)}">设为使用</button>`}
          <button type="button" class="tb-btn" data-mledit="${esc(p.id)}">编辑</button>
          <button type="button" class="tb-btn" data-mldel="${esc(p.id)}">删除</button>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-mluse]').forEach((b) => b.addEventListener('click', () => switchActiveModel(b.dataset.mluse)));
    box.querySelectorAll('[data-mledit]').forEach((b) => b.addEventListener('click', () => openMlEditor(b.dataset.mledit)));
    box.querySelectorAll('[data-mldel]').forEach((b) => b.addEventListener('click', () => deleteProfile(b.dataset.mldel)));
  }

  function openMlEditor(id) {
    editingProfileId = id || null;
    const p = id ? profiles.find((x) => x.id === id) : null;
    $('mlEditorTitle').textContent = p ? '编辑模型配置' : '添加模型';
    renderProviderOptions();
    $('mlProvider').value = p?.provider || providers[0]?.id || 'siliconflow';
    // 编辑时不回填密钥原文：留空表示「保持不变」，避免明文密钥反复出现在屏幕上
    $('mlApiKey').value = '';
    $('mlApiKey').placeholder = p && p.apiKey ? '已保存密钥（留空则保持不变）' : 'sk-...';
    $('mlLabel').value = p?.label || '';
    $('mlBaseURL').value = p?.baseURL || providerById($('mlProvider').value)?.baseURL || '';
    $('mlModel').value = p?.model || '';
    $('mlVisionOverride').value = normalizeVisionOverride(p?.visionOverride);
    $('mlTestResult').classList.add('hidden');
    renderModelChips();
    $('mlEditor').classList.remove('hidden');
    $('mlProvider').focus();
  }

  function closeMlEditor() {
    editingProfileId = null;
    $('mlEditor')?.classList.add('hidden');
    $('mlTestResult')?.classList.add('hidden');
  }

  // 供应商的推荐模型做成可点的小胶囊，点一下直接填入
  function renderModelChips() {
    const box = $('mlModelChips');
    const list = $('mlModelList');
    const p = providerById($('mlProvider').value);
    const models = p?.models || [];
    if (list) list.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    if (!box) return;
    if (!models.length) { box.innerHTML = ''; return; }
    box.innerHTML = models.map((m) => `<button type="button" class="ml-chip${m.vision ? ' vision' : ''}" data-mlmodel="${esc(m.id)}" title="${esc(m.note || m.name)}">${esc(m.name)}</button>`).join('');
    box.querySelectorAll('[data-mlmodel]').forEach((b) => b.addEventListener('click', () => {
      $('mlModel').value = b.dataset.mlmodel;
    }));
  }

  function currentMlForm() {
    const provider = $('mlProvider').value;
    return {
      provider,
      label: $('mlLabel').value.trim(),
      baseURL: $('mlBaseURL').value.trim(),
      apiKey: $('mlApiKey').value.trim(),
      model: $('mlModel').value.trim(),
      visionOverride: normalizeVisionOverride($('mlVisionOverride').value),
    };
  }

  async function saveMlProfile() {
    const f = currentMlForm();
    if (!f.baseURL) { toast('请填写接口地址 Base URL', 'error'); return; }
    if (!f.model) { toast('请填写模型名称', 'error'); return; }
    const editing = editingProfileId ? profiles.find((p) => p.id === editingProfileId) : null;
    if (!editing && !f.apiKey) { toast('请填写 API 密钥', 'error'); return; }

    if (editing) {
      editing.provider = f.provider;
      editing.label = f.label || editing.label;
      editing.baseURL = f.baseURL;
      editing.model = f.model;
      editing.visionOverride = f.visionOverride;
      if (f.apiKey) editing.apiKey = f.apiKey; // 留空 = 保持原密钥
    } else {
      const p = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), ...f, createdAt: new Date().toISOString() };
      profiles.push(p);
      // 第一条配置自动设为使用中
      if (!activeProfileId || !profiles.some((x) => x.id === activeProfileId)) activeProfileId = p.id;
    }
    await persistProfiles('模型配置已保存');
    closeMlEditor();
    renderProfileList();
  }

  async function deleteProfile(id) {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`确定删除「${profileTitle(p)}」这条模型配置吗？`)) return;
    profiles = profiles.filter((x) => x.id !== id);
    if (activeProfileId === id) activeProfileId = profiles[0]?.id || '';
    await persistProfiles('已删除');
    renderProfileList();
    if (editingProfileId === id) closeMlEditor();
  }

  async function persistProfiles(msg) {
    try {
      settings = await api('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelProfiles: profiles,
          activeProfileId,
          aiProvider: $('setAiEnabled').checked ? 'siliconflow' : 'none',
          // 模型增删后原本指定的视觉模型可能已不存在，这里带上最新选择让后端保持一致
          visionProfileId: $('setVisionProfile') ? $('setVisionProfile').value : (settings.visionProfileId || ''),
        }),
      });
      profiles = settings.modelProfiles || profiles;
      activeProfileId = settings.activeProfileId || activeProfileId;
      await loadModels();
      renderModelSwitcher();
      renderVisionOptions();
      if (msg) toast(msg, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // 一键添加常用模型：DeepSeek 日常解析 + 当前视觉模型，需要用户补 Key
  async function addCommonPresets() {
    const want = [
      { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash', label: 'DeepSeek 日常解析' },
      { provider: 'siliconflow', model: 'zai-org/GLM-4.5V', label: 'GLM-4.5V 看图', visionOverride: 'yes' },
      { provider: 'siliconflow', model: 'Qwen/Qwen3.8-27B', label: 'Qwen3.8-27B 看图', visionOverride: 'yes' },
      { provider: 'siliconflow', model: 'moonshotai/Kimi-K2.7-Code', label: 'Kimi-K2.7-Code 看图', visionOverride: 'yes' },
      { provider: 'siliconflow', model: 'Pro/moonshotai/Kimi-K2.6', label: 'Kimi-K2.6 Pro 看图', visionOverride: 'yes' },
      { provider: 'siliconflow', model: 'Qwen/Qwen3.6-35B-A3B', label: 'Qwen3.6-35B-A3B 看图', visionOverride: 'yes' },
      { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek 官方' },
    ];
    let added = 0;
    for (const w of want) {
      if (profiles.some((p) => p.provider === w.provider && p.model === w.model)) continue;
      profiles.push({
        id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        label: w.label, provider: w.provider,
        baseURL: providerById(w.provider)?.baseURL || '', apiKey: '', model: w.model,
        visionOverride: w.visionOverride || 'auto',
        createdAt: new Date().toISOString(),
      });
      added++;
    }
    if (!added) { toast('常用模型都已经添加过了', 'error'); return; }
    if (!activeProfileId) activeProfileId = profiles[0].id;
    await persistProfiles(`已添加 ${added} 个常用模型，请逐个补填 API 密钥`);
    renderProfileList();
  }

  async function testMlProfile() {
    const box = $('mlTestResult');
    const f = currentMlForm();
    const editing = editingProfileId ? profiles.find((p) => p.id === editingProfileId) : null;
    const apiKey = f.apiKey || editing?.apiKey || '';
    if (!apiKey) { toast('请先填写 API 密钥（或先保存该配置）', 'error'); return; }
    box.className = 'ml-test-result';
    box.textContent = '正在测试连接…';
    const btn = $('btnMlTest');
    btn.disabled = true;
    try {
      const r = await api('/api/models/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: f.provider, baseURL: f.baseURL, apiKey, model: f.model }),
      });
      box.className = 'ml-test-result ' + (r.ok ? 'ok' : 'err');
      box.textContent = r.ok
        ? `✅ 连接成功（${r.cost} ms）模型回复：${r.reply}`
        : `❌ 连接失败（${r.cost} ms）：${r.error}`;
    } catch (e) {
      box.className = 'ml-test-result err';
      box.textContent = '❌ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    document.querySelectorAll('.view-tabs .tab').forEach((t) => t.addEventListener('click', () => {
      document.querySelectorAll('.view-tabs .tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active'); tab = t.dataset.tab; render();
    }));

    $('btnAddRecord').addEventListener('click', async () => {
      const body = { docType: lib.type };
      if (lib.collectionId && lib.collectionId !== UNCLASSIFIED) body.collectionId = lib.collectionId;
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
      applyRowHeight(b.dataset.rh);
      // 行高偏好持久化，下次启动保留
      api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rowHeight: b.dataset.rh }) }).catch(() => {});
    }));

    $('btnParseAll').addEventListener('click', () => {
      const pending = filteredItems().filter((i) => i.status !== 'done');
      if (!pending.length) { toast('没有待解析的文献', 'error'); return; }
      toast(`开始解析 ${pending.length} 篇…`); parseIds(pending.map((i) => i.id));
    });

    // 批量操作栏
    $('btnBulkParse').addEventListener('click', batchParse);
    $('btnBulkReparse').addEventListener('click', batchReparse);
    $('btnBulkProgress').addEventListener('click', batchProgress);
    $('btnBulkCollection').addEventListener('click', () => {
      const ids = pickIdsOrWarn();
      if (ids) openClassModal(ids);
    });
    $('btnBulkRank').addEventListener('click', batchRank);
    $('btnBulkDelete').addEventListener('click', batchDelete);
    $('btnBulkInvert').addEventListener('click', invertVisible);
    $('btnBulkClear').addEventListener('click', clearSelection);
    // Ctrl/Cmd+A 全选当前列表（焦点在输入框时不拦截）
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ($('viewLibrary').classList.contains('hidden')) return;
      e.preventDefault();
      selectAllVisible(true);
    });
    // Esc 取消选择
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !selectedIds.size) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ($('viewLibrary').classList.contains('hidden')) return;
      clearSelection();
    });
    $('btnExport').addEventListener('click', () => window.open('/api/export?format=csv', '_blank'));

    // 列宽拖拽调节（table-layout: fixed，实时移动 <col> 宽度，放大缩小都精确生效）
    let resizing = null;
    el.theadRow.addEventListener('mousedown', (e) => {
      const handle = e.target.closest('[data-resize]');
      if (!handle) return;
      e.preventDefault();
      const th = handle.closest('th');
      const grid = el.theadRow.closest('table');
      const colgroup = document.getElementById('gridCols');
      const cols = buildColumns();
      const idx = cols.findIndex((c) => c.key === handle.dataset.resize);
      if (idx < 0 || !colgroup) return;
      resizing = {
        key: handle.dataset.resize, startX: e.clientX, startW: th.getBoundingClientRect().width,
        th, handle, col: colgroup.children[idx + 2],
        baseTotal: parseFloat(grid.style.width) || 0, grid,
      };
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const w = Math.max(60, Math.min(900, resizing.startW + (e.clientX - resizing.startX)));
      colWidths[resizing.key] = Math.round(w);
      resizing.col.style.width = w + 'px';
      resizing.grid.style.width = Math.round(resizing.baseTotal + (w - resizing.startW)) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing.handle.classList.remove('active');
      document.body.style.cursor = '';
      resizing = null;
      render(); // 拖完立即按新列宽整表重排
      persistColWidths(); // 持久化，下次启动保留
    });
    // 双击列宽手柄：重置该列为默认宽度
    el.theadRow.addEventListener('dblclick', (e) => {
      const handle = e.target.closest('[data-resize]');
      if (!handle) return;
      delete colWidths[handle.dataset.resize];
      render();
      persistColWidths();
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
    el.drawerBody.addEventListener('click', async (e) => {
      const ds = e.target.closest('[data-dstar]'); if (ds) { setRating(currentId, parseInt(ds.dataset.dstar, 10)); renderDrawer(); return; }
      if (e.target.closest('[data-dprogress]')) cycleProgress(currentId).then(renderDrawer);
      if (e.target.closest('#btnSaveDrawerThoughts')) {
        const v = $('drawerThoughts').value.trim();
        const updated = await api('/api/literature/' + currentId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thoughts: v }) });
        const idx = items.findIndex((x) => x.id === currentId); if (idx >= 0) items[idx] = updated;
        render(); toast('我的思考已保存', 'success');
      }
    });

    $('btnSettingsClose').addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    $('btnSettingsCancel').addEventListener('click', () => el.settingsModal.classList.add('hidden'));
    $('btnSettingsSave').addEventListener('click', saveSettingsFromForm);

    // 全局字体/字号：下拉即预览，保存后持久化
    $('setAppFont').addEventListener('change', () => applyFont($('setAppFont').value));
    $('setFontSize').addEventListener('change', () => applyFontSize($('setFontSize').value));

    // 文献中心：批量更新当前列表的期刊等级
    $('btnRefreshRanks').addEventListener('click', refreshAllRanks);

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
        wlItems.push(it); added++;
      }
      renderWlList();
      toast(`解析完成，新增 ${added} 条${parsed.length - added ? `（重复跳过 ${parsed.length - added} 条）` : ''}`, 'success');
    });
    $('btnWlClear').addEventListener('click', () => { $('wlInput').value = ''; wlItems = []; renderWlList(); });
    $('btnWlDownloadAll').addEventListener('click', () => wlDownloadImport(false));
    $('btnWlImport').addEventListener('click', wlImport);

    // 主题配色
    $('themeColorPicker').addEventListener('input', () => {
      $('themeColorInput').value = $('themeColorPicker').value;
    });
    const applyThemeFromInput = () => applyTheme($('themeColorInput').value.trim(), true);
    $('btnThemeApply').addEventListener('click', applyThemeFromInput);
    $('themeColorInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyThemeFromInput(); });
    $('btnThemeReset').addEventListener('click', () => applyTheme(DEFAULT_THEME, true));
    // ---- 多模型配置 ----
    $('btnMlAdd').addEventListener('click', () => openMlEditor(null));
    $('btnMlAddPreset').addEventListener('click', addCommonPresets);
    $('btnMlSave').addEventListener('click', saveMlProfile);
    $('btnMlCancel').addEventListener('click', closeMlEditor);
    $('btnMlTest').addEventListener('click', testMlProfile);
    // 切供应商时自动带出官方 Base URL（用户手动改过则不动）
    $('mlProvider').addEventListener('change', () => {
      const p = providerById($('mlProvider').value);
      const cur = $('mlBaseURL').value.trim();
      const known = providers.map((x) => x.baseURL).filter(Boolean);
      if (p?.baseURL && (!cur || known.includes(cur))) $('mlBaseURL').value = p.baseURL;
      renderModelChips();
    });
    $('mlModel').addEventListener('input', () => {});

    // ---- 顶栏模型切换器 ----
    $('btnModelSwitch').addEventListener('click', (e) => {
      e.stopPropagation();
      if ($('modelPanel').classList.contains('hidden')) showModelPanel(); else hideModelPanel();
    });
    $('btnModelManage').addEventListener('click', () => { hideModelPanel(); openSettingsModal(); });
    $('modelPanel').addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => hideModelPanel());

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
        else if (!$('updateModal').classList.contains('hidden')) $('updateModal').classList.add('hidden');
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
    tab: 'translate',    // 当前右侧面板页签
    chat: [],            // 本篇论文的 AI 对话消息 [{role,content,images:[dataURL]}]
    chatBusy: false,
    chatAbort: null,     // 流式生成中用于「停止」的 AbortController
  };
  const prChatImages = []; // 待发送图片 [{name, dataUrl}]（按论文重置）

  // ---------- 右侧页签切换 ----------
  function switchPrTab(name) {
    pr.tab = name || 'translate';
    document.querySelectorAll('.pr-tab').forEach((b) => b.classList.toggle('active', b.dataset.prtab === pr.tab));
    document.querySelectorAll('.pr-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.prpane !== pr.tab));
    if (pr.tab === 'analysis') renderPrAnalysis();
    if (pr.tab === 'chat') { renderPrChat(); setTimeout(() => $('prChatInput')?.focus(), 60); }
  }

  // ---------- 解析结果面板（与左侧正在阅读的文献同步） ----------
  // 复用文献中心的字段体系与渲染函数，保证「阅读时看到的解析」与列表完全一致。
  function renderPrAnalysis() {
    const box = $('prAnalysisBody');
    if (!box) return;
    const it = items.find((x) => x.id === pr.recordId);
    if (!it) {
      $('prAnTitle').textContent = '—';
      box.innerHTML = '<div class="pr-an-empty">未找到对应的文献记录。</div>';
      return;
    }
    $('prAnTitle').textContent = it.title || '（未命名）';
    $('prAnTitle').title = it.title || '';

    const sections = [];
    // 「基本信息」单独成块展示（这些是元数据，不适合当作解析结果条目）
    const META_KEYS = new Set(['importedAt', 'title', 'authors', 'journal', 'year', 'doi']);
    const basics = [
      ['作者', it.authors], ['期刊/会议', it.journal], ['年份', it.year],
      ['DOI', it.doi], ['关键词', it.keywords],
    ].filter(([, v]) => String(v || '').trim());
    if (basics.length) {
      sections.push({
        label: '基本信息', icon: '📌',
        html: basics.map(([k, v]) => `<div style="margin-bottom:3px"><b style="color:var(--text-3);font-weight:600">${esc(k)}：</b>${esc(v)}</div>`).join(''),
      });
    }

    // 其余内容字段按当前文库类型的顺序展示（我的思考已在 TYPE_ORDER 内，不重复追加）
    const order = TYPE_ORDER[it.docType || 'empirical'] || [];
    const cols = order.map((k) => CONTENT_COLS[k]).filter((c) => c && !META_KEYS.has(c.key));
    for (const c of cols) {
      const v = it[c.key];
      if (!String(v || '').trim()) continue;
      const rendered = c.type === 'md' ? mdInline(String(v)) : esc(String(v)).replace(/\n/g, '<br />');
      sections.push({ label: c.label, icon: typeIcon(c.type), html: rendered, ai: c.ai });
    }

    // 解析状态提示
    const statusHtml = it.status === 'done'
      ? ''
      : `<div class="pr-an-empty" style="padding:14px;text-align:left">
           ${it.status === 'parsing' ? '⏳ 该文献正在解析中，稍后刷新可看到结果。'
             : it.status === 'error' ? `⚠️ 解析失败：${esc(it.error || '未知错误')}`
             : '📭 这篇文献还没有解析结果。点下方「开始解析」，AI 会自动读全文并填写字段。'}
         </div>`;

    // 有解析结果但内容字段全为空时，给一句明确提示，而不是一片空白
    const noContent = it.status === 'done' && sections.length === 0;
    const emptyTip = noContent
      ? '<div class="pr-an-empty">该文献已解析，但内容字段都为空。<br />可点下方「重新解析这篇」重跑一次。</div>'
      : '';

    box.innerHTML = statusHtml + emptyTip + sections.map((s) => `
      <div class="pr-an-sec">
        <div class="pr-an-label">${s.icon || '⃝'} ${esc(s.label)}${s.ai ? '<span class="col-ai">AI 生成</span>' : ''}</div>
        <div class="pr-an-value">${s.html}</div>
      </div>`).join('')
      + `<div class="pr-an-actions">
           <button class="btn btn-primary btn-sm" id="prAnParse">${it.status === 'done' ? '↻ 重新解析这篇' : '▶ 开始解析这篇'}</button>
           <button class="btn btn-ghost btn-sm" id="prAnEdit">✎ 编辑字段</button>
           <button class="btn btn-ghost btn-sm" id="prAnOpenLib">⤢ 在文献中心查看</button>
         </div>`;

    $('prAnParse')?.addEventListener('click', async () => {
      toast('开始解析…');
      await parseIds([it.id]);
      renderPrAnalysis();
    });
    $('prAnEdit')?.addEventListener('click', () => { currentId = it.id; openEdit(); });
    $('prAnOpenLib')?.addEventListener('click', () => { closePdfReader(); switchView('library'); openDrawer(it.id); });
  }

  // ==================== 论文 AI 对话（文本 + 图片多模态） ====================
  // 与文献中心的 AI 助手共用同一套模型配置，但走 /api/paper-chat（流式、不落库），
  // 并把「当前论文的解析结果」作为强上下文，把用户上传的图片按 OpenAI 多模态
  // content 数组格式一并提交，从而支持「文字 + 图片」混合提问。
  function prChatMessageHtml(m, index) {
    const imgs = (m.images || []).length
      ? `<div class="pr-msg-attach">${m.images.map((u) => `<img src="${u}" alt="附图" />`).join('')}</div>`
      : '';
    const body = m.pending
      ? '<span class="pr-typing"><i></i><i></i><i></i></span>'
      : (m.role === 'assistant' ? renderMarkdown(m.content || '') : esc(m.content || '').replace(/\n/g, '<br />'));
    // 「两段式看图」完成后，折叠展示视觉模型的原始转述，方便用户核对 AI 是否看错图
    const vnote = (m.visions || []).length
      ? `<div class="pr-vision-note">👁 <b>图片已由 ${esc(m.visions[0].label || '视觉模型')} 转述</b>`
        + `<details><summary>查看转述内容</summary><pre>${esc(m.visions.map((v) => v.text).join('\n\n'))}</pre></details></div>`
      : '';
    return `<div class="pr-msg ${m.role === 'user' ? 'user' : 'ai'}">
      <div class="pr-msg-avatar">${m.role === 'user' ? '👤' : '🤖'}</div>
      <div class="pr-msg-body">
        <div class="pr-msg-role">${m.role === 'user' ? '我' : 'AI 助手'}</div>
        ${imgs}
        ${vnote}
        <div class="pr-msg-bubble">${body}</div>
        ${m.error ? `<button class="btn btn-sm md-retry" data-pr-retry="${index}">重试回答</button>` : ''}
      </div>
    </div>`;
  }

  function renderPrChat() {
    const box = $('prChatMsgs');
    if (!box) return;
    if (!pr.chat.length) {
      const it = items.find((x) => x.id === pr.recordId);
      box.innerHTML = `<div class="pr-chat-empty">
        基于《${esc((it?.title || '当前论文').slice(0, 24))}》提问吧。<br />我会结合这篇论文的解析结果回答，也可以看图。
        <div class="pr-chat-hints">
          <button class="pr-chat-hint" data-prq="用三句话概括这篇论文的核心贡献与结论。">用三句话概括核心贡献与结论</button>
          <button class="pr-chat-hint" data-prq="这篇论文的研究方法/模型是什么？请分步骤讲清楚它的逻辑链条。">拆解研究方法/模型的逻辑链条</button>
          <button class="pr-chat-hint" data-prq="这篇论文有哪些局限性？作者自己承认的和我可能忽略的分别是什么？">找出论文的局限性</button>
          <button class="pr-chat-hint" data-prq="如果我要在自己的研究中复现或借鉴这篇论文，需要注意哪些关键细节？">如何复现/借鉴这篇论文</button>
          <button class="pr-chat-hint" data-prq="这篇论文有哪些地方写得含糊或证据不足，我可以在综述中如何质疑它？">哪些结论证据不足</button>
        </div>
      </div>`;
      box.querySelectorAll('[data-prq]').forEach((b) => b.addEventListener('click', () => {
        $('prChatInput').value = b.dataset.prq;
        sendPrChat();
      }));
      renderPrAttach();
      return;
    }
    box.innerHTML = pr.chat.map(prChatMessageHtml).join('');
    renderPrAttach();
    box.scrollTop = box.scrollHeight;
  }

  // 待发送图片缩略图
  function renderPrAttach() {
    const box = $('prChatAttach');
    if (!box) return;
    box.innerHTML = prChatImages.map((im, i) => `
      <div class="pr-attach-chip">
        <img src="${im.dataUrl}" alt="${esc(im.name)}" title="${esc(im.name)}" />
        <button data-prattdel="${i}" title="移除">✕</button>
      </div>`).join('');
    box.querySelectorAll('[data-prattdel]').forEach((b) => b.addEventListener('click', () => {
      prChatImages.splice(parseInt(b.dataset.prattdel, 10), 1);
      renderPrAttach();
    }));
  }

  function readPrChatImage(file) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve({ name: file.name || 'image', dataUrl: String(r.result || '') });
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
    });
  }

  async function addPrChatImages(files) {
    const list = [...(files || [])].filter((f) => /^image\//i.test(f.type));
    if (!list.length) { toast('请上传图片文件', 'error'); return; }
    for (const f of list.slice(0, 6)) {
      if (f.size > 6 * 1024 * 1024) { toast(`「${f.name}」超过 6MB，已跳过`, 'error'); continue; }
      const im = await readPrChatImage(f);
      if (im) prChatImages.push(im);
    }
    renderPrAttach();
  }

  // 组装论文上下文：解析字段 + 当前页附近文字，让 AI 的回答贴合这篇论文
  function buildPaperContext() {
    const it = items.find((x) => x.id === pr.recordId);
    if (!it) return '';
    const order = TYPE_ORDER[it.docType || 'empirical'] || [];
    const cols = order.map((k) => CONTENT_COLS[k]).filter(Boolean);
    const lines = [it.title ? `标题：${it.title}` : '', it.authors ? `作者：${it.authors}` : '',
      it.journal ? `期刊/会议：${it.journal}` : '', it.year ? `年份：${it.year}` : '',
      it.doi ? `DOI：${it.doi}` : ''].filter(Boolean);
    for (const c of cols) {
      const v = String(it[c.key] || '').trim();
      if (v) lines.push(`${c.label}：${v.length > 900 ? v.slice(0, 900) + '…' : v}`);
    }
    if (String(it.thoughts || '').trim()) lines.push(`我的思考：${String(it.thoughts).slice(0, 400)}`);
    return lines.join('\n');
  }

  // 取当前页及相邻页的纯文字（用于「附上当前页文字」）
  async function currentPageText() {
    try {
      if (!pr.doc) return '';
      const p = await pr.doc.getPage(pr.pageNum || 1);
      const tc = await p.getTextContent();
      return (tc.items || []).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    } catch (_) { return ''; }
  }

  // 发送并流式接收回答：逐字追加到 pending 气泡，支持中途「停止」
  async function sendPrChat(retryPayload = null) {
    if (pr.chatBusy) return;
    const input = $('prChatInput');
    const text = String(retryPayload?.text ?? input?.value ?? '').trim();
    if (!text && !prChatImages.length && !retryPayload?.imgs?.length) { toast('请输入问题或上传图片', 'error'); return; }
    const it = items.find((x) => x.id === pr.recordId);
    if (!it) { toast('未找到对应的文献记录', 'error'); return; }

    const imgs = retryPayload?.imgs ? [...retryPayload.imgs] : prChatImages.map((x) => x.dataUrl);
    const userMessage = retryPayload?.userMessage || { role: 'user', content: text, images: imgs };
    if (!retryPayload) pr.chat.push(userMessage);
    const holder = { role: 'assistant', content: '', pending: true, streaming: true, retryPayload: { text, imgs, userMessage } };
    pr.chat.push(holder);
    prChatImages.length = 0;
    input.value = '';
    input.style.height = '';
    renderPrChat();
    pr.chatBusy = true;
    setPrChatBusyUI(true);

    const ctx = buildPaperContext();
    const sys = '你是一位严谨的科研助理。用户正在精读一篇文献，请只围绕这篇论文回答，'
      + '回答要具体、可核查，必要时指明依据来自论文的哪一部分。如果论文上下文里没有相关信息，'
      + '请明确说「论文解析结果中没有提到」，不要编造。用简体中文和规范 Markdown 回答；适合比较的信息可用 Markdown 表格，代码使用带语言标识的围栏代码块，公式使用 $...$ 或 $$...$$。\n\n【当前论文解析结果】\n' + (ctx || '（这篇文献还没有解析结果）');
    // 组织为多模态 content：文本 + 图片
    const userContent = imgs.length
      ? [{ type: 'text', text: text || '请分析这些图片，并结合这篇论文回答我的问题。' },
         ...imgs.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
      : text;

    // 每 ~60ms 重绘一次，避免每个 token 都重建 DOM
    let lastPaint = 0;
    const paint = (force) => {
      const now = performance.now();
      if (!force && now - lastPaint < 60) return;
      lastPaint = now;
      const box = $('prChatMsgs');
      const bubbles = box?.querySelectorAll('.pr-msg.ai .pr-msg-bubble');
      const last = bubbles?.[bubbles.length - 1];
      if (!last) return;
      // 「看图」阶段还没有正文：显示一行进度提示，让等待可见
      if (holder.stage === 'vision') {
        last.innerHTML = `<span class="pr-vision-stage"><span class="pr-vision-spin"></span>`
          + `正在用「${esc(holder.visionLabel || '视觉模型')}」识别 ${holder.visionCount || ''} 张图片…</span>`;
      } else if (holder.content) {
        last.innerHTML = mdInline(holder.content) + '<span class="pr-caret"></span>';
      }
      if (holder.stage === 'vision' || holder.content) {
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
      }
    };

    pr.chatAbort = new AbortController();
    const r = await streamSSE('/api/paper-chat', {
      messages: [
        { role: 'system', content: sys },
        ...pr.chat.filter((m) => !m.pending && m !== userMessage && !m.error).slice(-8).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userContent },
      ],
    }, {
      signal: pr.chatAbort.signal,
      onEvent: (o) => {
        if (o.model) {
          holder.modelLabel = `${o.model.providerName} · ${o.model.model}`;
          holder.modelVision = o.model.vision;
        }
        // 第一段：视觉模型正在看图 —— 在气泡里显示进度，用户知道为什么还没出字
        if (o.stage === 'vision') {
          holder.stage = 'vision';
          holder.visionLabel = o.visionModel ? `${o.visionModel.providerName} · ${o.visionModel.model}` : '';
          holder.visionCount = o.imageCount || 0;
          paint(true);
        }
        // 第二段：图已转成文字，开始真正回答
        if (o.stage === 'answer') {
          holder.stage = 'answer';
          holder.visions = (holder.visions || []).concat([{ label: holder.visionLabel, text: o.description || '' }]);
          paint(true);
        }
        if (o.delta) {
          if (holder.stage === 'vision') holder.stage = 'answer';
          holder.content += o.delta;
          paint(false);
        }
        if (o.error) holder.error = o.error;
      },
    });
    pr.chatAbort = null;
    if (r.error && !holder.error) holder.error = r.error;

    // pending 标记去掉，转成正式消息
    delete holder.pending;
    delete holder.streaming;
    delete holder.stage;
    if (!holder.content) {
      holder.content = holder.error
        ? '请求失败：' + holder.error
        : (r.aborted ? '（已停止生成）' : '（AI 没有返回内容，请重试）');
      if (!r.aborted && !holder.error) holder.error = 'AI 没有返回内容，请重试';
    } else if (r.error) {
      holder.content += '\n\n⚠️ ' + r.error;
    } else if (r.aborted) {
      holder.content += '\n\n_（已停止生成）_';
    }
    // 只有在「当前模型看不了图、而且后端也没找到视觉模型」时才是真问题；
    // 后端能自动转述时不应再吓唬用户（v1 的写法会把正常流程误报成不支持）。
    if (imgs.length && holder.modelVision === false && !holder.visions?.length && !holder.error) {
      holder.content += `\n\n💡 当前模型「${holder.modelLabel || ''}」不支持图片输入，且没有可用的视觉模型。`
        + '可到「AI 设置 → 两段式看图」指定一个视觉模型（如 GLM-4.5V 或 Qwen3.8-27B），或在顶栏直接切换。';
    }
    if (holder.visions?.length) holder.visionNote = true;

    pr.chatBusy = false;
    setPrChatBusyUI(false);
    renderPrChat();
  }

  // 生成中把「发送」按钮变成「停止」，让用户能中断长回答
  function setPrChatBusyUI(busy) {
    const btn = $('btnPrChatSend');
    if (!btn) return;
    btn.classList.toggle('stop', !!busy);
    btn.textContent = busy ? '■ 停止' : '发送';
    btn.title = busy ? '停止生成' : '发送（Enter）';
  }

  function stopPrChat() {
    if (pr.chatAbort) { try { pr.chatAbort.abort(); } catch (_) { /* ignore */ } }
  }

  function openPdfReader(id) {
    const it = items.find((x) => x.id === id);
    if (!it?.filename) { toast('该文献还没有 PDF 附件', 'error'); return; }
    pr.recordId = id;
    pr.open = true;
    // 切换文献时终止上一篇的流式生成，并重置对话与待发图片（对话是「按论文」的）
    stopPrChat();
    pr.chatBusy = false;
    setPrChatBusyUI(false);
    pr.chat = [];
    prChatImages.length = 0;
    $('pdfReader').classList.remove('hidden');
    $('prFilename').textContent = it.originalName || '';
    $('prTransResult').innerHTML = '<div class="pr-trans-placeholder">翻译结果将显示在这里。<br />在左侧 PDF 中选中文字后会自动翻译。</div>';
    $('prSourceText').value = '';
    $('prThoughts').value = it.thoughts || '';
    $('prThoughtsState').textContent = it.thoughts ? '已保存' : '';
    // 右侧「解析结果」与正在阅读的文献同步刷新
    renderPrAnalysis();
    switchPrTab(pr.tab || 'translate');
    loadPdfDocument('/uploads/' + encodeURIComponent(it.filename));
  }

  function closePdfReader() {
    pr.open = false;
    pr.doc = null;
    pr.rendered.clear();
    if (pr.observer) { pr.observer.disconnect(); pr.observer = null; }
    // 关窗时终止仍在进行的流式回答，避免后台白白跑完
    stopPrChat();
    pr.chatBusy = false;
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
      } else if (a.type === 'underline') {
        const lineH = Math.max(1.5, 1.4 * scale);
        for (const r of (a.rects || [])) {
          const u = document.createElement('div');
          u.style.position = 'absolute';
          u.style.left = (r.x1 * scale) + 'px';
          u.style.top = (r.y2 * scale - lineH) + 'px';
          u.style.width = ((r.x2 - r.x1) * scale) + 'px';
          u.style.height = lineH + 'px';
          u.style.background = HIGHLIGHT_COLORS[a.color] || '#e8a213';
          u.style.borderRadius = '1px';
          layer.appendChild(u);
        }
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
        ${a.type === 'highlight' ? '<span class="badge badge-source">高亮</span>' : a.type === 'underline' ? '<span class="badge badge-source">下划线</span>' : '<span class="badge badge-done">笔记</span>'}
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
    tb.classList.remove('hidden');
    // 水平：对准选区中心并收拢到窗口内；垂直：默认在选区下方，靠底时翻到上方
    const tw = tb.offsetWidth || 240;
    const th = tb.offsetHeight || 40;
    let left = last.left + last.width / 2 - tw / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - tw - 10));
    let top = last.bottom + 10;
    if (top + th > window.innerHeight - 10) top = Math.max(10, last.top - th - 10);
    const z = uiZoom();
    tb.style.left = (left / z) + 'px';
    tb.style.top = (top / z) + 'px';
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

  // 下划线：按选区的逐行矩形，在每行文字底部画一条线（跨行选中会得到多条下划线）
  function doUnderline() {
    const sel = pr.currentSelection;
    if (!sel) return;
    addAnnotation({ id: 'a' + Date.now(), page: sel.pageNum, type: 'underline', color: pr.highlightColor, rects: sel.rects, text: sel.text, note: '', createdAt: new Date().toISOString() });
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
    const z = uiZoom();
    pop.style.left = ((pos.left != null ? pos.left : Math.max(10, tbRect.left)) / z) + 'px';
    pop.style.top = ((pos.top != null ? pos.top : Math.min(window.innerHeight - 250, tbRect.bottom + 8)) / z) + 'px';
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

    // 右侧页签：划词翻译 / 解析结果 / AI 对话
    document.querySelectorAll('.pr-tab').forEach((b) => b.addEventListener('click', () => switchPrTab(b.dataset.prtab)));
    $('btnPrAnRefresh').addEventListener('click', async () => {
      const it = items.find((x) => x.id === pr.recordId);
      if (!it) return;
      toast('开始解析…');
      await parseIds([it.id]);
      renderPrAnalysis();
    });

    // 论文 AI 对话：发送 / 停止 / 换行 / 传图 / 附当前页文字
    $('btnPrChatSend').addEventListener('click', () => {
      if (pr.chatBusy) stopPrChat(); else sendPrChat();
    });
    $('prChatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!pr.chatBusy) sendPrChat(); }
    });
    $('prChatMsgs').addEventListener('click', (e) => {
      const retry = e.target.closest('[data-pr-retry]');
      if (!retry || pr.chatBusy) return;
      const index = Number(retry.dataset.prRetry);
      const failed = pr.chat[index];
      if (!failed?.retryPayload) return;
      const payload = failed.retryPayload;
      pr.chat.splice(index, 1);
      renderPrChat();
      sendPrChat(payload);
    });
    $('prChatInput').addEventListener('input', () => {
      const n = $('prChatInput');
      n.style.height = 'auto';
      n.style.height = Math.min(120, n.scrollHeight) + 'px';
    });
    // 粘贴图片直接进入待发送区
    $('prChatInput').addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.items || [])]
        .filter((i) => i.kind === 'file' && /^image\//i.test(i.type))
        .map((i) => i.getAsFile())
        .filter(Boolean);
      if (files.length) { e.preventDefault(); addPrChatImages(files); }
    });
    $('btnPrChatImg').addEventListener('click', () => { $('prChatFile').value = ''; $('prChatFile').click(); });
    $('prChatFile').addEventListener('change', () => addPrChatImages($('prChatFile').files));
    $('btnPrChatText').addEventListener('click', async () => {
      const t = await currentPageText();
      if (!t) { toast('当前页没有提取到文字（可能是扫描版 PDF）', 'error'); return; }
      const box = $('prChatInput');
      box.value = (box.value ? box.value + '\n\n' : '')
        + `【第 ${pr.pageNum} 页原文摘录】\n${t}\n\n请基于以上原文回答：`;
      box.focus();
      box.dispatchEvent(new Event('input'));
      toast(`已附上第 ${pr.pageNum} 页文字`, 'success');
    });
    // 拖拽图片到对话面板
    const chatPane = document.querySelector('[data-prpane="chat"]');
    if (chatPane) {
      chatPane.addEventListener('dragover', (e) => { e.preventDefault(); });
      chatPane.addEventListener('drop', (e) => {
        const files = [...(e.dataTransfer?.files || [])].filter((f) => /^image\//i.test(f.type));
        if (files.length) { e.preventDefault(); e.stopPropagation(); addPrChatImages(files); }
      });
    }

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

    // Ctrl + 鼠标滚轮 / 笔记本触控板捏合 缩放（Chromium 中捏合手势会带 ctrlKey 的 wheel 事件）
    let zoomDebounce = null;
    $('prPages').addEventListener('wheel', (e) => {
      if (!pr.open || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      pr.scale = Math.max(0.5, Math.min(4, pr.scale + (e.deltaY > 0 ? -0.07 : 0.07)));
      $('prZoomLabel').textContent = Math.round(pr.scale * 100) + '%';
      clearTimeout(zoomDebounce);
      zoomDebounce = setTimeout(() => {
        const c = $('prPages');
        const ratio = c.scrollTop / Math.max(1, c.scrollHeight); // 缩放后尽量保持阅读位置
        rebuildAllPages();
        requestAnimationFrame(() => { c.scrollTop = ratio * c.scrollHeight; });
      }, 60);
    }, { passive: false });

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
      if (btn.dataset.sel === 'copy') {
        navigator.clipboard.writeText(sel.text).then(() => toast('已复制选中内容', 'success')).catch(() => toast('复制失败', 'error'));
        return;
      }
      if (btn.dataset.sel === 'translate') translateSelection(sel.text);
      else if (btn.dataset.sel === 'highlight') doHighlight();
      else if (btn.dataset.sel === 'underline') doUnderline();
      else if (btn.dataset.sel === 'note') doNote();
    });

    // 我的思考：PDF 阅读器侧栏直接写，保存到文献库 thoughts 字段
    $('btnPrThoughtsSave').addEventListener('click', async () => {
      const v = $('prThoughts').value.trim();
      try {
        const updated = await api('/api/literature/' + pr.recordId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ thoughts: v }) });
        const idx = items.findIndex((x) => x.id === pr.recordId); if (idx >= 0) items[idx] = updated;
        $('prThoughtsState').textContent = v ? '已保存' : '';
        toast('我的思考已保存', 'success');
      } catch (e2) { toast('保存失败：' + e2.message, 'error'); }
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

  // ---------- Markdown 笔记 ----------
  function activeMarkdownNote() {
    return markdownNotes.find((note) => note.id === activeMarkdownNoteId) || null;
  }

  async function loadMarkdownNotes() {
    markdownNotes = await api('/api/markdown-notes').catch(() => []);
    markdownNotesLoaded = true;
    if (activeMarkdownNoteId && !activeMarkdownNote()) activeMarkdownNoteId = null;
    if (!activeMarkdownNoteId && markdownNotes.length) activeMarkdownNoteId = markdownNotes[0].id;
    renderMarkdownNotes();
  }

  function renderMarkdownNoteList() {
    const box = $('mdNoteList');
    const query = String($('mdNoteSearch')?.value || '').trim().toLowerCase();
    const list = markdownNotes.filter((note) => !query || `${note.title} ${note.content}`.toLowerCase().includes(query));
    box.innerHTML = list.length ? list.map((note) => `
      <div class="md-note-item${note.id === activeMarkdownNoteId ? ' active' : ''}" data-md-note="${note.id}">
        <b>${esc(note.title || '未命名笔记')}</b><span>${fmtTime(note.updatedAt || note.createdAt)}</span>
      </div>`).join('') : '<div class="pr-loading">没有匹配的笔记</div>';
  }

  function renderMarkdownPreview() {
    const preview = $('mdPreview');
    if (preview) preview.innerHTML = renderMarkdown($('mdSource')?.value || '');
  }

  function renderMarkdownNotes() {
    renderMarkdownNoteList();
    const note = activeMarkdownNote();
    $('mdEmpty').classList.toggle('hidden', !!note);
    $('mdEditorShell').classList.toggle('hidden', !note);
    if (!note) return;
    $('mdNoteTitle').value = note.title || '未命名笔记';
    $('mdSource').value = note.content || '';
    $('mdSaveState').textContent = '';
    renderMarkdownPreview();
  }

  async function createMarkdownNote(title = '未命名笔记', content = '', sourceName = '') {
    // 新建或连续导入前先落盘当前编辑内容，避免未到防抖时间就切换笔记而丢失修改。
    if (activeMarkdownNote()) await saveActiveMarkdownNote();
    const note = await api('/api/markdown-notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content, sourceName }),
    });
    markdownNotes.unshift(note);
    activeMarkdownNoteId = note.id;
    renderMarkdownNotes();
    setTimeout(() => (sourceName ? $('mdSource') : $('mdNoteTitle'))?.focus(), 30);
    return note;
  }

  async function saveActiveMarkdownNote() {
    clearTimeout(markdownSaveTimer);
    const note = activeMarkdownNote();
    if (!note) return;
    const title = $('mdNoteTitle').value.trim() || '未命名笔记';
    const content = $('mdSource').value;
    $('mdSaveState').textContent = '保存中...';
    try {
      const saved = await api('/api/markdown-notes/' + note.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }),
      });
      Object.assign(note, saved);
      $('mdSaveState').textContent = '已保存';
      renderMarkdownNoteList();
    } catch (e) {
      $('mdSaveState').textContent = '保存失败';
      toast('笔记保存失败：' + e.message, 'error');
    }
  }

  function scheduleMarkdownSave() {
    const note = activeMarkdownNote();
    if (!note) return;
    note.title = $('mdNoteTitle').value.trim() || '未命名笔记';
    note.content = $('mdSource').value;
    $('mdSaveState').textContent = '未保存';
    renderMarkdownPreview();
    clearTimeout(markdownSaveTimer);
    markdownSaveTimer = setTimeout(saveActiveMarkdownNote, 650);
  }

  function insertMarkdown(before, after = '', placeholder = '') {
    const ta = $('mdSource');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = ta.value.slice(start, end) || placeholder;
    ta.setRangeText(before + selected + after, start, end, 'end');
    ta.focus();
    scheduleMarkdownSave();
  }

  function prefixMarkdownLines(prefix, ordered = false) {
    const ta = $('mdSource');
    const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    const nextNewline = ta.value.indexOf('\n', ta.selectionEnd);
    const end = nextNewline < 0 ? ta.value.length : nextNewline;
    const lines = ta.value.slice(start, end).split('\n');
    const replaced = lines.map((line, index) => (ordered ? `${index + 1}. ` : prefix) + line.replace(/^(?:#{1,6}|[-*>]|\d+[.])\s+/, '')).join('\n');
    ta.setRangeText(replaced, start, end, 'select');
    ta.focus();
    scheduleMarkdownSave();
  }

  function runMarkdownCommand(command, value = '') {
    const ta = $('mdSource');
    if (!ta) return;
    if (command === 'heading') return prefixMarkdownLines(value ? '#'.repeat(Number(value)) + ' ' : '');
    if (command === 'bold') return insertMarkdown('**', '**', '加粗文字');
    if (command === 'italic') return insertMarkdown('*', '*', '斜体文字');
    if (command === 'highlight') return insertMarkdown('<mark>', '</mark>', '高亮文字');
    if (command === 'align' && value) return insertMarkdown(`<div align="${value}">\n`, '\n</div>', '对齐内容');
    if (command === 'font' && value) return insertMarkdown(`<span style="font-family: ${value}">`, '</span>', '文字');
    if (command === 'size' && value) return insertMarkdown(`<span style="font-size: ${value}">`, '</span>', '文字');
    if (command === 'ul') return prefixMarkdownLines('- ');
    if (command === 'ol') return prefixMarkdownLines('', true);
    if (command === 'quote') return prefixMarkdownLines('> ');
    if (command === 'link') return insertMarkdown('[', '](https://)', '链接文字');
    if (command === 'code') return insertMarkdown('```text\n', '\n```', '在这里输入代码');
    if (command === 'formula') return insertMarkdown('$$\n', '\n$$', 'E = mc^2');
    if (command === 'table') return insertMarkdown('', '', '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |');
  }

  async function importMarkdownFiles(files) {
    const input = [...(files || [])];
    const list = input.filter((file) => /\.(?:md|markdown)$/i.test(file.name));
    if (!list.length) { toast('请导入扩展名为 .md 或 .markdown 的文件', 'error'); return; }
    if (input.length !== list.length) toast('已忽略不支持的文件，仅导入 Markdown 文件', 'error');
    let imported = 0;
    for (const file of list.slice(0, 50)) {
      if (file.size > 5 * 1024 * 1024) { toast(`「${file.name}」超过 5MB，已跳过`, 'error'); continue; }
      try {
        const content = (await file.text()).replace(/^\uFEFF/, '');
        await createMarkdownNote(file.name.replace(/\.(?:md|markdown)$/i, '') || '导入笔记', content, file.name);
        imported++;
      } catch (e) { toast(`无法读取「${file.name}」：${e.message}`, 'error'); }
    }
    if (imported) toast(`已导入 ${imported} 篇 Markdown 笔记`, 'success');
  }

  async function exportMarkdownNote(format) {
    const note = activeMarkdownNote();
    if (!note) return;
    await saveActiveMarkdownNote();
    if (format === 'pdf') {
      try {
        const result = await api(`/api/markdown-notes/${note.id}/export-pdf`, { method: 'POST' });
        if (result.browserPrint && result.printUrl) window.open(result.printUrl, '_blank');
        else if (!result.canceled) toast('PDF 已导出到所选位置', 'success');
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    try {
      const response = await fetch(`/api/markdown-notes/${note.id}/export-md`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '导出失败');
      if (/application\/json/i.test(response.headers.get('content-type') || '')) {
        const result = await response.json();
        if (!result.canceled) toast('Markdown 已导出到所选位置', 'success');
      } else {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = `${note.title || 'note'}.md`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { toast(e.message, 'error'); }
  }

  function bindMarkdownNotes() {
    $('btnMdNew').addEventListener('click', () => createMarkdownNote());
    $('btnMdImport').addEventListener('click', () => $('mdFileInput').click());
    $('mdFileInput').addEventListener('change', (e) => { importMarkdownFiles(e.target.files); e.target.value = ''; });
    $('mdNoteSearch').addEventListener('input', renderMarkdownNoteList);
    $('mdNoteList').addEventListener('click', (e) => {
      const item = e.target.closest('[data-md-note]');
      if (!item || item.dataset.mdNote === activeMarkdownNoteId) return;
      saveActiveMarkdownNote().then(() => { activeMarkdownNoteId = item.dataset.mdNote; renderMarkdownNotes(); });
    });
    $('mdSource').addEventListener('input', scheduleMarkdownSave);
    $('mdNoteTitle').addEventListener('input', scheduleMarkdownSave);
    $('mdToolbar').addEventListener('click', (e) => {
      const button = e.target.closest('[data-md-command]');
      if (button?.tagName === 'BUTTON') runMarkdownCommand(button.dataset.mdCommand, button.value);
      const mode = e.target.closest('[data-md-mode]');
      if (mode) {
        document.querySelectorAll('[data-md-mode]').forEach((b) => b.classList.toggle('active', b === mode));
        $('mdWorkspace').className = 'md-workspace ' + mode.dataset.mdMode;
      }
    });
    $('mdToolbar').addEventListener('change', (e) => {
      const select = e.target.closest('select[data-md-command]');
      if (!select) return;
      runMarkdownCommand(select.dataset.mdCommand, select.value);
      select.value = '';
    });
    $('btnMdExport').addEventListener('click', () => exportMarkdownNote('md'));
    $('btnMdPdf').addEventListener('click', () => exportMarkdownNote('pdf'));
    $('btnMdDelete').addEventListener('click', async () => {
      const note = activeMarkdownNote();
      if (!note || !confirm(`确认删除笔记「${note.title}」？`)) return;
      await api('/api/markdown-notes/' + note.id, { method: 'DELETE' });
      markdownNotes = markdownNotes.filter((item) => item.id !== note.id);
      activeMarkdownNoteId = markdownNotes[0]?.id || null;
      renderMarkdownNotes();
      toast('笔记已删除', 'success');
    });
    const zone = $('mdDropZone');
    ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('dragging'); }));
    zone.addEventListener('drop', (e) => importMarkdownFiles(e.dataTransfer.files));
    const view = $('viewMarkdown');
    ['dragenter', 'dragover'].forEach((type) => view.addEventListener(type, (e) => {
      if (![...(e.dataTransfer?.files || [])].some((file) => /\.(?:md|markdown)$/i.test(file.name))) return;
      e.preventDefault(); e.stopPropagation(); view.classList.add('md-view-dragging');
    }));
    ['dragleave', 'drop'].forEach((type) => view.addEventListener(type, (e) => {
      if (type === 'drop') { e.preventDefault(); e.stopPropagation(); importMarkdownFiles(e.dataTransfer.files); }
      view.classList.remove('md-view-dragging');
    }));
  }

  // ---------- 灵感孵化 ----------
  async function loadIdeas() {
    ideas = await api('/api/ideas');
    ideasLoaded = true;
    renderIdeas();
  }

  function ideaMarkdown(value) { return renderMarkdown(value); }

  function renderIdeas() {
    const wrap = $('ideaCards');
    if (!wrap) return;
    const status = $('ideaStatusFilter')?.value || 'all';
    const query = ($('ideaSearch')?.value || '').trim().toLowerCase();
    const list = ideas.filter((idea) => {
      if (status !== 'all' && idea.status !== status) return false;
      if (!query) return true;
      return [idea.title, idea.content, idea.field, idea.researchMode, ...(idea.tags || [])].join(' ').toLowerCase().includes(query);
    });
    $('ideaCount').textContent = `${list.length} / ${ideas.length} 条`;
    if (!list.length) {
      wrap.innerHTML = `<div class="idea-empty"><b>${ideas.length ? '没有匹配的灵感' : '还没有记录灵感'}</b><span>把研究中的疑问、矛盾和机制猜想先记下来，再用模型收敛成可检验的创新点。</span></div>`;
      return;
    }
    wrap.innerHTML = list.map((idea) => {
      const busy = incubatingIdeaIds.has(idea.id) || idea.status === 'incubating';
      const error = ideaErrors.get(idea.id) || '';
      const project = projects.find((p) => p.id === idea.projectId);
      const statusText = busy ? '孵化中' : idea.status === 'incubated' ? '已孵化' : '待孵化';
      const modeLabel = { empirical: '实证类', model: '模型类', ccf: 'CCF 算法类' }[idea.researchMode] || '实证类';
      return `<article class="idea-card" data-idea="${idea.id}">
        <div class="idea-card-head">
          <span class="idea-status status-${busy ? 'incubating' : idea.status}">${statusText}</span>
          <div class="idea-card-actions">
            <button class="icon-btn" data-idea-edit="${idea.id}" title="编辑灵感">✎</button>
            <button class="icon-btn danger" data-idea-delete="${idea.id}" title="删除灵感">🗑</button>
          </div>
        </div>
        <h3>${esc(idea.title || '未命名灵感')}</h3>
        <p class="idea-source">${esc(idea.content || '')}</p>
        <div class="idea-meta">
          <span>模式：${modeLabel}${idea.field ? ` · ${esc(idea.field)}` : ''}</span>
          ${project ? `<span>项目：${esc(project.name || '未命名')}</span>` : ''}
          ${(idea.literatureIds || []).length ? `<span>证据文献：${idea.literatureIds.length} 篇</span>` : '<span>尚未关联文献</span>'}
          <span>${fmtTime(idea.updatedAt || idea.createdAt)}</span>
        </div>
        ${(idea.tags || []).length ? `<div class="idea-tags">${idea.tags.map((tag) => `<span>${esc(tag)}</span>`).join('')}</div>` : ''}
        <div class="idea-incubation md-render${idea.incubation || busy || error ? '' : ' hidden'}" data-idea-output="${idea.id}">
          ${error ? `<p class="md-error-line">孵化失败：${esc(error)}</p>` : idea.incubation ? ideaMarkdown(idea.incubation) : '<p class="idea-generating">正在构建假设、证据缺口与最小验证方案...</p>'}
        </div>
        <div class="idea-card-foot">
          <button class="btn btn-primary" data-idea-incubate="${idea.id}"${busy ? ' disabled' : ''}>${busy ? '孵化中...' : error ? '重试孵化' : idea.incubation ? '重新孵化' : '孵化创新点'}</button>
        </div>
      </article>`;
    }).join('');
  }

  function openIdeaModal(id) {
    editingIdeaId = id || null;
    const idea = ideas.find((item) => item.id === id) || {};
    $('ideaModalTitle').textContent = id ? '编辑灵感' : '记录灵感';
    $('ideaTitle').value = idea.title || '';
    $('ideaContent').value = idea.content || '';
    $('ideaResearchMode').value = ['empirical', 'model', 'ccf'].includes(idea.researchMode) ? idea.researchMode : 'empirical';
    $('ideaField').value = idea.field || '';
    $('ideaTags').value = (idea.tags || []).join('，');
    $('ideaProject').innerHTML = '<option value="">不关联项目</option>' + projects.map((p) => `<option value="${p.id}"${p.id === idea.projectId ? ' selected' : ''}>${esc(p.name || '未命名项目')}</option>`).join('');
    const selected = new Set(idea.literatureIds || []);
    const literature = items.filter((item) => item.title || item.originalName).slice(0, 200);
    $('ideaLiterature').innerHTML = literature.length ? literature.map((item) => `<label title="${esc(item.title || item.originalName)}"><input type="checkbox" value="${item.id}"${selected.has(item.id) ? ' checked' : ''} /> <span>${esc(item.title || item.originalName)}</span></label>`).join('') : '<span class="lit-empty">文献中心暂无可关联记录</span>';
    $('ideaModal').classList.remove('hidden');
    setTimeout(() => $('ideaTitle').focus(), 30);
  }

  async function saveIdea() {
    const body = {
      title: $('ideaTitle').value.trim(),
      content: $('ideaContent').value.trim(),
      researchMode: $('ideaResearchMode').value,
      field: $('ideaField').value.trim(),
      tags: $('ideaTags').value,
      projectId: $('ideaProject').value || null,
      literatureIds: [...$('ideaLiterature').querySelectorAll('input:checked')].map((input) => input.value),
    };
    if (!body.title && !body.content) { toast('请填写灵感标题或内容', 'error'); return; }
    try {
      await api(editingIdeaId ? `/api/ideas/${editingIdeaId}` : '/api/ideas', {
        method: editingIdeaId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      $('ideaModal').classList.add('hidden');
      await loadIdeas();
      toast('灵感已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteIdea(id) {
    if (!confirm('确认删除这条灵感及其孵化结果？')) return;
    try { await api('/api/ideas/' + id, { method: 'DELETE' }); await loadIdeas(); toast('灵感已删除', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function incubateIdea(id) {
    if (incubatingIdeaIds.has(id)) return;
    ideaErrors.delete(id);
    incubatingIdeaIds.add(id);
    renderIdeas();
    let full = '';
    let streamError = '';
    const result = await streamSSE(`/api/ideas/${id}/incubate`, {}, {
      onEvent(event) {
        if (event.error) streamError = event.error;
        if (event.delta) {
          full += event.delta;
          const output = document.querySelector(`[data-idea-output="${id}"]`);
          if (output) { output.classList.remove('hidden'); output.innerHTML = ideaMarkdown(full) + '<span class="chat-cursor"></span>'; }
        }
      },
    });
    incubatingIdeaIds.delete(id);
    const error = streamError || result.error;
    if (error) ideaErrors.set(id, error);
    await loadIdeas();
    if (error) toast(error, 'error');
    else if (!result.aborted) toast('创新点已孵化并保存', 'success');
  }

  function bindIdeas() {
    $('btnAddIdea').addEventListener('click', () => openIdeaModal(null));
    $('ideaStatusFilter').addEventListener('change', renderIdeas);
    $('ideaSearch').addEventListener('input', renderIdeas);
    $('ideaCards').addEventListener('click', (e) => {
      const edit = e.target.closest('[data-idea-edit]'); if (edit) return openIdeaModal(edit.dataset.ideaEdit);
      const del = e.target.closest('[data-idea-delete]'); if (del) return deleteIdea(del.dataset.ideaDelete);
      const incubate = e.target.closest('[data-idea-incubate]'); if (incubate) incubateIdea(incubate.dataset.ideaIncubate);
    });
    const closeIdeaModal = () => $('ideaModal').classList.add('hidden');
    $('btnIdeaClose').addEventListener('click', closeIdeaModal);
    $('btnIdeaCancel').addEventListener('click', closeIdeaModal);
    $('btnIdeaSave').addEventListener('click', saveIdea);
  }

  // ---------- 模拟审稿 ----------
  function activeReview() { return reviews.find((review) => review.id === activeReviewId) || null; }

  async function loadReviews() {
    reviews = await api('/api/reviews').catch(() => []);
    reviewsLoaded = true;
    if (activeReviewId && !activeReview()) activeReviewId = null;
    if (!activeReviewId && reviews.length) activeReviewId = reviews[0].id;
    renderReviews();
  }

  function renderReviewList() {
    const list = $('reviewList');
    list.innerHTML = reviews.length ? reviews.map((review) => {
      const busy = reviewingIds.has(review.id) || review.status === 'reviewing';
      return `<button class="review-list-item${review.id === activeReviewId ? ' active' : ''}" data-review-id="${review.id}">
        <b>${esc(review.title || '未命名文稿')}</b>
        <span>${review.fileType?.toUpperCase() || '文稿'}${busy ? ' · 审阅中' : review.result ? ' · 已完成' : ' · 待审阅'}</span>
      </button>`;
    }).join('') : '<div class="pr-loading">还没有导入文稿</div>';
  }

  function renderReviews() {
    renderReviewList();
    const active = activeReview();
    $('reviewEmpty').classList.toggle('hidden', !!active);
    $('reviewWorkspace').classList.toggle('hidden', !active);
    if (!active) return;
    $('reviewTitle').value = active.title || '';
    $('reviewExpertise').value = active.expertise || '';
    $('reviewJournal').value = active.targetJournal || '';
    $('reviewCustomPrompt').value = active.customPrompt || '';
    $('reviewRank').textContent = active.journalRank || '尚未查询 EasyScholar 等级';
    $('reviewMeta').textContent = `${active.originalName || ''}${active.pages ? ` · ${active.pages} 页` : ''}${active.truncated ? ` · 已截取前 80,000 字符（原文 ${active.textLength} 字符）` : ''}`;
    const busy = reviewingIds.has(active.id) || active.status === 'reviewing';
    const error = reviewErrors.get(active.id) || '';
    $('btnReviewGenerate').disabled = busy;
    $('btnReviewGenerate').textContent = busy ? '正在生成审稿意见...' : error ? '重试模拟审稿' : active.result ? '重新生成模拟审稿' : '生成模拟审稿意见';
    $('reviewOutput').innerHTML = error
      ? `<p class="md-error-line">模拟审稿失败：${esc(error)}</p><button class="btn btn-sm md-retry" data-review-retry="${active.id}">重试</button>`
      : active.result ? renderMarkdown(active.result) : '<p class="idea-generating">设置审稿角色和目标期刊后，生成结构化的模拟同行评审意见。</p>';
  }

  async function saveActiveReview() {
    clearTimeout(reviewSaveTimer);
    const review = activeReview();
    if (!review || reviewingIds.has(review.id)) return;
    $('reviewSaveState').textContent = '保存中...';
    try {
      const saved = await api('/api/reviews/' + review.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: $('reviewTitle').value.trim(), expertise: $('reviewExpertise').value.trim(), targetJournal: $('reviewJournal').value.trim(), customPrompt: $('reviewCustomPrompt').value.trim() }),
      });
      Object.assign(review, saved);
      $('reviewSaveState').textContent = '已保存';
      renderReviewList();
    } catch (e) { $('reviewSaveState').textContent = '保存失败'; toast('审稿配置保存失败：' + e.message, 'error'); }
  }

  function scheduleReviewSave() {
    const review = activeReview();
    if (!review) return;
    review.title = $('reviewTitle').value.trim() || '未命名文稿';
    review.expertise = $('reviewExpertise').value.trim();
    review.targetJournal = $('reviewJournal').value.trim();
    review.customPrompt = $('reviewCustomPrompt').value.trim();
    $('reviewSaveState').textContent = '未保存';
    clearTimeout(reviewSaveTimer);
    reviewSaveTimer = setTimeout(saveActiveReview, 650);
  }

  async function uploadReviewFile(file) {
    if (!file) return;
    if (!/\.(?:pdf|docx)$/i.test(file.name)) { toast('模拟审稿仅支持 PDF 或 DOCX；旧版 .doc 请先另存为 .docx', 'error'); return; }
    if (file.size > 100 * 1024 * 1024) { toast('文稿超过 100MB，无法导入', 'error'); return; }
    const form = new FormData(); form.append('file', file);
    toast('正在提取文稿正文...');
    try {
      const review = await api('/api/reviews/upload', { method: 'POST', body: form });
      reviews.unshift(review); activeReviewId = review.id; renderReviews();
      toast('文稿已导入，可开始配置审稿条件', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function queryReviewRank() {
    const review = activeReview();
    if (!review) return;
    await saveActiveReview();
    $('reviewRank').textContent = '正在查询...';
    try {
      const saved = await api(`/api/reviews/${review.id}/rank`, { method: 'POST' });
      Object.assign(review, saved); renderReviews(); toast('期刊等级已更新', 'success');
    } catch (e) { $('reviewRank').textContent = '查询失败：' + e.message; toast(e.message, 'error'); }
  }

  async function generateReview() {
    const review = activeReview();
    if (!review || reviewingIds.has(review.id)) return;
    await saveActiveReview();
    reviewErrors.delete(review.id); reviewingIds.add(review.id); renderReviews();
    let full = ''; let streamError = '';
    const result = await streamSSE(`/api/reviews/${review.id}/generate`, {}, {
      onEvent(event) {
        if (event.error) streamError = event.error;
        if (event.delta) {
          full += event.delta;
          const out = $('reviewOutput');
          if (out) out.innerHTML = renderMarkdown(full) + '<span class="chat-cursor"></span>';
        }
      },
    });
    reviewingIds.delete(review.id);
    const error = streamError || result.error;
    if (error) reviewErrors.set(review.id, error);
    await loadReviews();
    if (error) toast(error, 'error');
    else if (!result.aborted) toast('模拟审稿意见已生成并保存', 'success');
  }

  async function exportReview(format) {
    const review = activeReview();
    if (!review?.result) { toast('请先生成审稿意见', 'error'); return; }
    try {
      if (format === 'pdf') {
        const data = await api(`/api/reviews/${review.id}/export-pdf`, { method: 'POST' });
        if (data.browserPrint && data.printUrl) window.open(data.printUrl, '_blank');
        else if (!data.canceled) toast('PDF 已导出到所选位置', 'success');
        return;
      }
      const response = await fetch(`/api/reviews/${review.id}/export-md`, { method: 'POST' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '导出失败');
      if (/application\/json/i.test(response.headers.get('content-type') || '')) {
        const data = await response.json(); if (!data.canceled) toast('Markdown 已导出到所选位置', 'success');
      } else {
        const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a');
        link.href = url; link.download = `${review.title || 'review'}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { toast(e.message, 'error'); }
  }

  function bindReviewer() {
    $('btnReviewUpload').addEventListener('click', () => $('reviewFileInput').click());
    $('reviewDropZone').addEventListener('click', () => $('reviewFileInput').click());
    $('reviewFileInput').addEventListener('change', (e) => { uploadReviewFile(e.target.files?.[0]); e.target.value = ''; });
    $('reviewList').addEventListener('click', (e) => {
      const item = e.target.closest('[data-review-id]');
      if (!item || item.dataset.reviewId === activeReviewId) return;
      saveActiveReview().then(() => { activeReviewId = item.dataset.reviewId; renderReviews(); });
    });
    ['reviewTitle', 'reviewExpertise', 'reviewJournal', 'reviewCustomPrompt'].forEach((id) => $(id).addEventListener('input', scheduleReviewSave));
    $('btnReviewRank').addEventListener('click', queryReviewRank);
    $('btnReviewGenerate').addEventListener('click', generateReview);
    $('reviewOutput').addEventListener('click', (e) => { if (e.target.closest('[data-review-retry]')) generateReview(); });
    $('btnReviewExportMd').addEventListener('click', () => exportReview('md'));
    $('btnReviewExportPdf').addEventListener('click', () => exportReview('pdf'));
    $('btnReviewDelete').addEventListener('click', async () => {
      const review = activeReview();
      if (!review || !confirm(`确认删除「${review.title}」及其审稿意见？`)) return;
      try { await api('/api/reviews/' + review.id, { method: 'DELETE' }); reviews = reviews.filter((item) => item.id !== review.id); activeReviewId = reviews[0]?.id || null; renderReviews(); toast('审稿文稿已删除', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    });
    const zone = $('reviewDropZone');
    ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.remove('dragging'); }));
    zone.addEventListener('drop', (e) => uploadReviewFile(e.dataTransfer.files?.[0]));
    const view = $('viewReviewer');
    ['dragenter', 'dragover'].forEach((type) => view.addEventListener(type, (e) => { if ([...(e.dataTransfer?.files || [])].some((file) => /\.(?:pdf|docx)$/i.test(file.name))) { e.preventDefault(); e.stopPropagation(); view.classList.add('review-view-dragging'); } }));
    ['dragleave', 'drop'].forEach((type) => view.addEventListener(type, (e) => { if (type === 'drop') { e.preventDefault(); e.stopPropagation(); uploadReviewFile(e.dataTransfer.files?.[0]); } view.classList.remove('review-view-dragging'); }));
  }

  async function switchView(v) {
    view = v;
    document.querySelectorAll('.nav-item[data-view]').forEach((n) => n.classList.toggle('active', n.dataset.view === v));
    const map = { home: 'viewHome', library: 'viewLibrary', projects: 'viewProjects', tasks: 'viewTasks', papers: 'viewPapers', notes: 'viewNotes', markdown: 'viewMarkdown', ideas: 'viewIdeas', reviewer: 'viewReviewer', ai: 'viewAI', worldlib: 'viewWorldlib', mail: 'viewMail' };
    for (const [key, id] of Object.entries(map)) $(id).classList.toggle('hidden', key !== v);
    const isLib = v === 'library';
    // 文献中心：主区固定不滚动，表格容器内滚动（横向滚动条贴可视区底部）
    document.querySelector('.main-area').classList.toggle('lib-mode', isLib);
    // 邮箱：三栏铺满视口，各自内部滚动
    document.querySelector('.main-area').classList.toggle('mail-mode', v === 'mail');
    document.querySelector('.main-area').classList.toggle('markdown-mode', v === 'markdown');
    document.querySelector('.main-area').classList.toggle('reviewer-mode', v === 'reviewer');
    $('searchInput').classList.toggle('hidden', !isLib);
    $('btnParseAll').classList.toggle('hidden', !isLib);
    $('btnRefreshRanks').classList.toggle('hidden', !isLib);
    $('btnExport').classList.toggle('hidden', !isLib);
    // 离开文献中心时收起批量操作栏（选中集合保留，回来还在）
    if (el.bulkBar) el.bulkBar.classList.toggle('hidden', !isLib || selectedIds.size === 0);
    if (v === 'home') renderHome();
    if (v === 'projects') renderProjects();
    if (v === 'tasks') renderTasks();
    if (v === 'papers') { renderPaperTab(); }
    if (v === 'worldlib') renderWlList();
    if (v === 'notes') renderNotes();
    if (v === 'markdown') { if (!markdownNotesLoaded) await loadMarkdownNotes(); else renderMarkdownNotes(); }
    if (v === 'ideas') { if (!ideasLoaded) await loadIdeas(); else renderIdeas(); }
    if (v === 'reviewer') { if (!reviewsLoaded) await loadReviews(); else renderReviews(); }
    if (v === 'mail') await enterMailView();
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
    const encouragements = [
      '今天先完成一个可检验的小步骤，进展不需要轰轰烈烈。',
      '卡住不等于没有进展，把问题写清楚也是研究的一部分。',
      '论文不是一次写成的，允许草稿先不完美。',
      '休息不是偏离研究，它是保持判断力的一部分。',
      '先验证最关键的假设，再决定是否扩大工作量。',
      '把模糊的焦虑改写成一个具体问题，下一步通常就会出现。',
      '今天读懂一张表、修正一个变量，也算扎实的推进。',
      '研究的价值不靠忙碌证明，可靠的证据比漂亮的叙述更重要。',
    ];
    const dayKey = Number(todayStr().replaceAll('-', ''));
    $('dailyEncouragement').textContent = encouragements[dayKey % encouragements.length];
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
      const color = p === '已阅读' ? 'var(--green)' : p === '阅读中' ? 'var(--orange)' : 'var(--scrollbar-hover)';
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
    submit: { color: 'var(--primary)', label: '投稿' },
    milestone: { color: 'var(--primary-light)', label: '论文节点' },
    project: { color: '#0ea5a4', label: '项目' },
    imported: { color: '#5b6abf', label: '导入日历' },
    festival: { color: '#c2415d', label: '节日' },
    solarTerm: { color: '#27845f', label: '节气' },
  };
  function calendarDateInfo(dateKey) {
    if (!window.Solar || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return { lunar: '', events: [] };
    try {
      const [year, month, day] = dateKey.split('-').map(Number);
      const solar = window.Solar.fromYmd(year, month, day);
      const lunar = solar.getLunar();
      const term = calendarData.preferences.solarTerms ? lunar.getJieQi() : '';
      const festivals = calendarData.preferences.festivals
        ? [...solar.getFestivals(), ...lunar.getFestivals()].filter(Boolean)
        : [];
      let lunarLabel = '';
      if (calendarData.preferences.lunar) {
        lunarLabel = lunar.getDay() === 1 ? `${lunar.getMonthInChinese()}月` : lunar.getDayInChinese();
      }
      return {
        lunar: term || festivals[0] || lunarLabel,
        events: [
          ...(term ? [{ type: 'solarTerm', label: term, computed: true }] : []),
          ...[...new Set(festivals)].map((label) => ({ type: 'festival', label, computed: true })),
        ],
      };
    } catch (_) { return { lunar: '', events: [] }; }
  }
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
    for (const event of (calendarData.events || [])) {
      if (!event?.date || !event?.label) continue;
      (map[event.date] = map[event.date] || []).push({ ...event, type: 'imported' });
    }
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
      const dateInfo = calendarDateInfo(dateKey);
      const evs = [...(events[dateKey] || []), ...dateInfo.events];
      const dots = evs.slice(0, 3).map((e) => `<i class="cal-dot" style="background:${CAL_TYPES[e.type]?.color || '#999'}"></i>`).join('');
      const more = evs.length > 3 ? `<i class="cal-more">+${evs.length - 3}</i>` : '';
      const cls = ['cal-cell', c.out ? 'out' : '', dateKey === t0 ? 'today' : '', calSelected === dateKey ? 'selected' : ''].filter(Boolean).join(' ');
      return `<div class="${cls}" data-date="${dateKey}" title="${esc(evs.map((e) => e.label).join('；'))}">
        <span class="cal-num">${c.d}</span>${dateInfo.lunar ? `<span class="cal-lunar">${esc(dateInfo.lunar)}</span>` : ''}<span class="cal-dots">${dots}${more}</span>
      </div>`;
    }).join('');
    renderCalDayEvents();
  }

  function renderCalDayEvents() {
    const key = calSelected || todayStr();
    const events = [...(calEventsByDate()[key] || []), ...calendarDateInfo(key).events];
    const box = $('calDayEvents');
    const head = `<div class="cal-day-head">${calSelected ? '📆 ' + key : '📆 今天 · ' + key}<span class="side-count">${events.length} 项</span></div>`;
    box.innerHTML = head + (events.length
      ? events.map((e) => `<div class="cal-event"><i class="cal-dot" style="background:${CAL_TYPES[e.type]?.color || '#999'}"></i><span class="cal-event-label" title="${esc(e.label)}">${esc(e.label)}</span><span class="cal-tag" style="color:${CAL_TYPES[e.type]?.color}">${CAL_TYPES[e.type]?.label || ''}</span>${e.type === 'imported' && e.id ? `<button class="cal-event-del" data-cal-event-del="${e.id}" title="删除导入事件">✕</button>` : ''}</div>`).join('')
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

  // 手动更新单篇期刊等级：点卡片上的 🔄 按钮。不受自动补查的失败缓存限制，
  // 且失败原因会明确提示（如未配置 easyScholar SecretKey）。
  function rankRefreshBtn(id) {
    return `<button class="rank-refresh" data-rankrefresh="${id}" title="手动更新期刊等级（easyScholar）">🔄</button>`;
  }
  async function manualRankRefresh(id) {
    const p = papers.find((x) => x.id === id);
    if (!p) return;
    if (!p.journal) { toast('请先在编辑中填写目标期刊', 'error'); return; }
    wlRankFailed.delete(p.journal);
    const box = document.querySelector(`[data-rankfor="${id}"]`);
    if (box) box.innerHTML = '<span class="cell-empty">查询中…</span>' + rankRefreshBtn(id);
    try {
      const rank = await api('/api/journal-rank?name=' + encodeURIComponent(p.journal));
      const updated = await api('/api/papers/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rank }) });
      const idx = papers.findIndex((x) => x.id === id);
      if (idx >= 0) papers[idx] = updated;
      if (box) box.innerHTML = (rank.items?.length ? rankChips(rank.items) : `<span class="cell-empty">${esc(rank.summary)}</span>`) + rankRefreshBtn(id);
      toast(`期刊等级已更新：${rank.summary}`, 'success');
    } catch (e) {
      if (box) box.innerHTML = `<span class="rank-err">⚠ ${esc(e.message)}</span>` + rankRefreshBtn(id);
      toast('期刊等级更新失败：' + e.message, 'error');
    }
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
        stay = `<span class="meta-chip" title="当前状态起始日：${esc(startDate)}（可在编辑弹窗中修正）">⏱ 当前状态已停留 ${d} 天</span>`;
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
      const rank = p.journal ? `
        <div class="paper-rank" data-rankfor="${p.id}">
          ${p.rank?.summary
            ? (p.rank.items?.length ? rankChips(p.rank.items) : `<span class="cell-empty">${esc(p.rank.summary)}</span>`)
            : '<span class="cell-empty">期刊等级未查询</span>'}
          <button class="rank-refresh" data-rankrefresh="${p.id}" title="手动更新期刊等级（easyScholar）">🔄</button>
        </div>` : '';
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
    // 状态起始日：默认取最近一条动态的日期，可手动修正（停留天数按这天起算）
    const hist0 = paperDraft.history;
    $('paperStatusDate').value = (hist0.length ? hist0[hist0.length - 1].date : '') || p?.submitDate || todayStr();
    $('paperRankChips').innerHTML = paperDraft.rank?.summary ? rankChips(paperDraft.rank.items) : '';
    // 已有译文则显示，否则收起
    const rtWrap = $('reviewTransWrap');
    if (paperDraft.reviewTranslation) {
      rtWrap.classList.remove('hidden');
      rtWrap.classList.remove('expanded');
      $('reviewTransBody').innerHTML = renderMarkdown(paperDraft.reviewTranslation);
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
  async function translateReview(retryText = '') {
    const text = String(retryText || $('paperNotes').value).trim();
    if (!text) { toast('请先在「审稿意见 / 备注」中粘贴英文审稿意见', 'error'); return; }
    const btn = $('btnTranslateReview');
    const wrap = $('reviewTransWrap');
    const body = $('reviewTransBody');
    btn.disabled = true; btn.textContent = '翻译中…';
    wrap.classList.remove('hidden');
    body.classList.add('rt-loading');
    body.textContent = '正在用 AI 整理审稿意见（忠于原文、逐条中文、不增不减）…';
    let full = '';
    let streamError = '';
    const result = await streamSSE('/api/translate-review', { text }, {
      onEvent(event) {
        if (event.error) streamError = event.error;
        if (event.delta) {
          full += event.delta;
          body.classList.remove('rt-loading');
          body.innerHTML = renderMarkdown(full) + '<span class="chat-cursor"></span>';
        }
      },
    });
    const error = streamError || result.error || (!full && !result.aborted ? 'AI 未返回有效内容，请稍后重试' : '');
    try {
      body.classList.remove('rt-loading');
      if (error) {
        body.innerHTML = `<div class="md-error-line">${esc(error)}</div><button class="btn btn-sm md-retry" data-review-retry>重试翻译</button>`;
        body.querySelector('[data-review-retry]')?.addEventListener('click', () => translateReview(text));
        throw new Error(error);
      }
      body.innerHTML = renderMarkdown(full);
      paperDraft.reviewTranslation = full;
      toast('翻译完成，保存论文后生效', 'success');
    } catch (e) {
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
    // 状态起始日：用户可修正（停留天数按它计算）。状态变化时作为新动态的日期；状态未变时用于修正当前状态的起始日
    const effDate = /^\d{4}-\d{2}-\d{2}$/.test($('paperStatusDate').value || '') ? $('paperStatusDate').value : todayStr();
    if (!history.length) {
      history.push({ status, date: effDate, note: '创建论文' });
    } else if (history[history.length - 1].status !== status) {
      history.push({ status, date: effDate, note: '状态更新' });
    } else {
      history[history.length - 1].date = effDate;
    }
    const journal = $('paperJournal').value.trim();
    const original = paperModalId ? papers.find((x) => x.id === paperModalId) : null;
    const journalChanged = !!journal && journal !== (original?.journal || '');
    // 期刊名变更时：清空旧等级，改为携带 null 让后端置空并触发重查，避免旧等级残留导致不更新
    const rankToSend = journalChanged ? null : paperDraft.rank;
    const body = {
      title, journal, status,
      projectId: $('paperProject').value || null,
      submitDate: $('paperSubmitDate').value, revisionDeadline: $('paperDeadline').value,
      backupJournals: $('paperBackup').value.trim(), notes: $('paperNotes').value,
      reviewTranslation: paperDraft.reviewTranslation || '',
      history, rank: rankToSend,
    };
    try {
      let saved;
      if (paperModalId) {
        saved = await api('/api/papers/' + paperModalId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const idx = papers.findIndex((x) => x.id === paperModalId); if (idx >= 0) papers[idx] = saved;
      } else {
        saved = await api('/api/papers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        papers.unshift(saved);
      }
      $('paperModal').classList.add('hidden');
      renderPaperTab(); renderChatMeta();
      // 期刊名变更（或新增论文带期刊）时自动重查等级；清除失败缓存，允许重查
      if (journalChanged) wlRankFailed.delete(journal);
      const needRank = (journalChanged || !saved.rank?.summary) && !!journal;
      if (needRank) {
        toast('论文已保存，正在自动更新期刊等级…', 'success');
        autoFillPaperRanks();
      } else {
        toast('论文已保存', 'success');
      }
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
  function chatMd(v) { return renderMarkdown(v); }
  function renderChatMsgs() {
    const box = $('chatMsgs');
    if (!chatMsgs.length) {
      box.innerHTML = `<div class="chat-welcome"><div class="chat-welcome-ico">🤖</div><b>AI 科研助手已就绪</b><p>基于你的文献知识库、项目与任务进行定制化对话。<br />支持多会话与上下文记忆，试试右侧快捷指令，或直接输入问题。</p></div>`;
      return;
    }
    const summaryHint = activeSummary ? '<div class="chat-summary-hint">🗜 早期对话已压缩为摘要，AI 仍保留其要点记忆</div>' : '';
    box.innerHTML = summaryHint + chatMsgs.map((m, index) =>
      `<div class="chat-bubble ${m.role === 'user' ? 'user' : 'assistant'}${m.error ? ' error' : ''}">${m.role === 'user'
        ? esc(m.content).replace(/\n/g, '<br />')
        : `<div class="md md-render">${m.content ? chatMd(m.content) : ''}${m.pending ? '<span class="chat-cursor"></span>' : ''}</div>${m.error ? `<button class="btn btn-sm md-retry" data-chat-retry="${index}">重试回答</button>` : ''}`}</div>`).join('');
    box.scrollTop = box.scrollHeight;
  }
  async function sendChat(text, { retry = false } = {}) {
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
    if (!retry) chatMsgs.push({ id: 'local', role: 'user', content: text });
    const holder = { id: 'local', role: 'assistant', content: '', pending: true, retryContent: text };
    chatMsgs.push(holder);
    renderChatMsgs();
    const box = $('chatMsgs');
    let full = '';
    let errMsg = '';
    let compressed = false;
    let lastPaint = 0;
    const result = await streamSSE('/api/chat', { conversationId: activeConvId, content: text, retry }, {
      onEvent(event) {
        if (event.error) errMsg = event.error;
        if (event.compressed) compressed = true;
        if (event.delta) {
          full += event.delta;
          holder.content = full;
          const now = performance.now();
          if (now - lastPaint > 60) { lastPaint = now; renderChatMsgs(); }
        }
      },
    });
    if (result.error) errMsg = result.error;
    delete holder.pending;
    if (errMsg || !full) {
      holder.error = errMsg || '模型没有返回内容，请稍后重试';
      holder.content = `请求失败：${holder.error}`;
    } else {
      holder.content = full;
      delete holder.retryContent;
    }
    renderChatMsgs();
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

  // ============ 邮箱（多账户 IMAP / SMTP） ============
  let mailAccounts = [];
  let mailProviders = null;
  let mailCur = { accountId: '', folder: 'INBOX', folderName: '收件箱', page: 1, pageSize: 25, search: '' };
  let mailFolders = [];
  let mailFoldersOwner = '';
  let mailMessages = [];
  let mailTotal = 0;
  let mailDetail = null;
  let mailMaEditId = null;
  let mailInited = false;

  const FOLDER_ICONS = { '\\Inbox': '📥', '\\Sent': '📤', '\\Drafts': '📝', '\\Trash': '🗑', '\\Junk': '🚫', '\\Archive': '📦' };

  // 邮箱徽标：优先用域名首字母，数字域名（如 163.com）用 📧
  function mailBadge(email) {
    const d = String(email || '').split('@')[1] || '';
    const c = (d[0] || '').toUpperCase();
    return /[A-Z]/.test(c) ? c : '📧';
  }

  async function ensureMailProviders() {
    if (mailProviders) return mailProviders;
    try { mailProviders = await api('/api/mail/providers'); } catch { mailProviders = {}; }
    return mailProviders;
  }

  async function loadMailAccounts() {
    mailAccounts = await api('/api/mail/accounts');
    return mailAccounts;
  }

  // ============ 新邮件提醒（轮询 + 桌面通知 + 未读角标） ============
  // 设计要点：
  //  · 每个账户记录「上次已看到的最高 uid」作为基线，存 localStorage，重启后不回到零。
  //  · 首次运行没有基线时只记录基线、不弹提醒，避免把邮箱里的历史邮件一次性全弹出来。
  //  · uid 变大且未读 => 新邮件 => 应用内浮层 + 系统桌面通知。
  //  · 同一 uid 只提醒一次（notifiedUids 去重），避免轮询反复弹。
  const MAIL_SINCE_KEY = 'sci_mail_seen_uids';
  const NOTIFY_INTERVAL = 60 * 1000; // 轮询间隔：60 秒
  let mailNotifyTimer = null;
  let mailNotifyBusy = false;
  let mailNotifyEnabled = true;
  const notifiedUids = new Set(); // `${accountId}:${uid}` 已提醒过的邮件

  function readMailSince() {
    try { return JSON.parse(localStorage.getItem(MAIL_SINCE_KEY) || '{}') || {}; } catch { return {}; }
  }
  function writeMailSince(map) {
    try { localStorage.setItem(MAIL_SINCE_KEY, JSON.stringify(map)); } catch (_) { /* ignore */ }
  }

  // 侧边栏「邮箱」未读角标
  function renderNavMailBadge(totalUnread) {
    const n = parseInt(totalUnread, 10) || 0;
    const badge = $('navMailBadge');
    if (!badge) return;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n <= 0);
  }

  // 应用内新邮件浮层（可点击跳转）
  function showMailNotification(acc, msg) {
    const stack = $('mailNotifStack');
    if (!stack) return;
    const el2 = document.createElement('div');
    el2.className = 'mail-notif';
    el2.innerHTML = `
      <div class="mail-notif-ico">📬</div>
      <div class="mail-notif-body">
        <div class="mail-notif-title">新邮件 · ${esc(acc.label || acc.email)}</div>
        <div class="mail-notif-subject">${esc(String(msg.subject || '(无主题)').slice(0, 80))}</div>
        <div class="mail-notif-from">${esc(msg.fromName || msg.fromAddress || '未知发件人')}</div>
      </div>
      <button class="mail-notif-close" title="关闭">✕</button>`;
    const close = () => { el2.classList.add('out'); setTimeout(() => el2.remove(), 220); };
    el2.querySelector('.mail-notif-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
    // 点击浮层：切到邮箱视图并打开这封邮件
    el2.addEventListener('click', async () => {
      close();
      try {
        await switchView('mail');
        await selectMailAccount(acc.id);
        if (mailCur.folder !== 'INBOX') await openMailFolder(acc.id, 'INBOX', '收件箱');
        await openMailMessage(msg.uid);
      } catch (e) { toast('打开邮件失败：' + e.message, 'error'); }
    });
    stack.appendChild(el2);
    // 12 秒后自动收起（点击/关闭不受影响）
    setTimeout(close, 12000);
  }

  // 系统级桌面通知（Electron / 浏览器原生）
  function showDesktopNotification(acc, msg) {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'granted') return;
      const n = new Notification('📬 新邮件 · ' + (acc.label || acc.email), {
        body: `${msg.fromName || msg.fromAddress || '未知发件人'}\n${msg.subject || '(无主题)'}`,
        tag: `mail-${acc.id}-${msg.uid}`,
      });
      n.onclick = () => { try { window.focus(); } catch (_) {} n.close(); };
    } catch (_) { /* 通知失败不影响功能 */ }
  }

  function requestNotifyPermission() {
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    } catch (_) { /* ignore */ }
  }

  // 单轮轮询
  async function checkNewMail() {
    if (mailNotifyBusy || !mailNotifyEnabled) return;
    mailNotifyBusy = true;
    try {
      const since = readMailSince();
      const data = await api('/api/mail/notify?since=' + encodeURIComponent(JSON.stringify(since)));
      renderNavMailBadge(data.totalUnread || 0);

      const nextSince = { ...since };
      let changed = false;
      for (const a of data.accounts || []) {
        if (a.error) continue;
        const prev = parseInt(since[a.id], 10);
        const hadBaseline = Number.isFinite(prev);
        // 推进基线到当前最大 uid
        if (!hadBaseline || (a.newestUid || 0) > prev) { nextSince[a.id] = a.newestUid || 0; changed = true; }
        if (!hadBaseline) continue; // 首次不提醒历史邮件
        for (const m of a.fresh || []) {
          const key = a.id + ':' + m.uid;
          if (notifiedUids.has(key)) continue;
          notifiedUids.add(key);
          showMailNotification(a, m);
          showDesktopNotification(a, m);
        }
      }
      if (changed) writeMailSince(nextSince);
    } catch (_) {
      // 网络/离线/账户报错时静默，下一轮再试
    } finally {
      mailNotifyBusy = false;
    }
  }

  function startMailNotify() {
    if (mailNotifyTimer) return;
    requestNotifyPermission();
    checkNewMail();
    mailNotifyTimer = setInterval(checkNewMail, NOTIFY_INTERVAL);
  }
  function stopMailNotify() {
    if (mailNotifyTimer) { clearInterval(mailNotifyTimer); mailNotifyTimer = null; }
  }
  // 调试/自动化钩子：便于手动触发一轮检查或临时改间隔
  window.__mailNotifyTick = () => checkNewMail();
  window.__mailNotifySetInterval = (ms) => {
    stopMailNotify();
    mailNotifyTimer = setInterval(checkNewMail, Math.max(3000, parseInt(ms, 10) || NOTIFY_INTERVAL));
  };
  // 调试/自动化钩子：直接打开某篇文献的 PDF 阅读器、切换右侧页签、读取当前模型
  window.__openReader = (id) => openPdfReader(id);
  window.__setPrTab = (t) => switchPrTab(t);
  window.__activeModel = () => ({
    activeProfileId, active: activeModelInfo,
    profiles: profiles.map((p) => ({ id: p.id, label: p.label, provider: p.provider, model: p.model })),
  });

  function fmtMailDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }
  function fmtMailFullDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtSize(n) {
    const b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ---------- 三栏渲染 ----------
  function renderMailView() {
    renderMailSide();
    if (!mailCur.accountId) {
      renderMailListHead();
      $('mailList').innerHTML = mailAccounts.length
        ? '<div class="mail-empty">选择左侧邮箱账户开始收信</div>'
        : mailGuideHtml();
      $('mailPager').innerHTML = '';
      renderMailDetail();
    }
  }
  function mailGuideHtml() {
    return `<div class="mail-guide">
      <div class="mail-guide-ico">📧</div>
      <b>还没有登录邮箱</b>
      <p>登录邮箱后可以在这里直接收发与阅读邮件，多个邮箱可以同时管理（例如个人 163 邮箱 + 学校邮箱）。</p>
      <p class="mail-guide-dim">暂时不登录也没关系，其他功能不受影响，随时可以在左侧「＋ 账户管理」里添加。</p>
      <button class="btn btn-primary" id="btnMailGuideAdd">＋ 添加邮箱账户</button>
    </div>`;
  }

  function renderMailSide() {
    const accBox = $('mailAccounts');
    accBox.innerHTML = mailAccounts.length
      ? mailAccounts.map((a) => `
        <div class="mail-acc${a.id === mailCur.accountId ? ' active' : ''}" data-acc="${a.id}" title="${esc(a.email)}">
          <span class="mail-badge">${mailBadge(a.email)}</span>
          <div class="mail-acc-info">
            <b>${esc(a.label || a.email)}</b>
            <span>${esc(a.email)}</span>
          </div>
        </div>`).join('')
      : '<div class="mail-empty-side">尚未添加邮箱账户</div>';

    const fBox = $('mailFolders');
    if (!mailCur.accountId) { fBox.innerHTML = ''; return; }
    fBox.innerHTML = mailFolders.length
      ? mailFolders.map((f) => `
        <div class="mail-folder${f.path === mailCur.folder ? ' active' : ''}" data-folder="${esc(f.path)}" data-foldername="${esc(f.name)}">
          <span class="mail-folder-ico">${FOLDER_ICONS[f.specialUse] || '📁'}</span><span class="mail-folder-name">${esc(f.name)}</span>
        </div>`).join('')
      : '<div class="mail-empty-side">暂无文件夹</div>';
  }

  function renderMailListHead() {
    const box = $('mailListHead');
    if (!mailCur.accountId) { box.innerHTML = ''; return; }
    const acc = mailAccounts.find((a) => a.id === mailCur.accountId);
    const scope = mailCur.search ? `搜索「${esc(mailCur.search)}」` : esc(mailCur.folderName || mailCur.folder);
    box.innerHTML = `<span class="mail-title-main">${scope}</span>
      <span class="mail-title-sub">${esc(acc ? (acc.label || acc.email) : '')} · 共 ${mailTotal} 封</span>`;
  }

  function renderMailMessages() {
    const box = $('mailList');
    if (!mailMessages.length) {
      box.innerHTML = `<div class="mail-empty">${mailCur.search ? '没有找到匹配的邮件' : '这个文件夹还没有邮件'}</div>`;
    } else {
      box.innerHTML = mailMessages.map((m) => `
        <div class="mail-item${m.seen ? '' : ' unread'}${mailDetail && mailDetail.uid === m.uid ? ' active' : ''}" data-mail="${m.uid}">
          <span class="mail-dot"></span>
          <div class="mail-item-main">
            <div class="mail-item-row1">
              <span class="mail-from" title="${esc(m.fromAddress)}">${esc(m.fromName || m.fromAddress || '(未知发件人)')}</span>
              <span class="mail-date">${esc(fmtMailDate(m.date))}</span>
            </div>
            <div class="mail-item-row2">
              <span class="mail-subject" title="${esc(m.subject)}">${esc(m.subject)}</span>
              ${m.hasAttachments ? '<span class="mail-attach-ico" title="含附件">📎</span>' : ''}
            </div>
          </div>
        </div>`).join('');
    }
    renderMailPager();
    renderMailListHead();
  }

  function renderMailPager() {
    const box = $('mailPager');
    if (!mailCur.accountId) { box.innerHTML = ''; return; }
    const pages = Math.max(1, Math.ceil(mailTotal / mailCur.pageSize));
    const p = Math.min(mailCur.page, pages);
    box.innerHTML = `
      <button class="tb-btn" data-mail-page="prev"${p <= 1 ? ' disabled' : ''}>‹ 上一页</button>
      <span class="mail-page-info">${p} / ${pages}</span>
      <button class="tb-btn" data-mail-page="next"${p >= pages ? ' disabled' : ''}>下一页 ›</button>
      <span class="mail-page-size">
        <select class="tb-select" id="mailPageSize">
          ${[25, 50, 100].map((n) => `<option value="${n}"${n === mailCur.pageSize ? ' selected' : ''}>每页 ${n} 封</option>`).join('')}
        </select>
      </span>`;
  }

  // 邮件 HTML 正文：注入基础样式（自适应宽度 / 图片不溢出 / 字体统一），并清理未替换的内嵌图片引用
  function mailFrameDoc(html) {
    let s = String(html || '');
    s = s.replace(/(src|href)\s*=\s*(["'])cid:[^"']*\2/gi, '$1=$2data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7$2');
    const inject = `<base target="_blank">
<style>
html, body { margin: 0; padding: 12px 16px; font-size: 14px; line-height: 1.75; word-break: break-word;
  font-family: "Times New Roman", "Microsoft YaHei", "PingFang SC", sans-serif; color: #17231f; background: #fff; }
img { max-width: 100%; height: auto; }
table { max-width: 100% !important; }
pre { white-space: pre-wrap; }
a { color: #176b87; }
</style>`;
    if (/<head[^>]*>/i.test(s)) return s.replace(/<head[^>]*>/i, (m) => m + inject);
    if (/<html[^>]*>/i.test(s)) return s.replace(/<html[^>]*>/i, (m) => m + inject);
    return inject + s;
  }

  function renderMailDetail() {
    const box = $('mailDetail');
    if (!mailDetail) {
      box.innerHTML = '<div class="mail-placeholder">📬 选中一封邮件后在此阅读</div>';
      return;
    }
    const d = mailDetail;
    const accId = mailCur.accountId;
    const folderQ = encodeURIComponent(mailCur.folder);
    const atts = (d.attachments || []).filter((a) => !a.inline);    box.innerHTML = `
      <div class="mail-detail-head">
        <div class="mail-detail-subject">${esc(d.subject)}</div>
        <div class="mail-detail-meta">
          <span class="mail-detail-from">${esc(d.fromName || d.fromAddress)}</span>
          <span class="mail-detail-addr">&lt;${esc(d.fromAddress)}&gt;</span>
          <span class="ob-spacer"></span>
          <span class="mail-detail-date">${esc(fmtMailFullDate(d.date))}</span>
        </div>
        <div class="mail-detail-to">收件人：${esc(d.to || '')}${d.cc ? `　抄送：${esc(d.cc)}` : ''}</div>
        <div class="mail-detail-ops">
          <button class="tb-btn" data-mail-reply="1">↩ 回复</button>
          <button class="tb-btn" data-mail-unread="1">标记未读</button>
          <button class="tb-btn" data-mail-del="1">🗑 删除</button>
        </div>
        ${atts.length ? `<div class="mail-atts">${atts.map((a) => `
          <a class="mail-att" href="/api/mail/accounts/${accId}/messages/${d.uid}/attachments/${a.index}?folder=${folderQ}" title="${esc(a.filename)}">
            <span class="mail-att-ico">📎</span>
            <span class="mail-att-name">${esc(a.filename)}</span>
            <span class="mail-att-size">${fmtSize(a.size)}</span>
          </a>`).join('')}</div>` : ''}
      </div>
      <div class="mail-body">${d.html
        ? `<iframe class="mail-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(mailFrameDoc(d.html))}"></iframe>`
        : `<pre class="mail-text">${esc(d.text || '(无正文)')}</pre>`}</div>`;
  }

  // ---------- 数据加载 ----------
  async function ensureMailFolders(accountId, force = false) {
    if (!force && mailFoldersOwner === accountId && mailFolders.length) { renderMailSide(); return; }
    mailFoldersOwner = accountId;
    try {
      mailFolders = await api(`/api/mail/accounts/${accountId}/folders`);
    } catch (e) {
      mailFolders = [];
      toast('读取文件夹失败：' + e.message, 'error');
    }
    renderMailSide();
  }

  async function openMailFolder(accountId, folder, name, page = 1) {
    if (!accountId) return;
    mailCur.accountId = accountId;
    mailCur.folder = folder || 'INBOX';
    mailCur.folderName = name || folder || '收件箱';
    mailCur.page = page;
    mailDetail = null;
    renderMailSide();
    renderMailDetail();
    await loadMailMessages();
  }

  async function selectMailAccount(id) {
    if (!id || (mailCur.accountId === id && mailMessages.length)) return;
    mailMessages = []; mailTotal = 0; mailDetail = null;
    $('mailSearch').value = '';
    mailCur = { accountId: id, folder: 'INBOX', folderName: '收件箱', page: 1, pageSize: mailCur.pageSize, search: '' };
    await ensureMailFolders(id, true);
    // 优先定位到真正的收件箱文件夹（不同邮箱命名可能不同）
    const inbox = mailFolders.find((f) => f.specialUse === '\\Inbox') || mailFolders.find((f) => f.path === 'INBOX');
    await openMailFolder(id, inbox ? inbox.path : 'INBOX', inbox ? inbox.name : '收件箱', 1);
  }

  async function loadMailMessages() {
    if (!mailCur.accountId) return;
    $('mailList').innerHTML = '<div class="mail-loading">正在收取邮件…</div>';
    renderMailListHead();
    const q = new URLSearchParams({ folder: mailCur.folder, page: String(mailCur.page), pageSize: String(mailCur.pageSize) });
    if (mailCur.search) q.set('search', mailCur.search);
    try {
      const data = await api(`/api/mail/accounts/${mailCur.accountId}/messages?${q.toString()}`);
      mailMessages = data.messages || [];
      mailTotal = data.total || 0;
      renderMailMessages();
    } catch (e) {
      mailMessages = []; mailTotal = 0;
      $('mailList').innerHTML = `<div class="mail-error">收取失败：${esc(e.message)}<div><button class="btn" data-mail-retry="1">重试</button></div></div>`;
      renderMailPager();
    }
  }

  async function openMailMessage(uid) {
    const id = mailCur.accountId;
    $('mailDetail').innerHTML = '<div class="mail-loading">正在打开邮件…</div>';
    try {
      const d = await api(`/api/mail/accounts/${id}/messages/${uid}?folder=${encodeURIComponent(mailCur.folder)}`);
      mailDetail = d;
      renderMailDetail();
      const item = mailMessages.find((m) => m.uid === Number(uid));
      if (item && !item.seen) {
        item.seen = true;
        api(`/api/mail/accounts/${id}/messages/${uid}/seen`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seen: true, folder: mailCur.folder }),
        }).catch(() => { /* 标记失败不影响阅读 */ });
      }
      renderMailMessages();
    } catch (e) {
      mailDetail = null;
      $('mailDetail').innerHTML = `<div class="mail-error">打开失败：${esc(e.message)}</div>`;
    }
  }

  async function markMailUnread() {
    if (!mailDetail) return;
    const uid = mailDetail.uid;
    try {
      await api(`/api/mail/accounts/${mailCur.accountId}/messages/${uid}/seen`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seen: false, folder: mailCur.folder }),
      });
      const it = mailMessages.find((m) => m.uid === uid);
      if (it) it.seen = false;
      renderMailMessages();
      toast('已标记为未读', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function removeMailMessage() {
    if (!mailDetail) return;
    if (!confirm('确认删除这封邮件？删除后无法恢复。')) return;
    const uid = mailDetail.uid;
    try {
      await api(`/api/mail/accounts/${mailCur.accountId}/messages/${uid}?folder=${encodeURIComponent(mailCur.folder)}`, { method: 'DELETE' });
      mailDetail = null;
      renderMailDetail();
      await loadMailMessages();
      toast('邮件已删除', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- 账户管理 ----------
  function renderMaProviderOptions() {
    const sel = $('maProvider');
    if (sel.dataset.ready) return;
    sel.innerHTML = Object.entries(mailProviders || {})
      .map(([key, p]) => `<option value="${esc(key)}">${esc(p.label || key)}</option>`).join('');
    sel.dataset.ready = '1';
    sel.value = '163';
    applyMailProviderPreset();
  }

  function applyMailProviderPreset() {
    const p = (mailProviders || {})[$('maProvider').value] || {};
    $('maNote').textContent = p.note || '';
    $('maImapHost').value = p.imapHost || '';
    $('maImapPort').value = p.imapPort || 993;
    $('maImapSecure').checked = p.imapSecure !== false;
    $('maSmtpHost').value = p.smtpHost || '';
    $('maSmtpPort').value = p.smtpPort || 465;
    $('maSmtpSecure').checked = p.smtpSecure !== false;
    $('maSelfSigned').checked = false;
  }

  function resetMailAccountForm() {
    mailMaEditId = null;
    $('maFormTitle').textContent = '添加邮箱账户';
    $('maLabel').value = '';
    $('maEmail').value = '';
    $('maPassword').value = '';
    $('maTestResult').classList.add('hidden');
    $('maProvider').value = '163';
    applyMailProviderPreset();
  }

  function fillMailAccountForm(acc) {
    if (!acc) return;
    mailMaEditId = acc.id;
    $('maFormTitle').textContent = `编辑账户：${acc.label || acc.email}`;
    $('maProvider').value = acc.provider || 'custom';
    if (!mailProviders || !mailProviders[acc.provider]) $('maProvider').value = 'custom';
    $('maLabel').value = acc.label || '';
    $('maEmail').value = acc.email || '';
    $('maPassword').value = '';
    $('maPassword').placeholder = acc.hasPassword ? '留空表示不修改授权码' : '请输入授权码';
    $('maImapHost').value = acc.imapHost || '';
    $('maImapPort').value = acc.imapPort || 993;
    $('maImapSecure').checked = acc.imapSecure !== false;
    $('maSmtpHost').value = acc.smtpHost || '';
    $('maSmtpPort').value = acc.smtpPort || 465;
    $('maSmtpSecure').checked = acc.smtpSecure !== false;
    $('maSelfSigned').checked = !!acc.allowSelfSigned;
    $('maNote').textContent = (mailProviders[acc.provider] || {}).note || '';
    $('maTestResult').classList.add('hidden');
  }

  function renderMaList() {
    const box = $('maList');
    if (!mailAccounts.length) {
      box.innerHTML = '<div class="ma-empty">还没有添加任何邮箱账户。在下方表单填写信息即可登录，支持同时添加多个邮箱。</div>';
      return;
    }
    box.innerHTML = mailAccounts.map((a) => `
      <div class="ma-item${a.id === mailMaEditId ? ' active' : ''}">
        <span class="mail-badge">${mailBadge(a.email)}</span>
        <div class="ma-item-info">
          <b>${esc(a.label || a.email)}</b>
          <span>${esc(a.email)}${a.imapHost ? ' · ' + esc(a.imapHost) : ''}${a.lastSyncAt ? ' · 最近收信 ' + esc(fmtMailFullDate(a.lastSyncAt)) : ''}</span>
        </div>
        <div class="ma-item-ops">
          <button class="tb-btn" data-ma-test="${a.id}">测试</button>
          <button class="tb-btn" data-ma-edit="${a.id}">编辑</button>
          <button class="tb-btn danger" data-ma-del="${a.id}">删除</button>
        </div>
      </div>`).join('');
  }

  async function openMailAccountModal(id) {
    await ensureMailProviders();
    renderMaProviderOptions();
    mailMaEditId = id || null;
    renderMaList();
    if (id) fillMailAccountForm(mailAccounts.find((a) => a.id === id));
    else resetMailAccountForm();
    renderMaList();
    $('maTestResult').classList.add('hidden');
    $('mailAccountModal').classList.remove('hidden');
  }

  function mailAccFormData() {
    return {
      provider: $('maProvider').value,
      label: $('maLabel').value.trim(),
      email: $('maEmail').value.trim(),
      password: $('maPassword').value,
      imapHost: $('maImapHost').value.trim(),
      imapPort: $('maImapPort').value.trim(),
      imapSecure: $('maImapSecure').checked,
      smtpHost: $('maSmtpHost').value.trim(),
      smtpPort: $('maSmtpPort').value.trim(),
      smtpSecure: $('maSmtpSecure').checked,
      allowSelfSigned: $('maSelfSigned').checked,
    };
  }

  async function testMailAccountForm() {
    const box = $('maTestResult');
    box.className = 'ma-test-result';
    box.classList.remove('hidden');
    box.textContent = '正在连接邮件服务器…';
    const btn = $('btnMaTest');
    btn.disabled = true;
    try {
      const r = await api('/api/mail/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mailAccFormData()),
      });
      box.classList.add('ok');
      box.textContent = `✅ 连接成功：收件箱 ${r.inboxMessages} 封邮件，共 ${r.folderCount} 个文件夹`;
    } catch (e) {
      box.classList.add('err');
      box.textContent = '❌ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function saveMailAccountForm() {
    const data = mailAccFormData();
    const btn = $('btnMaSave');
    btn.disabled = true;
    const editingId = mailMaEditId;
    try {
      if (editingId) {
        await api('/api/mail/accounts/' + editingId, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        });
      } else {
        const created = await api('/api/mail/accounts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        });
        mailMaEditId = created.id;
      }
      await loadMailAccounts();
      const targetId = editingId || mailMaEditId;
      resetMailAccountForm();
      renderMaList();
      renderMailSide();
      toast(editingId ? '账户已更新' : '账户已添加，正在连接邮箱…', 'success');
      await selectMailAccount(targetId);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 写邮件 ----------
  function openMailCompose(to = '', subject = '') {
    if (!mailAccounts.length) {
      toast('请先添加一个邮箱账户', 'error');
      openMailAccountModal(null);
      return;
    }
    $('mcFrom').innerHTML = mailAccounts
      .map((a) => `<option value="${a.id}">${esc(a.label || a.email)}</option>`).join('');
    if (mailCur.accountId) $('mcFrom').value = mailCur.accountId;
    $('mcTo').value = to || '';
    $('mcCc').value = '';
    $('mcSubject').value = subject || '';
    $('mcBody').value = '';
    $('mailComposeModal').classList.remove('hidden');
    setTimeout(() => { if (!to) $('mcTo').focus(); else $('mcBody').focus(); }, 30);
  }

  async function sendMailCompose() {
    const id = $('mcFrom').value;
    const to = $('mcTo').value.trim();
    if (!to) return toast('请填写收件人', 'error');
    const btn = $('btnMcSend');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '发送中…';
    try {
      await api(`/api/mail/accounts/${id}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to, cc: $('mcCc').value.trim(),
          subject: $('mcSubject').value.trim(), text: $('mcBody').value,
        }),
      });
      $('mailComposeModal').classList.add('hidden');
      toast('邮件已发送', 'success');
    } catch (e) {
      toast('发送失败：' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  // ---------- 邮箱事件绑定 ----------
  function bindMailEvents() {
    $('btnMailManage').addEventListener('click', () => openMailAccountModal(null));
    $('btnMailCompose').addEventListener('click', () => openMailCompose());
    $('btnMailRefresh').addEventListener('click', async () => {
      if (!mailCur.accountId) { toast('请先添加邮箱账户', 'error'); return; }
      await ensureMailFolders(mailCur.accountId, true);
      await loadMailMessages();
      toast('已刷新', 'success');
    });

    $('mailSearch').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (!mailCur.accountId) return;
      mailCur.search = $('mailSearch').value.trim();
      mailCur.page = 1;
      loadMailMessages();
    });
    $('mailSearch').addEventListener('input', (e) => {
      if (!e.target.value && mailCur.search && mailCur.accountId) {
        mailCur.search = '';
        mailCur.page = 1;
        loadMailMessages();
      }
    });

    $('mailAccounts').addEventListener('click', (e) => {
      const a = e.target.closest('[data-acc]');
      if (a) selectMailAccount(a.dataset.acc);
    });
    $('mailFolders').addEventListener('click', (e) => {
      const f = e.target.closest('[data-folder]');
      if (f) openMailFolder(mailCur.accountId, f.dataset.folder, f.dataset.foldername, 1);
    });
    $('mailList').addEventListener('click', (e) => {
      if (e.target.closest('[data-mail-retry]')) { loadMailMessages(); return; }
      if (e.target.closest('#btnMailGuideAdd')) { openMailAccountModal(null); return; }
      const item = e.target.closest('[data-mail]');
      if (item) openMailMessage(Number(item.dataset.mail));
    });
    $('mailPager').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mail-page]');
      if (!b) return;
      const pages = Math.max(1, Math.ceil(mailTotal / mailCur.pageSize));
      if (b.dataset.mailPage === 'prev' && mailCur.page > 1) { mailCur.page--; loadMailMessages(); }
      if (b.dataset.mailPage === 'next' && mailCur.page < pages) { mailCur.page++; loadMailMessages(); }
    });
    $('mailPager').addEventListener('change', (e) => {
      if (e.target.id === 'mailPageSize') {
        mailCur.pageSize = parseInt(e.target.value, 10) || 25;
        mailCur.page = 1;
        loadMailMessages();
      }
    });
    $('mailDetail').addEventListener('click', (e) => {
      if (!mailDetail) return;
      if (e.target.closest('[data-mail-reply]')) {
        const subj = /^re:/i.test(mailDetail.subject) ? mailDetail.subject : 'Re: ' + mailDetail.subject;
        openMailCompose(mailDetail.fromAddress, subj);
      } else if (e.target.closest('[data-mail-unread]')) markMailUnread();
      else if (e.target.closest('[data-mail-del]')) removeMailMessage();
    });

    // 账户管理弹窗
    $('btnMaClose').addEventListener('click', () => $('mailAccountModal').classList.add('hidden'));
    $('btnMaCancel').addEventListener('click', () => { resetMailAccountForm(); renderMaList(); });
    $('btnMaSave').addEventListener('click', saveMailAccountForm);
    $('btnMaTest').addEventListener('click', testMailAccountForm);
    $('maProvider').addEventListener('change', () => {
      $('maTestResult').classList.add('hidden');
      applyMailProviderPreset();
    });
    $('maList').addEventListener('click', async (e) => {
      const ed = e.target.closest('[data-ma-edit]');
      const del = e.target.closest('[data-ma-del]');
      const ts = e.target.closest('[data-ma-test]');
      if (ed) { fillMailAccountForm(mailAccounts.find((a) => a.id === ed.dataset.maEdit)); renderMaList(); return; }
      if (ts) {
        const box = $('maTestResult');
        box.className = 'ma-test-result';
        box.classList.remove('hidden');
        box.textContent = '正在连接邮件服务器…';
        try {
          const r = await api(`/api/mail/accounts/${ts.dataset.maTest}/test`, { method: 'POST' });
          box.classList.add('ok');
          box.textContent = `✅ 连接成功：收件箱 ${r.inboxMessages} 封邮件，共 ${r.folderCount} 个文件夹`;
        } catch (err) {
          box.classList.add('err');
          box.textContent = '❌ ' + err.message;
        }
        return;
      }
      if (del) {
        const acc = mailAccounts.find((a) => a.id === del.dataset.maDel);
        if (!acc) return;
        if (!confirm(`确认删除邮箱账户「${acc.label || acc.email}」？\n（仅从本软件移除，不会影响邮箱里的邮件）`)) return;
        try {
          await api('/api/mail/accounts/' + acc.id, { method: 'DELETE' });
          await loadMailAccounts();
          if (mailCur.accountId === acc.id) {
            mailCur = { accountId: '', folder: 'INBOX', folderName: '收件箱', page: 1, pageSize: mailCur.pageSize, search: '' };
            mailFolders = []; mailFoldersOwner = ''; mailMessages = []; mailTotal = 0; mailDetail = null;
            renderMailView();
          }
          if (mailMaEditId === acc.id) resetMailAccountForm();
          renderMaList();
          renderMailSide();
          toast('账户已移除', 'success');
        } catch (err) { toast(err.message, 'error'); }
      }
    });

    // 写邮件弹窗
    $('btnMcClose').addEventListener('click', () => $('mailComposeModal').classList.add('hidden'));
    $('btnMcCancel').addEventListener('click', () => $('mailComposeModal').classList.add('hidden'));
    $('btnMcSend').addEventListener('click', sendMailCompose);
  }

  // 进入邮箱视图（首次进入时懒加载账户，避免拖慢启动）
  async function enterMailView() {
    renderMailView();
    if (mailInited) return;
    mailInited = true;
    try {
      await ensureMailProviders();
      renderMaProviderOptions();
      await loadMailAccounts();
    } catch (e) {
      toast('读取邮箱账户失败：' + e.message, 'error');
    }
    renderMailView();
    if (mailAccounts.length && !mailCur.accountId) await selectMailAccount(mailAccounts[0].id);
  }

  // ---------- 桌面应用更新 ----------
  function formatUpdateBytes(value) {
    const n = Number(value || 0);
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function renderUpdateStatus(status = updateStatus) {
    if (!status) return;
    updateStatus = status;
    const phase = status.phase || 'idle';
    const current = status.currentVersion ? `v${status.currentVersion}` : '--';
    const available = status.availableVersion ? `v${status.availableVersion}` : '--';
    $('updateCurrentVersion').textContent = current;
    $('updateAvailableVersion').textContent = available;
    $('updateVersionArrow').classList.toggle('hidden', !status.availableVersion);

    const copy = {
      idle: ['↻', '准备检查更新', '点击下方按钮，从 GitHub Releases 检查可安装的新版本。'],
      unsupported: ['—', '当前环境不支持自动更新', status.error || '请在安装后的 Windows 桌面版中使用此功能。'],
      checking: ['↻', '正在检查新版本', '正在读取 GitHub Releases 的稳定版本信息…'],
      available: ['↓', `发现新版本 ${available}`, '版本已通过更新清单验证，可以开始下载。'],
      downloading: ['↓', `正在下载 ${available}`, '可以关闭此窗口继续使用，下载会在后台进行。'],
      downloaded: ['✓', `${available} 已准备好`, '保存当前工作后，退出应用并启动安装程序。'],
      'not-available': ['✓', '当前已是最新版本', `当前使用的是 ${current}，暂未发现更高版本。`],
      error: ['!', '更新检查失败', status.error || '请检查网络、代理或 GitHub Release 配置后重试。'],
    }[phase] || ['↻', '应用更新', '可以手动检查 GitHub Releases。'];
    $('updateStateIcon').textContent = copy[0];
    $('updateStateIcon').className = `update-state-icon phase-${phase}`;
    $('updateStateTitle').textContent = copy[1];
    $('updateStateMessage').textContent = copy[2];

    const downloading = phase === 'downloading';
    $('updateProgressWrap').classList.toggle('hidden', !downloading);
    const percent = Math.max(0, Math.min(100, Number(status.percent || 0)));
    $('updateProgressBar').style.width = `${percent}%`;
    $('updateProgressText').textContent = status.total
      ? `${percent.toFixed(1)}% · ${formatUpdateBytes(status.transferred)} / ${formatUpdateBytes(status.total)}`
      : `${percent.toFixed(1)}%`;
    $('updateSpeedText').textContent = status.bytesPerSecond ? `${formatUpdateBytes(status.bytesPerSecond)}/s` : '';

    const hasNotes = Boolean(status.releaseName || status.releaseNotes);
    $('updateReleaseWrap').classList.toggle('hidden', !hasNotes);
    $('updateReleaseName').textContent = status.releaseName || `版本 ${available}`;
    $('updateReleaseNotes').innerHTML = status.releaseNotes
      ? renderMarkdown(status.releaseNotes)
      : '<p>此版本未提供发布说明。</p>';

    const actions = {
      idle: ['检查更新', 'check'], checking: ['正在检查…', ''], available: ['下载更新', 'download'],
      downloading: ['正在下载…', ''], downloaded: ['退出并安装', 'install'],
      'not-available': ['重新检查', 'check'], error: ['重试', 'check'], unsupported: ['仅桌面版可用', ''],
    };
    const [label, nextAction] = actions[phase] || actions.idle;
    const actionButton = $('btnUpdateAction');
    actionButton.textContent = label;
    actionButton.dataset.updateAction = nextAction;
    actionButton.disabled = updateActionBusy || !nextAction;

    const badge = $('updateNavBadge');
    badge.classList.toggle('hidden', !['available', 'downloaded'].includes(phase));
    badge.textContent = phase === 'downloaded' ? '待安装' : '新版本';
    $('updateNavLabel').textContent = phase === 'downloading' ? `下载 ${Math.round(percent)}%` : (phase === 'downloaded' ? '安装更新' : '检查更新');
    $('btnCheckUpdate').classList.toggle('has-update', ['available', 'downloaded'].includes(phase));
  }

  async function loadUpdateStatus(silent = false) {
    try {
      const status = await api('/api/update/status');
      renderUpdateStatus(status);
      return status;
    } catch (e) {
      if (!silent) toast('读取更新状态失败：' + e.message, 'error');
      return null;
    }
  }

  function beginUpdatePolling() {
    if (updatePollTimer) return;
    updatePollTimer = setInterval(async () => {
      const status = await loadUpdateStatus(true);
      if (status && !['checking', 'downloading'].includes(status.phase) && !updateActionBusy) {
        clearInterval(updatePollTimer);
        updatePollTimer = null;
      }
    }, 900);
  }

  async function runUpdateAction() {
    const action = $('btnUpdateAction').dataset.updateAction;
    if (!action || updateActionBusy) return;
    updateActionBusy = true;
    if (action === 'check') renderUpdateStatus({ ...updateStatus, phase: 'checking', error: '' });
    if (action === 'download') renderUpdateStatus({ ...updateStatus, phase: 'downloading', percent: 0, error: '' });
    beginUpdatePolling();
    try {
      renderUpdateStatus(await api(`/api/update/${action}`, { method: 'POST' }));
    } catch (e) {
      const latest = await loadUpdateStatus(true);
      if (!latest || latest.phase !== 'error') renderUpdateStatus({ ...(updateStatus || {}), phase: 'error', error: e.message });
    } finally {
      updateActionBusy = false;
      renderUpdateStatus(updateStatus);
      if (!['checking', 'downloading'].includes(updateStatus?.phase)) {
        clearInterval(updatePollTimer);
        updatePollTimer = null;
      }
    }
  }

  function bindUpdater() {
    const open = async () => {
      $('updateModal').classList.remove('hidden');
      await loadUpdateStatus();
      if (['checking', 'downloading'].includes(updateStatus?.phase)) beginUpdatePolling();
    };
    const close = () => $('updateModal').classList.add('hidden');
    $('btnCheckUpdate').addEventListener('click', open);
    $('btnUpdateClose').addEventListener('click', close);
    $('btnUpdateCancel').addEventListener('click', close);
    $('updateModal').querySelector('.modal-mask').addEventListener('click', close);
    $('btnUpdateAction').addEventListener('click', runUpdateAction);
    loadUpdateStatus(true);
  }

  // ---------- 工作台事件绑定 ----------
  function bindWorkbench() {
    // 侧边栏导航
    document.querySelectorAll('.nav-item[data-view]').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));
    $('btnNavSettings').addEventListener('click', openSettingsModal);
    $('btnSettings').addEventListener('click', openSettingsModal);

    // 文献分类移动弹窗
    const closeClassModal = () => $('classModal').classList.add('hidden');
    $('btnClassClose').addEventListener('click', closeClassModal);
    $('btnClassCancel').addEventListener('click', closeClassModal);
    $('btnClassSave').addEventListener('click', saveClassMove);

    // 邮箱
    bindMailEvents();

    // 数据备份
    bindBackupEvents();

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
      const rb = e.target.closest('[data-rankrefresh]');
      if (rb) { e.stopPropagation(); manualRankRefresh(rb.dataset.rankrefresh); return; }
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
    // 期刊名变更时立即清空等级（旧期刊的等级作废），保存后会按新期刊名自动重查
    $('paperJournal').addEventListener('input', () => {
      if (paperDraft && paperDraft.rank) {
        paperDraft.rank = null;
        $('paperRankChips').innerHTML = '<span class="rank-err" style="opacity:.75">期刊已变更，保存后将自动重新查询等级</span>';
      }
    });
    // 状态切换时，起始日默认重置为今天（用户可手动改成实际生效日）
    $('paperStatus').addEventListener('change', () => { $('paperStatusDate').value = todayStr(); });
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
    $('calOptions').addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('calOptionsPop');
      pop.querySelectorAll('[data-cal-pref]').forEach((input) => {
        input.checked = calendarData.preferences[input.dataset.calPref] !== false;
      });
      pop.classList.toggle('hidden');
    });
    $('calOptionsPop').addEventListener('click', (e) => e.stopPropagation());
    $('calOptionsPop').addEventListener('change', async (e) => {
      const input = e.target.closest('[data-cal-pref]');
      if (!input) return;
      try {
        calendarData = await api('/api/calendar/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [input.dataset.calPref]: input.checked }),
        });
        renderCalendar();
      } catch (err) {
        input.checked = !input.checked;
        toast('保存历法设置失败：' + err.message, 'error');
      }
    });
    document.addEventListener('click', () => $('calOptionsPop').classList.add('hidden'));
    $('calImport').addEventListener('click', () => {
      $('calIcsInput').value = '';
      $('calIcsInput').click();
    });
    $('calIcsInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { toast('ICS 文件超过 10MB，无法导入', 'error'); return; }
      try {
        const result = await api('/api/calendar/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ics: await file.text(), sourceName: file.name }),
        });
        calendarData = result.calendar;
        renderCalendar();
        toast(`已导入 ${result.added} 项${result.skipped ? `，跳过 ${result.skipped} 项重复事件` : ''}`, 'success');
      } catch (err) { toast('导入日历失败：' + err.message, 'error'); }
    });
    $('calDayEvents').addEventListener('click', async (e) => {
      const button = e.target.closest('[data-cal-event-del]');
      if (!button || !confirm('确认删除这条导入的日历事件？')) return;
      try {
        calendarData = await api('/api/calendar/events/' + encodeURIComponent(button.dataset.calEventDel), { method: 'DELETE' });
        renderCalendar();
        toast('日历事件已删除', 'success');
      } catch (err) { toast(err.message, 'error'); }
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
    $('chatMsgs').addEventListener('click', (e) => {
      const button = e.target.closest('[data-chat-retry]');
      if (!button || chatBusy) return;
      const index = Number(button.dataset.chatRetry);
      const failed = chatMsgs[index];
      if (!failed?.error || !failed.retryContent) return;
      const content = failed.retryContent;
      chatMsgs.splice(index, 1);
      renderChatMsgs();
      sendChat(content, { retry: true });
    });
    $('btnClearChat').addEventListener('click', async () => {
      if (!confirm('确认清空全部会话？所有聊天记录将删除且不可恢复。')) return;
      try { await api('/api/chat/history', { method: 'DELETE' }); conversations = []; activeConvId = null; chatMsgs = []; activeSummary = ''; renderChatMsgs(); renderConvList(); toast('全部对话已清空', 'success'); }
      catch (e) { toast(e.message, 'error'); }
    });
  }

  async function openSettingsModal() {
    // 先拉一次最新配置，避免用设置页改完再进设置时看到旧列表
    await loadModels();
    fillSettingsForm();
    $('settingsModal').classList.remove('hidden');
    loadBackupList();
  }

  // ============ 数据备份与恢复 ============
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
    return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  // 备份目录名形如 2026-09-16T03-45-12_startup -> 显示成「2026-09-16 03:45:12 · 自动」
  function fmtBackupName(name) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})_?(.*)$/.exec(String(name || ''));
    if (!m) return name;
    const kind = { startup: '自动', manual: '手动', 'before-restore': '恢复前' }[m[5]] || m[5] || '';
    return `${m[1]} ${m[2]}:${m[3]}:${m[4]}${kind ? ' · ' + kind : ''}`;
  }

  async function loadBackupList() {
    const wrap = $('bkListWrap');
    if (!wrap) return;
    wrap.innerHTML = '<div class="bk-loading">正在读取备份列表…</div>';
    try {
      const d = await api('/api/backup/list');
      const list = d.backups || [];
      const dirLine = `<div class="bk-dir" title="${esc(d.dataDir || '')}">📁 ${esc(d.dataDir || '')}</div>`;
      if (!list.length) {
        wrap.innerHTML = dirLine + '<div class="bk-empty">还没有备份。点「立即备份」创建第一份，或重启应用后自动生成。</div>';
        return;
      }
      wrap.innerHTML = dirLine + `<div class="bk-list">${list.map((b) => `
        <div class="bk-item">
          <span class="bk-name" title="${esc(b.name)}">${esc(fmtBackupName(b.name))}</span>
          <span class="bk-size">${fmtBytes(b.size)}</span>
          <button class="tb-btn" data-bkrestore="${esc(b.name)}">恢复</button>
        </div>`).join('')}</div>`;
      wrap.querySelectorAll('[data-bkrestore]').forEach((btn) => btn.addEventListener('click', async () => {
        const name = btn.dataset.bkrestore;
        if (!confirm(`确认从备份「${fmtBackupName(name)}」恢复数据？\n\n`
          + `· 当前的数据会先自动备份一份（标记为「恢复前」），可以再退回来\n`
          + `· 恢复后建议重启应用，确保所有界面读到新数据`)) return;
        try {
          const r = await api('/api/backup/restore', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
          });
          toast(r.message || '已恢复', 'success');
          await Promise.all([loadItems(), loadSettings(), loadCollections(), loadWorkbenchData(), loadModels()]);
          renderModelSwitcher(); render(); loadBackupList();
        } catch (e) { toast('恢复失败：' + e.message, 'error'); }
      }));
    } catch (e) {
      wrap.innerHTML = `<div class="bk-empty">读取失败：${esc(e.message)}</div>`;
    }
  }

  function bindBackupEvents() {
    $('btnBkCreate')?.addEventListener('click', async () => {
      try {
        await api('/api/backup/create', { method: 'POST' });
        toast('已创建备份', 'success');
        loadBackupList();
      } catch (e) { toast('备份失败：' + e.message, 'error'); }
    });
    $('btnBkExport')?.addEventListener('click', () => {
      window.open('/api/backup/export', '_blank');
      toast('正在导出整包数据…');
    });
    $('btnBkOpenDir')?.addEventListener('click', async () => {
      try {
        const d = await api('/api/backup/list');
        if (!d.dataDir) { toast('未获取到数据目录', 'error'); return; }
        // 交给后端在系统文件管理器中打开
        await api('/api/open-datadir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: d.dataDir }) });
      } catch (e) { toast('打开目录失败：' + e.message, 'error'); }
    });
  }

  async function loadWorkbenchData() {
    [profile, projects, tasks, notes, papers, calendarData] = await Promise.all([
      api('/api/profile').catch(() => ({})),
      api('/api/projects').catch(() => []),
      api('/api/tasks').catch(() => []),
      api('/api/notes').catch(() => []),
      api('/api/papers').catch(() => []),
      api('/api/calendar').catch(() => ({ events: [], preferences: { lunar: true, solarTerms: true, festivals: true } })),
    ]);
  }

  // ============ 新手引导（首次使用） ============
  const OB_KEY = 'littable_onboarded_v2';
  const OB_VERSION = 2;
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
        { ico: '💾', html: '<b>数据保存目录</b>：默认存在<b>系统用户数据目录</b>（升级不丢失），想换位置再填，如 <code>D:\\文献库</code>，留空用默认' },
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

  // v2 focuses on the configuration required for every AI workflow. The previous
  // feature tour is intentionally replaced so existing users see the new setup path once.
  OB_STEPS.splice(0, OB_STEPS.length,
    {
      emoji: '👋', title: '先完成 AI 配置',
      desc: 'AI 助手、灵感孵化和模拟审稿都会使用当前激活的模型。接下来按实际设置顺序完成一条可用模型配置，再选择性接入 easyScholar。',
      points: [
        { ico: '🔒', html: 'API 密钥只保存在你的本机数据目录，不会显示在界面列表中。' },
        { ico: '🧪', html: '配置后先<b>测试连接</b>，再保存并设为使用中。' },
        { ico: '🏅', html: 'easyScholar 是可选项，仅用于提供期刊等级背景信息。' },
      ], target: null, center: true,
    },
    {
      emoji: '⚙️', title: '第 1 步 · 打开 AI 设置',
      desc: '点击侧边栏底部的<b>设置</b>，所有模型、视觉模型和 easyScholar 配置都在这里管理。',
      points: [
        { ico: '🧩', html: '可以保存多条模型配置，并在顶栏快速切换当前模型。' },
        { ico: '💡', html: '未配置模型时，涉及 AI 的功能会提示你先完成本步骤。' },
      ], target: '#btnNavSettings', view: 'home',
    },
    {
      emoji: '➕', title: '第 2 步 · 添加一条模型',
      desc: '已为你打开模型编辑表单。选择供应商后，继续填写接口地址、密钥和模型名称。',
      points: [
        { ico: '📌', html: '供应商预设会填入常见接口地址；其他 OpenAI 兼容服务可选择自定义。' },
        { ico: '📝', html: '备注名称可用于区分“日常阅读”“审稿”或“看图”等用途。' },
      ], target: '#mlEditor', view: 'home', settings: true, openModelEditor: true,
    },
    {
      emoji: '🔑', title: '第 3 步 · 填写接口信息',
      desc: '依次填写供应商、Base URL、API 密钥和模型名称。Base URL 填到版本根路径，例如以 <code>/v1</code> 结尾，程序会补全对话接口路径。',
      points: [
        { ico: '🌐', html: '<b>Base URL</b>：使用模型供应商提供的 OpenAI 兼容地址。' },
        { ico: '🔐', html: '<b>API 密钥</b>：只填写你自己的密钥，不要把密钥写入笔记、论文或截图。' },
        { ico: '🤖', html: '<b>模型名称</b>：必须与该供应商账户可用的模型 ID 完全一致。' },
      ], target: '#mlBaseURL', view: 'home', settings: true, openModelEditor: true,
    },
    {
      emoji: '🔌', title: '第 4 步 · 测试并保存',
      desc: '点击<b>测试连接</b>确认地址、密钥和模型 ID 可以共同工作；成功后点击保存。若失败，请根据返回的 HTTP 状态或错误信息逐项核对。',
      points: [
        { ico: '1️⃣', html: '先检查密钥是否有效、是否有余额或调用权限。' },
        { ico: '2️⃣', html: '再检查 Base URL 不是完整的 <code>/chat/completions</code> 地址。' },
        { ico: '3️⃣', html: '最后检查模型 ID 与供应商文档一致。' },
      ], target: '#btnMlTest', view: 'home', settings: true, openModelEditor: true,
    },
    {
      emoji: '✅', title: '第 5 步 · 设为使用中',
      desc: '保存后，在模型卡片上选择<b>使用中</b>的那条配置。顶栏的模型切换菜单也会显示它。模型未激活时，AI 工作流不会猜测该使用哪条密钥。',
      points: [
        { ico: '👁', html: '需要分析图片或图表时，可在下方为“两段式看图”指定视觉模型。' },
        { ico: '↔', html: '切换模型不会删除其他配置，适合按任务使用不同模型。' },
      ], target: '#mlList', view: 'home', settings: true,
    },
    {
      emoji: '🏅', title: '第 6 步 · 可选配置 easyScholar',
      desc: '如需显示期刊等级，在设置中填写你的 easyScholar SecretKey。模拟审稿会把查询结果作为严格度背景，不会把它当作真实期刊决定。',
      points: [
        { ico: '🔎', html: '目标期刊名称必须由用户填写，查询不到时应核对中英文全称。' },
        { ico: '⚠️', html: '等级数据可能更新或缺失，因此不能替代正式投稿指南和人工判断。' },
      ], target: '#setEasyKey', view: 'home', settings: true,
    },
    {
      emoji: '🧭', title: '配置完成后从这里开始',
      desc: '现在可以在灵感孵化中选择实证、模型或 CCF 算法模式；在模拟审稿中拖入 PDF 或 DOCX 获取 Markdown 格式的建设性意见。',
      points: [
        { ico: '💡', html: '<b>灵感孵化</b>会明确证据缺口，并把新颖性判断标注为待文献验证。' },
        { ico: '🔎', html: '<b>模拟审稿</b>会流式输出，可重试并导出 Markdown 或 PDF。' },
        { ico: '✎', html: '<b>Markdown 笔记</b>支持拖入 <code>.md</code> 或 <code>.markdown</code> 文件。' },
      ], target: null, center: true,
    },
  );

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
    // 持久化到后端数据目录（settings.onboarded），跨启动、跨版本、跨端口都稳定保留；
    // 不再依赖浏览器 localStorage（其按 origin 隔离，后端随机端口会导致每次重置）。
    settings.onboarded = true;
    settings.onboardingVersion = OB_VERSION;
    api('/api/onboarding/done', { method: 'POST' }).catch(() => {});
    try { localStorage.setItem(OB_KEY, '1'); } catch (_) { /* ignore */ }
  }

  function obShouldShow() {
    // 旧版完成标记不足以覆盖 v2 的 API 设置引导；只有已完成 v2 才抑制展示。
    const backendSeen = settings && Number(settings.onboardingVersion || 0) >= OB_VERSION;
    let legacySeen = false;
    try { legacySeen = localStorage.getItem(OB_KEY) === '1'; } catch (_) { /* ignore */ }
    if (legacySeen && !backendSeen) {
      // 老用户看过但后端未记录，补写后端标记，避免下次仍读到 false
      obMarkDone();
      return false;
    }
    return !backendSeen;
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

  async function obGoto(i) {
    if (i < 0 || i >= OB_STEPS.length) return;
    obIndex = i;
    const step = OB_STEPS[i];
    // 若该步绑定了视图，先切换到对应视图，确保界面可见
    if (step.view) await switchView(step.view);
    if (step.settings) await openSettingsModal();
    if (step.openModelEditor && $('mlEditor')?.classList.contains('hidden')) openMlEditor(null);
    if (!step.settings && !$('settingsModal')?.classList.contains('hidden')) $('settingsModal').classList.add('hidden');
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
    bindUpdater();
    bindWorkbench();
    bindPdfReader();
    bindIdeas();
    bindMarkdownNotes();
    bindReviewer();
    await Promise.all([loadItems(), loadSettings(), loadCollections(), loadWorkbenchData()]);
    // 模型列表依赖 settings（其中 visionProfileId 用于「两段式看图」），必须放在其后，
    // 否则首次渲染设置页时视觉模型下拉会显示成「自动」而丢掉用户已保存的指定。
    await loadModels();
    renderModelSwitcher();
    items.filter((i) => i.filename && !i.thumb).slice(0, 10).forEach((i) => ensureThumb(i));
    renderLibBar();
    switchView('home');
    maybeStartOnboarding();
    // 新邮件提醒：启动后即开始轮询收件箱（未配置邮箱时接口会立即返回，无额外开销）
    startMailNotify();
  }

  init();
})();
