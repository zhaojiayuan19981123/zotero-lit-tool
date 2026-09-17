// store.js —— 轻量 JSON 文件持久化存储（无需数据库，零配置开箱即用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { migrateSettings, syncLegacyFields } from './modelCatalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 数据目录可在启动时通过 configure() 重设（Electron 打包后指向 userData）
let DATA_DIR = path.join(__dirname, '..', 'data');
let DATA_FILE = path.join(DATA_DIR, 'literature.json');
let SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let COLLECTIONS_FILE = path.join(DATA_DIR, 'collections.json');
let PROFILE_FILE = path.join(DATA_DIR, 'profile.json');
let PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
let TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
let NOTES_FILE = path.join(DATA_DIR, 'notes.json');
let CHAT_FILE = path.join(DATA_DIR, 'chat.json');
let PAPERS_FILE = path.join(DATA_DIR, 'papers.json');
let MAIL_FILE = path.join(DATA_DIR, 'mail.json');
let IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
let REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
let MARKDOWN_NOTES_FILE = path.join(DATA_DIR, 'markdown-notes.json');
let CALENDAR_FILE = path.join(DATA_DIR, 'calendar.json');

export function configure({ dataDir }) {
  if (dataDir) {
    DATA_DIR = dataDir;
    DATA_FILE = path.join(DATA_DIR, 'literature.json');
    SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
    COLLECTIONS_FILE = path.join(DATA_DIR, 'collections.json');
    PROFILE_FILE = path.join(DATA_DIR, 'profile.json');
    PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
    TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
    NOTES_FILE = path.join(DATA_DIR, 'notes.json');
    CHAT_FILE = path.join(DATA_DIR, 'chat.json');
    PAPERS_FILE = path.join(DATA_DIR, 'papers.json');
    CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
    MAIL_FILE = path.join(DATA_DIR, 'mail.json');
    IDEAS_FILE = path.join(DATA_DIR, 'ideas.json');
    REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
    MARKDOWN_NOTES_FILE = path.join(DATA_DIR, 'markdown-notes.json');
    CALENDAR_FILE = path.join(DATA_DIR, 'calendar.json');
  }
}

export function getDataDir() {
  return DATA_DIR;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadFile(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (e) {
    console.error(`[store] 读取 ${file} 失败：`, e.message);
  }
  return fallback;
}

function saveFile(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

// ==================== 数据备份（防止重装/升级/误操作丢数据） ====================
// 策略：每次应用启动时做一份快照（zip 不便依赖，改为把关键 JSON 复制到一个带时间戳
// 的子目录），并滚动保留最近 KEEP 份。用户也可在设置里手动导出整包数据。
const BACKUP_DIRNAME = 'backups';
const BACKUP_KEEP = 10; // 最多保留的自动备份份数

/**
 * 所有「用户数据文件」的文件名清单（唯一数据源）。
 * 备份、恢复、导出、数据目录迁移都从这里取，避免各处手写清单而漏文件
 * —— 历史上就出现过漏搬 mail.json/tasks.json/projects.json 导致重装后配置消失。
 * 新增数据文件时只需要加到 ALL_DATA_FILES，其他功能自动跟上。
 */
const ALL_DATA_FILES = [
  'literature.json',    // 文献
  'settings.json',      // 全部设置（含多模型配置、主题、字体、数据目录）
  'collections.json',   // 文献分类
  'profile.json',       // 个人资料
  'projects.json',      // 项目管理
  'tasks.json',         // 任务安排 / 待办
  'notes.json',         // 研究记录
  'chat.json',          // AI 助手会话数据
  'papers.json',        // 论文进度
  'mail.json',          // 邮箱账户与设置
  'ideas.json',         // 灵感孵化
  'reviews.json',       // 模拟审稿
  'markdown-notes.json', // Markdown 笔记
  'conversations.json', // AI 助手会话列表
  'calendar.json',      // 科研日历
  'worldlib.json',      // 世图下载助手历史
];

export function dataFileNames() {
  // store.js 内的路径变量是权威来源；ALL_DATA_FILES 兜底覆盖「表里有但变量还没建」的情况
  const known = new Set(ALL_DATA_FILES);
  for (const f of [DATA_FILE, SETTINGS_FILE, COLLECTIONS_FILE, PROFILE_FILE, PROJECTS_FILE,
    TASKS_FILE, NOTES_FILE, CHAT_FILE, PAPERS_FILE, MAIL_FILE, IDEAS_FILE, REVIEWS_FILE, MARKDOWN_NOTES_FILE,
    CALENDAR_FILE, CONVERSATIONS_FILE]) {
    if (f) known.add(path.basename(f));
  }
  return [...known];
}

// 数据目录下「除备份外」的全部数据文件绝对路径（存在 + 不存在都给，交由调用方判断）
export function dataFilePaths() {
  return dataFileNames().map((f) => path.join(DATA_DIR, f));
}

export function getBackupDir() {
  return path.join(DATA_DIR, BACKUP_DIRNAME);
}

// 需要纳入备份的文件（存在才复制）
function backupFileList() {
  return dataFilePaths().filter((f) => f && fs.existsSync(f));
}

// 生成一份时间戳备份目录，返回目录路径（无数据可备份时返回 null）
export function createBackup(label = 'auto') {
  try {
    const files = backupFileList();
    if (!files.length) return null;
    ensureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(getBackupDir(), `${stamp}_${label}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) {
      try { fs.copyFileSync(f, path.join(dir, path.basename(f))); } catch (_) { /* 单个失败不影响其他 */ }
    }
    // 同时把上传的 PDF 目录复制一份（文献附件丢失同样很致命），体积大所以单独 try
    const uploads = path.join(DATA_DIR, 'uploads');
    if (fs.existsSync(uploads)) {
      try { fs.cpSync(uploads, path.join(dir, 'uploads'), { recursive: true }); } catch (_) { /* 忽略 */ }
    }
    pruneBackups();
    return dir;
  } catch (e) {
    console.error('[store] 创建备份失败：', e.message);
    return null;
  }
}

// 只保留最近 BACKUP_KEEP 份自动备份
function pruneBackups() {
  try {
    const root = getBackupDir();
    if (!fs.existsSync(root)) return;
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(); // 时间戳前缀，字典序即时间序
    while (dirs.length > BACKUP_KEEP) {
      const victim = dirs.shift();
      try { fs.rmSync(path.join(root, victim), { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    }
  } catch (e) {
    console.error('[store] 清理旧备份失败：', e.message);
  }
}

export function listBackups() {
  try {
    const root = getBackupDir();
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const full = path.join(root, d.name);
        let size = 0;
        try {
          size = fs.readdirSync(full).reduce((a, n) => {
            const st = fs.statSync(path.join(full, n));
            return a + (st.isFile() ? st.size : 0);
          }, 0);
        } catch (_) { /* 忽略 */ }
        return { name: d.name, path: full, size };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  } catch (_) { return []; }
}

// 从指定备份目录恢复：把其中的 JSON 覆写回数据目录（恢复前会先备份当前状态）
export function restoreBackup(name) {
  const dir = path.join(getBackupDir(), String(name || ''));
  if (!name || !fs.existsSync(dir)) throw new Error('备份不存在');
  createBackup('before-restore'); // 恢复前先留一手，避免恢复错版本无法回退
  let n = 0;
  // 恢复备份里出现的所有 .json（而不是固定清单），这样老备份里的新文件也能还原
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { fs.copyFileSync(path.join(dir, f), path.join(DATA_DIR, f)); n++; } catch (_) { /* 忽略 */ }
  }
  const up = path.join(dir, 'uploads');
  if (fs.existsSync(up)) {
    try { fs.cpSync(up, path.join(DATA_DIR, 'uploads'), { recursive: true }); } catch (_) { /* 忽略 */ }
  }
  return n;
}

// 导出整包数据为单个对象（便于用户自己另存 / 迁移到别的电脑）
// 按文件名自动收集，新增数据文件不必再改这里。
export function exportAll() {
  const out = {
    exportedAt: new Date().toISOString(),
    version: 2,
    dataDir: DATA_DIR,
    files: {},
  };
  for (const name of dataFileNames()) {
    const p = path.join(DATA_DIR, name);
    try {
      if (fs.existsSync(p)) out.files[name] = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (_) { /* 单个文件坏了不影响整包导出 */ }
  }
  // 兼容旧结构：同时把常用字段平铺一份，老版本导入逻辑仍能识别
  const alias = {
    literature: 'literature.json', settings: 'settings.json', collections: 'collections.json',
    profile: 'profile.json', projects: 'projects.json', tasks: 'tasks.json', notes: 'notes.json',
    chat: 'chat.json', papers: 'papers.json', conversations: 'conversations.json', mail: 'mail.json',
    ideas: 'ideas.json', reviews: 'reviews.json', markdownNotes: 'markdown-notes.json', calendar: 'calendar.json',
  };
  for (const [k, f] of Object.entries(alias)) out[k] = out.files[f] ?? null;
  return out;
}

// ---------- 文献记录 ----------
export function listLiterature() {
  const db = loadFile(DATA_FILE, { items: [] });
  return db.items || [];
}

export function getLiterature(id) {
  return listLiterature().find((it) => it.id === id) || null;
}

export function upsertLiterature(record) {
  const db = loadFile(DATA_FILE, { items: [] });
  const idx = db.items.findIndex((it) => it.id === record.id);
  if (idx >= 0) {
    db.items[idx] = { ...db.items[idx], ...record };
  } else {
    db.items.unshift(record); // 新纪录放最前
  }
  saveFile(DATA_FILE, db);
  return record;
}

export function deleteLiterature(id) {
  const db = loadFile(DATA_FILE, { items: [] });
  const before = db.items.length;
  db.items = db.items.filter((it) => it.id !== id);
  saveFile(DATA_FILE, db);
  return before !== db.items.length;
}

export function newId() {
  return crypto.randomUUID();
}

// ---------- 文献分类（collections） ----------
export function listCollections() {
  return loadFile(COLLECTIONS_FILE, []);
}

export function saveCollections(list) {
  saveFile(COLLECTIONS_FILE, Array.isArray(list) ? list : []);
  return list;
}

// ---------- 设置 ----------
export function getSettings() {
  const raw = loadFile(SETTINGS_FILE, {
    aiProvider: 'siliconflow', // 'siliconflow' | 'openai' | 'none'
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    // ---- 多模型配置：可保存多条（供应商 / Base URL / Key / 模型名），任选其一为激活 ----
    modelProfiles: [],
    activeProfileId: '',
    // 「两段式看图」：当前模型不支持图片时，先用这条（视觉模型）把图描述成文字再回答。
    // 留空则自动挑一个已配置且支持视觉的模型兜底。
    visionProfileId: '',
    language: 'zh',
    easyScholarKey: '', // easyScholar 期刊等级查询 SecretKey
    // 划词翻译
    translateProvider: 'siliconflow', // 'siliconflow' | 'deepl' | 'free'
    deeplKey: '', // DeepL API Key
    // 数据保存目录（空 = 使用默认用户数据目录）
    dataDir: '',
    // 新手引导是否已看过（持久化到数据目录，跨启动/跨版本稳定保留）
    onboarded: false,
    onboardingVersion: 0,
    // 用户调节的表格列宽 { 列key: 像素 }（持久化到数据目录，跨启动保留）
    colWidths: {},
  });
  // 老版本的 settings.json 里没有 modelProfiles。这里做一次就地迁移，
  // 迁移结果只返回给调用方，落盘交给 saveSettings（避免读接口产生副作用）。
  const migrated = migrateSettings(raw);
  return migrated;
}

export function saveSettings(settings) {
  const next = syncLegacyFields(migrateSettings(settings));
  saveFile(SETTINGS_FILE, next);
  return next;
}

// ---------- 个人资料（用户名等） ----------
export function getProfile() {
  return loadFile(PROFILE_FILE, {
    name: '研究生',   // 用户名（可修改）
    field: '',        // 专业方向
    grade: '',        // 年级（如 硕士二年级）
    school: '',       // 学校/院系
    avatar: '🎓',     // 头像 emoji
    progress: 0,      // 学业进度 0-100（手动设定）
  });
}

export function saveProfile(profile) {
  const merged = { ...getProfile(), ...profile };
  saveFile(PROFILE_FILE, merged);
  return merged;
}

// ---------- 科研项目 ----------
export function listProjects() {
  return loadFile(PROJECTS_FILE, []);
}

export function saveProjects(list) {
  saveFile(PROJECTS_FILE, Array.isArray(list) ? list : []);
  return list;
}

// ---------- 任务 ----------
export function listTasks() {
  return loadFile(TASKS_FILE, []);
}

export function saveTasks(list) {
  saveFile(TASKS_FILE, Array.isArray(list) ? list : []);
  return list;
}

// ---------- 实验记录 ----------
export function listNotes() {
  return loadFile(NOTES_FILE, []);
}

export function saveNotes(list) {
  saveFile(NOTES_FILE, Array.isArray(list) ? list : []);
  return list;
}

// ---------- 灵感孵化 ----------
export function listIdeas() {
  return loadFile(IDEAS_FILE, []);
}

export function getIdea(id) {
  return listIdeas().find((idea) => idea.id === id) || null;
}

export function saveIdeas(list) {
  saveFile(IDEAS_FILE, Array.isArray(list) ? list : []);
  return list;
}

export function upsertIdea(idea) {
  const list = listIdeas();
  const idx = list.findIndex((item) => item.id === idea.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...idea };
  else list.unshift(idea);
  saveIdeas(list);
  return idx >= 0 ? list[idx] : idea;
}

export function deleteIdea(id) {
  const list = listIdeas();
  const next = list.filter((idea) => idea.id !== id);
  if (next.length === list.length) return false;
  saveIdeas(next);
  return true;
}

// ---------- 模拟审稿 ----------
export function listReviews() {
  return loadFile(REVIEWS_FILE, []);
}

export function getReview(id) {
  return listReviews().find((review) => review.id === id) || null;
}

export function saveReviews(list) {
  saveFile(REVIEWS_FILE, Array.isArray(list) ? list : []);
  return list;
}

export function upsertReview(review) {
  const list = listReviews();
  const idx = list.findIndex((item) => item.id === review.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...review };
  else list.unshift(review);
  saveReviews(list);
  return idx >= 0 ? list[idx] : review;
}

export function deleteReview(id) {
  const list = listReviews();
  const next = list.filter((review) => review.id !== id);
  if (next.length === list.length) return false;
  saveReviews(next);
  return true;
}

// ---------- Markdown 笔记 ----------
export function listMarkdownNotes() {
  return loadFile(MARKDOWN_NOTES_FILE, []);
}

export function getMarkdownNote(id) {
  return listMarkdownNotes().find((note) => note.id === id) || null;
}

export function saveMarkdownNotes(list) {
  saveFile(MARKDOWN_NOTES_FILE, Array.isArray(list) ? list : []);
  return list;
}

export function upsertMarkdownNote(note) {
  const list = listMarkdownNotes();
  const idx = list.findIndex((item) => item.id === note.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...note };
  else list.unshift(note);
  saveMarkdownNotes(list);
  return idx >= 0 ? list[idx] : note;
}

export function deleteMarkdownNote(id) {
  const list = listMarkdownNotes();
  const next = list.filter((note) => note.id !== id);
  if (next.length === list.length) return false;
  saveMarkdownNotes(next);
  return true;
}

// ---------- 自定义日历事件 / 历法显示设置 ----------
export function getCalendar() {
  const value = loadFile(CALENDAR_FILE, { events: [], preferences: { lunar: true, solarTerms: true, festivals: true } });
  return {
    events: Array.isArray(value?.events) ? value.events : [],
    preferences: { lunar: true, solarTerms: true, festivals: true, ...(value?.preferences || {}) },
  };
}

export function saveCalendar(value) {
  const next = {
    events: Array.isArray(value?.events) ? value.events : [],
    preferences: { lunar: true, solarTerms: true, festivals: true, ...(value?.preferences || {}) },
  };
  saveFile(CALENDAR_FILE, next);
  return next;
}

// ---------- AI 助手多会话 ----------
let CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');

export function listConversations() {
  let list = loadFile(CONVERSATIONS_FILE, null);
  if (list === null) {
    // 迁移：旧版 chat.json（扁平消息数组）转为单个历史会话
    const legacy = loadFile(CHAT_FILE, null);
    list = [];
    if (Array.isArray(legacy) && legacy.length) {
      list.push({
        id: newId(),
        title: '历史对话',
        summary: '',
        messages: legacy,
        createdAt: legacy[0]?.ts || new Date().toISOString(),
        updatedAt: legacy[legacy.length - 1]?.ts || new Date().toISOString(),
      });
    }
    saveFile(CONVERSATIONS_FILE, list);
  }
  if (!Array.isArray(list)) list = [];
  return list;
}

export function saveConversations(list) {
  saveFile(CONVERSATIONS_FILE, Array.isArray(list) ? list : []);
  return list;
}

// ---------- 论文管理（小论文 / 大论文） ----------
export function listPapers() {
  return loadFile(PAPERS_FILE, []);
}

export function savePapers(list) {
  saveFile(PAPERS_FILE, Array.isArray(list) ? list : []);
  return list;
}

// ---------- 邮箱账户 ----------
// 结构：{ accounts: [ { id, label, email, password, provider, imapHost, imapPort, imapSecure,
//                     smtpHost, smtpPort, smtpSecure, allowSelfSigned, createdAt, lastSyncAt } ] }
export function listMailAccounts() {
  const db = loadFile(MAIL_FILE, { accounts: [] });
  return Array.isArray(db?.accounts) ? db.accounts : [];
}

export function saveMailAccounts(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  saveFile(MAIL_FILE, { accounts: list });
  return list;
}

export function getMailAccount(id) {
  return listMailAccounts().find((a) => a.id === id) || null;
}

export function upsertMailAccount(acc) {
  const list = listMailAccounts();
  const idx = list.findIndex((a) => a.id === acc.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...acc };
  else list.push(acc);
  saveMailAccounts(list);
  return acc;
}

export function deleteMailAccount(id) {
  const list = listMailAccounts();
  const next = list.filter((a) => a.id !== id);
  saveMailAccounts(next);
  return next.length !== list.length;
}
