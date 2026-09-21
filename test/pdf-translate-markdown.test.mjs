// pdf-translate-markdown.test.mjs —— Markdown 译文输出（文本层路径 + 视觉模型路径）的回归用例
//
// 守护点：
//   1) 输出模式：md 是一等公民（resolveModes / OUTPUT_META / 默认值）
//   2) 文本层路径：标题层级映射、段落、图表 crop 引用不能串
//   3) 视觉路径：标记解析的容错（漏闭合 / 无标记 / 未知标记）
//   4) 视觉组装：翻译回填、未译回退原文、[FIG] → analyze 图片区域的映射
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PDF_TRANSLATE_OPTIONS, MODES, OUTPUT_META, resolveModes,
} from '../src/pdfTranslate/index.js';
import {
  buildMarkdownFromLayout, elementsToMarkdown,
  parseVisionBlocks, collectVisionSegments, applyVisionTranslations,
  assembleVisionMarkdown, visionPageFallbackMarkdown, visionPaperPrompt,
} from '../src/pdfTranslate/markdown.js';

// ==================== fixture ====================

function mkBlock(over = {}) {
  return {
    id: 'b', text: '', rawText: '', translation: '', translatable: true,
    kind: 'body', size: 10, bold: false, italic: false, column: 0,
    x0: 50, y0: 600, x1: 500, y1: 620, tableLike: false,
    ...over,
  };
}

function mkPage(index, blocks, images = []) {
  return { index, rotate: 0, columns: [], blocks, images };
}

// ==================== 输出模式 ====================

test('md 是一等输出模式：默认值 / MODES / resolveModes / OUTPUT_META 全部认它', () => {
  assert.equal(DEFAULT_PDF_TRANSLATE_OPTIONS.mode, 'md');
  assert.ok(MODES.includes('md'));
  assert.deepEqual(resolveModes('md'), ['md']);
  // all 展开：Markdown 排最前（用户最终想看的那份）
  assert.deepEqual(resolveModes('all'), ['md', 'reflow', 'mono', 'dual']);
  assert.deepEqual(resolveModes('both'), ['mono', 'dual']);
  assert.equal(OUTPUT_META.md.suffix, '-译文');
  assert.ok(OUTPUT_META.md.label.includes('Markdown'));
});

// ==================== 文本层路径 ====================

test('buildMarkdownFromLayout：标题层级 / 段落 / 图注的 Markdown 映射', () => {
  const pages = [mkPage(0, [
    mkBlock({ id: 't', kind: 'title', size: 18, y1: 750, text: 'Paper Title', translation: '论文标题' }),
    mkBlock({ id: 'h', kind: 'heading', size: 14, y1: 700, text: '1 Introduction', translation: '1 引言' }),
    mkBlock({ id: 'p1', kind: 'body', size: 10, y1: 650, text: 'Body one.', translation: '正文一' }),
    mkBlock({ id: 'p2', kind: 'body', size: 10, y1: 600, text: 'Body two.', translation: '正文二' }),
    mkBlock({ id: 'cap', kind: 'caption', size: 9, y1: 550, text: 'Figure 1: demo', translation: '图 1：示例' }),
  ])];
  const { markdown, stats } = buildMarkdownFromLayout(pages);
  assert.ok(markdown.startsWith('# 论文标题'), '论文主标题应为 H1');
  assert.ok(markdown.includes('## 1 引言'), '字号最大的 heading 定级为 H2');
  assert.ok(markdown.includes('正文一'));
  assert.ok(markdown.includes('*图 1：示例*'), '图注输出为斜体');
  assert.equal(stats.text, 5);
});

test('buildMarkdownFromLayout：公式块与插图区域转成 crop 引用，参考文献/页眉丢弃', () => {
  const pages = [mkPage(0, [
    mkBlock({ id: 'p', kind: 'body', size: 10, y1: 650, translation: '正文' }),
    // 不可译的公式块 → 裁剪保留
    mkBlock({ id: 'f', kind: 'formula', translatable: false, y1: 500, y0: 460, text: 'E=mc^2' }),
    // 参考文献与页眉（furniture）→ 直接丢弃
    mkBlock({ id: 'r', kind: 'reference', translatable: false, y1: 100, text: '[1] someone' }),
    mkBlock({ id: 'h', kind: 'furniture', translatable: false, y1: 790, text: 'header' }),
  ], [
    // 插图区域（面积 ≥ 2200）
    { x0: 320, y0: 250, x1: 520, y1: 400 },
  ])];
  const { markdown, stats } = buildMarkdownFromLayout(pages);
  // 公式 crop：p1 + 矩形坐标（带 1.5 pad）
  assert.ok(/\[E=mc\^2\]\(crop:p1:48\.5:458\.5:501\.5:501\.5\)/.test(markdown), `公式 crop 引用缺失：${markdown}`);
  // 插图 crop：318.5:248.5:521.5:401.5
  assert.ok(/\(crop:p1:318\.5:248\.5:521\.5:401\.5\)/.test(markdown), `插图 crop 引用缺失：${markdown}`);
  assert.ok(!markdown.includes('someone'), '参考文献不应出现在 Markdown 里');
  assert.ok(!markdown.includes('header'), '页眉不应出现在 Markdown 里');
  assert.equal(stats.crops, 2);
});

test('elementsToMarkdown：译文缺失时回退原文', () => {
  const md = elementsToMarkdown([
    { type: 'text', level: 'body', text: '', sourceBold: false },
    { type: 'text', level: 'h2', text: '只有原文', sourceBold: false },
  ]);
  assert.ok(md.markdown.includes('## 只有原文'));
});

// ==================== 视觉路径：标记解析 ====================

test('parseVisionBlocks：标准标记逐一解析，多行 [P] 合并', () => {
  const raw = [
    '[TITLE] Deep Learning',
    '[H1] 1 Introduction',
    '[P] First paragraph line one',
    'continues here without marker',
    '[FIG] system architecture',
  ].join('\n');
  const blocks = parseVisionBlocks(raw);
  assert.deepEqual(blocks.map((b) => b.tag), ['TITLE', 'H1', 'P', 'FIG']);
  assert.equal(blocks[0].text, 'Deep Learning');
  assert.equal(blocks[2].text, 'First paragraph line one\ncontinues here without marker');
});

test('parseVisionBlocks：[/TABLE] / [/FORMULA] 闭合与漏闭合的容错', () => {
  const raw = [
    '[P] before table',
    '[TABLE]',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '[/TABLE]',
    '[FORMULA]',
    'E = mc^2',
    '[/FORMULA]',
    '[P] after',
  ].join('\n');
  const blocks = parseVisionBlocks(raw);
  assert.deepEqual(blocks.map((b) => b.tag), ['P', 'TABLE', 'FORMULA', 'P']);
  assert.equal(blocks[1].text, '| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(blocks[2].text, 'E = mc^2');

  // 漏写 [/TABLE]：下一个 [P] 出现时必须截断，不能吞掉后半页
  const leaky = ['[TABLE]', '| a | b |', '[P] next paragraph'].join('\n');
  const blocks2 = parseVisionBlocks(leaky);
  assert.deepEqual(blocks2.map((b) => b.tag), ['TABLE', 'P']);
});

test('parseVisionBlocks：整页无标记时兜底成一个大段落', () => {
  const blocks = parseVisionBlocks('just plain text\nsecond line');
  assert.deepEqual(blocks, [{ tag: 'P', text: 'just plain text\nsecond line' }]);
  assert.deepEqual(parseVisionBlocks('   '), []);
});

// ==================== 视觉路径：翻译与组装 ====================

test('collectVisionSegments：TABLE/FORMULA/FIG 不送翻译，REF 按开关决定', () => {
  const pages = [{
    page: 3,
    blocks: [
      { tag: 'H1', text: 'Method' },
      { tag: 'P', text: 'text' },
      { tag: 'TABLE', text: '| a |' },
      { tag: 'FORMULA', text: 'E=mc^2' },
      { tag: 'FIG', text: 'a diagram' },
      { tag: 'REF', text: '[1] ref' },
      { tag: 'CAP', text: 'Figure 1' },
    ],
  }];
  const ids = (opts) => collectVisionSegments(pages, opts).map((s) => s.id);
  assert.deepEqual(ids({}), ['v3:0', 'v3:1', 'v3:6'], '默认不翻参考文献');
  assert.deepEqual(ids({ translateReferences: true }), ['v3:0', 'v3:1', 'v3:5', 'v3:6']);
});

test('applyVisionTranslations + assembleVisionMarkdown：回填、回退、FIG→crop 映射', () => {
  const pages = [
    {
      page: 2,
      blocks: [
        { tag: 'H2', text: '2.1 Model' },
        { tag: 'P', text: 'untranslated paragraph' },
        { tag: 'FORMULA', text: '$$y=x$$' },
        { tag: 'TABLE', text: '| a | b |\n|---|---|\n| 1 | 2 |' },
        { tag: 'FIG', text: 'framework diagram' },
        { tag: 'FIG', text: 'second figure' },
      ],
    },
  ];
  const layoutPages = [mkPage(0, [mkBlock({ id: 'x' })], [
    { x0: 100, y0: 100, x1: 300, y1: 200 },
  ])];
  // 第 2 页（1 起始）→ layout.index = 1；给第 2 页一个图片区域
  layoutPages.push(mkPage(1, [mkBlock({ id: 'y' })], [
    { x0: 40, y0: 500, x1: 400, y1: 640 },
    { x0: 40, y0: 300, x1: 400, y1: 440 },
  ]));

  const segments = collectVisionSegments(pages);
  // 只给 H2 回填译文；P 不给 → 组装时必须回退原文
  const map = new Map([['v2:0', '2.1 模型']]);
  applyVisionTranslations(pages, segments, map);

  const { markdown, stats } = assembleVisionMarkdown(pages, layoutPages);
  assert.ok(markdown.includes('### 2.1 模型'), 'H2 经翻译回填 → ###');
  assert.ok(!markdown.includes('2.1 Model'), '回填后不应残留原文标题');
  assert.ok(markdown.includes('untranslated paragraph'), '未译块回退原文');
  assert.ok(markdown.includes('$$\ny=x\n$$'), '公式用 $$ 包裹');
  assert.ok(markdown.includes('| a | b |'), '表格 GFM 原样透传');
  assert.ok(/\[framework diagram\]\(crop:p2:38\.5:498\.5:401\.5:641\.5\)/.test(markdown), `FIG 按顺序映射图片区域：${markdown}`);
  assert.ok(/\(crop:p2:38\.5:298\.5:401\.5:441\.5\)/.test(markdown), '第二个 FIG 用第二个图片区域');
  assert.equal(stats.crops, 2);
  assert.ok(stats.text >= 3);
});

test('assembleVisionMarkdown：图片区域不够时 FIG 退化为文字占位', () => {
  const pages = [{ page: 1, blocks: [{ tag: 'FIG', text: 'some figure' }] }];
  const { markdown } = assembleVisionMarkdown(pages, [mkPage(0, [mkBlock({ id: 'x' })], [])]);
  assert.ok(markdown.includes('（图：some figure）'));
});

test('visionPageFallbackMarkdown：缺图页用文本层兜底（含译文）', () => {
  const page = mkPage(0, [
    mkBlock({ id: 'p', kind: 'body', y1: 650, translation: '兜底正文' }),
    mkBlock({ id: 'h', kind: 'heading', size: 13, y1: 700, translation: '兜底标题' }),
  ]);
  const { markdown } = visionPageFallbackMarkdown(page);
  assert.ok(markdown.includes('## 兜底标题'));
  assert.ok(markdown.includes('兜底正文'));
  assert.equal(visionPageFallbackMarkdown(null).markdown, '');
});

test('visionPaperPrompt：提示词包含全部标记且按开关提及参考文献', () => {
  const p1 = visionPaperPrompt({});
  for (const tag of ['[TITLE]', '[H1]', '[P]', '[TABLE]', '[FORMULA]', '[FIG]', '[CAP]']) {
    assert.ok(p1.includes(tag), `缺少标记 ${tag}`);
  }
  assert.ok(/跳过|不要转录/.test(p1), '默认提示应说明跳过参考文献');
  const p2 = visionPaperPrompt({ translateReferences: true });
  assert.ok(p2.includes('完整转录'), '开启后要求转录参考文献');
});
