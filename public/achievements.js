/* achievements.js —— 科研成果管理（独立模块）
 *
 * 与文献中心、学位论文阅读完全分开：数据走 /api/achievements 系列，界面自建，
 * app.js 只负责在切到本视图时调一次 AchievementView.mount()。
 *
 * 布局：
 *   ┌ 顶栏：标题 + 统计 + 操作 ────────────────────────────┐
 *   ├ 二级侧边栏（可收起）│ 主区：工具栏 + 表格 ───────────┤
 *   │  类型：论文/专利/…  │                               │
 *   │  文件夹：数据文件夹 │                               │
 *   └────────────────────┴───────────────────────────────┘
 *   详情抽屉（右侧浮层）：字段编辑 / 在投进度与草稿 / 附件（打开·下载·导出）/ AI 识别
 *
 * 附件「打开」有三条路，都是用户可感知的必要能力：
 *   ① 默认程序打开（docx→Word、pptx→PowerPoint、xlsx→Excel…）
 *   ② 用其它程序打开（弹系统对话框让用户自己挑，代码文件 / 无关联格式靠这个）
 *   ③ 打开所在文件夹 / 下载
 */
(function () {
  'use strict';

  // ==================== 常量 ====================

  const LS = {
    collapsed: 'acSideCollapsed2',
    model: 'aiModel:achievement',
    sort: 'acSort',
  };

  /** 详情表单里用多行文本框的字段（其余用单行输入） */
  const LONG_FIELDS = new Set([
    'abstract', 'background', 'summary', 'innovation', 'theory', 'method', 'researchDesign',
    'constructs', 'results', 'conclusion', 'criticalThinking', 'model', 'paramDiscussion',
    'progressNote', 'collectionNote', 'tags',
  ]);

  /** 会占满整行的字段 */
  const WIDE_FIELDS = new Set([
    'title', 'authors', 'abstract', 'background', 'summary', 'innovation', 'journal',
    'keywords', 'collectionNote', 'referrerName',
  ]);

  const ALL_COLS = [
    { key: 'category', label: '类型', kind: 'category' },
    { key: 'title', label: '名称', kind: 'link', width: 260 },
    { key: 'stage', label: '阶段', kind: 'stage' },
    { key: 'files', label: '附件', kind: 'file' },
    { key: 'folderId', label: '文件夹', kind: 'folder' },
    { key: 'updatedAt', label: '更新时间' },
  ];

  const SORTS = [
    { key: 'updatedAt', label: '按更新时间' },
    { key: 'createdAt', label: '按创建时间' },
    { key: 'year', label: '按年份' },
    { key: 'title', label: '按名称' },
  ];

  // ==================== 状态 ====================

  const S = {
    mounted: false,
    meta: null,
    items: [],
    folders: [],
    summary: null,
    filter: { category: '__all__', folderId: '__all__', stage: '', q: '' },
    sort: 'updatedAt',
    sortDir: 'desc',
    selected: new Set(),
    collapsed: false,
    detailId: '',
    busy: false,
    modelChoices: [],
    /** 详情抽屉里「未保存的改动」提示用得到 */
    dirty: false,
  };

  // ==================== 工具 ====================

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'ac-toast' + (kind === 'error' ? ' err' : kind === 'warn' ? ' warn' : '');
    el.textContent = String(msg || '');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2600);
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, init);
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: raw }; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `请求失败（${res.status}）`);
      if (data) Object.assign(err, data);
      throw err;
    }
    return data;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function fmtSize(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
  }

  function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function readLs(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  function writeLs(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* ignore */ }
  }

  function catOf(key) {
    return (S.meta?.categories || []).find((c) => c.key === key) || { key, label: key, icon: '📌' };
  }

  function folderName(id) {
    return S.folders.find((f) => f.id === (id || ''))?.name || (S.meta?.defaultFolder?.name || '数据文件夹');
  }

  function stageLabelOf(item) {
    const table = S.meta?.stageLabels?.[item.category] || {};
    return table[item.stage === 'done' ? 'done' : 'working'] || (item.stage === 'done' ? '已完成' : '进行中');
  }

  function fkLabel(key) {
    return (S.meta?.fileKinds || []).find((k) => k.key === key)?.label || '附件';
  }

  function fileUrl(item, file, tail) {
    return `/api/achievements/${encodeURIComponent(item.id)}/files/${encodeURIComponent(file.id)}/${tail}`;
  }

  /** 只有 PDF 能进终端阅读器（阅读器基于 pdf.js） */
  function isPdfFile(f) {
    return String(f?.ext || '').toLowerCase() === 'pdf' || /\.pdf$/i.test(String(f?.originalName || ''));
  }

  /**
   * 在终端内阅读这个附件。
   * 复用文献中心那套阅读器（左侧连续页 + 右侧划词翻译 / 全文翻译），
   * 阅读器由 app.js 提供（window.__openReaderExternal），成果管理只交出 PDF 地址与来源标识。
   * 翻译走的是与文献中心完全相同的接口与翻译源，所以英文论文在这里也能边读边译。
   */
  function readInTerminal(item, file) {
    const open = window.__openReaderExternal;
    if (typeof open !== 'function') {
      toast('阅读器未就绪，请刷新页面后重试', 'error');
      return;
    }
    open({
      pdfUrl: fileUrl(item, file, 'raw'),
      title: file.originalName || '',
      achievementId: item.id,
      fileId: file.id,
    });
  }

  // ==================== 视图骨架 ====================

  function buildDom() {
    const view = $('#viewAchievements');
    if (!view) return;
    view.classList.add('ac-view');
    view.classList.toggle('ac-collapsed', S.collapsed);
    view.innerHTML = `
      <div class="ac-head">
        <div class="ac-head-row">
          <div class="ac-title"><h2>🏆 成果管理</h2><span id="acSummary"></span></div>
          <div class="tb-spacer"></div>
          <button class="tb-btn accent" id="acBtnNew">＋ 新建成果</button>
          <button class="tb-btn accent" id="acBtnUpload">⬆ 上传成果文件（自动建档）</button>
          <button class="tb-btn" id="acBtnExport">⬇ 导出</button>
          <div class="ac-path" id="acPath"></div>
        </div>
      </div>
      <div class="ac-body">
        <aside class="ac-side" id="acSide">
          <div class="ac-side-head">
            <span class="ac-side-title">成果分类</span>
            <button class="ac-collapse" id="acCollapse" title="收起 / 展开二级侧边栏">«</button>
          </div>
          <div class="ac-side-body">
            <div class="ac-sec-label">类型</div>
            <div id="acCats"></div>
            <div class="ac-sec-label">文件夹</div>
            <div id="acFolders"></div>
          </div>
          <div class="ac-side-foot">
            <button class="tb-btn accent" id="acBtnNewFolder" title="新建文件夹">＋ 新建文件夹<span class="ac-foot-text"></span></button>
          </div>
        </aside>
        <div class="ac-main">
          <div class="ac-toolbar">
            <input type="search" id="acSearch" class="tb-input ac-search" placeholder="搜索名称 / 作者 / 期刊 / DOI / 编号…" />
            <select id="acStage" class="tb-select">
              <option value="">阶段：全部</option>
              <option value="done">已完成（已出版发行 / 已授权…）</option>
              <option value="working">进行中（在投 / 申请中…）</option>
              <option value="draft">草稿</option>
            </select>
            <select id="acSort" class="tb-select">${SORTS.map((s) => `<option value="${s.key}">${s.label}</option>`).join('')}</select>
            <button class="tb-btn" id="acSortDir" title="切换升序 / 降序">↓ 降序</button>
            <div class="tb-spacer"></div>
            <button class="tb-btn" id="acBatchParse">▶ 识别选中</button>
            <button class="tb-btn" id="acBatchMove">▣ 移动到文件夹</button>
            <button class="tb-btn danger" id="acBatchDelete">🗑 删除选中</button>
          </div>
          <div class="ac-bulk hidden" id="acBulk"></div>
          <div class="ac-wrap" id="acWrap"></div>
        </div>
      </div>
      <input type="file" id="acFileInput" class="hidden" multiple />
      <input type="file" id="acAttachInput" class="hidden" />
      <div class="ac-detail hidden" id="acDetail"></div>
      <div class="ac-mask hidden" id="acMask"></div>
      <div class="ac-preview hidden" id="acPreview"></div>
    `;
  }

  // ==================== 侧边栏 ====================

  function renderSide() {
    const cats = S.meta?.categories || [];
    // 计数一律按当前列表实时算：S.summary / S.folders 里的 count 是上一次请求的快照，
    // 新建、改文件夹、删除之后如果直接用它，侧边栏会停在旧数字（用户会以为没生效）。
    const countByCat = (key) => S.items.filter((it) => it.category === key).length;
    const countByFolder = (id) => S.items.filter((it) => String(it.folderId || '') === String(id)).length;
    const box = $('#acCats');
    if (box) {
      box.innerHTML = [
        `<div class="ac-cat ${S.filter.category === '__all__' ? 'active' : ''}" data-cat="__all__" title="全部成果">`
        + `<span class="ac-ico">🗂️</span><span class="ac-label">全部成果</span><span class="ac-count">${S.items.length}</span></div>`,
        ...cats.map((c) => {
          const n = countByCat(c.key);
          return `<div class="ac-cat ${S.filter.category === c.key ? 'active' : ''}" data-cat="${c.key}" title="${esc(c.label)}">`
            + `<span class="ac-ico">${c.icon}</span><span class="ac-label">${esc(c.label)}</span><span class="ac-count">${n}</span></div>`;
        }),
      ].join('');
    }
    const fbox = $('#acFolders');
    if (fbox) {
      fbox.innerHTML = [
        `<div class="ac-folder ${S.filter.folderId === '__all__' ? 'active' : ''}" data-folder="__all__" title="全部文件夹">`
        + `<span class="ac-ico">📚</span><span class="ac-label">全部文件夹</span></div>`,
        ...S.folders.map((f) => `<div class="ac-folder ${f.isDefault ? 'is-default' : ''} ${String(S.filter.folderId) === String(f.id) ? 'active' : ''}" data-folder="${esc(f.id)}" title="${esc(f.name)}">`
          + `<span class="ac-ico">${f.isDefault ? '📁' : '🗂️'}</span><span class="ac-label">${esc(f.name)}</span>`
          + `<span class="ac-count">${countByFolder(f.id)}</span>`
          + `<button class="ac-fbtn" data-frename="${esc(f.id)}" title="重命名">✎</button>`
          + `<button class="ac-fbtn" data-fdel="${esc(f.id)}" title="删除（里面的成果会回到数据文件夹）">✕</button></div>`),
      ].join('');
    }
    const sum = S.summary;
    const stat = $('#acSummary');
    if (stat && sum) {
      stat.textContent = `共 ${sum.total} 项 · 在投 ${sum.working} · 草稿 ${sum.draft} · 附件 ${sum.files} 个 · ${sum.folders} 个自定义文件夹`;
    }
    const path = $('#acPath');
    if (path) {
      const cat = S.filter.category === '__all__' ? '全部成果' : catOf(S.filter.category).label;
      const fname = S.filter.folderId === '__all__' ? '全部文件夹' : folderName(S.filter.folderId);
      path.textContent = `${cat} / ${fname}`;
    }
  }

  // ==================== 表格 ====================

  function columns() {
    if (S.filter.category === '__all__') return ALL_COLS;
    const cols = S.meta?.columns?.[S.filter.category];
    return Array.isArray(cols) && cols.length ? cols : ALL_COLS;
  }

  function filtered() {
    const q = S.filter.q.trim().toLowerCase();
    let list = S.items.slice();
    if (S.filter.category !== '__all__') list = list.filter((it) => it.category === S.filter.category);
    if (S.filter.folderId !== '__all__') {
      const want = S.filter.folderId || '';
      list = list.filter((it) => (it.folderId || '') === want);
    }
    if (S.filter.stage === 'draft') list = list.filter((it) => it.isDraft);
    else if (S.filter.stage) list = list.filter((it) => !it.isDraft && it.stage === S.filter.stage);
    if (q) {
      list = list.filter((it) => [
        it.title, it.authors, it.journal, it.publisher, it.doi, it.keywords, it.abstract,
        it.patentNo, it.applicationNo, it.certNo, it.projectNo, it.fundingAgency, it.tags,
      ].some((v) => String(v ?? '').toLowerCase().includes(q)));
    }
    const dir = S.sortDir === 'asc' ? 1 : -1;
    const key = S.sort;
    list.sort((a, b) => {
      const av = String(a[key] ?? '');
      const bv = String(b[key] ?? '');
      if (key === 'updatedAt' || key === 'createdAt') return dir * av.localeCompare(bv);
      if (key === 'year') return dir * ((Number(av) || 0) - (Number(bv) || 0));
      return dir * av.localeCompare(bv, 'zh-Hans-CN');
    });
    return list;
  }

  function cellHtml(it, col) {
    const v = it[col.key];
    switch (col.kind) {
      case 'category': {
        const c = catOf(it.category);
        return `<span class="ac-badge ok">${c.icon} ${esc(c.label)}</span>`;
      }
      case 'link':
        return `<div class="ac-name-cell" data-open="${esc(it.id)}" title="${esc(it.title || '未命名')}">${esc(it.title || '未命名成果')}</div>`
          + (it.isDraft ? ' <span class="ac-badge draft">草稿</span>' : '')
          + (it.paperId ? ' <span class="ac-badge ok" title="已同步到论文进度">已同步</span>' : '')
          + (it.status === 'parsing' ? ' <span class="ac-badge parsing">识别中</span>' : '')
          + (it.status === 'error' ? ` <span class="ac-badge error" title="${esc(it.error || '')}">识别失败</span>` : '');
      case 'stage':
        return `<span class="ac-badge ${it.stage === 'done' ? 'done' : 'working'}">${esc(stageLabelOf(it))}</span>`
          + (it.progressStatus ? `<div class="ac-muted" style="font-size:11.5px">${esc(it.progressStatus)}</div>` : '');
      case 'file': {
        const files = it.files || [];
        if (!files.length) return '<span class="ac-muted">无</span>';
        const shown = files.slice(0, 3);
        return `<div class="ac-files-cell">${shown.map((f) => `<span class="ac-file-chip" data-file-open="${esc(it.id)}|${esc(f.id)}" title="点击用系统程序打开：${esc(f.originalName)}">📎 <span class="ac-file-kind">${esc(fkLabel(f.kind))}</span> ${esc(f.originalName)}</span>`).join('')}`
          + (files.length > shown.length ? `<span class="ac-muted" style="font-size:11.5px">等 ${files.length} 个附件</span>` : '')
          + '</div>';
      }
      case 'folder':
        return `<span class="ac-muted">${esc(folderName(it.folderId))}</span>`;
      default:
        if (col.key === 'updatedAt') return `<span class="ac-muted">${esc(fmtDate(v))}</span>`;
        return v ? esc(v) : '<span class="ac-muted">—</span>';
    }
  }

  function renderTable() {
    const wrap = $('#acWrap');
    if (!wrap) return;
    const cols = columns();
    const list = filtered();
    const head = `<tr><th class="ac-col-pick"><input type="checkbox" id="acPickAll" ${list.length && list.every((it) => S.selected.has(it.id)) ? 'checked' : ''} /></th>`
      + cols.map((c) => `<th${c.width ? ` style="min-width:${c.width}px"` : ''}>${esc(c.label)}</th>`).join('')
      + '<th style="width:96px">操作</th></tr>';

    if (!list.length) {
      wrap.innerHTML = `<table class="ac-table"><thead>${head}</thead></table>`
        + `<div class="ac-empty"><div class="ac-empty-icon">🏆</div>`
        + `<p>${S.items.length ? '当前筛选下没有成果' : '还没有录入自己的成果'}</p>`
        + `<p class="ac-muted" style="font-size:12.5px">点「＋ 新建成果」逐条录入，或点「⬆ 上传成果文件」把你的论文 PDF 批量导入并自动识别字段</p>`
        + `<p class="ac-muted" style="font-size:12.5px">论文 / 专利 / 证书 / 教材 / 项目证明都可以放在这里；附件支持 PDF、Word、PPT、Excel、代码等任意格式，双击即可用系统程序打开</p></div>`;
    } else {
      wrap.innerHTML = `<table class="ac-table"><thead>${head}</thead><tbody>${list.map((it) => {
        const cls = S.selected.has(it.id) ? ' class="sel"' : '';
        return `<tr data-row="${esc(it.id)}"${cls}>`
          + `<td class="ac-col-pick"><input type="checkbox" data-pick="${esc(it.id)}" ${S.selected.has(it.id) ? 'checked' : ''} /></td>`
          + cols.map((c) => `<td>${cellHtml(it, c)}</td>`).join('')
          + `<td><button class="ac-mini" data-open="${esc(it.id)}">详情</button> `
          + `<button class="ac-mini danger" data-del="${esc(it.id)}" title="删除">🗑</button></td></tr>`;
      }).join('')}</tbody></table>`;
    }
    renderBulk();
  }

  function renderBulk() {
    const box = $('#acBulk');
    if (!box) return;
    const n = S.selected.size;
    box.classList.toggle('hidden', n === 0);
    if (!n) return;
    box.innerHTML = `<span><b>${n}</b> 项已选中</span>`
      + `<button class="tb-btn" id="acBulkExport">⬇ 导出选中（含附件 ZIP）</button>`
      + `<button class="tb-btn ghost" id="acBulkClear">取消选择</button>`;
  }

  // ==================== 详情抽屉 ====================

  function detailItem() {
    return S.items.find((it) => it.id === S.detailId) || null;
  }

  function fieldHtml(item, key) {
    const label = S.meta?.fieldLabels?.[key] || key;
    const val = item[key] ?? '';
    const isLong = LONG_FIELDS.has(key);
    const wide = WIDE_FIELDS.has(key) || isLong ? ' wide' : '';
    const hint = key === 'progressPercent'
      ? `<span class="ac-hint">0–100</span>`
      : key === 'doi' ? '<span class="ac-hint">只填 10.xxxx/… 即可，不用带 https://doi.org/</span>' : '';
    const input = isLong
      ? `<textarea data-field="${key}" rows="${key === 'abstract' || key === 'summary' ? 4 : 3}">${esc(val)}</textarea>`
      : `<input type="text" data-field="${key}" value="${esc(val)}" />`;
    return `<div class="ac-field${wide}"><label>${esc(label)}${hint}</label>${input}</div>`;
  }

  function progressCard(item) {
    const hist = item.progressHistory || [];
    const pct = Math.max(0, Math.min(100, Number(item.progressPercent) || 0));
    const done = item.stage === 'done';
    return `<div class="ac-card">
      <div class="ac-card-head">🚀 在投进度
        <span class="tb-spacer"></span>
        <span class="ac-badge ${done ? 'done' : 'working'}">${esc(stageLabelOf(item))}</span>
        ${item.isDraft ? '<span class="ac-badge draft">草稿</span>' : ''}
        ${item.paperId ? '<span class="ac-badge ok" title="已在论文进度中">已同步到论文进度</span>' : ''}
      </div>
      <div class="ac-progress-row">
        <select id="acPgStatus" class="tb-select">
          <option value="">未设置</option>
          ${(S.meta?.progressStatuses || []).map((s) => `<option value="${esc(s)}" ${item.progressStatus === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
        <input type="number" id="acPgPercent" class="tb-input" style="width:90px" min="0" max="100" value="${pct}" />
        <div class="ac-bar"><i style="width:${pct}%"></i></div>
        <span class="ac-muted">${pct}%</span>
      </div>
      <div class="ac-form">
        <div class="ac-field"><label>投稿 / 提交日期</label><input type="date" data-field="submitDate" value="${esc(item.submitDate || '')}" /></div>
        <div class="ac-field"><label>返修截止</label><input type="date" data-field="revisionDeadline" value="${esc(item.revisionDeadline || '')}" /></div>
        <div class="ac-field wide"><label>本次进度说明</label><input type="text" id="acPgNote" placeholder="例如：已投稿至《管理世界》，等待初审结果" /></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button class="tb-btn accent" id="acPgAdd">＋ 记一笔进度</button>
        <button class="tb-btn" id="acSyncPaper">⇄ 同步到论文进度</button>
        <button class="tb-btn" id="acPgDone">✓ 转为已完成（已出版发行）</button>
      </div>
      ${hist.length ? `<ul class="ac-hist" style="margin-top:10px">${hist.slice().reverse().slice(0, 30).map((h) => `<li><span class="ac-hist-date">${esc(h.date || '')}</span><span class="ac-hist-status">${esc(h.status || '')}</span><span>${esc(h.note || '')}</span></li>`).join('')}</ul>` : '<p class="ac-muted" style="font-size:12.5px;margin:10px 0 0">还没有进度记录。每推进一次就「记一笔」，投稿、外审、返修的时间线会留在这里。</p>'}
    </div>`;
  }

  function filesCard(item) {
    const files = item.files || [];
    return `<div class="ac-card">
      <div class="ac-card-head">📎 附件（${files.length}）
        <span class="tb-spacer"></span>
        <button class="ac-mini" data-attach="main">⬆ 上传正文</button>
        <button class="ac-mini" data-attach="searchReport">⬆ 上传检索报告</button>
        <button class="ac-mini" data-attach="other">⬆ 上传其它文件</button>
      </div>
      ${files.length ? `<div class="ac-flist">${files.map((f) => `<div class="ac-frow">
        <span class="ac-fkind">${esc(fkLabel(f.kind))}</span>
        <span class="ac-fname">${esc(f.originalName)}<div class="ac-fmeta">${fmtSize(f.fileSize)}${f.ext ? ` · .${esc(f.ext)}` : ''}${f.appHint ? ` · 通常用 ${esc(f.appHint)} 打开` : ''}</div></span>
        <span class="ac-facts">
          ${isPdfFile(f) ? `<button class="ac-mini accent" data-fread="${esc(f.id)}" title="在终端内阅读：连续翻页 + 划词翻译 + 全文翻译（英文论文可边读边译）">📖 阅读</button>` : ''}
          <button class="ac-mini" data-fopen="${esc(f.id)}" data-mode="default" title="用系统默认程序打开">打开</button>
          <button class="ac-mini" data-fopen="${esc(f.id)}" data-mode="pick" title="自己选择打开程序">用其它程序…</button>
          <button class="ac-mini" data-fprev="${esc(f.id)}" title="在应用内预览">预览</button>
          <button class="ac-mini" data-fdown="${esc(f.id)}" title="导出 / 下载这个文件">导出</button>
          <button class="ac-mini" data-ffolder="${esc(f.id)}" title="在文件夹中定位">定位</button>
          <button class="ac-mini danger" data-fdel="${esc(f.id)}" title="删除附件">删除</button>
        </span>
      </div>`).join('')}</div>` : '<p class="ac-muted" style="font-size:12.5px;margin:0">还没有附件。上传论文正文 PDF、检索报告（查收查引）、录用通知、证书扫描件、代码与数据都行 —— 支持任意格式。</p>'}
    </div>`;
  }

  function renderDetail() {
    const box = $('#acDetail');
    if (!box) return;
    const item = detailItem();
    if (!item) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    const cat = catOf(item.category);
    const groups = S.meta?.detailGroups?.[item.category] || [];
    const isPaper = item.category === 'paper';

    box.innerHTML = `
      <div class="ac-detail-top">
        <span>${cat.icon}</span>
        <span class="ac-dt-title" title="${esc(item.title || '未命名成果')}">${esc(item.title || '未命名成果')}</span>
        <select id="acDtCat">${(S.meta?.categories || []).map((c) => `<option value="${c.key}" ${c.key === item.category ? 'selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('')}</select>
        <select id="acDtStage">${['done', 'working'].map((s) => `<option value="${s}" ${item.stage === s ? 'selected' : ''}>${esc((S.meta?.stageLabels?.[item.category] || {})[s] || s)}</option>`).join('')}</select>
        <select id="acDtFolder">${S.folders.map((f) => `<option value="${esc(f.id)}" ${String(item.folderId || '') === String(f.id) ? 'selected' : ''}>📁 ${esc(f.name)}</option>`).join('')}</select>
        <span class="ac-dt-spacer"></span>
        <button id="acDtClose" title="关闭">✕ 关闭</button>
      </div>
      <div class="ac-detail-body">
        <div class="ac-card">
          <div class="ac-card-head">🧠 字段识别
            <span class="tb-spacer"></span>
            <select id="acDtModel" class="tb-select" style="max-width:200px">${S.modelChoices.map((m) => `<option value="${esc(m.id)}" ${m.id === pickedModelId() ? 'selected' : ''}>${esc(m.label)}${m.active ? ' ★' : ''}</option>`).join('')}</select>
            <button class="ac-mini" data-parse="main">识别正文，自动填字段</button>
            <button class="ac-mini" data-parse="searchReport">识别检索报告</button>
          </div>
          <p class="ac-muted" style="font-size:12.5px;margin:0">
            ${item.parsedAt
    ? `上次识别：${esc(fmtDate(item.parsedAt))} · 方式：${esc(item.source === 'rule' ? '规则解析（未配置 AI 时的兜底）' : item.source === 'ai-report' ? 'AI 读检索报告' : item.source === 'ai' ? 'AI 读正文' : '—')}${item.parseModel ? ` · 模型：${esc(item.parseModel)}` : ''}`
    : '上传 PDF 后点上面的按钮，会自动识别标题、作者、期刊、年份、DOI、摘要、关键词等字段；识别结果只在有值时覆盖，你手填过的内容不会被清空。'}
            ${item.status === 'error' ? `<br /><span style="color:var(--red)">失败原因：${esc(item.error || '')}</span>` : ''}
          </p>
        </div>

        ${groups.map((g) => `<div class="ac-card">
          <div class="ac-card-head">${esc(g.title)}</div>
          <div class="ac-form">${g.fields.filter((f) => f !== 'progressNote' || isPaper).map((f) => fieldHtml(item, f)).join('')}</div>
        </div>`).join('')}

        ${isPaper ? progressCard(item) : ''}
        ${filesCard(item)}
      </div>
      <div class="ac-detail-foot">
        <span class="ac-muted" id="acDtHint">${item.isDraft ? '这条是草稿，随时补充后保存即可' : `更新时间 ${esc(fmtDate(item.updatedAt))}`}</span>
        <span class="tb-spacer"></span>
        <button class="tb-btn" id="acDtExportOne">⬇ 导出这条（含附件）</button>
        <button class="tb-btn" id="acDtDraft">💾 保存草稿</button>
        <button class="tb-btn accent" id="acDtSave">保存</button>
      </div>
    `;
    // 注意：详情抽屉里的事件全部由 bindList() 里的委托（#acDetail 上的 click / change / input）
    // 处理。早先这里残了一句 bindDetail(item)，而该函数并不存在 —— 每次打开详情都会抛
    // ReferenceError（真实浏览器里必现，静态检查与单测都看不到）。不要再加回来。
  }

  /** 收集详情表单里的字段（只收集认识的白名单 key） */
  function collectDetail() {
    const box = $('#acDetail');
    if (!box) return null;
    const out = {};
    for (const el of $$('[data-field]', box)) {
      out[el.dataset.field] = el.value;
    }
    out.stage = $('#acDtStage')?.value === 'working' ? 'working' : 'done';
    out.folderId = $('#acDtFolder')?.value ?? '';
    out.category = $('#acDtCat')?.value || 'paper';
    return out;
  }

  function pickedModelId() {
    const saved = localStorage.getItem(LS.model) || '';
    if (S.modelChoices.some((m) => m.id === saved)) return saved;
    return S.modelChoices.find((m) => m.active)?.id || S.modelChoices[0]?.id || '';
  }

  function currentModelId() {
    const v = $('#acDtModel')?.value || '';
    if (v) { try { localStorage.setItem(LS.model, v); } catch (_) { /* ignore */ } }
    return v;
  }

  // ==================== 数据操作 ====================

  async function loadMeta() {
    if (S.meta) return S.meta;
    S.meta = await api('/api/achievements/meta');
    return S.meta;
  }

  async function loadModelChoices() {
    if (S.modelChoices.length) return S.modelChoices;
    try {
      const data = await api('/api/models/choices');
      S.modelChoices = (data?.choices || []).map((m) => ({ id: m.id, label: m.label, active: !!m.isActive }));
    } catch (_) { S.modelChoices = []; }
    return S.modelChoices;
  }

  async function refresh() {
    const data = await api('/api/achievements');
    S.items = data.items || [];
    S.folders = data.folders || [];
    S.summary = data.summary || null;
    for (const id of [...S.selected]) if (!S.items.some((it) => it.id === id)) S.selected.delete(id);
    renderSide();
    renderTable();
    if (S.detailId) renderDetail();
  }

  async function patchItem(id, patch) {
    const updated = await api(`/api/achievements/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
    const idx = S.items.findIndex((it) => it.id === id);
    if (idx >= 0) S.items[idx] = updated;
    renderSide();
    renderTable();
    return updated;
  }

  async function saveDetail({ draft = false } = {}) {
    const item = detailItem();
    if (!item) return;
    const patch = collectDetail();
    if (!patch) return;
    if (!draft && !String(patch.title || '').trim()) {
      toast('名称不能为空：先填个名字，或点「保存草稿」先存着', 'error');
      return;
    }
    try {
      const updated = draft
        ? await api(`/api/achievements/${encodeURIComponent(item.id)}/draft`, { method: 'POST', body: { ...patch, isDraft: true } })
        : await patchItem(item.id, { ...patch, isDraft: false });
      const idx = S.items.findIndex((it) => it.id === item.id);
      if (idx >= 0) S.items[idx] = updated;
      S.dirty = false;
      toast(draft ? '已保存草稿' : '已保存');
      renderSide(); renderTable(); renderDetail();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function addProgress() {
    const item = detailItem();
    if (!item) return;
    const body = {
      status: $('#acPgStatus')?.value || '',
      note: $('#acPgNote')?.value || '',
      percent: $('#acPgPercent')?.value,
      submitDate: $('[data-field="submitDate"]', $('#acDetail'))?.value || '',
      revisionDeadline: $('[data-field="revisionDeadline"]', $('#acDetail'))?.value || '',
    };
    if (!body.status && !body.note) { toast('先选个进度状态，或写一句进度说明', 'warn'); return; }
    try {
      const updated = await api(`/api/achievements/${encodeURIComponent(item.id)}/progress`, { method: 'POST', body });
      const idx = S.items.findIndex((it) => it.id === item.id);
      if (idx >= 0) S.items[idx] = updated;
      toast('进度已记录');
      renderSide(); renderTable(); renderDetail();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function syncPaper() {
    const item = detailItem();
    if (!item) return;
    try {
      const out = await api(`/api/achievements/${encodeURIComponent(item.id)}/sync-paper`, { method: 'POST', body: {} });
      const idx = S.items.findIndex((it) => it.id === item.id);
      if (idx >= 0) S.items[idx] = out.achievement;
      toast(`已同步到「论文进度」：${out.paper?.title || ''}`);
      renderTable(); renderDetail();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function toggleDone() {
    const item = detailItem();
    if (!item) return;
    try {
      await patchItem(item.id, { stage: item.stage === 'done' ? 'working' : 'done' });
      renderDetail();
      toast(item.stage === 'done' ? '已转回「进行中」' : '已标记为「已完成」');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ==================== 附件 ====================

  let attachTarget = null; // { id, kind }

  function pickAttachment(id, kind) {
    const input = $('#acAttachInput');
    if (!input) return;
    attachTarget = { id, kind };
    input.value = '';
    input.multiple = kind === 'other';
    input.click();
  }

  async function uploadAttachment(id, kind, file) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind);
    const res = await fetch(`/api/achievements/${encodeURIComponent(id)}/files`, { method: 'POST', body: fd });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { error: raw }; }
    if (!res.ok) throw new Error((data && data.error) || `上传失败（${res.status}）`);
    const idx = S.items.findIndex((it) => it.id === id);
    if (idx >= 0) S.items[idx] = data;
    return data;
  }

  async function openFile(item, file, mode) {
    try {
      const out = await api(fileUrl(item, file, 'open'), { method: 'POST', body: { mode } });
      if (out?.canceled) return;
      if (mode === 'folder') { toast('已在文件夹中定位'); return; }
      if (mode === 'pick') { toast(out?.app ? `已用 ${out.app.split(/[\\/]/).pop()} 打开` : '已用所选程序打开'); return; }
      toast(out?.app ? `已用 ${out.app} 打开` : '已用系统程序打开');
    } catch (e) {
      // 浏览器运行时没有系统打开能力：给一条明确出路，而不是假装失败
      if (e.fallback === 'download' || /不支持/.test(e.message)) {
        downloadFile(item, file);
        toast('当前运行方式不能直接调起本地程序，已改为下载文件', 'warn');
        return;
      }
      toast(e.message, 'error');
    }
  }

  function downloadFile(item, file) {
    const a = document.createElement('a');
    a.href = fileUrl(item, file, 'download');
    a.download = file.originalName || '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function previewFile(item, file) {
    const box = $('#acPreview');
    if (!box) return;
    const url = fileUrl(item, file, 'raw');
    const ext = String(file.ext || '').toLowerCase();
    const isImg = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'].includes(ext);
    box.classList.remove('hidden');
    box.innerHTML = `
      <div class="ac-preview-top">
        <span>${esc(file.originalName)}</span>
        <span class="tb-spacer"></span>
        <button id="acPvOpen">用系统程序打开</button>
        <button id="acPvDown">导出</button>
        <button id="acPvClose">✕ 关闭</button>
      </div>
      <div class="ac-preview-body">${isImg ? `<img src="${esc(url)}" alt="${esc(file.originalName)}" />` : `<iframe src="${esc(url)}" title="预览"></iframe>`}</div>
    `;
    $('#acPvClose').addEventListener('click', () => { box.classList.add('hidden'); box.innerHTML = ''; });
    $('#acPvOpen').addEventListener('click', () => openFile(item, file, 'default'));
    $('#acPvDown').addEventListener('click', () => downloadFile(item, file));
  }

  async function exportZip(ids) {
    try {
      const res = await fetch('/api/achievements/export-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids || [] }),
      });
      if (!res.ok) {
        const raw = await res.text();
        let msg = `导出失败（${res.status}）`;
        try { msg = JSON.parse(raw).error || msg; } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `科研成果导出-${today()}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('已开始导出 ZIP（含附件原文件）');
    } catch (e) { toast(e.message, 'error'); }
  }

  function exportCsv() {
    const cat = S.filter.category !== '__all__' ? `?category=${encodeURIComponent(S.filter.category)}` : '';
    const a = document.createElement('a');
    a.href = `/api/achievements/export${cat}`;
    a.download = 'achievements.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ==================== 字段识别 ====================

  async function parseOne(id, source) {
    const item = S.items.find((it) => it.id === id);
    if (!item) return;
    try {
      toast('正在识别，请稍候…');
      const updated = await api(`/api/achievements/${encodeURIComponent(id)}/parse`, {
        method: 'POST',
        body: { profileId: currentModelId(), source },
      });
      const idx = S.items.findIndex((it) => it.id === id);
      if (idx >= 0) S.items[idx] = updated;
      toast('识别完成，字段已填入');
      renderTable(); renderSide();
      if (S.detailId === id) renderDetail();
    } catch (e) {
      toast(`识别失败：${e.message}`, 'error');
      await refresh().catch(() => {});
    }
  }

  async function batchParse() {
    const ids = [...S.selected];
    if (!ids.length) { toast('先在列表里勾选要识别的成果', 'warn'); return; }
    toast(`正在识别 ${ids.length} 项…`);
    try {
      const out = await api('/api/achievements/batch-parse', { method: 'POST', body: { ids, profileId: currentModelId() } });
      const bad = (out.results || []).filter((r) => r.status === 'error');
      toast(bad.length ? `识别完成，其中 ${bad.length} 项失败：${bad[0].error || ''}` : '全部识别完成', bad.length ? 'warn' : undefined);
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ==================== 新建 / 上传 / 文件夹 ====================

  function openMask(html) {
    const mask = $('#acMask');
    if (!mask) return null;
    mask.classList.remove('hidden');
    mask.innerHTML = html;
    return mask;
  }

  function closeMask() {
    const mask = $('#acMask');
    if (!mask) return;
    mask.classList.add('hidden');
    mask.innerHTML = '';
  }

  function newAchievementModal() {
    const cats = S.meta?.categories || [];
    let picked = S.filter.category !== '__all__' ? S.filter.category : 'paper';
    const mask = openMask(`
      <div class="ac-modal" role="dialog" aria-modal="true">
        <div class="ac-modal-head">＋ 新建成果<span class="tb-spacer"></span><button class="ac-mini" data-close="1">✕</button></div>
        <div class="ac-modal-body">
          <div class="ac-type-grid" id="acTypeGrid">
            ${cats.map((c) => `<div class="ac-type-opt ${c.key === picked ? 'active' : ''}" data-type="${c.key}"><span>${c.icon}</span><span>${esc(c.label)}</span></div>`).join('')}
          </div>
          <div class="ac-form" style="margin-top:12px">
            <div class="ac-field wide"><label>名称</label><input type="text" id="acNewTitle" placeholder="例如：平台生态系统的价值共创机制研究" /></div>
            <div class="ac-field wide"><label>阶段</label>
              <select id="acNewStage">
                <option value="done">已完成（已出版发行 / 已授权 / 已获得）</option>
                <option value="working">进行中（在投 / 申请中 / 在研）</option>
              </select>
            </div>
            <div class="ac-field wide"><label>文件夹</label>
              <select id="acNewFolderSel">${S.folders.map((f) => `<option value="${esc(f.id)}" ${String(S.filter.folderId) === String(f.id) ? 'selected' : ''}>${esc(f.name)}${f.isDefault ? '（默认）' : ''}</option>`).join('')}</select>
            </div>
          </div>
          <p class="ac-muted" style="font-size:12.5px;margin:10px 0 0">没选文件夹时，新成果会放在「${esc(S.meta?.defaultFolder?.name || '数据文件夹')}」里，不会丢。</p>
        </div>
        <div class="ac-modal-foot">
          <button class="tb-btn" data-close="1">取消</button>
          <button class="tb-btn accent" id="acNewOk">创建</button>
        </div>
      </div>
    `);
    if (!mask) return;
    mask.addEventListener('click', (e) => { if (e.target === mask) closeMask(); });
    $('#acTypeGrid').addEventListener('click', (e) => {
      const opt = e.target.closest('[data-type]');
      if (!opt) return;
      picked = opt.dataset.type;
      $$('#acTypeGrid .ac-type-opt').forEach((el) => el.classList.toggle('active', el === opt));
    });
    $$('[data-close]', mask).forEach((b) => b.addEventListener('click', closeMask));
    $('#acNewOk').addEventListener('click', async () => {
      try {
        const created = await api('/api/achievements', {
          method: 'POST',
          body: {
            category: picked,
            title: $('#acNewTitle').value.trim(),
            stage: $('#acNewStage').value,
            // ★ 必须用弹窗里那个下拉的 id：早先这里写 '#acNewFolder'，与侧边栏的
            //   「＋ 新建文件夹」按钮撞了 id，$() 取到的是按钮 → value 为 undefined，
            //   于是「新建时选的文件夹」永远不生效（真实浏览器里才暴露）。
            folderId: $('#acNewFolderSel').value,
          },
        });
        closeMask();
        S.detailId = created.id;
        S.filter.category = '__all__';
        // 拉一次全量：让顶部统计与侧边栏计数跟上（S.summary 是上一次请求的快照）
        await refresh();
        toast('已创建，接着上传附件或填写字段即可');
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  /** 选一堆 PDF/Word 一次建档：建档 → 上传 → 自动识别 */
  function importFilesModal() {
    const mask = openMask(`
      <div class="ac-modal" role="dialog" aria-modal="true">
        <div class="ac-modal-head">⬆ 上传成果文件（自动建档）<span class="tb-spacer"></span><button class="ac-mini" data-close="1">✕</button></div>
        <div class="ac-modal-body">
          <p style="margin:0 0 10px">选一批 PDF / Word 文件，系统会为每个文件建一条成果记录、挂上附件，并尝试自动识别字段（标题 / 作者 / 期刊 / 年份 / DOI / 摘要…）。</p>
          <div class="ac-form">
            <div class="ac-field"><label>成果类型</label>
              <select id="acImpCat">${(S.meta?.categories || []).map((c) => `<option value="${c.key}" ${c.key === (S.filter.category === '__all__' ? 'paper' : S.filter.category) ? 'selected' : ''}>${c.icon} ${esc(c.label)}</option>`).join('')}</select></div>
            <div class="ac-field"><label>阶段</label>
              <select id="acImpStage">
                <option value="done">已完成（已出版发行）</option>
                <option value="working">进行中（在投 / 草稿）</option>
              </select></div>
            <div class="ac-field wide"><label>文件夹</label>
              <select id="acImpFolder">${S.folders.map((f) => `<option value="${esc(f.id)}" ${String(S.filter.folderId) === String(f.id) ? 'selected' : ''}>${esc(f.name)}${f.isDefault ? '（默认）' : ''}</option>`).join('')}</select></div>
          </div>
          <label style="display:flex;gap:6px;align-items:center;margin-top:10px;font-size:13px">
            <input type="checkbox" id="acImpParse" checked /> 上传后立即用 AI 识别字段
          </label>
          <div id="acImpList" class="ac-flist" style="margin-top:10px"></div>
        </div>
        <div class="ac-modal-foot">
          <button class="tb-btn" data-close="1">取消</button>
          <button class="tb-btn" id="acImpPick">选择文件…</button>
          <button class="tb-btn accent" id="acImpOk" disabled>开始导入</button>
        </div>
      </div>
    `);
    if (!mask) return;
    mask.addEventListener('click', (e) => { if (e.target === mask) closeMask(); });
    $$('[data-close]', mask).forEach((b) => b.addEventListener('click', closeMask));
    let files = [];
    const listBox = $('#acImpList');
    const renderList = () => {
      listBox.innerHTML = files.map((f) => `<div class="ac-frow"><span class="ac-fname">${esc(f.name)}</span><span class="ac-fmeta">${fmtSize(f.size)}</span></div>`).join('')
        || '<p class="ac-muted" style="font-size:12.5px;margin:0">还没有选择文件</p>';
      $('#acImpOk').disabled = files.length === 0;
    };
    renderList();
    $('#acImpPick').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.pdf,.docx,.doc';
      input.addEventListener('change', () => { files = [...input.files]; renderList(); });
      input.click();
    });
    $('#acImpOk').addEventListener('click', async () => {
      const category = $('#acImpCat').value;
      const stage = $('#acImpStage').value;
      const folderId = $('#acImpFolder').value;
      const parse = $('#acImpParse').checked;
      closeMask();
      const created = [];
      for (const file of files) {
        try {
          const rec = await api('/api/achievements', {
            method: 'POST',
            body: { category, stage, folderId, title: file.name.replace(/\.(pdf|docx|doc)$/i, '') },
          });
          await uploadAttachment(rec.id, 'main', file);
          created.push(rec.id);
        } catch (e) {
          toast(`「${file.name}」导入失败：${e.message}`, 'error');
        }
      }
      await refresh();
      toast(`已导入 ${created.length} 项${parse ? '，开始识别字段…' : ''}`);
      if (parse && created.length) {
        for (const id of created) await parseOne(id, 'main').catch(() => {});
        await refresh();
      }
      if (created.length === 1) { S.detailId = created[0]; renderDetail(); }
    });
  }

  function askTextModal({ title, label, value = '', placeholder = '' }) {
    return new Promise((resolve) => {
      const mask = openMask(`
        <div class="ac-modal" role="dialog" aria-modal="true" style="width:min(420px,92vw)">
          <div class="ac-modal-head">${esc(title)}<span class="tb-spacer"></span><button class="ac-mini" data-close="1">✕</button></div>
          <div class="ac-modal-body"><div class="ac-field wide"><label>${esc(label)}</label><input type="text" id="acAskInput" value="${esc(value)}" placeholder="${esc(placeholder)}" /></div></div>
          <div class="ac-modal-foot"><button class="tb-btn" data-close="1">取消</button><button class="tb-btn accent" id="acAskOk">确定</button></div>
        </div>
      `);
      if (!mask) { resolve(null); return; }
      const input = $('#acAskInput');
      input.focus();
      input.select();
      const done = (v) => { closeMask(); resolve(v); };
      $$('[data-close]', mask).forEach((b) => b.addEventListener('click', () => done(null)));
      $('#acAskOk').addEventListener('click', () => done(input.value.trim() || null));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim() || null); });
      mask.addEventListener('click', (e) => { if (e.target === mask) done(null); });
    });
  }

  async function newFolder() {
    const name = await askTextModal({ title: '＋ 新建文件夹', label: '文件夹名称', placeholder: '例如：2026 年投稿 / 国家自然科学基金' });
    if (!name) return;
    try {
      const folder = await api('/api/achievement-folders', { method: 'POST', body: { name } });
      await refresh();
      toast(`已新建文件夹「${folder.name}」`);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function renameFolder(id) {
    const cur = S.folders.find((f) => f.id === id);
    if (!cur || cur.isDefault) return;
    const name = await askTextModal({ title: '重命名文件夹', label: '新名称', value: cur.name });
    if (!name || name === cur.name) return;
    try {
      await api(`/api/achievement-folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteFolder(id) {
    const cur = S.folders.find((f) => f.id === id);
    if (!cur || cur.isDefault) return;
    const ok = await askTextModal({ title: `删除文件夹「${cur.name}」`, label: '输入 删除 以确认（里面的成果会回到「数据文件夹」，不会丢）' });
    if (ok !== '删除') { if (ok !== null) toast('输入不匹配，已取消', 'warn'); return; }
    try {
      await api(`/api/achievement-folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (String(S.filter.folderId) === String(id)) S.filter.folderId = '__all__';
      await refresh();
      toast('文件夹已删除，里面的成果已回到「数据文件夹」');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function moveSelectedToFolder() {
    const ids = [...S.selected];
    if (!ids.length) { toast('先勾选要移动的成果', 'warn'); return; }
    const options = S.folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
    const mask = openMask(`
      <div class="ac-modal" role="dialog" aria-modal="true" style="width:min(420px,92vw)">
        <div class="ac-modal-head">▣ 移动到文件夹<span class="tb-spacer"></span><button class="ac-mini" data-close="1">✕</button></div>
        <div class="ac-modal-body"><div class="ac-field wide"><label>目标文件夹（共 ${ids.length} 项）</label><select id="acMoveSel">${options}</select></div></div>
        <div class="ac-modal-foot"><button class="tb-btn" data-close="1">取消</button><button class="tb-btn accent" id="acMoveOk">移动</button></div>
      </div>
    `);
    if (!mask) return;
    mask.addEventListener('click', (e) => { if (e.target === mask) closeMask(); });
    $$('[data-close]', mask).forEach((b) => b.addEventListener('click', closeMask));
    $('#acMoveOk').addEventListener('click', async () => {
      try {
        await api('/api/achievements/batch-update', { method: 'POST', body: { ids, folderId: $('#acMoveSel').value } });
        closeMask();
        S.selected.clear();
        await refresh();
        toast('已移动');
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  // ==================== 事件绑定 ====================

  function bindList() {
    const view = $('#viewAchievements');

    // 二级侧边栏：收起 / 展开
    $('#acCollapse')?.addEventListener('click', () => {
      S.collapsed = !S.collapsed;
      view.classList.toggle('ac-collapsed', S.collapsed);
      writeLs(LS.collapsed, S.collapsed);
      const btn = $('#acCollapse');
      if (btn) btn.textContent = S.collapsed ? '»' : '«';
    });

    // 类型 / 文件夹
    $('#acCats')?.addEventListener('click', (e) => {
      const el = e.target.closest('[data-cat]');
      if (!el) return;
      S.filter.category = el.dataset.cat;
      renderSide(); renderTable();
    });
    $('#acFolders')?.addEventListener('click', (e) => {
      const rename = e.target.closest('[data-frename]');
      if (rename) { e.stopPropagation(); renameFolder(rename.dataset.frename); return; }
      const del = e.target.closest('[data-fdel]');
      if (del) { e.stopPropagation(); deleteFolder(del.dataset.fdel); return; }
      const el = e.target.closest('[data-folder]');
      if (!el) return;
      S.filter.folderId = el.dataset.folder;
      renderSide(); renderTable();
    });
    $('#acBtnNewFolder')?.addEventListener('click', newFolder);

    // 工具栏
    $('#acBtnNew')?.addEventListener('click', newAchievementModal);
    $('#acBtnUpload')?.addEventListener('click', importFilesModal);
    $('#acBtnExport')?.addEventListener('click', () => {
      const ids = [...S.selected];
      if (ids.length) exportZip(ids);
      else {
        // 没勾选就导出当前筛选下的全部（ZIP 含附件），Ctrl 点击可只导 CSV
        exportZip(filtered().map((it) => it.id));
      }
    });
    $('#acBtnExport')?.addEventListener('contextmenu', (e) => { e.preventDefault(); exportCsv(); });
    let searchTimer = 0;
    $('#acSearch')?.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const v = e.target.value;
      searchTimer = setTimeout(() => { S.filter.q = v; renderTable(); }, 160);
    });
    $('#acStage')?.addEventListener('change', (e) => { S.filter.stage = e.target.value; renderTable(); });
    $('#acSort')?.addEventListener('change', (e) => { S.sort = e.target.value; writeLs(LS.sort, { key: S.sort, dir: S.sortDir }); renderTable(); });
    $('#acSortDir')?.addEventListener('click', () => {
      S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
      $('#acSortDir').textContent = S.sortDir === 'asc' ? '↑ 升序' : '↓ 降序';
      writeLs(LS.sort, { key: S.sort, dir: S.sortDir });
      renderTable();
    });
    $('#acBatchParse')?.addEventListener('click', batchParse);
    $('#acBatchMove')?.addEventListener('click', moveSelectedToFolder);
    $('#acBatchDelete')?.addEventListener('click', async () => {
      const ids = [...S.selected];
      if (!ids.length) { toast('先勾选要删除的成果', 'warn'); return; }
      const ok = await askTextModal({ title: `删除 ${ids.length} 项成果`, label: '输入 删除 以确认（附件文件也会一并删除）' });
      if (ok !== '删除') return;
      try {
        await api('/api/achievements/batch-delete', { method: 'POST', body: { ids } });
        S.selected.clear();
        await refresh();
        toast('已删除');
      } catch (e) { toast(e.message, 'error'); }
    });
    $('#acBulk')?.addEventListener('click', (e) => {
      if (e.target.closest('#acBulkExport')) exportZip([...S.selected]);
      if (e.target.closest('#acBulkClear')) { S.selected.clear(); renderTable(); }
    });

    // 表格
    $('#acWrap')?.addEventListener('click', (e) => {
      const openRow = e.target.closest('[data-open]');
      if (openRow) { S.detailId = openRow.dataset.open; renderDetail(); return; }
      const del = e.target.closest('[data-del]');
      if (del) {
        const item = S.items.find((it) => it.id === del.dataset.del);
        if (!item) return;
        askTextModal({ title: `删除「${item.title || '未命名成果'}」`, label: '输入 删除 以确认' }).then(async (ok) => {
          if (ok !== '删除') return;
          await api(`/api/achievements/${encodeURIComponent(item.id)}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
          if (S.detailId === item.id) S.detailId = '';
          await refresh();
        });
        return;
      }
      // 表格里的附件名：点了就直接用系统程序打开
      const chip = e.target.closest('[data-file-open]');
      if (chip) {
        const [recId, fileId] = chip.dataset.fileOpen.split('|');
        const item = S.items.find((it) => it.id === recId);
        const file = item?.files?.find((f) => f.id === fileId);
        if (item && file) openFile(item, file, 'default');
      }
    });
    $('#acWrap')?.addEventListener('change', (e) => {
      const pick = e.target.closest('[data-pick]');
      if (pick) {
        const id = pick.dataset.pick;
        if (pick.checked) S.selected.add(id); else S.selected.delete(id);
        pick.closest('tr')?.classList.toggle('sel', pick.checked);
        renderBulk();
        return;
      }
      if (e.target.id === 'acPickAll') {
        const list = filtered();
        if (e.target.checked) list.forEach((it) => S.selected.add(it.id));
        else list.forEach((it) => S.selected.delete(it.id));
        renderTable();
      }
    });

    // 详情抽屉
    $('#acDetail')?.addEventListener('click', (e) => {
      const t = e.target;
      if (t.closest('#acDtClose')) { S.detailId = ''; renderDetail(); return; }
      if (t.closest('#acDtSave')) { saveDetail(); return; }
      if (t.closest('#acDtDraft')) { saveDetail({ draft: true }); return; }
      if (t.closest('#acDtExportOne')) { exportZip([S.detailId]); return; }
      if (t.closest('#acPgAdd')) { addProgress(); return; }
      if (t.closest('#acSyncPaper')) { syncPaper(); return; }
      if (t.closest('#acPgDone')) { toggleDone(); return; }

      const parse = t.closest('[data-parse]');
      if (parse) { parseOne(S.detailId, parse.dataset.parse); return; }
      const attach = t.closest('[data-attach]');
      if (attach) { pickAttachment(S.detailId, attach.dataset.attach); return; }

      const item = detailItem();
      if (!item) return;
      const fread = t.closest('[data-fread]');
      if (fread) {
        const file = item.files.find((f) => f.id === fread.dataset.fread);
        if (file) readInTerminal(item, file);
        return;
      }
      const fopen = t.closest('[data-fopen]');
      if (fopen) {
        const file = item.files.find((f) => f.id === fopen.dataset.fopen);
        if (file) openFile(item, file, fopen.dataset.mode);
        return;
      }
      const fprev = t.closest('[data-fprev]');
      if (fprev) {
        const file = item.files.find((f) => f.id === fprev.dataset.fprev);
        if (file) previewFile(item, file);
        return;
      }
      const fdown = t.closest('[data-fdown]');
      if (fdown) {
        const file = item.files.find((f) => f.id === fdown.dataset.fdown);
        if (file) downloadFile(item, file);
        return;
      }
      const ffolder = t.closest('[data-ffolder]');
      if (ffolder) {
        const file = item.files.find((f) => f.id === ffolder.dataset.ffolder);
        if (file) openFile(item, file, 'folder');
        return;
      }
      const fdel = t.closest('[data-fdel]');
      if (fdel) {
        api(`/api/achievements/${encodeURIComponent(item.id)}/files/${encodeURIComponent(fdel.dataset.fdel)}`, { method: 'DELETE' })
          .then((updated) => {
            const idx = S.items.findIndex((it) => it.id === item.id);
            if (idx >= 0) S.items[idx] = updated;
            toast('附件已删除');
            renderTable(); renderDetail();
          })
          .catch((err) => toast(err.message, 'error'));
      }
    });
    $('#acDetail')?.addEventListener('change', (e) => {
      const item = detailItem();
      if (!item) return;
      const t = e.target;
      if (t.id === 'acDtCat' || t.id === 'acDtStage') {
        saveDetail().then(() => toast('已保存'));
      } else if (t.id === 'acDtFolder') {
        patchItem(item.id, { folderId: t.value }).then(() => { renderSide(); toast('已移动'); }).catch((err) => toast(err.message, 'error'));
      }
    });
    $('#acDetail')?.addEventListener('input', () => { S.dirty = true; });
    // 进度条预览：改完成度时实时反映到进度条
    $('#acDetail')?.addEventListener('input', (e) => {
      if (e.target.id !== 'acPgPercent') return;
      const item = detailItem();
      if (!item) return;
      const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      const bar = $('#acDetail .ac-bar > i');
      if (bar) bar.style.width = `${pct}%`;
    });

    // 上传 file input
    $('#acAttachInput')?.addEventListener('change', async (e) => {
      const files = [...(e.target.files || [])];
      const target = attachTarget;
      attachTarget = null;
      if (!target || !files.length) return;
      for (const file of files) {
        try {
          await uploadAttachment(target.id, target.kind, file);
          toast(`已上传「${file.name}」`);
        } catch (err) { toast(err.message, 'error'); }
      }
      const idx = S.items.findIndex((it) => it.id === target.id);
      if (idx >= 0 && S.detailId === target.id) renderDetail();
      renderTable();
    });
    $('#acFileInput')?.addEventListener('change', () => { /* 批量导入走弹窗，这里留作扩展 */ });

    // 预览浮层
    $('#acPreview')?.addEventListener('click', (e) => {
      if (e.target.closest('#acPvClose')) {
        const box = $('#acPreview');
        box.classList.add('hidden');
        box.innerHTML = '';
      }
    });
    // Esc 关闭浮层
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#viewAchievements')?.classList.contains('hidden')) {
        if (!$('#acPreview')?.classList.contains('hidden')) {
          $('#acPreview').classList.add('hidden');
          $('#acPreview').innerHTML = '';
          return;
        }
        if (!$('#acMask')?.classList.contains('hidden')) { closeMask(); return; }
        if (S.detailId) { S.detailId = ''; renderDetail(); }
      }
    });
  }

  // ==================== 生命周期 ====================

  function closeAll() {
    closeMask();
    const pv = $('#acPreview');
    if (pv) { pv.classList.add('hidden'); pv.innerHTML = ''; }
  }

  async function mount() {
    if (!S.mounted) {
      S.mounted = true;
      S.collapsed = readLs(LS.collapsed, false) === true;
      const savedSort = readLs(LS.sort, null);
      if (savedSort?.key && SORTS.some((s) => s.key === savedSort.key)) {
        S.sort = savedSort.key;
        S.sortDir = savedSort.dir === 'asc' ? 'asc' : 'desc';
      }
      buildDom();
      bindList();
      const sortSel = $('#acSort');
      if (sortSel) sortSel.value = S.sort;
      const dirBtn = $('#acSortDir');
      if (dirBtn) dirBtn.textContent = S.sortDir === 'asc' ? '↑ 升序' : '↓ 降序';
      const collapseBtn = $('#acCollapse');
      if (collapseBtn) collapseBtn.textContent = S.collapsed ? '»' : '«';
    }
    closeAll();
    try {
      await loadMeta();
      await Promise.all([refresh(), loadModelChoices()]);
      if (S.detailId) renderDetail();
    } catch (err) {
      const wrap = $('#acWrap');
      if (wrap) wrap.innerHTML = `<div class="ac-empty">加载失败：${esc(err.message)}</div>`;
    }
  }

  window.AchievementView = {
    mount,
    close: closeAll,
    /** 从别的视图跳进来并直接打开某条成果 */
    open: (id) => { S.detailId = id; if (S.mounted) renderDetail(); },
  };
})();
