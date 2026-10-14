import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const utilSource = fs.readFileSync(path.join(ROOT, 'public', 'pdf-reader-utils.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(utilSource, context, { filename: 'pdf-reader-utils.js' });
const utils = context.window.PdfReaderUtils;

test('拼接模式保持英文词边界并连续拼接中文选区', () => {
  assert.equal(utils.joinSelectionText('multi', 'modal'), 'multi modal');
  assert.equal(utils.joinSelectionText('研究', '问题'), '研究问题');
  assert.equal(utils.joinSelectionText('First paragraph.', 'Second paragraph.'), 'First paragraph. Second paragraph.');
  assert.equal(utils.joinSelectionText('', '  selected text  '), 'selected text');
});

test('单页旋转会正确交换显示尺寸，并可把标注矩形往返映射', () => {
  const size = { w: 600, h: 800 };
  assert.deepEqual({ ...utils.getDisplaySize(size, 0) }, { w: 600, h: 800 });
  assert.deepEqual({ ...utils.getDisplaySize(size, 90) }, { w: 800, h: 600 });
  const original = [100, 200, 300, 260];
  for (const degrees of [0, 90, 180, 270]) {
    const displayed = utils.toDisplayRect(original, size, degrees);
    const restored = utils.toCanonicalRect(displayed, size, degrees);
    assert.deepEqual({ ...restored }, { x1: 100, y1: 200, x2: 300, y2: 260 });
  }
  assert.equal(utils.normalizeRotation(-90), 270);
  assert.equal(utils.normalizeRotation(450), 90);
});

test('PDF 阅读器保留旋转控件，划词翻译面板已还原', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  for (const id of ['prRotateLeft', 'prRotateRight', 'prRotationLabel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  // 划词翻译面板已还原（「🌐 划词翻译」页签回来了），原文框 / 翻译按钮 / 结果框 /
  // 拼接模式 / 清空选区跟着一起回来。
  for (const id of ['prTabTranslate', 'prSourceText', 'prTransResult', 'prDoTranslate', 'prJoinMode', 'prClearSelection']) {
    assert.match(html, new RegExp(`id="${id}"`), `还原划词翻译面板后应存在 ${id}`);
  }
  // 拼接逻辑仍在：默认按中英边界拼（见 app.js 的 selectionText），也可用面板里的「拼接模式」开关
  assert.match(app, /pdfReaderUtils\.joinSelectionText/);
  assert.match(app, /getPageViewport\(page, pageNum\)/);
  assert.match(app, /toCanonicalRect/);
  assert.match(app, /toDisplayRect/);
});

// ---------- 论文正文的分段检索（AI 对话按需注入，避免每轮重发全文） ----------

test('正文切段：标题独占一段，正文合并到最小长度以上', () => {
  const text = [
    '# 摘要',
    '本文研究了 AI 产品的定价机制，并给出一个理论框架来说明价格与需求之间的关系，',
    '同时讨论了平台竞争对均衡价格的影响。',
    '## 1 引言',
    '既有文献主要关注传统商品，对 AI 产品的边际成本特征讨论不足。',
  ].join('\n\n');
  const segs = utils.splitContextSegments(text);
  assert.equal(segs[0], '# 摘要');
  assert.equal(segs[1].startsWith('本文研究了'), true);
  assert.equal(segs[2], '## 1 引言');
  assert.equal(utils.splitContextSegments('').length, 0);
});

test('提问分词：中文按 2-gram 滑窗，英文按单词', () => {
  const toks = utils.contextQueryTokens('AI 产品的定价机制 pricing mechanism');
  assert.ok(toks.includes('定价'));
  assert.ok(toks.includes('价机'));
  assert.ok(toks.includes('pricing'));
  assert.ok(toks.includes('mechanism'));
  assert.equal(toks.includes('a'), false);
});

test('按提问挑片段：命中相关段、还原原文顺序；命中太少返回空串', () => {
  const segs = [
    '# 摘要',
    '本文研究 AI 产品的定价机制，提出一个理论框架。定价机制是本文的核心问题。',
    '实验部分使用二手数据，样本来自三家平台。',
    '结论指出定价机制与平台竞争相互影响。',
    '参考文献列举若干。',
  ];
  const hit = utils.pickContextSegments(segs, '这篇论文的定价机制是什么', { minPicked: 2 });
  assert.ok(hit.text.includes('定价机制'));
  assert.ok(hit.indexes.includes(1));
  // vm 沙箱里创建的数组与当前 realm 的原型不同，deepStrictEqual 会误报，故比较拼接结果
  assert.equal([...hit.indexes].sort((a, b) => a - b).join(','), '1,3');

  // 与正文毫无交集的提问 → 返回空串，交给调用方走压缩全文兜底
  const miss = utils.pickContextSegments(segs, '量子纠缠的退相干时间', { minPicked: 2 });
  assert.equal(miss.text, '');
});

test('压缩全文：短文本原样返回，长文本保留头尾并标注省略', () => {
  assert.equal(utils.condenseContextText('短文本', 100), '短文本');
  const cut = utils.condenseContextText('A'.repeat(1000), 200);
  assert.ok(cut.length < 1000);
  assert.ok(cut.includes('中间内容略'));
  assert.ok(cut.startsWith('AAA'));
  assert.ok(cut.endsWith('AAA'));
});

test('全局性问题识别：总结/全文命中，具体问题不命中', () => {
  assert.equal(utils.needsWholePaper('请总结这篇论文'), true);
  assert.equal(utils.needsWholePaper('give me an overview'), true);
  assert.equal(utils.needsWholePaper('全文讲了什么'), true);
  assert.equal(utils.needsWholePaper('第 3 节的样本量是多少'), false);
  assert.equal(utils.needsWholePaper(''), false);
});
