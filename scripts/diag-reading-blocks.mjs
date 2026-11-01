// 诊断：逐个文本块打印页范围与行数（看跨页接续有没有连得太长）
import { buildReadingDoc } from '../src/readingMode.js';

const { doc } = await buildReadingDoc(process.argv[2]);
const from = Number(process.argv[3] || 1);
const to = Number(process.argv[4] || 999);
for (const b of doc.blocks) {
  if (b.t !== 'text') { console.log(`${b.id} crop p${b.page} ${b.k} rect=${b.rect.map(Math.round)}`); continue; }
  const pages = [...new Set(b.lines.map((l) => l.p))];
  if (pages[0] < from || pages[0] > to) continue;
  const first = b.lines[0].runs.map((r) => r[2]).join('').slice(0, 46);
  console.log(`${b.id} p${pages[0]}-${pages[pages.length - 1]} ${b.kind} L${b.level} lines=${b.lines.length} :: ${first}`);
}
