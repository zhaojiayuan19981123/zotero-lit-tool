// store.js —— 轻量 JSON 文件持久化存储（无需数据库，零配置开箱即用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

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
  return loadFile(SETTINGS_FILE, {
    aiProvider: 'siliconflow', // 'siliconflow' | 'openai' | 'none'
    baseURL: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    language: 'zh',
    easyScholarKey: '', // easyScholar 期刊等级查询 SecretKey
    // 划词翻译
    translateProvider: 'siliconflow', // 'siliconflow' | 'deepl' | 'free'
    deeplKey: '', // DeepL API Key
    // 数据保存目录（空 = 使用默认用户数据目录）
    dataDir: '',
    // 新手引导是否已看过（持久化到数据目录，跨启动/跨版本稳定保留）
    onboarded: false,
    // 用户调节的表格列宽 { 列key: 像素 }（持久化到数据目录，跨启动保留）
    colWidths: {},
  });
}

export function saveSettings(settings) {
  saveFile(SETTINGS_FILE, settings);
  return settings;
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
