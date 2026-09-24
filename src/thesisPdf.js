// thesisPdf.js —— 学位论文 PDF 的读取层：按页取文本 + 读内嵌书签
//
// 与 pdfParser.js 的区别：
//   pdfParser 只取「合并后的一大段文本」，够文献中心用；
//   学位论文需要**按页**的文本（章节定位、索引分块、进度计算都依赖页码），
//   以及 PDF 内嵌书签（章节识别最准的一级来源）。
//
// 依赖 unpdf（已内置，无新增依赖）。getDocumentProxy 返回的是 pdf.js 的
// PDFDocumentProxy，所以 getOutline / getPageIndex 这些接口都能直接用。

import fs from 'node:fs';

let unpdfPromise = null;
function unpdf() {
  if (!unpdfPromise) unpdfPromise = import('unpdf');
  return unpdfPromise;
}

/** 与 pdfParser 一致的归一化：统一换行、合并空白、去断词连字符 */
export function normalizePageText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/-\n(?=[a-z])/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function assertPdf(buf) {
  if (!buf || !buf.length) throw new Error('文件为空，无法解析');
  const header = buf.slice(0, 1024).toString('latin1');
  if (!header.includes('%PDF')) {
    throw new Error('不是有效的 PDF 文件（缺少 %PDF 文件头），请确认上传的是 PDF');
  }
}

/**
 * 读取 PDF：按页文本 + 内嵌书签 + 元信息
 * @param {string} filePath 本地 PDF 路径
 * @returns {Promise<{totalPages:number, pages:{page:number,text:string}[], bookmarks:{title,page,level}[], meta:object, charCount:number}>}
 */
export async function readThesisPdf(filePath) {
  const buf = fs.readFileSync(filePath);
  assertPdf(buf);
  const { extractText, getDocumentProxy } = await unpdf();

  let rawPages = [];
  let totalPages = 0;
  try {
    const result = await extractText(new Uint8Array(buf), { mergePages: false });
    rawPages = Array.isArray(result.text) ? result.text : [String(result.text || '')];
    totalPages = result.totalPages || rawPages.length || 0;
  } catch (e) {
    const msg = e?.message || '未知错误';
    if (/password/i.test(msg)) throw new Error('该 PDF 已加密，请先去除密码后再上传');
    if (/invalid|no pdf|xref/i.test(msg)) throw new Error('PDF 文件损坏或格式异常，无法解析，请重新导出后重试');
    throw new Error('PDF 解析失败：' + msg);
  }

  const pages = rawPages.map((t, i) => ({ page: i + 1, text: normalizePageText(t) }));
  const charCount = pages.reduce((a, p) => a + p.text.length, 0);

  // 书签与元信息是「有则更好」，失败不影响主流程（按页文本已拿到了）
  let bookmarks = [];
  let meta = {};
  try {
    const doc = await getDocumentProxy(new Uint8Array(buf));
    try {
      const outline = await doc.getOutline();
      bookmarks = await flattenPdfOutline(doc, outline);
    } catch (_) { /* 无大纲 */ }
    try {
      const md = await doc.getMetadata();
      const info = md?.info || {};
      meta = { title: info.Title || '', author: info.Author || '', creationDate: info.CreationDate || '' };
    } catch (_) { /* 无元信息 */ }
    try { doc.destroy?.(); } catch (_) { /* ignore */ }
  } catch (_) { /* ignore */ }

  return { totalPages: totalPages || pages.length, pages, bookmarks, meta, charCount };
}

/** 把 pdf.js 的 outline 树解析成 [{title, page, level}]（page 为 1 起的真实页号） */
async function flattenPdfOutline(doc, nodes) {
  const out = [];
  const walk = async (list, level) => {
    for (const node of Array.isArray(list) ? list : []) {
      const title = String(node?.title || '').replace(/\s+/g, ' ').trim();
      const page = await resolveDestPage(doc, node?.dest);
      if (title && page) out.push({ title, page, level: Math.min(4, level) });
      if (Array.isArray(node?.items) && node.items.length) await walk(node.items, level + 1);
    }
  };
  await walk(nodes, 1);
  return out;
}

/** 解析 outline 的 dest 得到 1 起的页号；拿不到返回 null */
async function resolveDestPage(doc, dest) {
  try {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await doc.getDestination(dest);
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const ref = explicit[0];
    // getPageIndex 只认引用对象（{num, gen}）；若已经是页号就直接换算
    if (typeof ref === 'number') return ref + 1;
    const index = await doc.getPageIndex(ref);
    return Number.isFinite(index) && index >= 0 ? index + 1 : null;
  } catch (_) {
    return null;
  }
}
