// mailRoutes.js —— 邮箱相关 API 路由（账户管理 + 收信 + 发信）
import * as store from './store.js';
import {
  MAIL_PROVIDERS, getProvider, testAccount, listFolders, listMessages, getMessage,
  getAttachment, setSeen, deleteMessage, sendMail, describeMailError, dropConnection, peekRecent,
} from './mail.js';

function publicAccount(a) {
  const { password, ...rest } = a || {};
  return { ...rest, hasPassword: !!password };
}

// 把前端提交的表单与预设服务商合并成完整账户对象
function normalizeAccountInput(body = {}, base = {}) {
  const provider = String(body.provider ?? base.provider ?? '163').trim() || '163';
  const preset = getProvider(provider);
  const email = String(body.email ?? base.email ?? '').trim();
  const password = (body.password === undefined || body.password === '')
    ? (base.password || '')
    : String(body.password);
  const pick = (key) => (body[key] === undefined ? base[key] : body[key]);
  const or = (v, d) => (v === undefined || v === null || v === '' ? d : v);

  return {
    ...base,
    label: String(or(body.label, base.label) || '').trim() || email,
    displayName: String(or(body.displayName, base.displayName) || '').trim(),
    email,
    password,
    provider,
    imapHost: String(or(pick('imapHost'), preset.imapHost) || '').trim(),
    imapPort: Number(or(pick('imapPort'), preset.imapPort)) || 993,
    imapSecure: or(pick('imapSecure'), preset.imapSecure !== false) !== false,
    smtpHost: String(or(pick('smtpHost'), preset.smtpHost) || '').trim(),
    smtpPort: Number(or(pick('smtpPort'), preset.smtpPort)) || 465,
    smtpSecure: or(pick('smtpSecure'), preset.smtpSecure !== false) !== false,
    allowSelfSigned: !!or(pick('allowSelfSigned'), false),
  };
}

function validate(acc) {
  if (!acc.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acc.email)) return '请填写正确的邮箱地址';
  if (!acc.password) return '请填写授权码 / 密码';
  if (!acc.imapHost) return '请填写 IMAP 服务器地址（可在「服务商」处选择预设）';
  return '';
}

export function registerMailRoutes(app) {
  // ---------- 服务商预设（前端渲染下拉与使用提示） ----------
  app.get('/api/mail/providers', (_req, res) => res.json(MAIL_PROVIDERS));

  // ---------- 账户 ----------
  app.get('/api/mail/accounts', (_req, res) => {
    res.json(store.listMailAccounts().map(publicAccount));
  });

  app.post('/api/mail/accounts', (req, res) => {
    const acc = normalizeAccountInput(req.body || {}, {});
    const err = validate(acc);
    if (err) return res.status(400).json({ error: err });
    const dup = store.listMailAccounts().find((a) => a.email === acc.email && a.id !== acc.id);
    if (dup) return res.status(400).json({ error: '该邮箱已经添加过了' });
    acc.id = store.newId();
    acc.createdAt = new Date().toISOString();
    store.upsertMailAccount(acc);
    res.json(publicAccount(acc));
  });

  app.patch('/api/mail/accounts/:id', (req, res) => {
    const base = store.getMailAccount(req.params.id);
    if (!base) return res.status(404).json({ error: '账户不存在' });
    const acc = normalizeAccountInput(req.body || {}, base);
    const err = validate(acc);
    if (err) return res.status(400).json({ error: err });
    dropConnection(acc.id); // 配置变更后重建连接
    store.upsertMailAccount(acc);
    res.json(publicAccount(acc));
  });

  app.delete('/api/mail/accounts/:id', (req, res) => {
    dropConnection(req.params.id);
    const ok = store.deleteMailAccount(req.params.id);
    if (!ok) return res.status(404).json({ error: '账户不存在' });
    res.json({ ok: true });
  });

  // ---------- 连接测试 ----------
  app.post('/api/mail/accounts/:id/test', async (req, res) => {
    const acc = store.getMailAccount(req.params.id);
    if (!acc) return res.status(404).json({ error: '账户不存在' });
    try {
      res.json(await testAccount(acc));
    } catch (e) {
      dropConnection(acc.id);
      res.status(502).json({ error: describeMailError(e) });
    }
  });

  // 未保存前的表单试连（避免用户来回保存调试）
  app.post('/api/mail/test', async (req, res) => {
    const acc = normalizeAccountInput(req.body || {}, {});
    const err = validate(acc);
    if (err) return res.status(400).json({ error: err });
    acc.id = '__probe__';
    try {
      const r = await testAccount(acc);
      dropConnection('__probe__');
      res.json(r);
    } catch (e) {
      dropConnection('__probe__');
      res.status(502).json({ error: describeMailError(e) });
    }
  });

  // ---------- 文件夹 ----------
  app.get('/api/mail/accounts/:id/folders', async (req, res) => {
    const acc = store.getMailAccount(req.params.id);
    if (!acc) return res.status(404).json({ error: '账户不存在' });
    try {
      res.json(await listFolders(acc));
    } catch (e) {
      dropConnection(acc.id);
      res.status(502).json({ error: describeMailError(e) });
    }
  });

  // ---------- 邮件列表 ----------
  app.get('/api/mail/accounts/:id/messages', async (req, res) => {
    const acc = store.getMailAccount(req.params.id);
    if (!acc) return res.status(404).json({ error: '账户不存在' });
    try {
      const data = await listMessages(acc, {
        folder: req.query.folder || 'INBOX',
        page: req.query.page,
        pageSize: req.query.pageSize,
        search: req.query.search || '',
      });
      acc.lastSyncAt = new Date().toISOString();
      store.upsertMailAccount(acc);
      res.json(data);
    } catch (e) {
      dropConnection(acc.id);
      res.status(502).json({ error: describeMailError(e) });
    }
  });

  // ---------- 邮件详情 ----------
  app.get('/api/mail/accounts/:id/messages/:uid', async (req, res) => {
    const acc = store.getMailAccount(req.params.id);
    if (!acc) return res.status(404).json({ error: '账户不存在' });
    try {
      res.json(await getMessage(acc, { folder: req.query.folder || 'INBOX', uid: req.params.uid }));
    } catch (e) {
      res.status(502).json({ error: describeMailError(e) });
    }
  });

  // ---------- 附件下载 ----------
  app.get('/api/mail/accounts/:id/messages/:uid/attachments/:index', async (req, res) => {
    const acc = store.getMailAccount(req.params.id);
    if (!acc) return res.status(404).json({ error: '账户不存在' });
    try {
      const file = await getAttachment(acc, {
        folder: req.query.folder || 'INBOX',
        uid: req.params.uid,
        index: req.params.index,
      });
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition',
        `attachment; filename="${encodeURIComponent(file.filename)}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
      res.send(file.content);
    } catch (e) {
      res.status(502).json({ error: describeMailError(e) });
    }
  });

  // ---------- 标记已读 / 未读 ----------
  app.post('/api/mail/accounts/:id/messages/:uid/seen', async (req, res) => {
    const acc = store.getMailAccount(req.params.id);
    if (!acc) return res.status(404).json({ error: '账户不存在' });
    try {
      const seen = !!(req.body || {}).seen;
      res.json(await setSeen(acc, { folder: (req.body || {}).folder || 'INBOX', uid: req.params.uid, seen }));
    } catch (e) {
      res.status(502).json({ error: describeMailError(e) });
    }
  });

  // ---------- 删除邮件 ----------
  app.delete('/api/mail/accounts/:id/messages/:uid', async (req, res) => {
    const acc = store.getMailAccount(req.params.id);
    if (!acc) return res.status(404).json({ error: '账户不存在' });
    try {
      res.json(await deleteMessage(acc, { folder: req.query.folder || 'INBOX', uid: req.params.uid }));
    } catch (e) {
      res.status(502).json({ error: describeMailError(e) });
    }
  });

  // ---------- 新邮件轮询（前端定时调用，用于弹窗提醒 / 未读角标） ----------
  // 返回所有账户的收件箱概况：最新邮件、未读数、以及「是否有比上次基线更新的邮件」。
  // 前端把自己上次看到的最高 uid 作为 since 传进来，服务端据此判断是否为新邮件，
  // 避免前端自己维护每账户状态、也避免首次加载就弹一堆历史邮件提醒。
  app.get('/api/mail/notify', async (req, res) => {
    const accounts = store.listMailAccounts();
    if (!accounts.length) return res.json({ accounts: [], totalUnread: 0 });

    // since 形如 { [accountId]: uid }，来自前端 localStorage
    let sinceMap = {};
    try {
      const raw = req.query.since;
      if (raw) sinceMap = JSON.parse(String(raw)) || {};
    } catch (_) { sinceMap = {}; }

    const out = [];
    await Promise.all(accounts.map(async (acc) => {
      const folder = acc.notifyFolder || 'INBOX';
      try {
        const info = await peekRecent(acc, { folder, limit: 15 });
        const since = parseInt(sinceMap[acc.id], 10);
        // 未提供基线（首次运行）时视为「不提醒历史邮件」，只记录当前最新 uid
        const baseline = Number.isFinite(since) ? since : (info.latest[0]?.uid || 0);
        const fresh = Number.isFinite(since)
          ? info.latest.filter((m) => (m.uid || 0) > since && !m.seen)
          : [];
        out.push({
          id: acc.id, email: acc.email, label: acc.label || acc.email,
          folder, unseen: info.unseen, exists: info.exists,
          newestUid: info.latest[0]?.uid || 0,
          fresh,
          error: '',
        });
      } catch (e) {
        out.push({ id: acc.id, email: acc.email, label: acc.label || acc.email, folder, error: describeMailError(e) });
      }
    }));
    res.json({
      accounts: out,
      totalUnread: out.reduce((a, x) => a + (x.unseen || 0), 0),
    });
  });

  // ---------- 发信 ----------
  app.post('/api/mail/accounts/:id/send', async (req, res) => {
    const acc = store.getMailAccount(req.params.id);
    if (!acc) return res.status(404).json({ error: '账户不存在' });
    const { to, cc, subject, text, html } = req.body || {};
    if (!String(to || '').trim()) return res.status(400).json({ error: '请填写收件人' });
    try {
      res.json(await sendMail(acc, { to, cc, subject, text, html }));
    } catch (e) {
      res.status(502).json({ error: describeMailError(e) });
    }
  });
}
