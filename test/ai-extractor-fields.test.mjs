// ai-extractor-fields.test.mjs —— 实证类字段体系与提示词的单测
//
// 背景：2026-10 把实证类文库的解析字段整体换成「研究问题 / 研究对象 / 核心结论 / 作用机制 /
// 边界条件 / 方法 / 设计 / 构念 / 批判性思考 / 对综述有什么用 / 研究空白」这一套。
// 这里盯三件事，任何一件被改回去都要立刻变红：
//   ① 服务端字段集与前端列顺序是同一套、同一个顺序（两边各写一份，最容易慢慢跑偏）；
//   ② 「我的思考」「导入时间」永远不由 AI 产出（前者用户手写，后者系统写入）；
//   ③ 提示词里点名了每个字段的提取要求，并且带上了证据标签 / 不夸大因果 / 分组空白这些硬要求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FIELDS, FIELD_LABELS, TYPE_FIELDS, buildPrompt, pickPaperText,
  normalizeDocType, DOC_TYPE_LABELS,
} from '../src/aiExtractor.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 实证类的 24 个解析字段（不含导入时间与我的思考）
const EMPIRICAL_KEYS = [
  'title', 'authors', 'journal', 'year', 'doi', 'keywords', 'abstract',
  'researchQuestion', 'scienceQuestion', 'researchObject', 'coreFindings', 'mechanism', 'boundaryConditions',
  'method', 'researchDesign', 'constructs',
  'independentVar', 'dependentVar', 'moderatorVar', 'mediatorVar', 'controlVar',
  'criticalThinking', 'reviewUse', 'researchGap',
];

test('实证类字段：数量、顺序都与约定一致', () => {
  assert.deepEqual(TYPE_FIELDS.empirical, EMPIRICAL_KEYS);
});

test('导入时间与我的思考不在 AI 可写字段集里（系统/用户各自的字段）', () => {
  assert.ok(!FIELDS.includes('thoughts'), '我的思考必须由用户手填，不能被解析结果覆盖');
  assert.ok(!FIELDS.includes('importedAt'), '导入时间是系统字段');
  assert.ok(!TYPE_FIELDS.empirical.includes('thoughts'));
  assert.ok(!TYPE_FIELDS.empirical.includes('importedAt'));
});

test('实证类新增五个变量字段：自变量 / 因变量 / 调节变量 / 中介变量 / 控制变量', () => {
  const vars = ['independentVar', 'dependentVar', 'moderatorVar', 'mediatorVar', 'controlVar'];
  for (const k of vars) {
    assert.ok(TYPE_FIELDS.empirical.includes(k), `实证类缺少变量字段 ${k}`);
    assert.ok(FIELDS.includes(k), `${k} 不在存储字段集里`);
    assert.ok(FIELD_LABELS[k], `${k} 缺中文标签`);
  }
  // 五个字段必须各自独立，不能合成一个「变量」字段
  assert.deepEqual(
    TYPE_FIELDS.empirical.filter((k) => vars.includes(k)),
    vars,
    '变量字段的顺序应为 自变量 → 因变量 → 调节 → 中介 → 控制',
  );
  assert.equal(FIELD_LABELS.independentVar, '自变量');
  assert.equal(FIELD_LABELS.dependentVar, '因变量');
  assert.equal(FIELD_LABELS.moderatorVar, '调节变量');
  assert.equal(FIELD_LABELS.mediatorVar, '中介变量');
  assert.equal(FIELD_LABELS.controlVar, '控制变量');
});

test('五个变量字段只要干净的变量名：不要解释、不要假设、不要结果、不要前缀', () => {
  const p = buildPrompt('empirical', '简体中文');
  assert.match(p, /只给干净的变量名/, '必须点明「只给干净的变量名」');
  assert.match(p, /不要解释变量含义/, '禁止解释变量含义');
  assert.match(p, /不要写研究假设/, '禁止把假设写进变量字段');
  assert.match(p, /不要写结果与系数/, '禁止把结果系数写进变量字段');
  assert.match(p, /不要写「自变量：」这类前缀/, '禁止「自变量：」这类前缀');
  assert.match(p, /调节变量只写/, '调节变量要限定为被实际检验的');
  assert.match(p, /中介变量只写/, '中介变量要限定为被实际测量的');
  assert.match(p, /控制变量只写/, '控制变量要限定为论文实际控制的');
  assert.match(p, /原文未检验调节效应/, '没有调节效应时要给标签而不是凑数');
});

test('构念只要「变量名 + 测量方法 / 操作化」，不要其它描述', () => {
  const p = buildPrompt('empirical', '简体中文');
  assert.match(p, /测量方法 \/ 操作化|测量方法 \/ 操作化/, '构念要给出测量方法与操作化');
  assert.match(p, /中文名（英文原名）：测量方法/, '要给出「中文名（英文原名）：测量方法」的写法示例');
  assert.match(p, /不要写任何其它描述/, '明确禁止其它描述');
  assert.match(p, /不要写概念定义/, '不再要求写概念定义');
  assert.match(p, /不要写你的评析/, '评析归批判性思考');
});

test('所有 AI 字段改为段落格式：段间空一行 + 首行缩进两格 + 不用无序列表', () => {
  for (const t of ['empirical', 'model', 'algorithm']) {
    const p = buildPrompt(t, '简体中文');
    assert.match(p, /段落格式/, `${t} 类必须要求段落格式`);
    assert.match(p, /段与段之间空一行/, `${t} 类必须要求段间空行`);
    assert.match(p, /开头空两格/, `${t} 类必须要求首行缩进`);
    assert.match(p, /不要用 "- " 无序列表/, `${t} 类必须禁止无序列表`);
  }
  // 变量清单类字段同样按段落给（一个变量一段）
  const p = buildPrompt('empirical', '简体中文');
  assert.match(p, /一个变量单独一段/, '变量清单也要一段一个变量');
  // 列字段例外：进表格的列不能出现换行与列表
  assert.match(p, /列字段必须是单行纯文本/, '列字段要保留单行');
});

test('旧版字段仍留在存储集里（升级不丢老数据，成果管理也还在引用）', () => {
  for (const f of ['background', 'summary', 'innovation', 'theory', 'results', 'conclusion']) {
    assert.ok(FIELDS.includes(f), `${f} 不应从 FIELDS 中移除`);
    assert.ok(FIELD_LABELS[f], `${f} 缺中文标签`);
  }
});

test('每个字段都有中文标签', () => {
  for (const f of FIELDS) assert.ok(FIELD_LABELS[f], `${f} 缺中文标签`);
});

test('实证类提示词点名了全部字段，并声明不产出导入时间 / 我的思考', () => {
  const p = buildPrompt('empirical', '简体中文');
  for (const k of EMPIRICAL_KEYS) assert.ok(p.includes(k), `提示词里没提到字段 ${k}`);
  for (const label of ['研究问题', '研究对象', '核心结论', '作用机制', '边界条件', '研究设计', '构念', '研究空白']) {
    assert.ok(p.includes(label), `提示词里没提到中文字段名 ${label}`);
  }
  assert.match(p, /不要输出「我的思考」/, '必须明确禁止 AI 代写我的思考');
  assert.match(p, /不要输出「导入时间」/);
  assert.ok(p.includes('严格'), '必须要求严格 JSON');
});

test('实证类提示词带上了证据标签 / 出处 / 因果克制 / 空白三分类这些硬要求', () => {
  const p = buildPrompt('empirical', '简体中文');
  for (const phrase of ['原文未报告', '所提供材料未包含', '无法确认', '不适用', 'AI评析／待验证', '依据']) {
    assert.ok(p.includes(phrase), `提示词缺少信息状态或来源标签：${phrase}`);
  }
  assert.match(p, /相关不能写成因果/, '必须禁止把相关写成因果');
  assert.match(p, /显著.*不等于.*因果|不等于因果已被证明/, '必须提醒中介显著≠因果');
  assert.match(p, /作者明确提出的未解决问题/, '研究空白要分「作者提出」一类');
  assert.match(p, /跨文献检索确认/, '研究空白要分「需跨文献确认」一类');
  assert.match(p, /不要.*宣称「无人研究过」|无人研究过/, '禁止凭一篇论文宣称无人研究');
});

test('模型类：原有字段保留，并新增用户要求的七个分析性字段', () => {
  const p = buildPrompt('model', '简体中文');
  for (const k of ['model', 'paramDiscussion', 'results', 'summary', 'innovation']) {
    assert.ok(p.includes(k), `模型类提示词缺 ${k}`);
  }
  // 2026-10 用户要求：模型类也要有 研究问题 / 科学问题 / 核心结论 / 边界条件 /
  // 研究设计 / 对文献综述有什么用 / 作用机制
  for (const k of ['researchQuestion', 'scienceQuestion', 'coreFindings',
    'boundaryConditions', 'researchDesign', 'reviewUse', 'mechanism']) {
    assert.ok(p.includes(k), `模型类提示词缺 ${k}`);
  }
  assert.ok(!p.includes('researchGap'), '模型类不该出现实证类的研究空白');
  assert.ok(!p.includes('constructs'), '模型类不该出现实证类的构念');
});

test('科学问题与研究问题必须被讲成两件事（否则模型会写成同义重复）', () => {
  for (const t of ['empirical', 'model', 'algorithm']) {
    const p = buildPrompt(t, '简体中文');
    assert.ok(p.includes('scienceQuestion'), `${t} 类提示词缺科学问题`);
    assert.match(p, /科学问题.*更一般|更一般.*跨样本/, `${t} 类没有把科学问题讲成「更一般的那一层」`);
    assert.match(p, /与研究问题区分|两者不能写成同义重复/, `${t} 类没有要求区分两个问题`);
  }
});

test('算法类（CCF）提示词覆盖实验设计 / 消融 / 数据集 / 指标 / 领域，并强调 CCF 标注', () => {
  const p = buildPrompt('algorithm', '简体中文');
  for (const k of ['researchQuestion', 'scienceQuestion', 'coreFindings', 'researchDesign',
    'criticalThinking', 'reviewUse', 'experimentalDesign', 'ablationDesign', 'researchGap',
    'dataset', 'metrics', 'researchField']) {
    assert.ok(p.includes(k), `算法类提示词缺 ${k}`);
  }
  assert.match(p, /CCF/, '算法类必须提到 CCF 分级');
  assert.match(p, /CCF-A|CCF-A）/,'算法类要给出「会议名（CCF-A）」这类示例');
  assert.match(p, /基线/, '实验设计要提到对比基线');
  assert.match(p, /消融/, '必须要求写消融实验');
  assert.match(p, /数据泄漏|数据泄露/, '批判性思考要点到数据泄漏这类算法论文专属问题');
});

test('三种文献类型归一化：algorithm / ccf 都落到算法类', () => {
  assert.equal(normalizeDocType('algorithm'), 'algorithm');
  assert.equal(normalizeDocType('ccf'), 'algorithm');
  assert.equal(normalizeDocType('model'), 'model');
  assert.equal(normalizeDocType(''), 'empirical');
  assert.equal(normalizeDocType('乱写的'), 'empirical');
  assert.deepEqual(DOC_TYPE_LABELS, { empirical: '实证类', model: '模型类', algorithm: '算法类' });
});

test('算法类字段集：书目 + 12 个专属字段，且不含实证类/模型类的独有字段', () => {
  assert.deepEqual(TYPE_FIELDS.algorithm, [
    'title', 'authors', 'journal', 'year', 'doi', 'keywords', 'abstract',
    'researchQuestion', 'scienceQuestion', 'coreFindings', 'researchDesign', 'criticalThinking',
    'reviewUse', 'experimentalDesign', 'ablationDesign', 'researchGap',
    'dataset', 'metrics', 'researchField',
  ]);
  for (const k of ['researchObject', 'constructs', 'background', 'paramDiscussion', 'innovation', 'method']) {
    assert.ok(!TYPE_FIELDS.algorithm.includes(k), `算法类不该包含 ${k}`);
  }
  for (const k of TYPE_FIELDS.algorithm) assert.ok(FIELD_LABELS[k], `${k} 缺中文标签`);
});

test('送模型的正文是「开头 + 等距抽样 + 结尾」：方法/结果/讨论都能覆盖到', () => {
  const short = 'x'.repeat(500);
  assert.equal(pickPaperText(short), short, '短文本原样返回');

  // 造一篇 9 万字符的「论文」：按段落编号，便于检查抽样位置
  const blocks = Array.from({ length: 90 }, (_, i) => `#${i}`.padEnd(1000, '.'));
  const long = blocks.join('');
  const picked = pickPaperText(long, { maxChars: 14000 });

  assert.ok(picked.length < 14000 + 400, `总长度应受控，实际 ${picked.length}`);
  assert.ok(picked.startsWith('#0.'), '开头保留');
  assert.ok(picked.includes('#89.'), '结尾（讨论/结论）必须保留');
  assert.ok(picked.includes('此处省略原文的一部分'), '要标注被省略');
  // 中段（大致对应方法段与结果段）必须被抽样覆盖：不能只有「头 + 尾」
  const coveredMid = [];
  for (let i = 10; i <= 85; i += 1) if (picked.includes(`#${i}.`)) coveredMid.push(i);
  assert.ok(coveredMid.length >= 4, `中段抽样太少：覆盖了 ${coveredMid.join(',') || '无'}`);
  assert.ok(coveredMid.length <= 8, `中段抽样过多会挤掉头尾：覆盖了 ${coveredMid.join(',')}`);
});

test('前端列顺序与后端字段顺序一致（两边各写一份，必须对齐）', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const m = app.match(/empirical:\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'public/app.js 里找不到 TYPE_ORDER.empirical');
  const front = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1])
    // 前端多两个「不由 AI 产出」的列：导入时间（系统）与我的思考（用户手写）
    .filter((k) => k !== 'importedAt' && k !== 'thoughts');
  assert.ok(m[1].includes("'importedAt'"), '前端应保留导入时间列');
  assert.ok(m[1].includes("'thoughts'"), '前端应保留我的思考列');
  assert.deepEqual(front, EMPIRICAL_KEYS, '前端实证类列顺序与 src/aiExtractor.js 不一致');
});

test('前端三个文库的列顺序都与后端一致', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  for (const type of ['model', 'algorithm']) {
    const block = app.slice(app.indexOf('const TYPE_ORDER = {'));
    const m = block.match(new RegExp(`${type}:\\s*\\[([\\s\\S]*?)\\]`));
    assert.ok(m, `public/app.js 里找不到 TYPE_ORDER.${type}`);
    const front = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1])
      .filter((k) => k !== 'importedAt' && k !== 'thoughts');
    assert.deepEqual(front, TYPE_FIELDS[type], `前端 ${type} 列顺序与 src/aiExtractor.js 不一致`);
  }
});

test('侧边栏三个文库入口齐全（实证 / 模型 / 算法）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  for (const type of ['empirical', 'model', 'algorithm']) {
    assert.ok(html.includes(`data-rootlib="${type}"`), `index.html 缺少 ${type} 文库入口`);
  }
});
