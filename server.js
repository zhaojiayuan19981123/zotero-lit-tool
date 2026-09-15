// server.js —— Express 后端（可独立运行，也可被 Electron 主进程导入启动）
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractPdfText } from './src/pdfParser.js';
import { extract, FIELDS } from './src/aiExtractor.js';
import * as store from './src/store.js';
import { queryPublicationRank, formatRank } from './src/easyscholar.js';
import { translate } from './src/translate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_UPLOAD_DIR = path.join(__dirname, 'uploads');

// ---------- 中文文件名编码修复 ----------
// multer/busbboy 按 latin1 解码 multipart 的 filename，导致中文变成 "ç..." 乱码。
// 检测到 latin1 高位字符时按 latin1 -> utf8 还原；还原失败或不含中文则保持原样。
function fixFileName(raw) {
  const name = String(raw || '');
  if (!/[\u0080-\u00ff]/.test(name)) return name; // 纯 ASCII，无需处理
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    // 还原结果包含中日韩字符且无替换符 => 认定还原成功
    if (!decoded.includes('\uFFFD') && /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(decoded)) {
      return decoded;
    }
  } catch (_) { /* ignore */ }
  return name;
}

// ---------- 记录构造 ----------
function blankRecord() {
  const record = {
    id: store.newId(),
    originalName: '', filename: '', filePath: '', fileSize: 0,
    numPages: 0,
    status: 'pending',
    error: null,
    source: null,
    docType: 'empirical', // 'empirical' 实证类 | 'model' 模型类
    collectionId: null,   // 所属分类（collections.id，null = 未分类）
    createdAt: new Date().toISOString(),
    parsedAt: null,
    readingProgress: '未阅读',
    rating: 0,
    thumb: null,
    journalRank: '',
    journalRankDetail: [],
    journalRankError: '',
    annotations: [], // PDF 阅读器的高亮与笔记
  };
  for (const key of FIELDS) record[key] = '';
  return record;
}

// ---------- 解析单篇 ----------
async function parseRecord(record, settings, docType) {
  const type = docType || record.docType || 'empirical';
  store.upsertLiterature({ ...record, status: 'parsing', error: null });
  let updated = record;
  try {
    const { text, numPages, info } = await extractPdfText(record.filePath);
    const result = await extract(text, info, settings, type);
    updated = {
      ...record,
      status: 'done',
      numPages,
      source: result._source || null,
      docType: type,
      parsedAt: new Date().toISOString(),
      error: null,
    };
    for (const key of FIELDS) updated[key] = result[key] ?? '';
  } catch (e) {
    updated = { ...record, status: 'error', error: e.message };
    store.upsertLiterature(updated);
    return updated;
  }

  // 解析成功后自动查询期刊等级（若已配置 easyScholar SecretKey 且解析出期刊名）
  if (settings?.easyScholarKey && updated.journal) {
    try {
      const rankData = await queryPublicationRank(updated.journal, settings.easyScholarKey);
      if (rankData?.code === 200) {
        const f = formatRank(rankData.data);
        updated.journalRank = f.summary;
        updated.journalRankDetail = f.items;
        updated.journalRankError = '';
      } else {
        updated.journalRankError = (rankData?.msg || '查询失败');
      }
    } catch (e) {
      updated.journalRankError = e.message;
    }
  }

  store.upsertLiterature(updated);
  return updated;
}

// ---------- 构建应用 ----------
export function createApp({
  uploadDir = DEFAULT_UPLOAD_DIR,
  defaultDataDir = null,   // Electron 默认数据目录（用户「清空目录」时切回这里）
  defaultUploadDir = null, // 默认上传目录
  onDataDirChange = null,  // 数据目录切换成功后的回调（Electron 用于持久化引导配置）
} = {}) {
  let currentUploadDir = uploadDir;
  fs.mkdirSync(currentUploadDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '30mb' }));

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, currentUploadDir),
    filename: (_req, file, cb) => {
      const fixed = fixFileName(file.originalname);
      const safe = fixed.replace(/[\\/:*?"<>|\s]+/g, '_');
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const fixed = fixFileName(file.originalname);
      const isPdf = /\.pdf$/i.test(fixed) || file.mimetype === 'application/pdf';
      if (isPdf) cb(null, true);
      else cb(new Error('ONLY_PDF'));
    },
  });

  // ---------- 数据目录切换（迁移数据与上传文件） ----------
  function notifyDataDirChange(absDir) {
    if (typeof onDataDirChange === 'function') {
      try { onDataDirChange(absDir); } catch (e) { console.error('onDataDirChange 回调失败：', e.message); }
    }
  }

  function switchDataDir(newDataDir) {
    if (!newDataDir) return null;
    const oldDataDir = store.getDataDir();
    const absNew = path.resolve(newDataDir);
    if (absNew === oldDataDir) return null;
    // 切回 Electron 默认目录时，上传目录也回到默认上传目录，保证与下次启动一致
    const isDefault = defaultDataDir && absNew === path.resolve(defaultDataDir);
    const newUploadDir = (isDefault && defaultUploadDir) ? defaultUploadDir : path.join(absNew, 'uploads');
    fs.mkdirSync(absNew, { recursive: true });
    fs.mkdirSync(newUploadDir, { recursive: true });

    // 1) 更新所有记录的 filePath 并复制上传文件
    const items = store.listLiterature();
    for (const it of items) {
      if (it.filePath && fs.existsSync(it.filePath)) {
        const name = path.basename(it.filePath);
        const newPath = path.join(newUploadDir, name);
        if (newPath !== it.filePath) { try { fs.copyFileSync(it.filePath, newPath); } catch (_) { /* ignore */ } }
        it.filePath = newPath;
      }
    }

    // 2) 写新 literature.json 到新目录
    const newDataFile = path.join(absNew, 'literature.json');
    fs.writeFileSync(newDataFile + '.tmp', JSON.stringify({ items }, null, 2), 'utf-8');
    fs.renameSync(newDataFile + '.tmp', newDataFile);

    // 2.5) 迁移分类文件
    try {
      const cols = store.listCollections();
      if (cols.length) {
        const colFile = path.join(absNew, 'collections.json');
        fs.writeFileSync(colFile + '.tmp', JSON.stringify(cols, null, 2), 'utf-8');
        fs.renameSync(colFile + '.tmp', colFile);
      }
    } catch (_) { /* ignore */ }

    // 3) 写新 settings.json 到新目录（更新 dataDir）
    const settings = store.getSettings();
    settings.dataDir = absNew;
    const newSettingsFile = path.join(absNew, 'settings.json');
    fs.writeFileSync(newSettingsFile + '.tmp', JSON.stringify(settings, null, 2), 'utf-8');
    fs.renameSync(newSettingsFile + '.tmp', newSettingsFile);

    // 3.5) 同步旧目录的 settings.json（指向新目录），避免将来回退到旧目录时读到过期配置
    try {
      if (fs.existsSync(oldDataDir)) {
        const oldSettings = JSON.parse(JSON.stringify(settings));
        const oldSettingsFile = path.join(oldDataDir, 'settings.json');
        fs.writeFileSync(oldSettingsFile + '.tmp', JSON.stringify(oldSettings, null, 2), 'utf-8');
        fs.renameSync(oldSettingsFile + '.tmp', oldSettingsFile);
      }
    } catch (_) { /* ignore */ }

    // 4) 切换
    store.configure({ dataDir: absNew });
    currentUploadDir = newUploadDir;
    return absNew;
  }

  // ---------- 批量上传 ----------
  app.post('/api/upload', upload.array('files', 50), async (req, res) => {
    const files = req.files || [];
    const created = [];
    const failed = [];
    const docType = req.body?.docType || 'empirical';
    for (const f of files) {
      try {
        const record = blankRecord();
        record.docType = docType;
        if (req.body?.collectionId) record.collectionId = req.body.collectionId;
        Object.assign(record, {
          originalName: fixFileName(f.originalname),
          filename: f.filename,
          filePath: path.join(currentUploadDir, f.filename),
          fileSize: f.size,
        });
        store.upsertLiterature(record);
        created.push(record);
      } catch (e) {
        failed.push({ name: f.originalname, reason: e.message });
      }
    }
    res.json({ created, failed });
  });

  // ---------- 单篇附件上传 ----------
  app.post('/api/literature/:id/attachment', upload.single('file'), (req, res) => {
    const item = store.getLiterature(req.params.id);
    if (!item) return res.status(404).json({ error: '记录不存在' });
    const f = req.file;
    if (!f) return res.status(400).json({ error: '未收到 PDF 文件' });
    if (item.filePath) { try { fs.unlinkSync(item.filePath); } catch (_) { /* ignore */ } }
    const updated = {
      ...item,
      originalName: fixFileName(f.originalname),
      filename: f.filename,
      filePath: path.join(currentUploadDir, f.filename),
      fileSize: f.size,
      status: 'pending', error: null, source: null, numPages: 0, parsedAt: null,
      journalRank: '', journalRankDetail: [], journalRankError: '',
      annotations: [],
    };
    for (const key of FIELDS) updated[key] = '';
    store.upsertLiterature(updated);
    res.json(updated);
  });

  // ---------- 删除附件 ----------
  app.delete('/api/literature/:id/attachment', (req, res) => {
    const item = store.getLiterature(req.params.id);
    if (!item) return res.status(404).json({ error: '记录不存在' });
    if (item.filePath) { try { fs.unlinkSync(item.filePath); } catch (_) { /* ignore */ } }
    const updated = {
      ...item,
      originalName: '', filename: '', filePath: '', fileSize: 0,
      status: 'pending', error: null, source: null, numPages: 0, parsedAt: null,
      journalRank: '', journalRankDetail: [], journalRankError: '', annotations: [],
    };
    for (const key of FIELDS) updated[key] = '';
    store.upsertLiterature(updated);
    res.json(updated);
  });

  // ---------- 新建空白记录 ----------
  app.post('/api/literature', (req, res) => {
    const record = blankRecord();
    record.title = '未命名文献';
    if (req.body?.docType) record.docType = req.body.docType;
    store.upsertLiterature(record);
    res.json(record);
  });

  // ---------- 解析 ----------
  app.post('/api/parse', async (req, res) => {
    const settings = store.getSettings();
    const docType = req.body?.docType;
    let items = store.listLiterature();
    const ids = req.body?.ids;
    if (Array.isArray(ids) && ids.length) items = items.filter((it) => ids.includes(it.id));
    else items = items.filter((it) => it.status !== 'done' && it.status !== 'parsing');

    const results = [];
    for (const item of items) results.push(await parseRecord(item, settings, docType));
    res.json({ results });
  });

  app.post('/api/literature/:id/parse', async (req, res) => {
    const item = store.getLiterature(req.params.id);
    if (!item) return res.status(404).json({ error: '记录不存在' });
    res.json(await parseRecord(item, store.getSettings(), req.body?.docType));
  });

  // ---------- easyScholar 期刊等级 ----------
  app.post('/api/literature/:id/rank', async (req, res) => {
    const item = store.getLiterature(req.params.id);
    if (!item) return res.status(404).json({ error: '记录不存在' });
    const settings = store.getSettings();
    if (!settings.easyScholarKey) return res.status(400).json({ error: '未配置 easyScholar SecretKey，请在「AI 设置」中填写' });
    const journal = (item.journal || '').trim();
    if (!journal) return res.status(400).json({ error: '该文献未解析出期刊名，无法查询等级' });
    try {
      const data = await queryPublicationRank(journal, settings.easyScholarKey);
      if (data?.code !== 200) {
        const updated = { ...item, journalRankError: data?.msg || '查询失败' };
        store.upsertLiterature(updated);
        return res.status(400).json({ error: 'easyScholar：' + (data?.msg || '查询失败') });
      }
      const f = formatRank(data.data);
      const updated = { ...item, journalRank: f.summary, journalRankDetail: f.items, journalRankError: '' };
      store.upsertLiterature(updated);
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------- 划词翻译 ----------
  app.post('/api/translate', async (req, res) => {
    const text = req.body?.text;
    if (!text || !String(text).trim()) return res.status(400).json({ error: '缺少待翻译文本' });
    try {
      const translation = await translate(String(text), store.getSettings(), { target: req.body?.target });
      res.json({ translation });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ---------- 查询 ----------
  app.get('/api/literature', (_req, res) => res.json(store.listLiterature()));
  app.get('/api/literature/:id', (req, res) => {
    const item = store.getLiterature(req.params.id);
    if (!item) return res.status(404).json({ error: '记录不存在' });
    res.json(item);
  });

  const EDITABLE = [...FIELDS, 'readingProgress', 'rating', 'thumb', 'docType', 'annotations', 'collectionId', 'title'];
  app.patch('/api/literature/:id', (req, res) => {
    const item = store.getLiterature(req.params.id);
    if (!item) return res.status(404).json({ error: '记录不存在' });
    const patch = {};
    for (const k of EDITABLE) if (k in req.body) patch[k] = req.body[k];
    const updated = { ...item, ...patch };
    store.upsertLiterature(updated);
    res.json(updated);
  });

  app.delete('/api/literature/:id', (req, res) => {
    const item = store.getLiterature(req.params.id);
    const ok = store.deleteLiterature(req.params.id);
    if (!ok) return res.status(404).json({ error: '记录不存在' });
    try { if (item?.filePath) fs.unlinkSync(item.filePath); } catch (_) { /* ignore */ }
    res.json({ ok: true });
  });

  // ---------- 文献分类（collections） ----------
  app.get('/api/collections', (_req, res) => res.json(store.listCollections()));

  app.post('/api/collections', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const docType = req.body?.docType === 'model' ? 'model' : 'empirical';
    if (!name) return res.status(400).json({ error: '分类名称不能为空' });
    const list = store.listCollections();
    const col = { id: store.newId(), name, docType, createdAt: new Date().toISOString() };
    list.push(col);
    store.saveCollections(list);
    res.json(col);
  });

  app.patch('/api/collections/:id', (req, res) => {
    const list = store.listCollections();
    const col = list.find((c) => c.id === req.params.id);
    if (!col) return res.status(404).json({ error: '分类不存在' });
    if (req.body?.name) col.name = String(req.body.name).trim() || col.name;
    store.saveCollections(list);
    res.json(col);
  });

  app.delete('/api/collections/:id', (req, res) => {
    const list = store.listCollections();
    const next = list.filter((c) => c.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: '分类不存在' });
    store.saveCollections(next);
    // 该分类下的文献移回「未分类」
    const items = store.listLiterature();
    for (const it of items) {
      if (it.collectionId === req.params.id) store.upsertLiterature({ ...it, collectionId: null });
    }
    res.json({ ok: true });
  });

  // ---------- 个人资料 ----------
  app.get('/api/profile', (_req, res) => res.json(store.getProfile()));
  app.post('/api/profile', (req, res) => {
    const patch = {};
    for (const k of ['name', 'field', 'grade', 'school', 'avatar', 'progress']) {
      if (k in req.body) patch[k] = req.body[k];
    }
    if ('name' in patch) patch.name = String(patch.name).trim().slice(0, 30) || '研究生';
    if ('progress' in patch) patch.progress = Math.max(0, Math.min(100, Number(patch.progress) || 0));
    res.json(store.saveProfile(patch));
  });

  // ---------- 科研项目 ----------
  app.get('/api/projects', (_req, res) => res.json(store.listProjects()));

  app.post('/api/projects', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: '项目名称不能为空' });
    const project = {
      id: store.newId(),
      name,
      advisor: String(req.body?.advisor || '').trim(),   // 导师
      field: String(req.body?.field || '').trim(),        // 研究领域
      startDate: String(req.body?.startDate || ''),       // 开始日期 YYYY-MM-DD
      endDate: String(req.body?.endDate || ''),           // 预计结束
      status: ['进行中', '已完成', '暂停'].includes(req.body?.status) ? req.body.status : '进行中',
      progress: Math.max(0, Math.min(100, Number(req.body?.progress) || 0)),
      description: String(req.body?.description || '').trim(),
      literatureIds: Array.isArray(req.body?.literatureIds) ? req.body.literatureIds : [],
      createdAt: new Date().toISOString(),
    };
    const list = store.listProjects();
    list.unshift(project);
    store.saveProjects(list);
    res.json(project);
  });

  app.patch('/api/projects/:id', (req, res) => {
    const list = store.listProjects();
    const idx = list.findIndex((p) => p.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '项目不存在' });
    const patch = {};
    for (const k of ['name', 'advisor', 'field', 'startDate', 'endDate', 'status', 'progress', 'description']) {
      if (k in req.body) patch[k] = req.body[k];
    }
    if ('progress' in patch) patch.progress = Math.max(0, Math.min(100, Number(patch.progress) || 0));
    if ('status' in patch && !['进行中', '已完成', '暂停'].includes(patch.status)) delete patch.status;
    if (Array.isArray(req.body?.literatureIds)) patch.literatureIds = req.body.literatureIds;
    list[idx] = { ...list[idx], ...patch };
    store.saveProjects(list);
    res.json(list[idx]);
  });

  app.delete('/api/projects/:id', (req, res) => {
    const list = store.listProjects();
    const next = list.filter((p) => p.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: '项目不存在' });
    store.saveProjects(next);
    // 关联任务与实验记录解除项目关联
    store.saveTasks(store.listTasks().map((t) => (t.projectId === req.params.id ? { ...t, projectId: null } : t)));
    store.saveNotes(store.listNotes().map((n) => (n.projectId === req.params.id ? { ...n, projectId: null } : n)));
    res.json({ ok: true });
  });

  // ---------- 任务 ----------
  app.get('/api/tasks', (_req, res) => res.json(store.listTasks()));

  app.post('/api/tasks', (req, res) => {
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: '任务内容不能为空' });
    const task = {
      id: store.newId(),
      title: title.slice(0, 200),
      projectId: req.body?.projectId || null,
      due: /^\d{4}-\d{2}-\d{2}$/.test(req.body?.due || '') ? req.body.due : null,
      priority: ['高', '中', '低'].includes(req.body?.priority) ? req.body.priority : '中',
      status: 'todo', // 'todo' | 'done'
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    const list = store.listTasks();
    list.unshift(task);
    store.saveTasks(list);
    res.json(task);
  });

  app.patch('/api/tasks/:id', (req, res) => {
    const list = store.listTasks();
    const idx = list.findIndex((t) => t.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '任务不存在' });
    const patch = {};
    for (const k of ['title', 'projectId', 'due', 'priority', 'status']) {
      if (k in req.body) patch[k] = req.body[k];
    }
    if ('status' in patch) {
      if (!['todo', 'done'].includes(patch.status)) delete patch.status;
      else patch.completedAt = patch.status === 'done' ? new Date().toISOString() : null;
    }
    list[idx] = { ...list[idx], ...patch };
    store.saveTasks(list);
    res.json(list[idx]);
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const list = store.listTasks();
    const next = list.filter((t) => t.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: '任务不存在' });
    store.saveTasks(next);
    res.json({ ok: true });
  });

  // ---------- 实验记录 ----------
  app.get('/api/notes', (_req, res) => res.json(store.listNotes()));

  app.post('/api/notes', (req, res) => {
    const title = String(req.body?.title || '').trim() || '未命名记录';
    const note = {
      id: store.newId(),
      title: title.slice(0, 120),
      content: String(req.body?.content || ''),
      projectId: req.body?.projectId || null,
      paperId: req.body?.paperId || null,          // 关联小论文
      studyNo: String(req.body?.studyNo || '').trim(), // Study 划分（Study 1 / Study 2…）
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const list = store.listNotes();
    list.unshift(note);
    store.saveNotes(list);
    res.json(note);
  });

  app.patch('/api/notes/:id', (req, res) => {
    const list = store.listNotes();
    const idx = list.findIndex((n) => n.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '记录不存在' });
    const patch = { updatedAt: new Date().toISOString() };
    if ('title' in req.body) patch.title = String(req.body.title).trim().slice(0, 120) || list[idx].title;
    if ('content' in req.body) patch.content = String(req.body.content);
    if ('projectId' in req.body) patch.projectId = req.body.projectId || null;
    if ('paperId' in req.body) patch.paperId = req.body.paperId || null;
    if ('studyNo' in req.body) patch.studyNo = String(req.body.studyNo || '').trim();
    list[idx] = { ...list[idx], ...patch };
    store.saveNotes(list);
    res.json(list[idx]);
  });

  app.delete('/api/notes/:id', (req, res) => {
    const list = store.listNotes();
    const next = list.filter((n) => n.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: '记录不存在' });
    store.saveNotes(next);
    res.json({ ok: true });
  });

  // ---------- 论文管理（小论文投稿流水线 + 大论文阶段进度） ----------
  const JOURNAL_STATUSES = ['构思中', '撰写中', '导师审阅', '投稿中', '初审', '外审', '返修', '复审', '录用', '校样', '已见刊', '拒稿', '撤稿'];
  const THESIS_STAGES = ['选题', '开题', '搭框架', '读文献', '找数据', '实证分析', '撰写初稿', '修改完善', '查重盲审', '答辩'];

  function normalizeHistory(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 60).map((h) => ({
      status: JOURNAL_STATUSES.includes(h?.status) ? h.status : '撰写中',
      date: /^\d{4}-\d{2}-\d{2}$/.test(h?.date || '') ? h.date : new Date().toISOString().slice(0, 10),
      note: String(h?.note || '').slice(0, 300),
    }));
  }
  function normalizeChapters(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 30).map((c) => ({ title: String(c?.title || '').slice(0, 60), done: !!c?.done }));
  }
  function normalizeMilestones(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 20).map((m) => ({
      label: String(m?.label || '').slice(0, 60),
      date: /^\d{4}-\d{2}-\d{2}$/.test(m?.date || '') ? m.date : '',
      done: !!m?.done,
    }));
  }

  app.get('/api/papers', (_req, res) => res.json(store.listPapers()));

  app.post('/api/papers', (req, res) => {
    const kind = req.body?.kind === 'thesis' ? 'thesis' : 'journal';
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: '论文标题不能为空' });
    const paper = {
      id: store.newId(),
      kind,
      title: title.slice(0, 160),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (kind === 'journal') {
      Object.assign(paper, {
        journal: String(req.body?.journal || '').trim().slice(0, 80),
        rank: null, // { summary, items } 由 easyScholar 查询写入
        status: JOURNAL_STATUSES.includes(req.body?.status) ? req.body.status : '撰写中',
        submitDate: /^\d{4}-\d{2}-\d{2}$/.test(req.body?.submitDate || '') ? req.body.submitDate : '',
        revisionDeadline: /^\d{4}-\d{2}-\d{2}$/.test(req.body?.revisionDeadline || '') ? req.body.revisionDeadline : '',
        projectId: req.body?.projectId || null,
        backupJournals: String(req.body?.backupJournals || '').trim().slice(0, 200),
        notes: String(req.body?.notes || '').slice(0, 2000),
        reviewTranslation: String(req.body?.reviewTranslation || '').slice(0, 30000),
        history: normalizeHistory(req.body?.history?.length ? req.body.history : [{ status: paper.status, date: new Date().toISOString().slice(0, 10), note: '创建论文' }]),
      });
    } else {
      Object.assign(paper, {
        degree: ['硕士', '博士'].includes(req.body?.degree) ? req.body.degree : '硕士',
        stage: THESIS_STAGES.includes(req.body?.stage) ? req.body.stage : '选题',
        targetDate: /^\d{4}-\d{2}-\d{2}$/.test(req.body?.targetDate || '') ? req.body.targetDate : '',
        chapters: normalizeChapters(req.body?.chapters),
        milestones: normalizeMilestones(req.body?.milestones),
        notes: String(req.body?.notes || '').slice(0, 2000),
      });
    }
    const list = store.listPapers();
    list.unshift(paper);
    store.savePapers(list);
    res.json(paper);
  });

  app.patch('/api/papers/:id', (req, res) => {
    const list = store.listPapers();
    const idx = list.findIndex((p) => p.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '论文不存在' });
    const cur = list[idx];
    const patch = { updatedAt: new Date().toISOString() };
    if ('title' in req.body) patch.title = String(req.body.title).trim().slice(0, 160) || cur.title;
    if (cur.kind === 'journal') {
      if ('journal' in req.body) {
        const j = String(req.body.journal).trim().slice(0, 80);
        if (j !== cur.journal) { patch.journal = j; patch.rank = null; } // 期刊变了清空等级，需重新查询
      }
      if ('status' in req.body && JOURNAL_STATUSES.includes(req.body.status)) patch.status = req.body.status;
      if ('submitDate' in req.body) patch.submitDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.submitDate) ? req.body.submitDate : '';
      if ('revisionDeadline' in req.body) patch.revisionDeadline = /^\d{4}-\d{2}-\d{2}$/.test(req.body.revisionDeadline) ? req.body.revisionDeadline : '';
      if ('projectId' in req.body) patch.projectId = req.body.projectId || null;
      if ('backupJournals' in req.body) patch.backupJournals = String(req.body.backupJournals).trim().slice(0, 200);
      if ('notes' in req.body) patch.notes = String(req.body.notes).slice(0, 2000);
      if ('reviewTranslation' in req.body) patch.reviewTranslation = String(req.body.reviewTranslation).slice(0, 30000);
      if ('rank' in req.body) patch.rank = req.body.rank && req.body.rank.summary ? { summary: String(req.body.rank.summary), items: Array.isArray(req.body.rank.items) ? req.body.rank.items : [] } : null;
      if (Array.isArray(req.body.history)) patch.history = normalizeHistory(req.body.history);
    } else {
      if ('degree' in req.body && ['硕士', '博士'].includes(req.body.degree)) patch.degree = req.body.degree;
      if ('stage' in req.body && THESIS_STAGES.includes(req.body.stage)) patch.stage = req.body.stage;
      if ('targetDate' in req.body) patch.targetDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.targetDate) ? req.body.targetDate : '';
      if (Array.isArray(req.body.chapters)) patch.chapters = normalizeChapters(req.body.chapters);
      if (Array.isArray(req.body.milestones)) patch.milestones = normalizeMilestones(req.body.milestones);
      if ('notes' in req.body) patch.notes = String(req.body.notes).slice(0, 2000);
    }
    list[idx] = { ...cur, ...patch };
    store.savePapers(list);
    res.json(list[idx]);
  });

  app.delete('/api/papers/:id', (req, res) => {
    const list = store.listPapers();
    const next = list.filter((p) => p.id !== req.params.id);
    if (next.length === list.length) return res.status(404).json({ error: '论文不存在' });
    store.savePapers(next);
    // 关联研究记录解除关联
    store.saveNotes(store.listNotes().map((n) => (n.paperId === req.params.id ? { ...n, paperId: null } : n)));
    res.json({ ok: true });
  });

  // 期刊等级即时查询（供论文管理调用）
  app.get('/api/journal-rank', async (req, res) => {
    const name = String(req.query?.name || '').trim();
    if (!name) return res.status(400).json({ error: '缺少期刊名' });
    const settings = store.getSettings();
    if (!settings.easyScholarKey) return res.status(400).json({ error: '未配置 easyScholar SecretKey，请在「AI 设置」中填写' });
    try {
      const data = await queryPublicationRank(name, settings.easyScholarKey);
      if (data?.code !== 200) return res.status(404).json({ error: 'easyScholar：' + (data?.msg || '未查询到该期刊') });
      res.json(formatRank(data.data));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // ---------- AI 知识库上下文 ----------
  function clipText(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  function buildSystemPrompt(kbQuery) {
    const profile = store.getProfile();
    const projects = store.listProjects();
    const tasks = store.listTasks();
    const notes = store.listNotes();
    const lits = store.listLiterature().filter((i) => i.status === 'done');

    // 按关键词匹配度从知识库挑最相关的文献；无匹配则取最新
    let chosen;
    if (kbQuery) {
      const words = String(kbQuery).toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]+/g) || [];
      const hay = (it) => [it.title, it.keywords, it.summary, it.abstract, it.journal, it.authors, it.innovation, it.model]
        .join(' ').toLowerCase();
      const score = (it) => words.reduce((acc, w) => acc + (hay(it).includes(w) ? 1 : 0), 0);
      const ranked = [...lits].sort((a, b) => score(b) - score(a));
      chosen = ranked.filter((it) => score(it) > 0).slice(0, 12);
      if (!chosen.length) chosen = ranked.slice(0, 12);
    } else {
      chosen = lits.slice(0, 12);
    }

    const litBlock = chosen.length
      ? chosen.map((it, idx) => {
          return `【${idx + 1}】${clipText(it.title, 80) || '（无标题）'} | ${clipText(it.authors, 40) || '佚名'} | ${clipText(it.journal, 40)} ${clipText(it.year, 8)} | ${it.docType === 'model' ? '模型类' : '实证类'}`
            + (it.summary ? `\n  总结：${clipText(it.summary, 160)}` : '')
            + (it.innovation ? `\n  创新点：${clipText(it.innovation, 120)}` : '')
            + (it.method ? `\n  方法：${clipText(it.method, 120)}` : '')
            + (it.model ? `\n  模型：${clipText(it.model, 120)}` : '')
            + (it.conclusion ? `\n  结论：${clipText(it.conclusion, 120)}` : '');
        }).join('\n')
      : '（知识库暂无已解析完成的文献）';

    const projBlock = projects.length
      ? projects.map((p) => `- ${p.name}（${p.status}，进度 ${p.progress}%${p.advisor ? '，导师 ' + p.advisor : ''}${p.endDate ? '，截止 ' + p.endDate : ''}）${p.description ? '：' + clipText(p.description, 100) : ''}`).join('\n')
      : '（暂无项目）';

    const openTasks = tasks.filter((t) => t.status !== 'done');
    const taskBlock = openTasks.length
      ? openTasks.slice(0, 30).map((t) => `- [${t.priority}优先] ${clipText(t.title, 60)}${t.due ? '（截止 ' + t.due + '）' : ''}${t.status === 'todo' ? '' : '（进行中）'}`).join('\n')
      : '（暂无未完成任务）';

    // 论文（小论文投稿 + 大论文进度）
    const allPapers = store.listPapers();
    const recentNotes = notes.slice(0, 6).map((n) => {
      const paper = allPapers.find((p) => p.id === n.paperId);
      const tag = n.studyNo ? `[${n.studyNo}] ` : '';
      return `- ${tag}${clipText(n.title, 40)}${paper ? '（论文：' + clipText(paper.title, 30) + '）' : ''}：${clipText(n.content, 100)}`;
    }).join('\n');

    const journalPapers = allPapers.filter((p) => p.kind === 'journal');
    const theses = allPapers.filter((p) => p.kind === 'thesis');
    const papersBlock = journalPapers.length
      ? journalPapers.slice(0, 15).map((p) => {
          const last = (p.history || [])[p.history.length - 1];
          const rankTxt = p.rank?.summary ? `，期刊等级：${p.rank.summary}` : '';
          const ddlTxt = p.revisionDeadline ? `，返修截止 ${p.revisionDeadline}` : '';
          const noteTxt = last?.note ? `，最近动态：${clipText(last.note, 60)}` : '';
          return `- 《${clipText(p.title, 60)}》投 ${p.journal || '（未定期刊）'}${rankTxt}，当前状态【${p.status}】${p.submitDate ? '，投稿日 ' + p.submitDate : ''}${ddlTxt}${noteTxt}`;
        }).join('\n')
      : '（暂无小论文记录）';
    const thesisBlock = theses.length
      ? theses.map((t) => {
          const chapters = (t.chapters || []);
          const doneN = chapters.filter((c) => c.done).length;
          const ms = (t.milestones || []).filter((m) => m.label).slice(0, 6).map((m) => `${m.label}${m.date ? '(' + m.date + ')' : ''}${m.done ? '✓' : ''}`).join('、');
          return `- ${t.degree || '硕士'}学位论文《${clipText(t.title, 50)}》：当前阶段【${t.stage}】${t.targetDate ? '，计划完成 ' + t.targetDate : ''}，章节进度 ${doneN}/${chapters.length}${ms ? '，节点：' + ms : ''}`;
        }).join('\n')
      : '（暂无大论文记录）';

    return [
      `你是「一站式科研终端」内置的 AI 科研助手（底层模型 DeepSeek），服务于一位硕博研究人员。今天是 ${new Date().toISOString().slice(0, 10)}。`,
      `\n## 用户资料\n姓名：${profile.name || '研究生'}${profile.field ? '；方向：' + profile.field : ''}${profile.grade ? '；' + profile.grade : ''}${profile.school ? '；' + profile.school : ''}`,
      `\n## 进行中的科研项目\n${projBlock}`,
      `\n## 未完成任务\n${taskBlock}`,
      `\n## 小论文投稿状态\n${papersBlock}`,
      `\n## 大论文（学位论文）进度\n${thesisBlock}`,
      `\n## 知识库文献（与问题最相关的摘录，回答时可引用编号）\n${litBlock}`,
      recentNotes ? `\n## 最近研究记录摘录\n${recentNotes}` : '',
      `\n## 回答要求`,
      `- 用简体中文回答；科研问题要具体、可执行，避免空话。`,
      `- 引用用户文献结论时注明编号（如【2】）；知识库没有的内容要说明「知识库中未涉及」。`,
      `- 用户让你构思论文创新点时：结合其文献库与研究缺口，给出 3-5 个候选创新点，并说明每个的可行性、与现有文献的差异、可验证方式。`,
      `- 用户问投稿策略时：结合其小论文当前状态、期刊等级与审稿周期给出主投/备选/转投建议（经管类中文顶刊审稿常达 9-18 个月，返修一般须 30 天内返回）。`,
    ].filter(Boolean).join('\n');
  }

  // ---------- AI 助手（多会话 + 上下文压缩 + DeepSeek 流式对话） ----------
  const COMPRESS_THRESHOLD = 6000; // 会话消息总字数超过此值自动压缩早期对话
  const KEEP_RECENT = 6;           // 压缩时保留最近 N 条原文

  function conversationSummary(c) {
    return {
      id: c.id, title: c.title, updatedAt: c.updatedAt,
      messageCount: (c.messages || []).length,
      compressed: !!c.summary,
    };
  }
  app.get('/api/chat/conversations', (_req, res) => {
    res.json(store.listConversations().map(conversationSummary)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
  });

  app.post('/api/chat/conversations', (_req, res) => {
    const now = new Date().toISOString();
    const conv = { id: store.newId(), title: '新对话', summary: '', messages: [], createdAt: now, updatedAt: now };
    const list = store.listConversations();
    list.unshift(conv);
    store.saveConversations(list);
    res.json(conv);
  });

  app.get('/api/chat/conversations/:id', (req, res) => {
    const conv = store.listConversations().find((c) => c.id === req.params.id);
    if (!conv) return res.status(404).json({ error: '会话不存在' });
    res.json(conv);
  });

  app.patch('/api/chat/conversations/:id', (req, res) => {
    const list = store.listConversations();
    const conv = list.find((c) => c.id === req.params.id);
    if (!conv) return res.status(404).json({ error: '会话不存在' });
    if (typeof req.body?.title === 'string' && req.body.title.trim()) {
      conv.title = req.body.title.trim().slice(0, 40);
      store.saveConversations(list);
    }
    res.json(conversationSummary(conv));
  });

  app.delete('/api/chat/conversations/:id', (req, res) => {
    const list = store.listConversations();
    store.saveConversations(list.filter((c) => c.id !== req.params.id));
    res.json({ ok: true });
  });

  app.delete('/api/chat/history', (_req, res) => { store.saveConversations([]); res.json({ ok: true }); });

  app.post('/api/chat', async (req, res) => {
    const conversationId = String(req.body?.conversationId || '');
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: '缺少对话内容' });
    const settings = store.getSettings();
    if (settings.aiProvider === 'none' || !String(settings.apiKey || '').trim()) {
      return res.status(400).json({ error: '请先在「AI 设置」中填写 API 密钥（硅基流动 DeepSeek）后再使用 AI 助手' });
    }
    const base = (settings.baseURL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
    const convList = store.listConversations();
    const conv = convList.find((c) => c.id === conversationId);
    if (!conv) return res.status(404).json({ error: '会话不存在，请先新建对话' });
    if (!Array.isArray(conv.messages)) conv.messages = [];

    // 记录用户消息；首个消息自动命名会话
    conv.messages.push({ id: store.newId(), role: 'user', content, ts: new Date().toISOString() });
    if (conv.title === '新对话') conv.title = clipText(content, 18) || '新对话';

    // ---- 上下文压缩：总字数超阈值时，把较早的消息摘要化，保留最近 KEEP_RECENT 条原文 ----
    let compressed = false;
    const totalChars = conv.messages.reduce((s, m) => s + String(m.content || '').length, 0);
    if (totalChars > COMPRESS_THRESHOLD && conv.messages.length > KEEP_RECENT + 2) {
      const keep = conv.messages.slice(-KEEP_RECENT);
      const olds = conv.messages.slice(0, -KEEP_RECENT);
      try {
        const sumRes = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({
            model: settings.model || 'deepseek-ai/DeepSeek-V4-Flash',
            messages: [
              { role: 'system', content: '你是对话摘要助手。把用户与 AI 的科研对话压缩成要点摘要：保留已确认的结论、关键数字、论文/项目名称、待办承诺与用户偏好，按条列出，不超过 400 字，用简体中文。' },
              { role: 'user', content: (conv.summary ? '已有早期摘要：\n' + conv.summary + '\n\n请合并以下更早的对话内容，输出更新后的完整摘要：\n' : '请摘要以下科研对话：\n') + olds.map((m) => (m.role === 'user' ? '用户' : 'AI') + '：' + clipText(m.content, 1500)).join('\n') },
            ],
            stream: false,
            max_tokens: 600,
            temperature: 0.2,
          }),
        });
        if (sumRes.ok) {
          const sumData = await sumRes.json().catch(() => ({}));
          const sumText = sumData.choices?.[0]?.message?.content?.trim();
          if (sumText) { conv.summary = clipText(sumText, 1500); conv.messages = keep; compressed = true; }
        }
      } catch (_) { /* 压缩失败不影响本次对话 */ }
    }

    // ---- 流式回复 ----
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let full = '';
    try {
      const llmMsgs = [];
      if (conv.summary) llmMsgs.push({ role: 'system', content: '本会话早期对话的摘要（作为上下文参考，不要重复输出摘要本身）：\n' + conv.summary });
      llmMsgs.push(...conv.messages.slice(-20).map((m) => ({ role: m.role, content: m.content })));
      const up = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model: settings.model || 'deepseek-ai/DeepSeek-V4-Flash',
          messages: [{ role: 'system', content: buildSystemPrompt(content) }, ...llmMsgs],
          stream: true,
          temperature: 0.6,
          max_tokens: 4096,
        }),
      });
      if (!up.ok) {
        const errText = await up.text().catch(() => '');
        res.write(`data: ${JSON.stringify({ error: `AI 接口返回 ${up.status}：${clipText(errText, 300)}` })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const reader = up.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices?.[0]?.delta?.content || '';
            if (delta) { full += delta; res.write(`data: ${JSON.stringify({ delta })}\n\n`); }
          } catch (_) { /* 忽略不完整行 */ }
        }
      }
      if (compressed) res.write(`data: ${JSON.stringify({ compressed: true })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    // 持久化会话（含失败时的用户消息，保证上下文不丢）
    if (full) conv.messages.push({ id: store.newId(), role: 'assistant', content: full, ts: new Date().toISOString() });
    conv.updatedAt = new Date().toISOString();
    try { store.saveConversations(convList); } catch (_) { /* ignore */ }
  });

  // ---------- 审稿意见一键翻译（LLM 整理为逐条中文，忠于原文） ----------
  app.post('/api/translate-review', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: '请先粘贴审稿意见原文' });
    const settings = store.getSettings();
    if (settings.aiProvider === 'none' || !String(settings.apiKey || '').trim()) {
      return res.status(400).json({ error: '请先在「AI 设置」中填写 API 密钥后再使用一键翻译' });
    }
    const base = (settings.baseURL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
    try {
      const up = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model: settings.model || 'deepseek-ai/DeepSeek-V4-Flash',
          messages: [
            {
              role: 'system',
              content: '你是学术论文审稿意见翻译与整理助手。用户会提供一段（通常是英文的）审稿意见，请把它整理成一条一条的简体中文条目。硬性要求：\n' +
                '1. 忠于原文：不得篡改、夸大、弱化、遗漏或自行补充任何内容；每条意见的完整含义、限定条件、语气（含批评的尖锐程度）必须原样保留；\n' +
                '2. 逐条编号输出（1. 2. 3.…），一条独立意见编一个号；某条内部若有多个子要点，用「 - 」缩进列在其下；\n' +
                '3. 意见中提到的术语、变量名、图表编号等保持准确，专业术语首次出现可括注英文原词；\n' +
                '4. 如果原文明显分为多位审稿人（Reviewer #1 等），先输出「审稿人 X」小标题，再在其下逐条编号；\n' +
                '5. 只输出整理后的中文条目，不要输出任何解释、总结、评价或与原文无关的内容。',
            },
            { role: 'user', content: '请整理以下审稿意见：\n\n' + text.slice(0, 12000) },
          ],
          stream: false,
          temperature: 0.2,
          max_tokens: 4096,
        }),
      });
      if (!up.ok) {
        const errText = await up.text().catch(() => '');
        return res.status(502).json({ error: `AI 接口返回 ${up.status}：${clipText(errText, 200)}` });
      }
      const data = await up.json().catch(() => ({}));
      const out = data.choices?.[0]?.message?.content?.trim();
      if (!out) return res.status(502).json({ error: 'AI 未返回有效内容，请稍后重试' });
      res.json({ translation: out });
    } catch (e) {
      res.status(502).json({ error: '翻译请求失败：' + e.message });
    }
  });

  // ---------- 世图科研下载助手：批量导入到文献中心 ----------
  app.post('/api/worldlib/import', (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: '没有可导入的文献' });
    const list = store.listLiterature();
    const existDoi = new Set(list.map((r) => String(r.doi || '').trim().toLowerCase()).filter(Boolean));
    const existTitle = new Set(list.map((r) => String(r.title || '').trim().toLowerCase()).filter(Boolean));
    let imported = 0;
    const records = [];
    const skipped = [];
    for (const it of items.slice(0, 100)) {
      const title = String(it?.title || '').trim().slice(0, 200);
      const url = String(it?.url || '').trim();
      if (!title) continue;
      const doiKey = title.toLowerCase();
      // 去重：DOI（标题即 DOI）或标题已存在则跳过
      if (existDoi.has(doiKey) || existTitle.has(doiKey)) { skipped.push(title); continue; }
      const rec = blankRecord();
      rec.title = title;
      rec.doi = /^10\.\d{4,9}\//.test(title) ? title : '';
      rec.source = 'worldlib';
      rec.worldlibUrl = url.slice(0, 500);
      store.upsertLiterature(rec);
      list.push(rec);
      existTitle.add(doiKey);
      if (rec.doi) existDoi.add(doiKey);
      records.push(rec);
      imported++;
    }
    res.json({ imported, skipped, records });
  });

  // ---------- 设置 ----------
  app.get('/api/settings', (_req, res) => res.json(store.getSettings()));
  app.post('/api/settings', (req, res) => {
    const cur = store.getSettings();
    const next = { ...cur, ...(req.body || {}) };
    const wantsDefault = !String(next.dataDir || '').trim();
    try {
      if (wantsDefault) {
        // 清空目录 = 切回默认数据目录
        if (defaultDataDir && path.resolve(defaultDataDir) !== store.getDataDir()) {
          const abs = switchDataDir(defaultDataDir);
          if (abs) { next.dataDir = ''; notifyDataDirChange(abs); }
        } else {
          next.dataDir = cur.dataDir && path.resolve(cur.dataDir) === store.getDataDir() ? cur.dataDir : '';
        }
      } else if (path.resolve(next.dataDir) !== store.getDataDir()) {
        const abs = switchDataDir(next.dataDir);
        if (abs) { next.dataDir = abs; notifyDataDirChange(abs); }
      }
    } catch (e) {
      return res.status(400).json({ error: '切换保存目录失败：' + e.message });
    }
    res.json(store.saveSettings(next));
  });

  // ---------- 导出 ----------
  function csvEscape(v) {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  app.get('/api/export', (req, res) => {
    const format = (req.query.format || 'csv').toLowerCase();
    const items = store.listLiterature();
    const headers = ['标题', '作者', '期刊/会议', '年份', 'DOI', '摘要', '关键词', '研究背景',
      '一段话总结', '创新点', '理论', '研究方法', '研究设计', '构念', '实验结果', '结论', '批判性思考',
      '模型', '参数讨论', '期刊等级', '阅读进度', '评级', '解析状态', '来源'];
    const fieldMap = ['title', 'authors', 'journal', 'year', 'doi', 'abstract', 'keywords', 'background',
      'summary', 'innovation', 'theory', 'method', 'researchDesign', 'constructs', 'results', 'conclusion', 'criticalThinking',
      'model', 'paramDiscussion'];

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="literature.json"');
      return res.send(JSON.stringify(items, null, 2));
    }

    const lines = [headers.map(csvEscape).join(',')];
    for (const it of items) {
      const row = fieldMap.map((f) => csvEscape(it[f] ?? ''));
      row.push(csvEscape(it.journalRank || ''), csvEscape(it.readingProgress || '未阅读'),
        csvEscape(it.rating || 0), csvEscape(it.status), csvEscape(it.source || ''));
      lines.push(row.join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="literature.csv"');
    res.send('\uFEFF' + lines.join('\r\n'));
  });

  // 静态：上传目录（动态）+ 前端页面
  app.use('/uploads', (req, res, next) => express.static(currentUploadDir)(req, res, next));

  // 上传错误统一处理
  app.use((err, _req, res, next) => {
    if (err) {
      if (err.message === 'ONLY_PDF') return res.status(400).json({ error: '仅支持上传 PDF 文件，请移除其他格式文件后重试' });
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件超过 100MB 大小限制' });
      if (err instanceof multer.MulterError) return res.status(400).json({ error: '文件上传失败：' + err.message });
      return res.status(500).json({ error: '上传失败：' + err.message });
    }
    next();
  });

  return { app, getUploadDir: () => currentUploadDir };
}

// ---------- 启动 ----------
export async function startServer(options = {}) {
  const {
    dataDir, uploadDir, port = 0,
    publicDir = path.join(__dirname, 'public'),
    defaultDataDir, defaultUploadDir, onDataDirChange,
  } = options;
  if (dataDir) store.configure({ dataDir });
  const { app } = createApp({ uploadDir, defaultDataDir, defaultUploadDir, onDataDirChange });

  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use(express.static(publicDir));

  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, app });
    });
  });
}

// ---------- CLI 独立运行 ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  startServer({ port }).then(({ port: p }) => {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │   一站式科研终端 · 已启动                    │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log(`  访问： http://localhost:${p}`);
    console.log('');
  });
}
