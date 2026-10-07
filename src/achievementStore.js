// achievementStore.js —— 科研成果管理的数据层（独立于文献中心与学位论文，互不影响）
//
// 为什么再开一个 store 而不塞进 store.js：
//   store.js 已经背了 20 多种数据文件，而成果管理有自己的字段表、文件夹概念、
//   附件清单与解析状态；独立成文件后改动面小、可单独单测，
//   也保证「文献中心 / 学位论文阅读既有行为完全不受影响」。
//
// 数据文件（都在当前数据目录下，随备份 / 迁移 / 导出一起走）：
//   achievements.json          成果记录（含附件清单）
//   achievement-folders.json   自定义文件夹
//
// 文件夹约定：
//   folderId === '' 表示「数据文件夹」—— 一个永远存在的默认文件夹。
//   用户没有自定义文件夹时，新建的成果就落在它里面（不会被丢弃、也不会凭空消失）。

import fs from 'node:fs';
import path from 'node:path';
import * as store from './store.js';
import {
  ALL_TEXT_FIELDS, CATEGORY_KEYS, FILE_KIND_KEYS, STAGE_KEYS, PROGRESS_STATUSES,
  extOf, appHintFor, sanitizePercent,
} from './achievementFields.js';

const ITEMS = 'achievements.json';
const FOLDERS = 'achievement-folders.json';

/** 默认文件夹：id 固定为空串，不需要落盘，也删不掉 */
export const DEFAULT_FOLDER_ID = '';
export const DEFAULT_FOLDER_NAME = '数据文件夹';

/** 前端允许直接改的字段（白名单，filePath 之类绝对不给改） */
export const PATCH_WHITELIST = new Set([
  ...ALL_TEXT_FIELDS,
  'title', 'stage', 'isDraft', 'folderId', 'tags', 'rating',
]);

function file(name) {
  return path.join(store.getDataDir(), name);
}

function load(name, fallback) {
  try {
    const p = file(name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) {
    console.error(`[achievementStore] 读取 ${name} 失败：`, e.message);
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

function str(v, max = 60000) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => String(x ?? '')).filter(Boolean).join(', ').slice(0, max);
  if (typeof v === 'object') return '';
  return String(v).slice(0, max);
}

// ---------------- 记录 ----------------

export function blankAchievement(overrides = {}) {
  const now = new Date().toISOString();
  const category = CATEGORY_KEYS.includes(overrides.category) ? overrides.category : 'paper';
  const base = {
    id: store.newId(),
    category,
    // 'done' = 已完成（已出版发行 / 已授权 / 已获得）；'working' = 进行中（在投 / 申请中）
    stage: STAGE_KEYS.includes(overrides.stage) ? overrides.stage : 'done',
    folderId: DEFAULT_FOLDER_ID,
    // 在投论文：是否只是草稿（用户点了「保存草稿」，字段没填完也先存着）
    isDraft: false,
    // 在投进度
    progressHistory: [],
    // 附件清单：[{ id, kind, originalName, filename, filePath, fileSize, ext, appHint, addedAt }]
    files: [],
    // 解析状态
    status: 'pending', error: '', source: '', parsedAt: '', parseModel: '',
    // 与「论文进度」的关联（同步过去之后记下对方的 id）
    paperId: '', syncedAt: '',
    createdAt: now, updatedAt: now,
  };
  for (const f of ALL_TEXT_FIELDS) base[f] = '';
  const next = { ...base, ...overrides };
  next.category = category;
  next.stage = STAGE_KEYS.includes(next.stage) ? next.stage : 'done';
  next.folderId = typeof next.folderId === 'string' ? next.folderId : DEFAULT_FOLDER_ID;
  next.files = Array.isArray(next.files) ? next.files : [];
  next.progressHistory = normalizeHistory(next.progressHistory);
  if (!PROGRESS_STATUSES.includes(next.progressStatus) && next.progressStatus) next.progressStatus = '';
  return next;
}

function normalizeHistory(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 200).map((h) => ({
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(h?.date || '').slice(0, 10)) ? String(h.date).slice(0, 10) : '',
    status: PROGRESS_STATUSES.includes(h?.status) ? h.status : str(h?.status, 20),
    note: str(h?.note, 500),
  })).filter((h) => h.date || h.status || h.note);
}

function normalizeFile(f) {
  const originalName = str(f?.originalName, 300);
  // ext / appHint 没给就按文件名推出来：调用方漏传时界面仍能显示「通常用 Word 打开」
  const ext = str(f?.ext, 12) || extOf(originalName);
  return {
    id: str(f?.id, 60),
    kind: FILE_KIND_KEYS.includes(f?.kind) ? f.kind : 'other',
    originalName,
    filename: str(f?.filename, 300),
    filePath: str(f?.filePath, 1000),
    fileSize: Math.max(0, Number(f?.fileSize) || 0),
    ext,
    appHint: str(f?.appHint, 40) || appHintFor(originalName),
    addedAt: str(f?.addedAt, 40),
  };
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const next = { ...record };
  next.folderId = typeof next.folderId === 'string' ? next.folderId : DEFAULT_FOLDER_ID;
  next.files = (Array.isArray(next.files) ? next.files : []).map(normalizeFile).filter((f) => f.id && f.filePath);
  next.progressHistory = normalizeHistory(next.progressHistory);
  next.tags = Array.isArray(next.tags) ? next.tags.slice(0, 20).map((t) => str(t, 30)) : str(next.tags, 300);
  next.isDraft = !!next.isDraft;
  return next;
}

export function listAchievements() {
  const db = load(ITEMS, { items: [] });
  const items = Array.isArray(db?.items) ? db.items : [];
  return items.map(normalizeRecord);
}

export function getAchievement(id) {
  const key = str(id, 80).trim();
  if (!key) return null;
  return listAchievements().find((it) => it.id === key) || null;
}

export function upsertAchievement(record) {
  if (!record?.id) throw new Error('缺少成果 id');
  const clean = normalizeRecord({ ...record, updatedAt: new Date().toISOString() });
  const db = load(ITEMS, { items: [] });
  const items = Array.isArray(db?.items) ? db.items : [];
  const idx = items.findIndex((it) => it.id === clean.id);
  if (idx >= 0) items[idx] = { ...items[idx], ...clean };
  else items.unshift({ ...clean, createdAt: clean.createdAt || new Date().toISOString() });
  save(ITEMS, { items });
  return idx >= 0 ? items[idx] : items[0];
}

export function patchAchievement(id, patch) {
  const item = getAchievement(id);
  if (!item) return null;
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!PATCH_WHITELIST.has(k)) continue;
    if (k === 'isDraft') { clean[k] = !!v; continue; }
    if (k === 'rating') { clean[k] = Math.max(0, Math.min(5, Math.round(Number(v) || 0))); continue; }
    if (k === 'progressPercent') { clean[k] = sanitizePercent(v); continue; }
    if (k === 'year') { clean[k] = String(v ?? '').match(/((?:19|20)\d{2})/)?.[1] || ''; continue; }
    if (k === 'tags') {
      clean[k] = Array.isArray(v)
        ? v.slice(0, 20).map((t) => str(t, 30)).filter(Boolean)
        : str(v, 300);
      continue;
    }
    clean[k] = str(v, 60000);
  }
  return upsertAchievement({ ...item, ...clean });
}

export function deleteAchievement(id) {
  const key = str(id, 80).trim();
  const db = load(ITEMS, { items: [] });
  const items = Array.isArray(db?.items) ? db.items : [];
  const target = items.find((it) => it.id === key);
  const next = items.filter((it) => it.id !== key);
  if (next.length === items.length) return { removed: false, files: [] };
  save(ITEMS, { items: next });
  return { removed: true, files: (target?.files || []).map((f) => f.filePath).filter(Boolean) };
}

// ---------------- 附件清单 ----------------

/** 往记录上挂一个附件（返回挂好之后的新记录） */
export function addFile(id, entry) {
  const item = getAchievement(id);
  if (!item) return null;
  const next = normalizeFile({ ...entry, id: entry?.id || store.newId() });
  next.addedAt = next.addedAt || new Date().toISOString();
  return upsertAchievement({ ...item, files: [...item.files, next] });
}

export function removeFile(id, fileId) {
  const item = getAchievement(id);
  if (!item) return null;
  const target = item.files.find((f) => f.id === fileId);
  if (!target) return null;
  const updated = upsertAchievement({ ...item, files: item.files.filter((f) => f.id !== fileId) });
  return { record: updated, removed: target };
}

export function findFile(id, fileId) {
  const item = getAchievement(id);
  if (!item) return null;
  const f = item.files.find((x) => x.id === fileId);
  return f ? { record: item, file: f } : null;
}

// ---------------- 文件夹 ----------------

export function listFolders() {
  const list = load(FOLDERS, []);
  const arr = Array.isArray(list) ? list : [];
  return arr
    .filter((f) => f && f.id)
    .map((f) => ({ id: str(f.id, 60), name: str(f.name, 60), color: str(f.color, 20), createdAt: str(f.createdAt, 40) }));
}

export function saveFolders(list) {
  const next = (Array.isArray(list) ? list : []).slice(0, 200)
    .filter((f) => f && f.id)
    .map((f) => ({ id: str(f.id, 60), name: str(f.name, 60), color: str(f.color, 20), createdAt: str(f.createdAt, 40) }));
  save(FOLDERS, next);
  return next;
}

export function upsertFolder(record) {
  const list = listFolders();
  const idx = list.findIndex((f) => f.id === record.id);
  const now = new Date().toISOString();
  if (idx >= 0) list[idx] = { ...list[idx], ...record };
  else list.push({ ...record, createdAt: now });
  saveFolders(list);
  return list.find((f) => f.id === record.id);
}

/** 删除文件夹：里面的成果回到「数据文件夹」，绝不连带删成果 */
export function deleteFolder(id) {
  const key = str(id, 60).trim();
  if (!key) return false;
  const list = listFolders();
  const next = list.filter((f) => f.id !== key);
  if (next.length === list.length) return false;
  saveFolders(next);
  const db = load(ITEMS, { items: [] });
  const items = Array.isArray(db?.items) ? db.items : [];
  let changed = false;
  const moved = items.map((it) => {
    if (it?.folderId !== key) return it;
    changed = true;
    return { ...it, folderId: DEFAULT_FOLDER_ID };
  });
  if (changed) save(ITEMS, { items: moved });
  return true;
}

/** 文件夹视图：默认「数据文件夹」永远排第一 */
export function listFoldersWithDefault() {
  const counts = folderCounts();
  return [
    { id: DEFAULT_FOLDER_ID, name: DEFAULT_FOLDER_NAME, isDefault: true, count: counts.get(DEFAULT_FOLDER_ID) || 0 },
    ...listFolders().map((f) => ({ ...f, isDefault: false, count: counts.get(f.id) || 0 })),
  ];
}

function folderCounts() {
  const map = new Map();
  for (const it of listAchievements()) {
    const key = it.folderId || DEFAULT_FOLDER_ID;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

// ---------------- 统计 ----------------

export function summary() {
  const items = listAchievements();
  const byCategory = {};
  for (const k of CATEGORY_KEYS) byCategory[k] = 0;
  let files = 0;
  let working = 0;
  let draft = 0;
  let synced = 0;
  for (const it of items) {
    byCategory[it.category] = (byCategory[it.category] || 0) + 1;
    files += it.files.length;
    if (it.stage === 'working') working += 1;
    if (it.isDraft) draft += 1;
    if (it.paperId) synced += 1;
  }
  return {
    total: items.length,
    byCategory,
    files,
    working,
    draft,
    synced,
    folders: listFolders().length,
    parsed: items.filter((it) => it.status === 'done').length,
  };
}

/** 附件元信息里绝对不出现本地磁盘路径 —— 前端只需要「能不能打开 / 叫什么名字」 */
export function publicFile(f) {
  return {
    id: f.id,
    kind: f.kind,
    originalName: f.originalName,
    fileSize: f.fileSize,
    ext: f.ext,
    appHint: f.appHint,
    addedAt: f.addedAt,
  };
}

export function publicRecord(record) {
  return { ...record, files: (record?.files || []).map(publicFile) };
}
