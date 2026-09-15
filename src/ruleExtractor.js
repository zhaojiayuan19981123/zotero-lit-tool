// ruleExtractor.js —— 基于规则的离线信息提取（无需 API Key 的兜底方案）
// 说明：规则提取的精度有限，尤其是"创新点"等深层内容；推荐配置 AI 后获得更高质量结果。

function clean(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function firstMatch(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return '';
}

/**
 * 从 PDF 纯文本中做规则化信息提取
 * @param {string} text 全文文本
 * @param {object} pdfInfo pdf-parse 返回的元信息（title/author 等）
 */
export function extractByRules(text, pdfInfo = {}) {
  const out = {
    title: '',
    authors: '',
    journal: '',
    year: '',
    doi: '',
    abstract: '',
    keywords: '',
    background: '',
    summary: '',
    innovation: '',
    theory: '',
    method: '',
    researchDesign: '',
    constructs: '',
    results: '',
    conclusion: '',
    criticalThinking: '',
    model: '',
    paramDiscussion: '',
  };

  // ---------- DOI ----------
  out.doi = firstMatch(text, [
    /\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/,
    /doi[:\s]+(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/i,
  ]).replace(/[.,;)\]]+$/, '');

  // ---------- 年份 ----------
  const yearMatch = text.slice(0, 2000).match(/\b((?:19|20)\d{2})\b/);
  out.year = yearMatch ? yearMatch[1] : '';
  if (!out.year && pdfInfo.creationDate) {
    out.year = firstMatch(String(pdfInfo.creationDate), [/\b((?:19|20)\d{2})\b/]);
  }

  // ---------- 标题 ----------
  out.title = extractTitle(text, pdfInfo);

  // ---------- 摘要 ----------
  out.abstract = extractSection(text,
    [/\babstract\b/i, /摘\s*要/],
    [/\b(?:keywords?|index\s*terms?)\b/i, /关\s*键\s*词/, /\bintroduction\b/i, /\b引\s*言\b/]
  );
  // 无换行兜底：用关键词定位摘要
  if (!out.abstract) {
    const m = text.match(/\babstract\b[:\-]?\s*([\s\S]{0,600})/i) || text.match(/摘\s*要[：:]\s*([\s\S]{0,600})/);
    if (m) out.abstract = clean(m[1]).slice(0, 600);
  }

  // ---------- 关键词 ----------
  const kw = text.match(/\b(?:key\s*words?|index\s*terms?)\b[:\-]?\s*([^\n]{0,300})/i)
    || text.match(/关\s*键\s*词\s*[：:]\s*([^\n]{0,300})/);
  out.keywords = kw ? clean(kw[1]).slice(0, 300) : '';

  // ---------- 作者 ----------
  out.authors = extractAuthors(text);

  // ---------- 期刊 ----------
  out.journal = extractJournal(text);

  // ---------- 正文各章节（研究背景/方法/结果/总结/创新点） ----------
  out.background = extractSection(text,
    [/\bintroduction\b/i, /\b引\s*言\b/, /\b绪\s*论\b/, /研\s*究\s*背\s*景\b/, /\bbackground\b/i],
    [/\b(?:related\s*work|methods?|materials?\s*(?:and\s*)?methods?|approach|methodology)\b/i, /方\s*法\b/, /实\s*验\b/]
  );

  out.method = extractSection(text,
    [/\b(?:materials?\s*(?:and\s*)?)?methods?\b/i, /\bmethodology\b/i, /\bapproach\b/i, /\bexperimental\s*(?:setup|design)\b/i, /方\s*法\b/, /实验(?:方法|部分)?\b/],
    [/\b(?:results?|experiments?|evaluation)\b/i, /结\s*果\b/, /实验(?:结果|部分)?\b/]
  );

  out.results = extractSection(text,
    [/\bresults?\b/i, /\bexperiments?\b/i, /\bevaluation\b/i, /结\s*果(?:与讨论)?\b/, /实验(?:结果)?\b/],
    [/\b(?:discussion|conclusions?|future\s*work)\b/i, /讨\s*论\b/, /结\s*论\b/, /总\s*结\b/]
  );

  out.conclusion = extractSection(text,
    [/\b(?:discussions?|conclusions?|summary|findings)\b/i, /结\s*论\b/, /总\s*结\b/, /讨\s*论\b/],
    [/\breferences?\b/i, /参\s*考\s*文\s*献\b/, /\backnowledg?e?ments?\b/i, /致\s*谢\b/]
  );

  // 创新点：从结论/讨论中抓取含"创新/贡献/首次/提出/novel/contribution"的句子
  out.innovation = extractInnovation(text, out.conclusion);

  // 若摘要为空，退化为正文开头文本
  if (!out.abstract && text.length > 0) {
    out.abstract = text.slice(0, 800);
  }

  // 一段话总结（规则提取用摘要/结论兜底）
  out.summary = clean(out.abstract).slice(0, 250) || clean(out.conclusion).slice(0, 250);

  return out;
}

// ---------- 标题行判定 ----------
function extractTitle(text, pdfInfo) {
  let t = clean(pdfInfo.title);
  if (t && t.length >= 4 && t.length <= 400) return t;

  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 4);
  // 无换行文本（整段连在一起）时，取开头作为标题兜底
  if (lines.length <= 1) {
    const first = clean(text.slice(0, 120)).split(/[.!?。！？]\s/)[0];
    return first.length >= 4 && first.length <= 400 ? first.slice(0, 200) : clean(text.slice(0, 80));
  }
  for (const line of lines.slice(0, 8)) {
    if (line.length > 400) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^(journal|vol|volume|issue|no\.|pp\.|©|copyright|doi|received|accepted|published|http)/i.test(line)) continue;
    if (isAffiliationLine(line)) continue;
    const candidate = line.replace(/\s*\d+\s*$/, '').trim();
    if (candidate.length >= 5) return candidate;
  }
  return '';
}

// ---------- 章节定位（标题行感知） ----------
// 判断某行是否是"章节标题"：短行 + 关键字出现在行首（允许前面的编号如 "3."、"3 "）
function isHeading(line, patterns) {
  const t = (line || '').trim();
  if (!t || t.length > 70) return false; // 标题通常是短行，正文句子不会误判
  const stripped = t.replace(/^(?:\d{1,2}[\.\)、]\s*|\d{1,2}\s+)/, '');
  if (stripped.length < 2) return false;
  for (const p of patterns) {
    p.lastIndex = 0;
    const m = stripped.match(p);
    if (m && m.index === 0) return true;
  }
  return false;
}

function extractSection(text, startPatterns, endPatterns, maxLen = 1500) {
  const lines = text.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i], startPatterns)) { startIdx = i; break; }
  }
  if (startIdx < 0) return '';
  let buf = '';
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (isHeading(lines[i], endPatterns)) break;
    buf += lines[i].trim() + '\n';
    if (buf.length > maxLen) break;
  }
  return clean(buf).slice(0, maxLen);
}

// ---------- 作者 ----------
function isAffiliationLine(line) {
  return /(university|univ\.|college|school|institute|department|dept\.|laboratory|lab\.|academy|hospital|@|gmail|\.edu|\.cn|china|usa|united\s+states|japan|uk|北京|上海|大学|学院|研究所|研究院|医院|实验室)/i.test(line);
}

function isAuthorLine(line) {
  if (!line || line.length < 6 || line.length > 300) return false;
  if (/\d{3,}/.test(line)) return false;
  if (isAffiliationLine(line)) return false;
  const parts = line.split(/[,·;]/).filter((p) => p.trim());
  if (parts.length < 2) return false;
  return parts.every((p) => /^[A-Za-z\u4e00-\u9fa5.'\-\s]{2,40}$/.test(p.trim()));
}

function extractAuthors(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const explicit = text.match(/\b(?:authors?|by)\b\s*[:\-]?\s*([^\n]{0,200})/i);
  if (explicit) return clean(explicit[1]).slice(0,200);
  for (let i = 1; i < Math.min(lines.length, 12); i++) {
    if (isAuthorLine(lines[i])) return lines[i].slice(0, 200);
  }
  return '';
}

// ---------- 期刊 ----------
function extractJournal(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const phraseRe = /\b(journal\s+of|proceedings\s+of|conference\s+on|transactions\s+on)\b/i;
  const properRe = /\b(IEEE|ACM|arXiv|NeurIPS|ICLR|ICML|CVPR|AAAI|Nature|Science|Cell|Lancet|JMLR|KDD|WWW|ACL|EMNLP)\b/;

  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i];
    if (phraseRe.test(line) || properRe.test(line)) {
      if (line.length <= 200 && !/^doi|^https?|^\d/.test(line.toLowerCase())) {
        return line.slice(0, 200);
      }
    }
  }

  // 退化为：作者行之后的首个独立短语
  let authorIdx = -1;
  for (let i = 1; i < Math.min(lines.length, 10); i++) {
    if (isAuthorLine(lines[i])) { authorIdx = i; break; }
  }
  if (authorIdx >= 0) {
    for (let i = authorIdx + 1; i < Math.min(lines.length, authorIdx + 5); i++) {
      const line = lines[i];
      if (!line) continue;
      if (/^(abstract|introduction|keywords?|doi|received|accepted|published|©|https?)/i.test(line)) break;
      if (/^\d/.test(line)) continue;
      if (isAffiliationLine(line)) continue;
      if (line.length >= 6 && line.length <= 200) return line.slice(0, 200);
    }
  }
  return '';
}

// ---------- 创新点 ----------
function extractInnovation(text, conclusion) {
  const source = conclusion || text;
  const sentences = source.split(/(?<=[.!?。！？])\s+|\n/);
  const keywords = /(创新|首创|首次|提出|新(?:方法|模型|框架|思路|机制)|改进|novel|first|propose|contribution|outperform|state-of-the-art|优于)/i;
  const hits = sentences.filter((s) => keywords.test(s) && s.length > 20 && s.length < 400);
  if (hits.length) return clean(hits.slice(0, 3).join(' ')).slice(0, 800);
  const first = conclusion.split(/(?<=[.!?。！？])\s+|\n/).find((s) => s.length > 20);
  return first ? clean(first).slice(0, 400) : '';
}
