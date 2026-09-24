// thesisFields.js —— 学位论文的字段定义、默认列与 AI 抽取提示词
//
// 与文献中心（aiExtractor.js）刻意分开：学位论文的字段集、默认列、用户手写字段都不同，
// 混在一起会让两边的提示词互相牵制。
//
// 关键约定：
//   · AI 只填 5 个「书目前提字段」：标题 / 作者 / 学校 / 学位类型 / 年份。
//     其余内容（研究问题、方法、结论……）不在这里硬填 —— 学位论文的信息密度极高，
//     硬让模型从前 3 页挤出十几个字段，既慢又必然编造。要看内容请用阅读器里的
//     「本章速读 / 综述条目 / 答辩演练」，那是基于真实正文检索生成的。
//   · THESIS_USER_FIELDS（我的思考 / 参考价值 / 评级）**永不接受 AI 写入**；
//     评级由用户手点。
//   · 阅读进度不是 AI 猜的，按实际读到的页码算（见 thesisStore.progressOf）。

/**
 * AI 负责提取的字段（顺序即界面里的字段顺序）。
 * 刻意保持精简：字段越少，提示词越短，模型越不容易跑偏、也越快。
 */
export const THESIS_AI_FIELDS = ['title', 'authors', 'school', 'degreeType', 'year'];

/** 用户手写字段：AI 解析时一律不覆盖 */
export const THESIS_USER_FIELDS = ['myThoughts', 'referenceValue', 'rating'];

/**
 * 已废弃字段：v1.20.0 把字段从 22 个砍到 5 个。
 * 保留这份清单只为「迁移」—— 读写记录时把它们剔掉，免得旧数据里残留一堆
 * 界面上已经看不到、却还在文件里、还会被导出带走的僵尸字段。
 */
export const THESIS_REMOVED_FIELDS = [
  'major', 'supervisor', 'keywords', 'abstractPoints', 'summary',
  'researchQuestion', 'theory', 'method', 'dataSource', 'conclusion',
  'innovation', 'limitation', 'value', 'structure', 'dataOpen',
  'suggestedRating', 'ratingReason',
];

export const THESIS_FIELD_LABELS = {
  file: '文献', progress: '阅读进度', rating: '评级', collectionId: '分类',
  school: '学校', importedAt: '导入时间', title: '标题', authors: '作者',
  myThoughts: '我的思考', referenceValue: '参考价值',
  degreeType: '学位类型', year: '年份',
  // 下面这些只用于旧数据/导出时的可读性，界面不再展示
  major: '专业', supervisor: '导师', keywords: '关键词', abstractPoints: '摘要要点',
  summary: '一段话总结', researchQuestion: '研究问题', theory: '理论框架',
  method: '研究方法', dataSource: '数据来源与样本', conclusion: '主要结论',
  innovation: '创新点', limitation: '局限与不足', value: '可借鉴之处',
  structure: '章节结构概览', dataOpen: '数据/代码是否公开',
  suggestedRating: '建议评级', ratingReason: '建议理由',
  numPages: '页数', readPage: '读到页', lastPage: '上次位置',
};

/**
 * 默认显示的列（12 个，与用户勾选的一致）。
 * 注意：界面上的列由前端 public/thesis.js 的 BASE_COLS/EXTRA_COLS 决定，
 * 这里只是给外部（导出、脚本）一份权威清单，两边改动要同步。
 */
export const THESIS_DEFAULT_COLUMNS = [
  'file', 'title', 'authors', 'school', 'collectionId',
  'progress', 'rating', 'importedAt', 'myThoughts', 'referenceValue',
  'degreeType', 'year',
];

/** 「字段配置」里可额外开关的列：这两列默认就显示，但允许用户关掉 */
export const THESIS_EXTRA_COLUMNS = ['degreeType', 'year'];

/** 表格里可直接改的字段（白名单，防止前端写坏记录） */
export const THESIS_EDITABLE_FIELDS = [
  ...THESIS_AI_FIELDS, ...THESIS_USER_FIELDS,
];

const FIELD_SPEC = `- title：论文标题（完整题目；去掉封面上的「XX大学硕士学位论文」这类页眉或校名，也不要带书名号）
- authors：作者姓名（通常是 1 人；多位用逗号分隔；不要带「作者：」这类前缀）
- school：授予学位的学校全称（从封面、页眉、独创性声明处识别）
- degreeType：学位类型，只填「硕士」或「博士」；专业硕士（MBA/MPA/工程硕士等）也要归到对应层次
- year：答辩或授予学位的年份，4 位数字（如 2024）`;

/**
 * 构造「读前 3 页」的抽取提示词。
 *
 * 为什么只喂前 3 页：封面 + 摘要 + 目录开头已经含全部书目字段。
 * 为什么能用图片：学位论文封面版式五花八门（竖排、艺术字、印章、扫描件），
 * 纯文本层经常把「学校名」和「学位类型」读串行；直接让视觉模型看图更准。
 */
export function buildThesisParsePrompt(lang = '简体中文') {
  return `你是一位学位论文信息提取助手。用户会给你一篇学位论文的**前 3 页**（封面、摘要、目录开头），
可能是页面图片，也可能是页面文本。

请只提取下列 5 个字段，以**严格的 JSON 对象**返回（不要 markdown 代码块、不要任何解释，只返回 JSON 本身）。

${FIELD_SPEC}

铁律：
1. 5 个字段必须全部出现；确实判断不出来的，返回空字符串 ""，不要省略、不要写「未提及」「未知」。
2. **只依据你看到的内容**，绝对不要凭标题猜测学校或年份；拿不准就留空。
3. 除数字外一律用${lang}书写，忠实原文，不要翻译校名。
4. year 必须是 4 位数字组成的字符串（如 "2024"），不要写「2024年」。

只返回 JSON 对象本身。`;
}

function toText(val) {
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) return val.map((x) => String(x ?? '').trim()).filter(Boolean).join('；');
  if (val == null) return '';
  return String(val).trim();
}

/** 年份归一化：只接受 19xx/20xx 的 4 位数字，其余给空串 */
export function sanitizeYear(val) {
  const m = String(val ?? '').match(/(19|20)\d{2}/);
  return m ? m[0] : '';
}

/**
 * 学位类型归一化：只认「硕士 / 博士」两档。
 * 模型偶尔会回「硕士研究生」「博士学位」甚至「学术型硕士」——统一收敛，
 * 免得同一个意思在表格里出现好几种写法，排序和筛选都跟着乱。
 */
export function sanitizeDegreeType(val) {
  const s = toText(val);
  if (/博士/.test(s)) return '博士';
  if (/硕士|MBA|MPA|EMBA|MEM|MF|MPAcc/i.test(s)) return '硕士';
  return '';
}

/**
 * 校名归一化：去掉模型顺手抄下来的封面页眉。
 * 实测常见的三种脏值：
 *   「XX大学硕士学位论文」→ 学校名其实只有前半段；
 *   「作者：张三」这类字段名前缀；
 *   带书名号或引号的包装。
 */
export function sanitizeSchool(val) {
  let s = toText(val).replace(/^[「『"'《]+|[」』"'》]+$/g, '').trim();
  // 去掉「学校 + 学位论文」这种页眉组合，只留学校
  s = s.replace(/(硕士|博士)(研究生)?(学位)?(论文|毕业论文)$/g, '').trim();
  s = s.replace(/^(学校|授予单位|培养单位)[:：]\s*/g, '').trim();
  return s.length > 40 ? '' : s;
}

/** 归一化 AI 返回：只保留白名单字段，全部转成字符串 */
export function normalizeThesisFields(obj) {
  const out = {};
  for (const f of THESIS_AI_FIELDS) out[f] = toText(obj?.[f]);
  out.title = out.title.replace(/^[《「『]+|[》」』]+$/g, '').trim();
  out.authors = out.authors.replace(/^(作者|姓名)[:：]\s*/g, '').trim();
  out.school = sanitizeSchool(out.school);
  out.degreeType = sanitizeDegreeType(out.degreeType);
  out.year = sanitizeYear(out.year);
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
