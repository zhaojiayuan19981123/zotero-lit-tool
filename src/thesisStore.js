// thesisStore.js —— 学位论文的数据层（独立于文献中心，互不影响）
//
// 为什么单独一个模块而不塞进 store.js：
//   store.js 已经承担了 20 多种数据文件，而学位论文的数据结构、字段白名单、
//   索引缓存目录都自成一体；独立成文件后改动面小、可单独单测，
//   也保证「不动文献中心任何既有行为」这条硬要求。
//
// 数据文件（都在当前数据目录下，随备份/迁移/导出一起走）：
//   theses.json              学位论文记录
//   thesis-collections.json  学位论文分类
//   thesis-quotes.json       摘录素材库
//   thesis-bigpaper.json     关联的大论文信息（框架 / 阶段）
//   thesis-index/<id>.json   章节索引缓存（可重建，不进备份）

import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import { THESIS_AI_FIELDS, THESIS_USER_FIELDS } from './thesisFields.js';

const THESES = 'theses.json';
const COLLECTIONS = 'thesis-collections.json';
const QUOTES = 'thesis-quotes.json';
const BIGPAPER = 'thesis-bigpaper.json';
const INDEX_DIR = 'thesis-index';

/** 前端允许直接改的字段（白名单，防止写坏记录） */
export const PATCH_WHITELIST = new Set([
  ...THESIS_AI_FIELDS, ...THESIS_USER_FIELDS,
  'collectionId', 'readPage', 'lastPage', 'progressLabel', 'progressManual',
  'title', 'note', 'tags',
  // 阅读器里「我的书签」：忘了加进白名单会让 PATCH 被静默丢弃（加书签看着像没反应）
  'bookmarks',
]);

function file(name) {
  return path.join(store.getDataDir(), name);
}

function load(name, fallback) {
  try {
    const p = file(name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error(`[thesisStore] 读取 ${name} 失败：`, e.message);
  }
  return fallback;
}

function save(name, data) {
  const dir = store.getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

// ---------------- 记录 ----------------

export function blankThesis(overrides = {}) {
  const now = new Date().toISOString();
  const base = {
    id: store.newId(),
    // 附件
    originalName: '', filename: '', filePath: '', fileSize: 0,
    numPages: 0, charCount: 0, importedAt: now,
    // 解析状态
    status: 'pending', error: '', source: '', parsedAt: '',
    // 分类
    collectionId: '',
    // 进度（自动维护；progressManual 有值时以用户手改的为准）
    readPage: 0, lastPage: 1, progressManual: '',
    // 阅读器书签（用户自己加的，页码 + 备注）
    bookmarks: [],
    // 索引
    indexStatus: 'none', indexError: '', indexedAt: '', outlineSource: '', outlineCount: 0,
    createdAt: now, updatedAt: now,
  };
  for (const f of THESIS_AI_FIELDS) base[f] = '';
  for (const f of THESIS_USER_FIELDS) base[f] = '';
  return { ...base, ...overrides };
}

export function listTheses() {
  const db = load(THESES, { items: [] });
  return Array.isArray(db?.items) ? db.items : [];
}

export function getThesis(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  return listTheses().find((it) => it.id === key) || null;
}

export function upsertThesis(record) {
  if (!record?.id) throw new Error('缺少论文 id');
  const db = load(THESES, { items: [] });
  const items = Array.isArray(db?.items) ? db.items : [];
  const idx = items.findIndex((it) => it.id === record.id);
  const now = new Date().toISOString();
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...record, updatedAt: now };
  } else {
    items.unshift({ ...record, createdAt: record.createdAt || now, updatedAt: now });
  }
  save(THESES, { items });
  return idx >= 0 ? items[idx] : items[0];
}

export function patchThesis(id, patch) {
  const item = getThesis(id);
  if (!item) return null;
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!PATCH_WHITELIST.has(k)) continue;
    if (k === 'bookmarks') {
      // 只留结构正确的书签，避免把任意对象塞进数据文件
      clean[k] = (Array.isArray(v) ? v : []).slice(0, 200)
        .map((b) => ({
          id: String(b?.id || '').slice(0, 40),
          page: Math.max(1, Math.round(Number(b?.page) || 1)),
          note: String(b?.note || '').slice(0, 300),
        }))
        .filter((b) => b.id);
      continue;
    }
    clean[k] = typeof v === 'string' ? v.slice(0, 60000) : v;
  }
  // 用户手写的两个字段不允许被空值抹掉（前端可能整条提交）
  return upsertThesis({ ...item, ...clean });
}

export function deleteThesis(id) {
  const key = String(id || '').trim();
  const db = load(THESES, { items: [] });
  const items = Array.isArray(db?.items) ? db.items : [];
  const next = items.filter((it) => it.id !== key);
  if (next.length === items.length) return false;
  save(THESES, { items: next });
  removeIndex(key);
  // 素材库里属于这篇的摘录一并清掉，避免留下指向不存在的论文的「孤儿引用」
  const quotes = listQuotes().filter((q) => q.thesisId !== key);
  saveQuotes(quotes);
  return true;
}

/** 阅读进度：以实际读到的页码为准；用户手改过就以手改的为准 */
export function progressOf(record) {
  const total = Math.max(0, Number(record?.numPages) || 0);
  const read = Math.max(0, Number(record?.readPage) || 0);
  const manual = String(record?.progressManual || '').trim();
  if (!total) {
    return { percent: 0, label: manual || (read > 0 ? '阅读中' : '未阅读'), readPage: read, numPages: 0, manual: !!manual };
  }
  const percent = Math.min(100, Math.round((read / total) * 100));
  let label = '未阅读';
  if (read > 0) label = percent >= 95 ? '已阅读' : '阅读中';
  return { percent, label: manual || label, readPage: read, numPages: total, manual: !!manual };
}

// ---------------- 分类 ----------------

export function listCollections() {
  const list = load(COLLECTIONS, []);
  return Array.isArray(list) ? list : [];
}

export function saveCollections(list) {
  const next = (Array.isArray(list) ? list : []).slice(0, 200);
  save(COLLECTIONS, next);
  return next;
}

export function upsertCollection(record) {
  const list = listCollections();
  const idx = list.findIndex((c) => c.id === record.id);
  const now = new Date().toISOString();
  if (idx >= 0) list[idx] = { ...list[idx], ...record, updatedAt: now };
  else list.push({ ...record, createdAt: now, updatedAt: now });
  saveCollections(list);
  return record;
}

/** 删除分类：该分类下的论文回到「未分类」，不连带删论文 */
export function deleteCollection(id) {
  const key = String(id || '').trim();
  const list = listCollections();
  const next = list.filter((c) => c.id !== key);
  if (next.length === list.length) return false;
  saveCollections(next);
  const items = listTheses().map((it) => (it.collectionId === key ? { ...it, collectionId: '' } : it));
  save(THESES, { items });
  return true;
}

// ---------------- 摘录素材库 ----------------

export function listQuotes() {
  const db = load(QUOTES, { items: [] });
  return Array.isArray(db?.items) ? db.items : [];
}

export function saveQuotes(list) {
  const next = (Array.isArray(list) ? list : []).slice(0, 5000);
  save(QUOTES, { items: next });
  return next;
}

export function upsertQuote(quote) {
  const list = listQuotes();
  const idx = list.findIndex((q) => q.id === quote.id);
  const now = new Date().toISOString();
  if (idx >= 0) list[idx] = { ...list[idx], ...quote, updatedAt: now };
  else list.unshift({ ...quote, createdAt: quote.createdAt || now, updatedAt: now });
  saveQuotes(list);
  return idx >= 0 ? list[idx] : list[0];
}

export function deleteQuote(id) {
  const key = String(id || '').trim();
  const list = listQuotes();
  const next = list.filter((q) => q.id !== key);
  if (next.length === list.length) return false;
  saveQuotes(next);
  return true;
}

// ---------------- 关联的大论文 ----------------

export function getBigPaper() {
  const v = load(BIGPAPER, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function saveBigPaper(value) {
  const next = {
    title: String(value?.title || '').slice(0, 300),
    stage: String(value?.stage || '').slice(0, 100),
    framework: String(value?.framework || '').slice(0, 30000),
    notes: String(value?.notes || '').slice(0, 5000),
    updatedAt: new Date().toISOString(),
  };
  save(BIGPAPER, next);
  return next;
}

// ---------------- 章节索引缓存 ----------------

export function getIndexDir() {
  return path.join(store.getDataDir(), INDEX_DIR);
}

export function readIndex(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  try {
    const p = path.join(getIndexDir(), `${key}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error('[thesisStore] 读取索引失败：', e.message);
    return null;
  }
}

export function writeIndex(id, data) {
  const key = String(id || '').trim();
  if (!key) throw new Error('缺少论文 id');
  const dir = getIndexDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${key}.json`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmp, target);
  return target;
}

export function removeIndex(id) {
  const key = String(id || '').trim();
  if (!key) return false;
  try {
    const p = path.join(getIndexDir(), `${key}.json`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  } catch (_) { /* ignore */ }
  return false;
}

/** 统计：首页/看板用 */
export function summary() {
  const items = listTheses();
  const byProgress = { 未阅读: 0, 阅读中: 0, 已阅读: 0 };
  let indexed = 0;
  let pages = 0;
  for (const it of items) {
    const p = progressOf(it);
    if (byProgress[p.label] != null) byProgress[p.label] += 1;
    else byProgress[p.label] = 1;
    if (it.indexStatus === 'ready') indexed += 1;
    pages += Number(it.numPages) || 0;
  }
  return {
    total: items.length,
    byProgress,
    indexed,
    pages,
    quotes: listQuotes().length,
    collections: listCollections().length,
  };
}
