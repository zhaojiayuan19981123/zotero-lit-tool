// fonts.js —— 中文字体供给：内置 / 已下载 / 系统字体，并支持从 .ttc 字体集合中提取单个字体
//
// 为什么需要这一层：
//   要把中文写进 PDF，必须嵌入一个含 CJK 字形的字体（PDF 内置的 14 种标准字体里
//   没有任何中日韩字形）。各平台可用的中文字体格式不一：Windows 的 msyh/simsun 是
//   .ttc 字体集合（一个文件里打包了多个字体），macOS 的 PingFang/Songti 也是 .ttc，
//   而 pdf-lib 只能嵌入「单一 sfnt」字体文件。所以这里实现了 TTC → sfnt 的提取：
//   解析 TTC 头拿到各子字体的表目录，把表数据搬到新偏移上，重排出一个独立字体文件。
import fs from 'node:fs';
import path from 'node:path';

const TTC_TAG = 0x74746366; // 'ttcf'
const OTTO_TAG = 0x4f54544f; // 'OTTO' (CFF 轮廓)
const TRUE_TYPE_TAG = 0x00010000;
const TRUE_TAG = 0x74727565; // 'true'

/** 是否为 TTC 字体集合 */
export function isTtc(buf) {
  return Buffer.isBuffer(buf) && buf.length > 16 && buf.readUInt32BE(0) === TTC_TAG;
}

/** 读取 TTC 内的字体数量 */
export function ttcFontCount(buf) {
  if (!isTtc(buf)) return 0;
  return buf.readUInt32BE(8);
}

/**
 * 从 TTC 中提取第 index 个字体，返回可独立使用的 sfnt 缓冲。
 * 做法：读子字体的表目录 → 计算新的表偏移（4 字节对齐）→ 重建 sfnt 头 + 表目录 + 表数据。
 * 校验和沿用原值（字体消费方一般不校验，重算反而容易出错）。
 */
export function extractTtcFont(buf, index = 0) {
  if (!isTtc(buf)) throw new Error('不是 TTC 字体集合文件');
  const count = buf.readUInt32BE(8);
  if (index < 0 || index >= count) throw new Error(`TTC 内只有 ${count} 个字体，无法取第 ${index} 个`);
  const fontOffset = buf.readUInt32BE(12 + index * 4);
  const sfntVersion = buf.readUInt32BE(fontOffset);
  const numTables = buf.readUInt16BE(fontOffset + 4);
  if (!numTables || numTables > 512) throw new Error('TTC 子字体表目录异常');

  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const rec = fontOffset + 12 + i * 16;
    const tag = buf.readUInt32BE(rec);
    const checksum = buf.readUInt32BE(rec + 4);
    const offset = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    if (offset + length > buf.length) throw new Error('TTC 子字体表数据越界');
    tables.push({ tag, checksum, offset, length });
  }
  // 按 offset 排序后再布局，保持原文件中的物理顺序（部分解析器对此较敏感）
  tables.sort((a, b) => a.offset - b.offset);

  const dirSize = 12 + numTables * 16;
  let cursor = (dirSize + 3) & ~3;
  const placed = tables.map((t) => {
    const off = cursor;
    cursor = (cursor + t.length + 3) & ~3;
    return { ...t, newOffset: off };
  });

  const out = Buffer.alloc(cursor);
  out.writeUInt32BE(sfntVersion, 0);
  out.writeUInt16BE(numTables, 4);
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * 2 ** entrySelector;
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);

  placed.forEach((t, i) => {
    const rec = 12 + i * 16;
    out.writeUInt32BE(t.tag, rec);
    out.writeUInt32BE(t.checksum, rec + 4);
    out.writeUInt32BE(t.newOffset, rec + 8);
    out.writeUInt32BE(t.length, rec + 12);
    buf.copy(out, t.newOffset, t.offset, t.offset + t.length);
  });
  return out;
}

/** 校验缓冲是否为可用的单一 sfnt 字体（TrueType 轮廓 / CFF / 'true'） */
export function isSfnt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const tag = buf.readUInt32BE(0);
  return tag === TRUE_TYPE_TAG || tag === OTTO_TAG || tag === TRUE_TAG;
}

/**
 * 读取字体里 fvar 表 wght 轴的「默认值」。
 *
 * 为什么必须读它：可变字体（variable font）只有一套轮廓 + 一组插值轴，PDF 里没有
 * 「可变」这个概念——pdf-lib / fontkit 嵌入时只会取 fvar 的默认坐标那一档。
 * NotoSansSC-VF 的 wght 轴是 min=100 / **default=100** / max=900，于是嵌进 PDF 的
 * 是 Thin（极细）字重：实测墨迹面积只有 wght=400 的 46%，正文细到发灰看不清。
 * NotoSerifSC-VF 同理（默认 200）。所以这里把默认字重读出来，供上层判断
 * 「这个字体嵌进去会不会太细」，需要时用描边补偿。
 *
 * @returns {number|null} wght 默认值；非可变字体返回 null
 */
export function readDefaultWeight(buf) {
  try {
    if (!isSfnt(buf)) return null;
    const numTables = buf.readUInt16BE(4);
    let fvarOff = 0;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (buf.toString('latin1', rec, rec + 4) === 'fvar') { fvarOff = buf.readUInt32BE(rec + 8); break; }
    }
    if (!fvarOff) return null;
    const axesCount = buf.readUInt16BE(fvarOff + 8);
    const axesSize = buf.readUInt16BE(fvarOff + 10);
    if (!axesCount || axesSize < 20 || axesCount > 32) return null;
    for (let i = 0; i < axesCount; i++) {
      const a = fvarOff + 16 + i * axesSize;
      if (buf.toString('latin1', a, a + 4) !== 'wght') continue;
      return buf.readInt32BE(a + 8) / 65536; // Fixed 16.16
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** 判定「嵌进去会太细」的阈值：用墨迹面积实测标定，300 以下肉眼可见发灰 */
export const THIN_WEIGHT_THRESHOLD = 300;

/**
 * 各平台候选字体，按「家族（黑体/宋体）× 字重（常规/加粗）」分档。
 *
 * 排序原则（很重要，改之前先读）：
 *   1) **静态字体优先于可变字体**。静态字体只有一个字重、轮廓是最终形态，嵌入后
 *      所见即所得；可变字体的默认档常常是极细（见 readDefaultWeight 注释）。
 *   2) 同档内按「正文可读性」排。Windows 上微软雅黑 Regular 的墨迹面积约 0.41
 *      （介于 Noto Sans 的 wght 500~600 之间），小字号下远好于宋体（0.26）与
 *      等线（0.30）；宋体档只用于「原文本身就是衬线体、要还原观感」的场景。
 *   3) 可变字体放最后兜底（跨平台缺字时仍有中文字形可嵌），并由上层用描边补偿字重。
 */
export const SYSTEM_FONT_CANDIDATES = {
  win32: {
    sans: {
      regular: [
        { file: 'msyh.ttc', index: 0, label: '微软雅黑' },
        { file: 'Deng.ttf', label: '等线' },
        { file: 'simhei.ttf', label: '黑体' },
        { file: 'NotoSansSC-VF.ttf', label: 'Noto Sans SC' },
      ],
      bold: [
        { file: 'msyhbd.ttc', index: 0, label: '微软雅黑 Bold' },
        { file: 'Dengb.ttf', label: '等线 Bold' },
        { file: 'simhei.ttf', label: '黑体' },
        { file: 'NotoSansSC-VF.ttf', label: 'Noto Sans SC' },
      ],
    },
    serif: {
      regular: [
        { file: 'STSONG.TTF', label: '华文宋体' },
        { file: 'simsun.ttc', index: 0, label: '宋体' },
        { file: 'simkai.ttf', label: '楷体' },
        { file: 'NotoSerifSC-VF.ttf', label: 'Noto Serif SC' },
      ],
      bold: [
        { file: 'msyhbd.ttc', index: 0, label: '微软雅黑 Bold' },
        { file: 'STSONG.TTF', label: '华文宋体' },
        { file: 'simsun.ttc', index: 0, label: '宋体' },
        { file: 'NotoSerifSC-VF.ttf', label: 'Noto Serif SC' },
      ],
    },
  },
  darwin: {
    sans: {
      regular: [
        { file: '/System/Library/Fonts/PingFang.ttc', index: 0, label: '苹方' },
        { file: '/System/Library/Fonts/Supplemental/Hiragino Sans GB.ttc', index: 0, label: '冬青黑体' },
        { file: '/Library/Fonts/Arial Unicode.ttf', label: 'Arial Unicode MS' },
      ],
      bold: [
        { file: '/System/Library/Fonts/PingFang.ttc', index: 2, label: '苹方 Semibold' },
        { file: '/System/Library/Fonts/Supplemental/Hiragino Sans GB.ttc', index: 1, label: '冬青黑体 W6' },
        { file: '/System/Library/Fonts/PingFang.ttc', index: 0, label: '苹方' },
      ],
    },
    serif: {
      regular: [
        { file: '/System/Library/Fonts/Supplemental/Songti.ttc', index: 1, label: '宋体-简' },
        { file: '/System/Library/Fonts/Supplemental/Songti.ttc', index: 0, label: '宋体-简' },
      ],
      bold: [
        { file: '/System/Library/Fonts/Supplemental/Songti.ttc', index: 3, label: '宋体-简 Bold' },
        { file: '/System/Library/Fonts/Supplemental/Songti.ttc', index: 1, label: '宋体-简' },
      ],
    },
  },
  linux: {
    sans: {
      regular: [
        { file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', index: 0, label: 'Noto Sans CJK SC' },
        { file: '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', index: 0, label: 'Noto Sans CJK SC' },
        { file: '/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf', label: '思源黑体' },
        { file: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', index: 0, label: '文泉驿微米黑' },
      ],
      bold: [
        { file: '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', index: 0, label: 'Noto Sans CJK SC Bold' },
        { file: '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc', index: 0, label: 'Noto Sans CJK SC Bold' },
        { file: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', index: 0, label: '文泉驿微米黑' },
      ],
    },
    serif: {
      regular: [
        { file: '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc', index: 0, label: 'Noto Serif CJK SC' },
        { file: '/usr/share/fonts/opentype/source-han-serif/SourceHanSerifSC-Regular.otf', label: '思源宋体' },
      ],
      bold: [
        { file: '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', index: 0, label: 'Noto Serif CJK SC Bold' },
        { file: '/usr/share/fonts/opentype/source-han-serif/SourceHanSerifSC-Bold.otf', label: '思源宋体 Bold' },
      ],
    },
  },
};

/** 兼容旧调用：拍平成一个「全部候选」列表（不含家族/字重语义） */
export function flatCandidates(platform = process.platform) {
  const p = SYSTEM_FONT_CANDIDATES[platform] || SYSTEM_FONT_CANDIDATES.linux;
  const seen = new Set();
  const out = [];
  for (const fam of ['sans', 'serif']) {
    for (const w of ['regular', 'bold']) {
      for (const c of p[fam]?.[w] || []) {
        const key = `${c.file}#${c.index || 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}

/** 可下载的字体源（按可用性排序；jsDelivr 在国内通常可达） */
export const DOWNLOAD_SOURCES = [
  {
    label: 'Noto Sans SC (TTF)',
    url: 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf',
    file: 'NotoSansSC-VF.ttf',
  },
  {
    label: 'Noto Sans SC (OTF)',
    url: 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf',
    file: 'NotoSansSC-Regular.otf',
  },
  {
    label: 'Noto Sans SC (GitHub)',
    url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf',
    file: 'NotoSansSC-VF.ttf',
  },
];

function fontDir(dataDir) {
  return path.join(dataDir || process.cwd(), 'fonts');
}

function readFontFile(fullPath, index) {
  const buf = fs.readFileSync(fullPath);
  if (isTtc(buf)) return extractTtcFont(buf, index || 0);
  if (isSfnt(buf)) return buf;
  return null;
}

/** 从文件名/标签猜字重（用于用户显式指定字体路径的场景） */
function guessBoldFromName(name) {
  return /(?:^|[-_.])(bd|b|bold|black|heavy|semibold|demi|medium)(?:[-_.]|$)/i.test(String(name || ''));
}

/** 给一份字体字节补齐「可变轴默认字重 / 是否偏细」等元信息 */
function inspectFont(bytes, { label, source, fullPath, bold }) {
  const fvarWeight = readDefaultWeight(bytes);
  return {
    bytes,
    label,
    source,
    path: fullPath,
    variable: fvarWeight != null,
    // 名义字重：可变字体取 fvar 默认值，静态字体按文件名推断（加粗 700 / 常规 400）
    defaultWeight: fvarWeight != null ? fvarWeight : (bold ? 700 : 400),
    // 可变字体默认档过细（<300）时标记。真正决定要不要补偿描边的是
    // fontMetrics.planStroke 的墨量实测，这里只用于设置页给出提示文案。
    thin: fvarWeight != null && fvarWeight < THIN_WEIGHT_THRESHOLD,
    bold: !!bold,
  };
}

/**
 * 解析可用字体。查找顺序：
 *   1) 显式指定的字体文件路径（设置项）
 *   2) 数据目录 fonts/ 下已下载/用户放入的字体
 *   3) 项目 assets/fonts/ 内置字体
 *   4) 系统字体（按 family × bold 取对应档，逐档降级）
 *
 * 「降级链」是刻意的：先要 family+bold 都对；拿不到就退到同家族的常规档（再用描边
 * 合成加粗）；还拿不到就换另一个家族；最后才用可变字体兜底。
 *
 * @param {object} [opts]
 * @param {string} [opts.dataDir]
 * @param {string} [opts.explicitPath]
 * @param {string} [opts.bundledDir]
 * @param {'sans'|'serif'} [opts.family='sans'] 目标家族（跟随原文正文）
 * @param {boolean} [opts.bold=false] 是否要加粗档
 * @returns {{bytes:Buffer,label:string,source:string,path:string,variable:boolean,defaultWeight:number|null,thin:boolean,bold:boolean}|null}
 */
export function resolveCjkFont({ dataDir, explicitPath, bundledDir, family = 'sans', bold = false } = {}) {
  const tried = [];
  const tryFile = (fullPath, index, label, source, wantBold) => {
    try {
      if (!fullPath || !fs.existsSync(fullPath)) return null;
      const bytes = readFontFile(fullPath, index);
      if (!bytes) { tried.push(`${fullPath}（格式不支持）`); return null; }
      if (bytes.length < 20000) { tried.push(`${fullPath}（文件过小，疑似占位文件）`); return null; }
      const name = label || path.basename(fullPath);
      return inspectFont(bytes, {
        label: name,
        source,
        fullPath,
        bold: wantBold === undefined ? guessBoldFromName(name) : wantBold,
      });
    } catch (e) {
      tried.push(`${fullPath}（${e.message}）`);
      return null;
    }
  };

  // 1) 用户显式指定的字体：以它的实际名字判字重，不猜
  if (explicitPath) {
    const hit = tryFile(explicitPath, 0, path.basename(explicitPath), 'settings', guessBoldFromName(explicitPath));
    if (hit) return hit;
  }

  // 2) 数据目录 fonts/（用户手动放入或自动下载的）
  if (dataDir) {
    const dir = fontDir(dataDir);
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { /* 目录不存在，跳过 */ }
    const sorted = entries.filter((f) => /\.(ttf|otf|ttc)$/i.test(f));
    const want = sorted.find((f) => guessBoldFromName(f) === !!bold) || sorted[0];
    if (want) {
      const hit = tryFile(path.join(dir, want), 0, want, 'downloaded');
      if (hit) return hit;
    }
  }

  // 3) 项目内置字体
  if (bundledDir) {
    let entries = [];
    try { entries = fs.readdirSync(bundledDir); } catch (_) { /* 无内置字体 */ }
    for (const f of entries) {
      if (!/\.(ttf|otf|ttc)$/i.test(f)) continue;
      const hit = tryFile(path.join(bundledDir, f), 0, f, 'bundled');
      if (hit) return hit;
    }
  }

  // 4) 系统字体：family × bold 四档依次尝试，静态字体排在可变字体前面（见候选表注释）
  const profiles = SYSTEM_FONT_CANDIDATES[process.platform] || SYSTEM_FONT_CANDIDATES.linux;
  const other = family === 'serif' ? 'sans' : 'serif';
  const ladders = [
    { family, bold },
    { family, bold: false },        // 没有加粗档 → 退回常规档 + 描边合成
    { family: other, bold },
    { family: other, bold: false },
  ];
  const fontRoot = process.platform === 'win32' ? path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts') : '';
  for (const step of ladders) {
    for (const c of profiles[step.family]?.[step.bold ? 'bold' : 'regular'] || []) {
      const full = path.isAbsolute(c.file) ? c.file : path.join(fontRoot, c.file);
      const hit = tryFile(full, c.index || 0, c.label, 'system', step.bold);
      if (hit) return hit;
    }
  }

  resolveCjkFont.lastErrors = tried;
  return null;
}

/**
 * 从网络下载一个中文字体到数据目录（供首次使用或字体缺失时调用）。
 * 返回解析结果；全部源都失败时抛出带排查信息的错误。
 */
export async function downloadCjkFont({ dataDir, onProgress } = {}) {
  if (!dataDir) throw new Error('未配置数据目录，无法下载字体');
  const dir = fontDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });

  // 先看本地是否已经有可用的
  const local = resolveCjkFont({ dataDir });
  if (local && local.source === 'downloaded') return local;

  const errors = [];
  for (const src of DOWNLOAD_SOURCES) {
    const dest = path.join(dir, src.file);
    try {
      onProgress?.({ stage: 'font', message: `正在下载中文字体：${src.label}` });
      const res = await fetch(src.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200000) throw new Error(`文件过小（${buf.length} 字节），可能被劫持或截断`);
      if (!isTtc(buf) && !isSfnt(buf)) throw new Error('下载内容不是有效的字体文件');
      fs.writeFileSync(dest, buf);
      const resolved = resolveCjkFont({ dataDir });
      if (resolved) return resolved;
      throw new Error('字体已下载但解析失败');
    } catch (e) {
      errors.push(`${src.label}: ${e.message}`);
      try { if (fs.existsSync(dest) && fs.statSync(dest).size < 200000) fs.unlinkSync(dest); } catch (_) { /* ignore */ }
    }
  }
  throw new Error(
    '无法获取可用的中文字体，译文 PDF 需要嵌入中文字体。\n'
    + '排查方式：① 手动把任意 .ttf/.otf 中文字体放到数据目录的 fonts/ 文件夹；'
    + '② 或在「设置 → 全文翻译」里指定字体文件路径。\n'
    + `下载失败详情：${errors.join('；')}`
  );
}

/** 供设置页展示：当前会被使用的中文字体 */
export function describeFont(opts = {}) {
  const hit = resolveCjkFont(opts);
  if (!hit) {
    return { available: false, label: '', source: '', note: '未找到可用的中文字体，译文 PDF 无法嵌入中文' };
  }
  return {
    available: true,
    label: hit.label,
    source: hit.source,
    path: hit.path,
    sizeMB: +(hit.bytes.length / 1024 / 1024).toFixed(1),
    variable: hit.variable,
    defaultWeight: hit.defaultWeight,
    thin: hit.thin,
    bold: hit.bold,
    // 偏细的字体要提示用户：嵌进 PDF 会发灰，已自动改用描边补偿
    note: hit.thin
      ? `${hit.label} 是可变字体，默认字重 ${Math.round(hit.defaultWeight)}（偏细），将自动用描边补偿字重`
      : '',
  };
}

/**
 * 计算「合成加粗」需要的描边宽度 —— 已迁移到 fontMetrics.planStroke。
 *
 * 早期版本用「目标名义字重 - 字体名义字重」乘以一个经验系数来估算，问题是
 * 「名义字重」和「看上去多粗」并不成正比（可变字体的名义值、静态字体的设计密度
 * 都不一样）。现在改为直接实测字形墨迹面积、按周长解出描边宽度，不再需要经验系数。
 * 这里保留一个薄封装，方便老调用方平滑迁移。
 */
export { planStroke as planStrokeForFont } from './fontMetrics.js';

export function defaultBundledFontDir(baseDir) {
  return path.join(baseDir, 'assets', 'fonts');
}

export function platformFontHint() {
  return process.platform === 'win32'
    ? 'C:\\Windows\\Fonts'
    : (process.platform === 'darwin' ? '/System/Library/Fonts' : '/usr/share/fonts');
}
