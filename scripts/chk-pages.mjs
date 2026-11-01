// 诊断：检查阅读模式结构树是否整页丢失
import { buildReadingDoc } from '../src/readingMode.js';

const { doc } = await buildReadingDoc(process.argv[2]);
const seen = new Set();
for (const b of doc.blocks) {
  if (b.t === 'text') for (const l of b.lines) seen.add(l.p);
  else seen.add(b.page);
}
const missing = [];
for (let i = 1; i <= doc.pages; i++) if (!seen.has(i)) missing.push(i);
console.log('缺页:', missing.join(',') || '（无）');
const perPage = {};
for (const b of doc.blocks) perPage[b.page] = (perPage[b.page] || 0) + 1;
console.log('每页块数:', JSON.stringify(perPage));
