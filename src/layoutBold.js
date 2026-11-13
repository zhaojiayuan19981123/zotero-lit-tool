// layoutBold.js —— 判「这个版面块在原文里是不是加粗」，好让译文照抄字重
//
// ============================ 为什么要单独算 ============================
//
// 版面模型（PP-DocLayoutV3）只给 label（标题 / 正文 / 图注…）和坐标，**不给字重**。
// 于是「原文加粗、译文不加粗」一直存在：论文里的假设（H10. / H11.）、术语强调、
// 整段引用的粗体，在译文栏里全变成普通正文，读者看不出哪些是作者特意加重的地方。
//
// 字重信息只存在于 PDF 的字体资源里：同一条 TimesNewRomanPSMT 与
// TimesNewRomanPS-BoldMT 在文本层里是同一个 italicFamily 的两个 fontName。
// pdf.js 的 `textContent.styles` 只给 serif/sans-serif，判断不了；必须先跑
// `page.getOperatorList()` 把字体加载进 `commonObjs`，再用 `fontName` 取真实字体名。
// 实测 28 页全篇 getOperatorList 只要 ~270ms —— 比整篇翻译的运行时间可以忽略，
// 而且结果会落盘缓存，同一篇只算一次。
//
// 判定的粒度是「整块」而不是「段内某些字」：中文译文与英文原文没有字符级对应关系，
// 硬要把粗体片段映射到译文里只会切错位置。所以按「粗体字数占比」定整块是否加粗。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { toUint8Array } from './pdfTranslate/util.js';

/** 字体名里出现这些词就是粗体（与 analyze.js 的口径一致） */
const BOLD_FACE = /bold|black|heavy|semibold|demi|medi|extrab|fett/i;

/** 粗体字数占比达到这个比例才算「这一块是加粗的」 */
const BOLD_RATIO = 0.6;

const CACHE_VERSION = 1;

function layoutDirOf(dataDir, literatureId) {
  return path.join(dataDir, 'layout', String(literatureId));
}

/** 用块 id 序列当指纹：manifest 一变（重跑版面识别）就重算 */
function fingerprint(manifest) {
  const ids = (manifest?.blocks || []).map((b) => String(b?.id || '')).join(',');
  return crypto.createHash('sha1').update(ids).digest('hex');
}

function readCache(file, fp) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.version !== CACHE_VERSION || raw?.fingerprint !== fp) return null;
    if (!raw?.blocks || typeof raw.blocks !== 'object') return null;
    return new Map(Object.entries(raw.blocks));
  } catch (_) {
    return null;
  }
}

function writeCache(file, fp, map) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const blocks = {};
    for (const [k, v] of map) if (v) blocks[k] = true;   // 只存 true，文件很小
    fs.writeFileSync(file, JSON.stringify({ version: CACHE_VERSION, fingerprint: fp, blocks }), 'utf8');
  } catch (e) {
    console.warn('[layoutBold] 缓存写入失败：', e.message);
  }
}

/**
 * 扫 PDF 文本层，算出每个版面块是否是加粗块。
 *
 * @param {Uint8Array|Buffer} pdfBytes PDF 字节
 * @param {object} manifest 版面解析结果
 * @returns {Promise<Map<string, boolean>>} 块 id → 是否加粗
 */
export async function computeBoldByBlock(pdfBytes, manifest) {
  const out = new Map();
  const blocks = Array.isArray(manifest?.blocks) ? manifest.blocks : [];
  if (!blocks.length) return out;

  const byPage = new Map();
  for (const b of blocks) {
    const page = Number(b?.page);
    if (!Number.isFinite(page) || page < 1) continue;
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page).push(b);
  }

  const { getDocumentProxy } = await import('unpdf');
  // copy=true：pdf.js 会 transfer 掉这块 buffer，调用方后面可能还要用同一份字节。
  // 注意 Buffer 不能直接喂给 pdf.js（它只认纯 Uint8Array），toUint8Array 负责转换。
  const data = toUint8Array(pdfBytes, { copy: true });
  const doc = await getDocumentProxy(data);

  for (const [pageNo, list] of byPage) {
    if (pageNo > doc.numPages) continue;
    let page;
    try {
      page = await doc.getPage(pageNo);
      // 必须先把 operator list 走一遍：字体对象在那之后才出现在 commonObjs 里
      await page.getOperatorList();
    } catch (_) {
      continue;   // 单页取不到就当「未知」，不影响其它页
    }

    let items = [];
    let view = [0, 0, 612, 792];
    try {
      view = page.view || view;
      const tc = await page.getTextContent({ includeMarkedContent: false });
      items = tc.items || [];
    } catch (_) {
      continue;
    }
    const W = Math.abs(view[2] - view[0]) || 1;
    const H = Math.abs(view[3] - view[1]) || 1;
    const top = Math.max(view[1], view[3]);

    // 每个文字片段 → 归一化矩形 + 是否粗体 + 字数
    const pieces = [];
    for (const it of items) {
      const str = typeof it?.str === 'string' ? it.str : '';
      if (!str.trim()) continue;
      const tr = it.transform || [1, 0, 0, 1, 0, 0];
      // 竖排 / 旋转的文字（页边竖排编号、水印）不参与：它的坐标不能按横排算
      if (Math.abs(Math.atan2(tr[1], tr[0])) > 0.02) continue;
      const size = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || 10;
      const x0 = tr[4];
      const x1 = x0 + (typeof it.width === 'number' ? it.width : 0);
      const yBase = tr[5];
      // 基线上下各取一点当字框：只求「落在哪个块里」，不必精确
      const y0 = yBase - size * 0.22;
      const y1 = yBase + size * 0.82;
      let face = '';
      try { face = String(page.commonObjs?.get?.(it.fontName)?.name || ''); } catch (_) { face = ''; }
      const bold = BOLD_FACE.test(face);
      pieces.push({
        nx0: (x0 - view[0]) / W,
        nx1: (x1 - view[0]) / W,
        ny0: (top - y1) / H,
        ny1: (top - y0) / H,
        chars: Array.from(str.replace(/\s+/g, '')).length,
        bold,
      });
    }

    for (const b of list) {
      const bd = b.bounds || {};
      const x0 = Number(bd.x) || 0;
      const y0 = Number(bd.y) || 0;
      const x1 = x0 + (Number(bd.width) || 0);
      const y1 = y0 + (Number(bd.height) || 0);
      let total = 0;
      let boldChars = 0;
      for (const p of pieces) {
        const cx = (p.nx0 + p.nx1) / 2;
        const cy = (p.ny0 + p.ny1) / 2;
        if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
        total += p.chars;
        if (p.bold) boldChars += p.chars;
      }
      // 字数太少（几个字符的页码 / 编号）判不准，直接当不加粗
      const bold = total >= 6 && boldChars / total >= BOLD_RATIO;
      out.set(String(b.id || ''), bold);
    }
  }

  try { await doc.destroy?.(); } catch (_) { /* ignore */ }
  return out;
}

/**
 * 取某篇文献的「块 → 加粗」表（带磁盘缓存）。
 *
 * 缓存放在 `<数据目录>/layout/<文献id>/bold.json`，与 manifest 同目录 ——
 * manifest 重跑（块 id 变了）会自动失效重算。
 *
 * @param {object} args
 * @param {string} args.dataDir 数据目录
 * @param {string} args.literatureId 文献 id
 * @param {object} args.manifest 版面解析结果
 * @param {string} [args.pdfPath] PDF 路径（缺省或读不到就当没有）
 * @returns {Promise<Map<string, boolean>>}
 */
export async function boldMapFor({ dataDir, literatureId, manifest, pdfPath }) {
  if (!dataDir || !literatureId || !manifest) return new Map();
  const fp = fingerprint(manifest);
  const file = path.join(layoutDirOf(dataDir, literatureId), 'bold.json');
  const cached = readCache(file, fp);
  if (cached) return cached;
  if (!pdfPath) return new Map();
  let bytes;
  try {
    bytes = await fs.promises.readFile(pdfPath);
  } catch (_) {
    return new Map();
  }
  const map = await computeBoldByBlock(bytes, manifest);
  if (map.size) writeCache(file, fp, map);
  return map;
}
