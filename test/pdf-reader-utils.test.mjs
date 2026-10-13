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
