// achievement-fields.test.mjs —— 成果字段定义与归一化的单测
//
// 这里盯的是「模型返回什么都不能把数据写坏」：字段白名单、年份/DOI/完成度的清洗、
// 以及前端与本模块共用同一份列定义（避免两边慢慢跑偏）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIES, CATEGORY_KEYS, COLUMNS, DETAIL_GROUPS, FIELD_LABELS, FILE_KINDS,
  STAGE_LABELS, PROGRESS_STATUSES, ALL_TEXT_FIELDS, PAPER_AI_FIELDS,
  appHintFor, extOf, isPreviewable, normalizeFields, sanitizeYear,
  buildParsePrompt, buildSearchReportPrompt, stageLabel,
} from '../src/achievementFields.js';

test('五类成果齐全，且每类都有列定义与详情分组', () => {
  assert.deepEqual(CATEGORY_KEYS, ['paper', 'patent', 'certificate', 'textbook', 'project']);
  for (const c of CATEGORIES) {
    assert.ok(c.label && c.icon, `${c.key} 要有中文名与图标`);
    const cols = COLUMNS[c.key];
    assert.ok(Array.isArray(cols) && cols.length >= 6, `${c.key} 的表格列太少`);
    assert.equal(cols[0].key, 'title', `${c.key} 第一列应该是名称`);
    assert.ok(cols.some((x) => x.kind === 'link'), `${c.key} 要有可点击的名称列`);
    assert.ok(DETAIL_GROUPS[c.key]?.length, `${c.key} 要有详情分组`);
    assert.ok(STAGE_LABELS[c.key]?.done && STAGE_LABELS[c.key]?.working, `${c.key} 要有两个阶段的说法`);
    // 详情里出现的字段必须在字段总表里（否则表单渲染不出值、保存又被白名单丢掉）
    for (const g of DETAIL_GROUPS[c.key]) {
      for (const f of g.fields) {
        assert.ok(ALL_TEXT_FIELDS.includes(f), `${c.key}.${f} 不在 ALL_TEXT_FIELDS 里`);
        assert.ok(FIELD_LABELS[f], `${c.key}.${f} 缺中文标签`);
      }
    }
  }
});

test('论文的识别字段与文献中心对齐（同一篇论文两处识别结果一致）', () => {
  // 文献中心那套字段是 AI 提取出来的公共 + 实证 + 模型字段，这里必须全部覆盖
  for (const f of ['title', 'authors', 'journal', 'year', 'doi', 'abstract', 'keywords', 'innovation', 'method', 'results', 'conclusion']) {
    assert.ok(PAPER_AI_FIELDS.includes(f), `论文识别字段缺 ${f}`);
  }
  // 成果管理额外要的卷期页与出版方
  for (const f of ['volume', 'issue', 'pages', 'publisher', 'issn']) {
    assert.ok(PAPER_AI_FIELDS.includes(f), `论文识别字段缺 ${f}`);
  }
});

test('进度状态与「论文进度」的流水线用同一套词（同步过去不用翻译）', () => {
  assert.deepEqual(PROGRESS_STATUSES, ['构思中', '撰写中', '导师审阅', '投稿中', '初审', '外审', '返修', '复审', '录用', '校样', '已见刊', '拒稿', '撤稿']);
});

test('sanitizeYear 只留 4 位年份', () => {
  assert.equal(sanitizeYear('2024年'), '2024');
  assert.equal(sanitizeYear('发表于 2019 年 3 期'), '2019');
  assert.equal(sanitizeYear('没有年份'), '');
  assert.equal(sanitizeYear(2023), '2023');
});

test('normalizeFields：清洗年份 / DOI / 完成度，并丢掉不认识的字段', () => {
  const out = normalizeFields({
    title: '  平台生态系统的价值共创  ',
    year: '2021年',
    doi: 'https://doi.org/10.1287/isre.2021.1001.',
    volume: '32',
    issue: '4',
    pages: '901-920',
    progressPercent: '0.65',
    authors: ['张三', '李四'],
    __hacked: 'x',
    files: [{ id: 'evil' }],
  });
  assert.equal(out.title, '平台生态系统的价值共创', '首尾空白要去掉');
  assert.equal(out.year, '2021');
  assert.equal(out.doi, '10.1287/isre.2021.1001', '去掉 doi.org 前缀与行尾标点');
  assert.equal(out.volume, '32');
  assert.equal(out.pages, '901-920');
  assert.equal(out.progressPercent, '65', '0.65 要理解成 65%');
  assert.equal(out.authors, '张三, 李四', '数组要拍平成逗号分隔');
  assert.equal(out.__hacked, undefined, '不认识的字段不能进记录');
  assert.equal(out.files, undefined, '附件清单不能被解析结果覆盖');
});

test('normalizeFields：空输入与垃圾输入都不抛错', () => {
  assert.deepEqual(normalizeFields(null), {});
  assert.deepEqual(normalizeFields('不是对象'), {});
  const out = normalizeFields({ title: { nested: 1 }, abstract: 123 });
  assert.equal(out.title, '', '对象要拍掉而不是塞成 [object Object]');
  assert.equal(out.abstract, '123');
});

test('每个类型的阶段说法不一样，但都只有两种', () => {
  assert.equal(stageLabel('paper', 'done'), '已出版发行');
  assert.equal(stageLabel('paper', 'working'), '在投中');
  assert.equal(stageLabel('patent', 'done'), '已授权');
  assert.equal(stageLabel('project', 'working'), '在研');
  assert.equal(stageLabel('未知类型', 'working'), STAGE_LABELS.paper.working);
});

test('附件类型与扩展名提示', () => {
  assert.deepEqual(FILE_KINDS.map((k) => k.key), ['main', 'searchReport', 'certificate', 'code', 'other']);
  assert.equal(extOf('论文终稿.PDF'), 'pdf');
  assert.equal(extOf('没有扩展名'), '');
  assert.equal(appHintFor('a.docx'), 'Word');
  assert.equal(appHintFor('a.pptx'), 'PowerPoint');
  assert.equal(appHintFor('b.XLSX'), 'Excel');
  assert.match(appHintFor('run.do'), /Stata/);
  assert.equal(appHintFor('未知.zzz'), '');
  assert.equal(isPreviewable('a.pdf'), true);
  assert.equal(isPreviewable('a.png'), true);
  assert.equal(isPreviewable('a.docx'), false);
});

test('提示词里必须点名所有要提取的字段，避免模型漏字段', () => {
  const p = buildParsePrompt('简体中文', 'paper');
  for (const f of ['title', 'authors', 'journal', 'year', 'doi', 'keywords', 'abstract', 'volume', 'issue', 'pages']) {
    assert.ok(p.includes(f), `解析提示词里没提到 ${f}`);
  }
  assert.ok(p.includes('严格 JSON'), '必须要求严格 JSON');
  assert.ok(p.includes('不要编造'), '必须要求不要编造');
  assert.ok(p.includes('简体中文'), '语言要跟着设置走');
  const r = buildSearchReportPrompt('English');
  assert.ok(r.includes('检索报告'));
  assert.ok(r.includes('English'));
});
