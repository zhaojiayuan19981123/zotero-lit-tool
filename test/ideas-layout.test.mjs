import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

const style = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const ideasLayout = style.match(/\/\* ---------- 灵感孵化：固定工具栏，卡片区只在剩余高度内滚动 ----------[\s\S]*?(?=\n\s*\n\s*\n|$)/)?.[0] || '';

test('灵感孵化视图将滚动限制在卡片区域且不预留滚动条沟槽', () => {
  assert.match(ideasLayout, /flex: 1 1 0/);
  assert.match(ideasLayout, /min-height: 0/);
  assert.match(ideasLayout, /height: 0/);
  assert.match(ideasLayout, /overflow: hidden/);
  assert.match(ideasLayout, /overflow-x: hidden/);
  assert.match(ideasLayout, /overflow-y: auto/);
  assert.match(ideasLayout, /padding: 10px 20px 16px 0/);
  assert.doesNotMatch(ideasLayout, /scrollbar-gutter\\s*:/);
});

