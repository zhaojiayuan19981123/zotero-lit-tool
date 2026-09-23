/**
 * DOI 导出工具（纯逻辑，无 DOM 依赖，便于单测）。
 *
 * 支持三种常见格式：
 *  - txt：每行一个 DOI，最简单，方便直接粘贴到出版社网站或 Crossref 查询
 *  - ris：Research Information Systems 格式，Zotero / EndNote / NoteExpress 都能直接导入
 *  - bib：BibTeX，LaTeX 用户直接 \cite
 *
 * 一切字段都做「缺失即降级」处理：没有 DOI 的条目在 txt 里被跳过，
 * 在 ris/bib 里仍会导出（DOI 行省略），不会因为缺字段就整条丢掉。
 */
(() => {
  'use strict';

  /**
   * DOI 的规范形态：`10.` + 4~9 位注册号 + `/` + 非空后缀。
   * 见 DOI Handbook；注册号不足 4 位的（如 '10.1/abc'）属于非规范但历史上存在，
   * 这里放宽到 1~9 位，避免把老的测试数据/历史数据误判成非法。
   */
  const DOI_PATTERN = /^10\.\d{1,9}\/\S+$/;

  /**
   * 归一化 DOI：去掉常见的 URL / doi: 前缀与首尾空白。
   * 例：'https://doi.org/10.1000/xyz' → '10.1000/xyz'
   *
   * 同时按 DOI 规范做一次形态校验：`10.<4~9 位注册号>/<后缀>`。
   * 这样 '0'、'暂无'、'N/A'、'-' 这类占位值不会被当成 DOI 写进导出文件。
   */
  function normalizeDoi(value) {
    // 纯数字不可能是 DOI；表单空值的 Number() 之类的残留也可能漏进来
    if (typeof value === 'number') return '';
    let s = String(value == null ? '' : value).trim();
    if (!s) return '';
    s = s.replace(/^doi:\s*/i, '');
    s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    s = s.replace(/^https?:\/\/doi\.org\//i, '');
    // 顺带剥掉尾随逗号/句号等标点（从参考文献里复制时常见）
    s = s.replace(/[.,;)\]]+$/, '');
    s = s.trim();
    // DOI 规范形态：10.<注册号>/<后缀>。不匹配的一律视为「没有 DOI」。
    if (!DOI_PATTERN.test(s)) return '';
    return s;
  }

  /** 该条目是否算「有 DOI」 */
  function hasDoi(article) {
    return !!normalizeDoi(article?.doi);
  }

  /** 第一作者姓氏，用于 bib 的 cite key 与 ris 的作者行 */
  function firstAuthorSurname(article) {
    const authors = Array.isArray(article?.authors) ? article.authors : [];
    if (!authors.length) return '';
    const first = String(authors[0] || '').trim();
    if (!first) return '';
    // 支持 "Zhang, San" / "San Zhang" / "张三" 三种写法
    if (first.includes(',')) return first.split(',')[0].trim();
    const parts = first.split(/\s+/).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
  }

  /** 生成 bib 的 citation key：姓 + 年份 + 标题首词，全小写、只留字母数字 */
  function citeKey(article) {
    const sur = firstAuthorSurname(article).replace(/[^A-Za-z0-9]/g, '');
    const year = String(article?.year || (article?.publishedAt || '').slice(0, 4) || '').replace(/[^0-9]/g, '');
    const titleWord = String(article?.title || '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/)[0] || '';
    const key = [sur, year, titleWord].filter(Boolean).join('').toLowerCase();
    return key || 'ref';
  }

  /**
   * 纯 DOI 列表：每行一个，方便「一键复制」。
   * 没有 DOI 的条目会被跳过（因为该格式本身只表达 DOI）。
   */
  function buildDoiList(articles) {
    const list = Array.isArray(articles) ? articles : [];
    return list.map((a) => normalizeDoi(a?.doi)).filter(Boolean).join('\n');
  }

  /** 统计：总条数 / 有 DOI 条数 / 缺 DOI 条数 */
  function doiStats(articles) {
    const list = Array.isArray(articles) ? articles : [];
    const withDoi = list.filter(hasDoi).length;
    return { total: list.length, withDoi, missing: list.length - withDoi };
  }

  /** RIS 字段转义：换行折成空格，防止破坏一行一字段的格式 */
  const oneLine = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();

  /**
   * RIS 格式。注意：Zotero 认 `TY  - JOUR`，每条以 `ER  - ` 结束并空一行。
   */
  function buildRis(articles) {
    const list = Array.isArray(articles) ? articles : [];
    const blocks = [];
    for (const a of list) {
      const lines = ['TY  - JOUR'];
      const title = oneLine(a?.title);
      if (title) lines.push(`TI  - ${title}`);
      const authors = Array.isArray(a?.authors) ? a.authors : [];
      for (const au of authors) {
        const name = oneLine(au);
        if (name) lines.push(`AU  - ${name}`);
      }
      const journal = oneLine(a?.journal);
      if (journal) lines.push(`JO  - ${journal}`);
      const year = oneLine(a?.year || (a?.publishedAt || '').slice(0, 4));
      if (year) lines.push(`PY  - ${year}`);
      const doi = normalizeDoi(a?.doi);
      if (doi) lines.push(`DO  - ${doi}`);
      const url = oneLine(a?.originalUrl);
      if (url) lines.push(`UR  - ${url}`);
      const abstract = oneLine(a?.abstract);
      if (abstract) lines.push(`AB  - ${abstract}`);
      lines.push('ER  - ');
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n') + (blocks.length ? '\n' : '');
  }

  /** BibTeX 的字段值转义：花括号包裹，内部花括号转义掉 */
  const bibField = (v) => String(v == null ? '' : v).replace(/[{}\\]/g, (m) => '\\' + m).replace(/[\r\n]+/g, ' ').trim();

  /** BibTeX 格式（@article） */
  function buildBibtex(articles) {
    const list = Array.isArray(articles) ? articles : [];
    const used = new Map();
    const blocks = [];
    for (const a of list) {
      const fields = [];
      const title = bibField(a?.title);
      if (title) fields.push(`  title = {${title}}`);
      const authors = (Array.isArray(a?.authors) ? a.authors : []).map((x) => oneLine(x)).filter(Boolean);
      if (authors.length) fields.push(`  author = {${authors.map(bibField).join(' and ')}}`);
      const journal = bibField(a?.journal);
      if (journal) fields.push(`  journal = {${journal}}`);
      const year = bibField(a?.year || (a?.publishedAt || '').slice(0, 4));
      if (year) fields.push(`  year = {${year}}`);
      const doi = normalizeDoi(a?.doi);
      if (doi) fields.push(`  doi = {${doi}}`);
      const url = bibField(a?.originalUrl);
      if (url) fields.push(`  url = {${url}}`);

      // cite key 去重：重名的加 a/b/c 后缀，保证 .bib 可用
      const base = citeKey(a);
      const n = (used.get(base) || 0) + 1;
      used.set(base, n);
      const key = n === 1 ? base : `${base}${String.fromCharCode(96 + n)}`;
      blocks.push(`@article{${key},\n${fields.join(',\n')}\n}`);
    }
    return blocks.join('\n\n') + (blocks.length ? '\n' : '');
  }

  /** 按格式生成导出内容 + 建议文件名后缀 */
  function buildExport(articles, format) {
    const kind = ['ris', 'bib', 'txt'].includes(format) ? format : 'txt';
    if (kind === 'ris') return { content: buildRis(articles), ext: 'ris' };
    if (kind === 'bib') return { content: buildBibtex(articles), ext: 'bib' };
    return { content: buildDoiList(articles), ext: 'txt' };
  }

  window.DoiUtils = {
    normalizeDoi,
    hasDoi,
    citeKey,
    buildDoiList,
    doiStats,
    buildRis,
    buildBibtex,
    buildExport,
  };
})();
