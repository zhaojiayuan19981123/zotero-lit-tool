// aiExtractor.js —— 信息提取调度器：优先调用 LLM（硅基流动），否则回退规则提取
// 支持两种文献类型：empirical（实证类）/ model（模型类），字段与提示词不同
import { extractByRules } from './ruleExtractor.js';

// 公共字段
const COMMON_FIELDS = ['title', 'authors', 'journal', 'year', 'doi', 'keywords', 'abstract', 'background', 'summary', 'innovation'];
// 实证类专属
const EMPIRICAL_FIELDS = ['theory', 'method', 'researchDesign', 'constructs', 'results', 'conclusion', 'criticalThinking'];
// 模型类专属（method/results 与实证共用 key，但语义不同）
const MODEL_FIELDS = ['model', 'method', 'paramDiscussion', 'results'];

// 字段全集（存储用）
export const FIELDS = [...new Set([...COMMON_FIELDS, ...EMPIRICAL_FIELDS, ...MODEL_FIELDS])];

export const FIELD_LABELS = {
  title: '标题', authors: '作者', journal: '期刊/会议', year: '年份', doi: 'DOI',
  abstract: '摘要', keywords: '关键词', background: '研究背景', summary: '一段话总结', innovation: '创新点',
  theory: '理论', method: '研究方法', researchDesign: '研究设计', constructs: '构念',
  results: '实验结果', conclusion: '结论', criticalThinking: '批判性思考',
  model: '模型', paramDiscussion: '参数讨论',
};

// 两套类型对应的可见字段（供前端与提示词使用）
export const TYPE_FIELDS = {
  empirical: [...COMMON_FIELDS, ...EMPIRICAL_FIELDS],
  model: [...COMMON_FIELDS, ...MODEL_FIELDS],
};

// ---------- 提示词 ----------
const COMMON_SPEC = `通用字段（两类文献都需提取）：
- title：论文标题
- authors：作者列表，逗号分隔
- journal：期刊或会议名称
- year：发表年份（4位数字）
- doi：DOI
- keywords：关键词，分号分隔
- abstract：摘要的【中文翻译】（若原文为中文则保留原文，否则翻译成简体中文）
- background：研究背景，分点说明本文要解决的问题与动机
- summary：用一段话（150-250字）概括这篇论文做了什么
- innovation：创新点，本文相比现有工作的独特贡献`;

const EMPIRICAL_SPEC = `实证类专属字段：
- theory：本文所使用的理论是什么（如社会交换理论、资源基础观等），简述该理论及在文中的应用
- method：研究方法，用简洁的分类词描述（如：实验 / 二手数据 / 实验+二手数据 / 问卷调研 / 案例研究 等），并简要说明数据来源
- researchDesign：研究设计，本文分为几个 Study，分别如何设计、每个 Study 的目的是什么
- constructs：构念，本文使用了哪些构念，以及变量之间的关系（谁是自变量、因变量、调节变量、中介变量）
- results：实验结果，主要实验数据与发现
- conclusion：结论，本文的理论贡献是什么、主要结论是什么
- criticalThinking：批判性思考，站在审稿人角度指出这篇论文的缺点与不足，以及可以如何改进`;

const MODEL_SPEC = `模型类专属字段：
- model：本文使用了什么模型（如 CNN、Transformer、博弈论模型等）
- method：本文使用了什么求解方法（如梯度下降、拉格朗日松弛、启发式算法等）
- paramDiscussion：参数讨论，本文分别讨论了哪些参数、为什么这样讨论
- results：实验结果，主要实验数据与发现`;

function buildPrompt(docType, lang) {
  const extra = docType === 'model' ? MODEL_SPEC : EMPIRICAL_SPEC;
  return `请对给定的学术论文全文，提取以下字段，并以严格的 JSON 对象返回（不要包含 markdown 代码块、不要任何额外解释，只返回 JSON）。

${COMMON_SPEC}

${extra}

输出格式要求：
1. 所有字段都返回（没有的字段返回空字符串 ""，不要省略）。
2. background/summary 等需要分点或分段的内容，用 markdown 无序列表（每点以 "- " 开头）分点输出。
3. abstract 必须是中文（翻译结果）；其余内容字段用${lang}撰写，保持学术严谨、精炼、忠实原文，不要编造。

只返回 JSON 对象本身。`;
}

/**
 * 调用 OpenAI 兼容的 Chat Completions 接口（硅基流动 / 其他兼容服务）
 */
async function callLLM(settings, systemPrompt, userContent) {
  const url = (settings.baseURL || '').replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model || 'deepseek-ai/DeepSeek-V4-Flash',
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM 接口返回 ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

function parseJsonLoose(str) {
  let s = (str || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { /* ignore */ }
    }
    throw new Error('LLM 返回内容无法解析为 JSON：' + s.slice(0, 200));
  }
}

function sanitizeField(val) {
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) return val.join(', ');
  if (val == null) return '';
  return String(val);
}

function normalizeResult(obj) {
  const out = {};
  for (const f of FIELDS) out[f] = sanitizeField(obj[f]);
  return out;
}

/**
 * 信息提取主入口
 * @param {string} text 全文文本
 * @param {object} pdfInfo 元信息
 * @param {object} settings 设置（含 aiProvider/apiKey/model/baseURL/language）
 * @param {string} docType 文献类型 'empirical' | 'model'
 */
export async function extract(text, pdfInfo, settings, docType = 'empirical') {
  const useAI = (settings?.aiProvider === 'openai' || settings?.aiProvider === 'siliconflow') && settings?.apiKey;

  if (useAI) {
    const lang = settings.language === 'zh' ? '简体中文' : 'English';
    const systemPrompt = buildPrompt(docType, lang);
    const userContent = text.slice(0, 14000);
    const raw = await callLLM(settings, systemPrompt, userContent);
    const parsed = parseJsonLoose(raw);
    return { ...normalizeResult(parsed), _source: 'ai' };
  }

  // 规则兜底（规则提取不区分类型，抽取公共字段）
  const rules = extractByRules(text, pdfInfo);
  return { ...rules, _source: 'rule' };
}
