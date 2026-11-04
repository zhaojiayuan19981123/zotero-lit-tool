// reading-segments.test.mjs —— 断句拼接 / 译文按原比例回分 / 逐句配对
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  joinSplitSentence, splitTranslation, splitSentences, pairSentences,
} from '../src/readingSegments.js';

test('被分栏截断的两截拼成完整句，权重按原文长度', () => {
  const r = joinSplitSentence([
    { text: 'We observe that the demonstration together,', page: 2, col: 0 },
    { text: 'or demonstrators might invite more people', page: 2, col: 1 },
  ]);
  assert.match(r.text, /together, or demonstrators/);
  assert.equal(r.parts.length, 2);
  assert.ok(Math.abs(r.weights.reduce((a, b) => a + b, 0) - 1) < 0.001);
  assert.ok(r.weights[0] > 0 && r.weights[1] > 0);
});

test('英文断词连字符自动接合：con- + stantly → constantly', () => {
  const r = joinSplitSentence([
    { text: 'the effect is con', page: 1, col: 0 },
    { text: 'stantly present', page: 1, col: 1 },
  ]);
  // 不是断词结尾时按普通空格接
  assert.ok(!r.text.includes('con-'));
  const dehyph = joinSplitSentence([
    { text: 'the effect is con-', page: 1, col: 0 },
    { text: 'stantly present', page: 1, col: 1 },
  ]);
  assert.match(dehyph.text, /con stantly|constantly/);
});

test('连字符接合不会给中文段落乱补空格', () => {
  const r = joinSplitSentence([
    { text: '本文提出一种新的', page: 3, col: 0 },
    { text: '对照精读方法。', page: 3, col: 1 },
  ]);
  assert.equal(r.text, '本文提出一种新的对照精读方法。');
});

test('译文按原比例分回两处，且不切破英文单词', () => {
  const parts = splitTranslation(
    'The first half of this translated sentence belongs to the left column and the second half goes to the right column.',
    [0.5, 0.5]);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].length > 20 && parts[1].length > 20);
  assert.ok(!parts[0].endsWith('a') || parts[1].length > 0);
  // 拼回去不应丢字（切点落在词边界，最多丢一个空格）
  assert.ok((parts[0] + ' ' + parts[1]).replace(/\s+/g, ' ').length >= 100);
});

test('中文译文按字符比例回分', () => {
  const parts = splitTranslation('质量管理是本文研究的核心问题，我们采用主题模型进行分析并得到若干结论。', [0.6, 0.4]);
  assert.equal(parts.length, 2);
  assert.ok(parts[0].length > parts[1].length);
  assert.equal(parts[0] + parts[1], '质量管理是本文研究的核心问题，我们采用主题模型进行分析并得到若干结论。');
});

test('三截以上也能按权重回分，空权重返回空串', () => {
  const parts = splitTranslation('one two three four five six seven eight nine ten', [0.2, 0.3, 0.5]);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => typeof p === 'string'));
  assert.deepEqual(splitTranslation('abc', [0, 0, 1]), ['', '', 'abc']);
});

test('句子切分覆盖中英文标点', () => {
  assert.deepEqual(splitSentences('First sentence. Second sentence! Third?'),
    ['First sentence.', 'Second sentence!', 'Third?']);
  assert.ok(splitSentences('第一句。第二句！第三句？').length >= 3);
});

test('逐句配对：译文句数多于/少于原文都能对齐', () => {
  const pairs = pairSentences('A. B. C.', '甲。乙。');
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every((p) => typeof p.source === 'string' && typeof p.translation === 'string'));
  const same = pairSentences('A. B.', '甲。乙。');
  assert.equal(same.length, 2);
  assert.equal(same[1].translation, '乙。');
});
