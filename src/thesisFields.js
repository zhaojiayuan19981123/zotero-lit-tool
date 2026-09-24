// thesisFields.js —— 学位论文的字段定义、默认列与 AI 抽取提示词
//
// 与文献中心（aiExtractor.js）刻意分开：学位论文的字段集、默认列、用户手写字段都不同，
// 混在一起会让两边的提示词互相牵制。
//
// 关键约定：
//   · THESIS_USER_FIELDS（我的思考 / 参考价值 / 评级）**永不接受 AI 写入**；
//   · AI 只给「建议评级 + 理由」，用户点星才算数；
//   · 阅读进度不是 AI 猜的，按实际读到的页码算（见 server 侧 progressOf）。

/** AI 负责提取的字段（顺序即界面里的字段顺序） */
export const THESIS_AI_FIELDS = [
  'title', 'authors', 'school', 'degreeType', 'year', 'major', 'supervisor',
  'keywords', 'abstractPoints', 'summary', 'researchQuestion', 'theory', 'method',
  'dataSource', 'conclusion', 'innovation', 'limitation', 'value', 'structure',
  'dataOpen', 'suggestedRating', 'ratingReason',
];

/** 用户手写字段：AI 解析时一律不覆盖 */
export const THESIS_USER_FIELDS = ['myThoughts', 'referenceValue', 'rating'];

export const THESIS_FIELD_LABELS = {
  file: '文献', progress: '阅读进度', rating: '评级', collectionId: '分类',
  school: '学校', importedAt: '导入时间', title: '标题', authors: '作者',
  myThoughts: '我的思考', referenceValue: '参考价值',
  degreeType: '学位类型', year: '年份', major: '专业', supervisor: '导师',
  keywords: '关键词', abstractPoints: '摘要要点', summary: '一段话总结',
  researchQuestion: '研究问题', theory: '理论框架', method: '研究方法',
  dataSource: '数据来源与样本', conclusion: '主要结论', innovation: '创新点',
  limitation: '局限与不足', value: '可借鉴之处', structure: '章节结构概览',
  dataOpen: '数据/代码是否公开', suggestedRating: '建议评级', ratingReason: '建议理由',
  numPages: '页数', readPage: '读到页', lastPage: '上次位置',
};

/** 默认显示的列（用户指定的 9 个 + 分类） */
export const THESIS_DEFAULT_COLUMNS = [
  'file', 'title', 'authors', 'school', 'collectionId',
  'progress', 'rating', 'importedAt', 'myThoughts', 'referenceValue',
];

/** 「字段配置」里可额外打开、或作为详情面板展示的字段 */
export const THESIS_EXTRA_COLUMNS = [
  'degreeType', 'year', 'major', 'supervisor', 'keywords', 'abstractPoints',
  'summary', 'researchQuestion', 'theory', 'method', 'dataSource', 'conclusion',
  'innovation', 'limitation', 'value', 'structure', 'dataOpen',
];

/** 表格里可直接改的字段（白名单，防止前端写坏记录） */
export const THESIS_EDITABLE_FIELDS = [
  ...THESIS_AI_FIELDS, ...THESIS_USER_FIELDS,
];

const FIELD_SPEC = `- title：论文标题（完整题目，去掉「硕士学位论文」这类封面页眉）
- authors：作者姓名（通常是 1 人；多位用逗号分隔）
- school：授予学位的学校全称（从封面、页眉、独创性声明处识别）
- degreeType：学位类型，只填「硕士」或「博士」或「专业硕士」等最精确的一种
- year：答辩或授予学位年份（4 位数字）
- major：专业 / 学科名称
- supervisor：指导教师姓名（多人用逗号分隔；可带职称但要精简）
- keywords：关键词，分号分隔（优先用论文自己声明的关键词）
- abstractPoints：中文摘要的要点，markdown 无序列表，每点以 "- " 开头，3-6 点
- summary：用一段话（150-250 字）概括这篇学位论文做了什么、结论是什么
- researchQuestion：研究问题（分点，若原文明确）
- theory：理论框架 / 理论基础，简述用了什么理论及其作用
- method：研究方法（如 问卷调研 / 实验 / 二手数据 / 案例研究 / 扎根理论 / 混合方法），并简述研究设计
- dataSource：数据来源与样本（数据从哪里来、样本量多少、时间跨度）
- conclusion：主要结论（分点）
- innovation：创新点（分点，论文自己强调的贡献）
- limitation：局限与不足（若摘要或正文明确提到）
- value：可借鉴之处（站在「我在写自己的学位论文」的角度，这篇哪些做法/思路可以借鉴）
- structure：章节结构概览，markdown 无序列表，逐章一行（章号 + 章节标题）
- dataOpen：语料 / 代码 / 问卷是否公开，填「公开」「部分公开」「未公开」或「未提及」
- suggestedRating：给这篇论文的建议评级，只填 1-5 的整数（5 = 极有价值，1 = 参考价值低），
  依据是研究设计的严谨性、数据质量、与实证/模型研究的可借鉴程度
- ratingReason：给出该评级的理由，一句话（不超过 60 字）`;

/**
 * 构造「读前 3 页」的抽取提示词
 * 为什么只喂前 3 页：封面 + 摘要 + 目录开头已经含全部书目字段，
 * 且能把这步的耗时与费用压到最低（约 6k 字符）。
 */
export function buildThesisParsePrompt(lang = '简体中文') {
  return `你是一位学位论文信息提取助手。用户会给你一篇学位论文的**前几页文本**（封面、摘要、目录开头）。
请提取下列字段，以**严格的 JSON 对象**返回（不要 markdown 代码块、不要任何解释，只返回 JSON 本身）。

${FIELD_SPEC}

输出要求：
1. 所有字段都必须出现；确实无法从文本中判断的，返回空字符串 ""，不要省略、不要写「未提及」。
2. 分点类字段（abstractPoints / researchQuestion / conclusion / innovation / limitation /
   structure / value）用 markdown 无序列表，每点以 "- " 开头。
3. 除 suggestedRating 外，其余内容一律用${lang}撰写，保持学术、精炼、忠实原文，**不要编造**。
4. suggestedRating 必须是整数（1-5），不要写成字符串以外的形式。

只返回 JSON 对象本身。`;
}

function toText(val) {
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) return val.map((x) => String(x ?? '').trim()).filter(Boolean).join('\n');
  if (val == null) return '';
  return String(val).trim();
}

/** 归一化建议评级：只接受 1–5 的整数，其余给空串 */
export function sanitizeSuggestedRating(val) {
  const n = Math.round(Number(String(val ?? '').replace(/[^\d.-]/g, '')));
  if (!Number.isFinite(n) || n < 1 || n > 5) return '';
  return String(n);
}

/** 归一化 AI 返回：只保留白名单字段，全部转成字符串 */
export function normalizeThesisFields(obj) {
  const out = {};
  for (const f of THESIS_AI_FIELDS) out[f] = toText(obj?.[f]);
  out.suggestedRating = sanitizeSuggestedRating(obj?.suggestedRating);
  return out;
}

/** 从校名以外的文案里猜学位类型（AI 没用上时的兜底） */
export function guessDegreeType(text) {
  const s = String(text || '');
  if (/博士/.test(s)) return '博士';
  if (/硕士|专业硕士|MBA|MPA|工程硕士/.test(s)) return '硕士';
  return '';
}

/** 提取论文页眉常见的「学校 + 学位论文」里的学校名 */
export function guessSchool(text) {
  const s = String(text || '');
  const m = s.match(/([\u4e00-\u9fff]{4,20}(?:大学|学院|研究院|研究所))/);
  return m ? m[1].trim() : '';
}
