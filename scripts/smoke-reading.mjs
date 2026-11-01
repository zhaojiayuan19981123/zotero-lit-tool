// 冒烟：把一份真实 PDF 跑成阅读模式结构树，打印统计与首页前几块
import { buildReadingDoc } from '../src/readingMode.js';

const file = process.argv[2];
if (!file) { console.error('用法: node smoke-reading.mjs <pdf>'); process.exit(1); }
const t0 = Date.now();
const { doc, cached } = await buildReadingDoc(file, { force: process.argv.includes('--force') });
console.log('耗时', Date.now() - t0, 'ms | cached=', cached);
console.log('页数', doc.pages, '| blocks', doc.blocks.length, '| stats', JSON.stringify(doc.stats));
console.log('warnings', doc.warnings);
for (const b of doc.blocks.slice(0, 8)) {
  if (b.t === 'text') {
    const text = b.lines.flatMap((l) => l.runs.map((r) => r[2])).join(' ').replace(/\s+/g, ' ').slice(0, 90);
    console.log(`[${b.id}] p${b.page} ${b.kind} L${b.level} lines=${b.lines.length} :: ${text}`);
  } else {
    console.log(`[${b.id}] p${b.page} crop:${b.k} rect=${b.rect.join(',')} cap=${(b.caption || '').slice(0, 40)}`);
  }
}
const texts = doc.blocks.filter((b) => b.t === 'text');
const allChars = texts.reduce((n, b) => n + b.lines.reduce((m, l) => m + l.runs.reduce((k, r) => k + r[2].length, 0), 0), 0);
console.log('重排正文字符数', allChars, '| 文本块', texts.length, '| 裁图块', doc.blocks.length - texts.length);
console.log('JSON 体积', (JSON.stringify(doc).length / 1048576).toFixed(2), 'MB');
