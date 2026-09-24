// thesis-fields.test.mjs —— 学位论文字段层：归一化、兜底猜测，以及**两段式解析的判据**
//
// fieldsComplete 决定「要不要再花一次 token 去看后面的页」：
// 判松了会为每篇论文都多付一倍 token，判紧了封面信息不全的论文永远拿不到学校/年份。
// 所以这里把边界逐条钉死。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fieldsComplete, buildThesisParsePrompt, buildThesisOcrPrompt,
  normalizeThesisFields, sanitizeYear, sanitizeDegreeType, sanitizeSchool,
  guessSchool, guessDegreeType, THESIS_AI_FIELDS, THESIS_REMOVED_FIELDS, THESIS_DEFAULT_COLUMNS,
} from '../src/thesisFields.js';

test('fieldsComplete：有标题 + 另外 2 个字段才算够用', () => {
  const base = { title: '论文标题', authors: '', school: '', degreeType: '', year: '' };
  // 只有标题 → 不够（这是要触发「补看第 2–3 页」的典型情况）
  assert.equal(fieldsComplete(base), false);
  // 标题 + 1 个 → 仍然不够
  assert.equal(fieldsComplete({ ...base, authors: '张三' }), false);
  assert.equal(fieldsComplete({ ...base, year: '2024' }), false);
  // 标题 + 2 个 → 够用（常见封面：标题 + 作者 + 学校）
  assert.equal(fieldsComplete({ ...base, authors: '张三', school: '某某大学' }), true);
  assert.equal(fieldsComplete({ ...base, degreeType: '硕士', year: '2024' }), true);
  // 标题 + 3 个 → 够用
  assert.equal(fieldsComplete({ ...base, authors: '张三', school: '某某大学', year: '2024' }), true);
});

test('fieldsComplete：没有标题一律算不够用（哪怕其它字段都有）', () => {
  assert.equal(fieldsComplete({ title: '', authors: '张三', school: '某某大学', degreeType: '硕士', year: '2024' }), false);
  assert.equal(fieldsComplete({ title: '   ', authors: '张三', school: '某某大学' }), false, '空白也算空');
});

test('fieldsComplete：脏输入不炸（null / undefined / 非对象）', () => {
  assert.equal(fieldsComplete(null), false);
  assert.equal(fieldsComplete(undefined), false);
  assert.equal(fieldsComplete('标题'), false);
  assert.equal(fieldsComplete([]), false);
});

test('解析提示词按实际页数措辞（省 token 的可见证据）', () => {
  const one = buildThesisParsePrompt('简体中文', 1);
  assert.match(one, /第 1 页/);
  assert.ok(!/前 3 页/.test(one), '只给 1 页时不该还说「前 3 页」');

  const three = buildThesisParsePrompt('简体中文', 3);
  assert.match(three, /前 3 页/);

  // 页数异常时收敛到合理区间，别把 0 页 / 999 页写进提示词
  assert.match(buildThesisParsePrompt('简体中文', 0), /第 1 页/);
  assert.match(buildThesisParsePrompt('简体中文', 999), /前 9 页/);
});

test('解析提示词：5 个字段、只依据看到的内容、年份 4 位', () => {
  const p = buildThesisParsePrompt('简体中文', 1);
  for (const f of THESIS_AI_FIELDS) assert.ok(p.includes(f), `提示词要提到 ${f}`);
  assert.match(p, /不要凭标题猜测/);
  assert.match(p, /4 位数字/);
  assert.match(p, /只返回 JSON/);
});

test('OCR 提示词：只转录、不翻译不总结，并说明看不清就空着', () => {
  const p = buildThesisOcrPrompt('简体中文');
  assert.match(p, /原样转录/);
  assert.match(p, /不翻译、不总结、不解释/);
  assert.match(p, /空字符串/);
  assert.match(p, /不要编/);
});

test('字段归一化：书名号、字段名前缀、页眉、单位后缀都要收拾干净', () => {
  const out = normalizeThesisFields({
    title: '《短视频沉浸体验对购买意愿的影响研究》',
    authors: '作者：张三',
    school: '某某大学硕士学位论文',
    degreeType: '硕士研究生',
    year: '2024年',
  });
  assert.equal(out.title, '短视频沉浸体验对购买意愿的影响研究');
  assert.equal(out.authors, '张三');
  assert.equal(out.school, '某某大学');
  assert.equal(out.degreeType, '硕士');
  assert.equal(out.year, '2024');
  // 只保留白名单字段
  assert.deepEqual(Object.keys(out).sort(), [...THESIS_AI_FIELDS].sort());
});

test('sanitizeYear：只认 4 位年份', () => {
  assert.equal(sanitizeYear('2024年'), '2024');
  assert.equal(sanitizeYear('答辩于 2023 年 5 月'), '2023');
  assert.equal(sanitizeYear('1899'), '', '19 世纪的不认');
  assert.equal(sanitizeYear('未提及'), '');
  assert.equal(sanitizeYear(''), '');
});

test('sanitizeDegreeType：只收敛成硕士 / 博士', () => {
  assert.equal(sanitizeDegreeType('硕士研究生'), '硕士');
  assert.equal(sanitizeDegreeType('学术型硕士'), '硕士');
  assert.equal(sanitizeDegreeType('MBA'), '硕士');
  assert.equal(sanitizeDegreeType('博士学位'), '博士');
  assert.equal(sanitizeDegreeType('本科'), '');
});

test('sanitizeSchool：剥页眉与字段名前缀，过长的当脏值丢掉', () => {
  assert.equal(sanitizeSchool('某某大学硕士学位论文'), '某某大学');
  assert.equal(sanitizeSchool('学校：某某财经大学'), '某某财经大学');
  assert.equal(sanitizeSchool('「某某大学」'), '某某大学');
  assert.equal(sanitizeSchool('一'.repeat(60)), '');
});

test('兜底猜测：文本里找学校与学位层次（学校名按 4–20 字识别，避免把短词当校名）', () => {
  assert.equal(guessSchool('对外经济贸易大学硕士学位论文 2024'), '对外经济贸易大学');
  assert.equal(guessSchool('某某财经学院博士学位论文'), '某某财经学院');
  assert.equal(guessSchool('没有校名的正文'), '');
  assert.equal(guessDegreeType('专业硕士学位论文'), '硕士');
  assert.equal(guessDegreeType('博士学位论文'), '博士');
  assert.equal(guessDegreeType('普通期刊论文'), '');
});

test('字段契约：仍然只保留 5 个 AI 字段、12 列，17 个废弃字段不再出现', () => {
  assert.equal(THESIS_AI_FIELDS.length, 5);
  assert.equal(THESIS_DEFAULT_COLUMNS.length, 12);
  assert.equal(THESIS_REMOVED_FIELDS.length, 17);
  assert.ok(THESIS_DEFAULT_COLUMNS.includes('degreeType'));
  assert.ok(THESIS_DEFAULT_COLUMNS.includes('year'));
  // 废弃字段不能再出现在 AI 字段或默认列里
  for (const f of THESIS_REMOVED_FIELDS) {
    assert.ok(!THESIS_AI_FIELDS.includes(f), `${f} 不该再是 AI 字段`);
    assert.ok(!THESIS_DEFAULT_COLUMNS.includes(f), `${f} 不该再是默认列`);
  }
});
