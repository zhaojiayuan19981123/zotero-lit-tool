// achievementFields.js —— 科研成果管理的字段定义（类型 / 列 / AI 提示词 / 归一化）
//
// 为什么单独一份字段表：
//   五类成果（论文、专利、证书、教材、项目证明）字段差别很大，表格列、详情表单、
//   AI 识别提示词却必须永远一致 —— 所以把「唯一真相」放在服务端，
//   前端通过 /api/achievements/meta 拿到同一份定义，避免两边各写一套然后慢慢跑偏。
//
// 「论文」这一类的已出版识别字段，**直接复用文献中心那套 FIELDS**
// （src/aiExtractor.js）：用户在文献中心看到什么字段，成果管理里就是什么字段，
// 不会出现「同一条论文两处识别结果不一样」。

import { FIELDS as LITERATURE_FIELDS, FIELD_LABELS as LITERATURE_FIELD_LABELS } from './aiExtractor.js';

// ---------------- 类型 ----------------

export const CATEGORIES = [
  { key: 'paper', label: '论文', icon: '📄' },
  { key: 'patent', label: '专利', icon: '⚙️' },
  { key: 'certificate', label: '证书', icon: '🏅' },
  { key: 'textbook', label: '教材', icon: '📚' },
  { key: 'project', label: '项目证明', icon: '📁' },
];

export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

/** 每个类型下「阶段」的说法不一样：论文叫在投，专利叫申请中…… */
export const STAGE_LABELS = {
  paper: { done: '已出版发行', working: '在投中' },
  patent: { done: '已授权', working: '申请中' },
  certificate: { done: '已获得', working: '申领中' },
  textbook: { done: '已出版', working: '编写中' },
  project: { done: '已结项', working: '在研' },
};

export const STAGE_KEYS = ['done', 'working'];

export function stageLabel(category, stage) {
  const table = STAGE_LABELS[category] || STAGE_LABELS.paper;
  return table[stage === 'done' ? 'done' : 'working'];
}

/** 在投进度：与「论文进度」的流水线保持同一套词，同步过去时不用翻译 */
export const PROGRESS_STATUSES = [
  '构思中', '撰写中', '导师审阅', '投稿中', '初审', '外审', '返修', '复审',
  '录用', '校样', '已见刊', '拒稿', '撤稿',
];

// ---------------- 附件 ----------------

export const FILE_KINDS = [
  { key: 'main', label: '成果正文', hint: '论文 PDF / 专利说明书 / 教材定稿' },
  { key: 'searchReport', label: '检索报告', hint: '查收查引 / 检索证明' },
  { key: 'certificate', label: '证明材料', hint: '录用通知 / 证书扫描件 / 立项书' },
  { key: 'code', label: '代码与数据', hint: 'py / js / R / do / zip 等' },
  { key: 'other', label: '其他附件', hint: '任何格式都可以' },
];

export const FILE_KIND_KEYS = FILE_KINDS.map((k) => k.key);

/**
 * 扩展名 → 打开这类文件通常用什么程序。
 *
 * 只用于**界面上给个提示**（「将用 Word 打开」），不参与实际打开动作 ——
 * 实际打开交给系统关联（默认程序）或用户手动选的程序，
 * 因为每个人的关联设置都可能不一样，猜错了会误导用户。
 */
const EXT_APP_HINT = {
  pdf: 'PDF 阅读器', doc: 'Word', docx: 'Word', wps: 'WPS', dot: 'Word',
  ppt: 'PowerPoint', pptx: 'PowerPoint', pps: 'PowerPoint',
  xls: 'Excel', xlsx: 'Excel', csv: 'Excel', et: 'WPS 表格',
  py: 'Python 编辑器 / IDE', js: '代码编辑器', mjs: '代码编辑器', cjs: '代码编辑器',
  ts: '代码编辑器', java: 'IDE', cpp: 'IDE', c: 'IDE', h: 'IDE', r: 'R / RStudio',
  do: 'Stata', ipynb: 'Jupyter', sql: '数据库工具', json: '代码编辑器',
  md: 'Markdown 编辑器', tex: 'LaTeX 编辑器', bib: '文献工具',
  zip: '解压工具', rar: '解压工具', '7z': '解压工具',
  png: '图片查看器', jpg: '图片查看器', jpeg: '图片查看器', gif: '图片查看器', bmp: '图片查看器',
  txt: '文本编辑器', html: '浏览器', htm: '浏览器', xml: '编辑器 / 浏览器',
};

export function extOf(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

export function appHintFor(name) {
  return EXT_APP_HINT[extOf(name)] || '';
}

/** 附件是不是「可以就地打开看」的类型（其余类型只提供下载 + 选择程序打开） */
export function isPreviewable(name) {
  return ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'txt', 'md', 'html', 'htm'].includes(extOf(name));
}

// ---------------- 字段 ----------------

/** 论文「已出版发行」识别出来的字段 = 文献中心那一套 + 卷期页等书目信息 */
export const PAPER_AI_FIELDS = [...LITERATURE_FIELDS, 'volume', 'issue', 'pages', 'publisher', 'issn'];

/** 手填字段（AI 不产出、只由用户维护） */
export const COMMON_USER_FIELDS = [
  'tags', 'folderId', 'collectionNote',
  // 在投论文的进度与草稿
  'progressStatus', 'progressPercent', 'submitDate', 'revisionDeadline', 'progressNote',
];

export const PATENT_FIELDS = [
  'patentType', 'patentNo', 'applicationNo', 'applicant', 'inventors',
  'applicationDate', 'authorizationDate', 'patentStatus',
];

export const CERTIFICATE_FIELDS = ['certNo', 'issuer', 'issueDate', 'validUntil', 'certLevel'];

export const TEXTBOOK_FIELDS = ['publisher', 'isbn', 'edition', 'chiefEditor', 'publishDate', 'wordCount'];

export const PROJECT_FIELDS = [
  'projectNo', 'fundingAgency', 'role', 'amount', 'startDate', 'endDate', 'projectStatus',
];

/** 所有会出现在记录里的文本字段（建记录时统一初始化成空串，避免 undefined 到处飞） */
export const ALL_TEXT_FIELDS = [...new Set([
  ...PAPER_AI_FIELDS, ...PATENT_FIELDS, ...CERTIFICATE_FIELDS,
  ...TEXTBOOK_FIELDS, ...PROJECT_FIELDS, ...COMMON_USER_FIELDS,
])];

export const FIELD_LABELS = {
  ...LITERATURE_FIELD_LABELS,
  // 论文补充
  volume: '卷', issue: '期', pages: '页码', publisher: '出版社 / 期刊社', issn: 'ISSN',
  // 通用
  title: '名称', authors: '作者 / 完成人', year: '年份', doi: 'DOI', keywords: '关键词',
  abstract: '摘要', tags: '标签', folderId: '所属文件夹', collectionNote: '备注',
  progressStatus: '当前进度', progressPercent: '完成度', submitDate: '投稿 / 提交日期',
  revisionDeadline: '返修截止', progressNote: '进度说明',
  // 专利
  patentType: '专利类型', patentNo: '专利号', applicationNo: '申请号',
  applicant: '申请人', inventors: '发明人', applicationDate: '申请日',
  authorizationDate: '授权公告日', patentStatus: '法律状态',
  // 证书
  certNo: '证书编号', issuer: '颁发机构', issueDate: '颁发日期',
  validUntil: '有效期至', certLevel: '级别',
  // 教材
  isbn: 'ISBN', edition: '版次', chiefEditor: '主编', publishDate: '出版日期', wordCount: '字数',
  // 项目
  projectNo: '项目编号', fundingAgency: '资助机构', role: '本人角色',
  amount: '经费（万元）', startDate: '开始日期', endDate: '结束日期', projectStatus: '项目状态',
};

/**
 * 每个类型在表格里默认展示哪些列。
 * `kind` 只用来决定渲染方式：text（纯文本）/ link（点击打开详情）/ file（附件）/ stage / progress / folder
 */
export const COLUMNS = {
  paper: [
    { key: 'title', label: '论文标题', kind: 'link', width: 250 },
    { key: 'authors', label: '作者' },
    { key: 'journal', label: '期刊 / 会议' },
    { key: 'year', label: '年份' },
    { key: 'stage', label: '阶段', kind: 'stage' },
    { key: 'files', label: '附件', kind: 'file' },
    { key: 'folderId', label: '文件夹', kind: 'folder' },
    { key: 'updatedAt', label: '更新时间' },
  ],
  patent: [
    { key: 'title', label: '专利名称', kind: 'link', width: 250 },
    { key: 'patentType', label: '类型' },
    { key: 'patentNo', label: '专利号' },
    { key: 'inventors', label: '发明人' },
    { key: 'applicationDate', label: '申请日' },
    { key: 'authorizationDate', label: '授权公告日' },
    { key: 'files', label: '附件', kind: 'file' },
    { key: 'folderId', label: '文件夹', kind: 'folder' },
  ],
  certificate: [
    { key: 'title', label: '证书名称', kind: 'link', width: 230 },
    { key: 'certNo', label: '证书编号' },
    { key: 'issuer', label: '颁发机构' },
    { key: 'certLevel', label: '级别' },
    { key: 'issueDate', label: '颁发日期' },
    { key: 'validUntil', label: '有效期至' },
    { key: 'files', label: '附件', kind: 'file' },
    { key: 'folderId', label: '文件夹', kind: 'folder' },
  ],
  textbook: [
    { key: 'title', label: '教材名称', kind: 'link', width: 230 },
    { key: 'publisher', label: '出版社' },
    { key: 'isbn', label: 'ISBN' },
    { key: 'edition', label: '版次' },
    { key: 'chiefEditor', label: '主编' },
    { key: 'publishDate', label: '出版日期' },
    { key: 'files', label: '附件', kind: 'file' },
    { key: 'folderId', label: '文件夹', kind: 'folder' },
  ],
  project: [
    { key: 'title', label: '项目名称', kind: 'link', width: 250 },
    { key: 'projectNo', label: '项目编号' },
    { key: 'fundingAgency', label: '资助机构' },
    { key: 'role', label: '本人角色' },
    { key: 'amount', label: '经费' },
    { key: 'startDate', label: '开始' },
    { key: 'endDate', label: '结束' },
    { key: 'files', label: '附件', kind: 'file' },
    { key: 'folderId', label: '文件夹', kind: 'folder' },
  ],
};

/** 详情抽屉里按这个顺序分组展示（「可编辑」的字段会渲染成输入框） */
export const DETAIL_GROUPS = {
  paper: [
    { title: '基本信息', fields: ['title', 'authors', 'journal', 'year', 'volume', 'issue', 'pages', 'doi', 'issn', 'publisher'] },
    { title: '内容要点（AI 识别）', fields: ['keywords', 'abstract', 'background', 'summary', 'innovation', 'theory', 'method', 'researchDesign', 'constructs', 'results', 'conclusion', 'criticalThinking', 'model', 'paramDiscussion'] },
    { title: '在投进度', fields: ['progressStatus', 'progressPercent', 'submitDate', 'revisionDeadline', 'progressNote'] },
    { title: '其它', fields: ['tags', 'collectionNote'] },
  ],
  patent: [
    { title: '基本信息', fields: ['title', 'patentType', 'patentNo', 'applicationNo', 'applicant', 'inventors', 'applicationDate', 'authorizationDate', 'patentStatus'] },
    { title: '其它', fields: ['keywords', 'abstract', 'tags', 'collectionNote'] },
  ],
  certificate: [
    { title: '基本信息', fields: ['title', 'certNo', 'issuer', 'certLevel', 'issueDate', 'validUntil'] },
    { title: '其它', fields: ['tags', 'collectionNote'] },
  ],
  textbook: [
    { title: '基本信息', fields: ['title', 'publisher', 'isbn', 'edition', 'chiefEditor', 'publishDate', 'wordCount'] },
    { title: '其它', fields: ['abstract', 'tags', 'collectionNote'] },
  ],
  project: [
    { title: '基本信息', fields: ['title', 'projectNo', 'fundingAgency', 'role', 'amount', 'startDate', 'endDate', 'projectStatus'] },
    { title: '其它', fields: ['abstract', 'tags', 'collectionNote'] },
  ],
};

// ---------------- 归一化 ----------------

export function sanitizeYear(val) {
  const m = String(val ?? '').match(/((?:19|20)\d{2})/);
  return m ? m[1] : '';
}

/**
 * 完成度清洗（用户输入 / 表单用）：只做「去掉杂字符 + 夹到 0–100 的整数」。
 *
 * 这里**故意不做**「0.65 → 65」这种猜测：用户在表单里填「1」就是 1%，
 * 猜成 100% 会让进度条瞬间拉满，比不猜更糟。AI 输出里的 0.x 另有一套处理
 * （见 normalizeFields），因为那是模型的口径问题，不是人的口径问题。
 */
export function sanitizePercent(val) {
  // 先按原样解析，这样 "-5" 才会被夹成 0（直接抠数字会把它变成 5）；解析不了再退到抠数字
  const cleaned = String(val ?? '').trim().replace(/[%％\s]/g, '');
  if (!cleaned) return '';
  const direct = Number(cleaned);
  const digits = cleaned.replace(/[^\d.]/g, '');
  const n = Number.isFinite(direct) ? direct : (digits ? Number(digits) : NaN);
  if (!Number.isFinite(n)) return '';
  return String(Math.max(0, Math.min(100, Math.round(n))));
}

function sanitizeText(val, max = 60000) {
  if (val == null) return '';
  if (Array.isArray(val)) return val.map((v) => String(v ?? '')).filter(Boolean).join(', ').slice(0, max).trim();
  if (typeof val === 'object') return '';
  return String(val).trim().slice(0, max);
}

/** 卷 / 期 / 页码：模型经常把 12(3) 这种原样返回，保留原文即可，只做长度限制 */
function sanitizeShort(val) {
  return sanitizeText(val, 60).trim();
}

const SHORT_FIELDS = new Set([
  'year', 'volume', 'issue', 'pages', 'issn', 'doi', 'patentNo', 'applicationNo',
  'applicationDate', 'authorizationDate', 'certNo', 'issueDate', 'validUntil',
  'isbn', 'edition', 'publishDate', 'wordCount', 'projectNo', 'amount',
  'startDate', 'endDate', 'progressStatus', 'submitDate', 'revisionDeadline',
]);

/**
 * 把（AI 或规则解析出来的）原始对象归一化成合法字段集。
 * 只保留本模块认识的 key，避免模型幻觉出的字段被写进数据文件。
 */
export function normalizeFields(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const f of ALL_TEXT_FIELDS) {
    if (!(f in src)) continue;
    if (f === 'year') { out[f] = sanitizeYear(src[f]); continue; }
    out[f] = SHORT_FIELDS.has(f) ? sanitizeShort(src[f]) : sanitizeText(src[f]);
  }
  if ('year' in out && !out.year) {
    const guess = String(src.year ?? '').match(/((?:19|20)\d{2})/);
    if (guess) out.year = guess[1];
  }
  if ('doi' in out) out.doi = out.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/[.,;)\]]+$/, '');
  // 完成度必须是 0–100 的整数，模型偶尔会回 "80%" / "0.8"（把它当比例换算）
  if ('progressPercent' in out) {
    const n = Number(String(out.progressPercent).replace(/[^\d.]/g, ''));
    out.progressPercent = Number.isFinite(n)
      ? String(Math.max(0, Math.min(100, Math.round(n <= 1 && n > 0 ? n * 100 : n))))
      : '';
  }
  return out;
}

/** 识别是否「字段够用了」：标题拿到就算够用，其余留空由用户补 */
export function fieldsComplete(fields) {
  return !!String(fields?.title || '').trim();
}

// ---------------- 提示词 ----------------

export function buildParsePrompt(lang = '简体中文', category = 'paper') {
  const head = `你是一名科研秘书，正在帮科研人员录入自己已发表 / 已获得的学术成果（成果类型：${category === 'paper' ? '论文' : category}）。`;
  const common = `请从给定文本中提取以下字段，并以**严格 JSON 对象**返回（不要 markdown 代码块，不要任何解释）：
- title：成果标题（论文名 / 专利名 / 教材名 / 项目名）
- authors：作者或完成人，逗号分隔，按原文顺序
- year：年份（4 位数字）
- doi：DOI（没有则空字符串）
- keywords：关键词，分号分隔
- abstract：摘要或简介的【中文】（原文非中文时翻译成简体中文）
- background：研究背景（分点，每点以 "- " 开头）
- summary：用一段话（150-250 字）概括这项成果做了什么
- innovation：创新点 / 主要贡献
- volume / issue / pages：卷、期、页码
- journal：期刊或会议名称（非论文类留空）
- publisher：出版社或期刊社
- issn：ISSN
- theory / method / researchDesign / constructs / results / conclusion / criticalThinking / model / paramDiscussion：能识别到就填，识别不到留空字符串

输出要求：
1. 所有字段都要出现（没有的返回空字符串 ""，不要省略、不要返回 null）。
2. 分点内容用 markdown 无序列表（每点以 "- " 开头）。
3. 除了 abstract 必须是中文以外，其余内容用${lang}撰写，保持学术严谨、忠实原文，**不要编造**。
4. 只返回 JSON 对象本身。`;
  return `${head}\n\n${common}`;
}

export function buildSearchReportPrompt(lang = '简体中文') {
  return `你在读一份论文的**检索报告 / 查收查引证明**（可能来自 Web of Science、EI、知网、专利局等）。
请提取以下字段并返回**严格 JSON 对象**（不要 markdown 代码块、不要解释）：
- title：被检索的论文标题（若报告里有英文题名也一并给出）
- authors：论文作者
- journal：收录该论文的期刊或会议名
- year：发表年份（4 位数字）
- doi：DOI
- issn：ISSN
- volume / issue / pages：卷、期、页码
- publisher：出版方
- abstract：报告中对收录情况的**中文说明**（如"该论文被 SCI 收录，入藏号 WOS:000…，属于 JCR Q1"）
- keywords：收录数据库与检索号等关键信息，分号分隔
- summary：一段话概括这份检索报告的结论（收录与否、收录库、分区、影响因子等）
识别不到的字段返回空字符串。内容用${lang}撰写，不要编造。只返回 JSON。`;
}
