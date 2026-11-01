// 诊断：打印某一页 analyze 出的原始块与阅读顺序
import fs from 'node:fs';
import { analyzePdf } from '../src/pdfTranslate/analyze.js';
import { readingOrder } from '../src/pdfTranslate/reflow.js';

const file = process.argv[2];
const pageNo = Number(process.argv[3] || 1);
const bytes = await fs.promises.readFile(file);
const a = await analyzePdf(bytes, {});
const page = a.pages.find((p) => p.index === pageNo);
console.log('page', page.index, 'size', page.width, page.height, 'columns', JSON.stringify(page.columns));
const r = (v) => Math.round(v);
for (const b of readingOrder(page)) {
  console.log(`${b.id} ${b.kind}${b.tableLike ? '/table' : ''} col${b.column} y[${r(b.y0)},${r(b.y1)}] x[${r(b.x0)},${r(b.x1)}] sz=${r(b.size * 10) / 10} align=${b.align} :: ${b.text.slice(0, 60)}`);
}
