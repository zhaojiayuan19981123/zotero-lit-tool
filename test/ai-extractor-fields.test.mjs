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
} from '../src/aiExtractor.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// 实证类的 18 个解析字段（不含导入时间与我的思考）
const EMPIRICAL_KEYS = [
  'title', 'authors', 'journal', 'year', 'doi', 'keywords', 'abstract',
  'researchQuestion', 'researchObject', 'coreFindings', 'mechanism', 'boundaryConditions',
  'method', 'researchDesign', 'constructs', 'criticalThinking', 'reviewUse', 'researchGap',
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

test('模型类提示词保持原有字段，不被实证类字段污染', () => {
  const p = buildPrompt('model', '简体中文');
  for (const k of ['model', 'paramDiscussion', 'results', 'summary', 'innovation']) {
    assert.ok(p.includes(k), `模型类提示词缺 ${k}`);
  }
  assert.ok(!p.includes('researchGap'), '模型类不该出现实证类字段');
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
