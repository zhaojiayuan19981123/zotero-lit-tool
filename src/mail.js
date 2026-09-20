// mail.js —— 邮箱收信（IMAP）/ 发信（SMTP）封装
// 依赖 imapflow（IMAP 客户端）与 mailparser（MIME 解析），支持网易 163/126、QQ、Gmail、Outlook 及自定义服务器。
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

// ---------- 常见邮箱服务商预设（用户只需选服务商 + 填邮箱 + 授权码） ----------
export const MAIL_PROVIDERS = {
  '163': {
    label: '网易 163 邮箱',
    imapHost: 'imap.163.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: true,
    note: '先在网页版邮箱「设置 → POP3/SMTP/IMAP」中开启 IMAP/SMTP 服务，密码请填生成的 16 位授权码（不是网页登录密码）。',
  },
  '126': {
    label: '网易 126 邮箱',
    imapHost: 'imap.126.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.126.com', smtpPort: 465, smtpSecure: true,
    note: '同样需要在网页版开启 IMAP/SMTP 服务，密码填授权码。',
  },
  'yeah': {
    label: '网易 yeah.net',
    imapHost: 'imap.yeah.net', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.yeah.net', smtpPort: 465, smtpSecure: true,
    note: '同样需要在网页版开启 IMAP/SMTP 服务，密码填授权码。',
  },
  'qq': {
    label: 'QQ 邮箱 / Foxmail',
    imapHost: 'imap.qq.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.qq.com', smtpPort: 465, smtpSecure: true,
    note: '网页版「设置 → 账户 → IMAP/SMTP 服务」开启后生成授权码，密码填授权码。',
  },
  'exmail': {
    label: '腾讯企业邮',
    imapHost: 'imap.exmail.qq.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.exmail.qq.com', smtpPort: 465, smtpSecure: true,
    note: '使用企业邮账号密码或客户端专用密码。',
  },
  'gmail': {
    label: 'Gmail',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true,
    note: '需开启两步验证，并使用「应用专用密码」。在部分网络环境下需要代理才能连接。',
  },
  'outlook': {
    label: 'Outlook / Hotmail',
    imapHost: 'outlook.office365.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.office365.com', smtpPort: 587, smtpSecure: false,
    note: '若开启了两步验证，请使用应用密码。',
  },
  'sina': {
    label: '新浪邮箱',
    imapHost: 'imap.sina.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.sina.com', smtpPort: 465, smtpSecure: true,
    note: '需在网页版开启 IMAP/SMTP 服务。',
  },
  'aliyun': {
    label: '阿里云邮箱',
    imapHost: 'imap.aliyun.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.aliyun.com', smtpPort: 465, smtpSecure: true,
    note: '',
  },
  'custom': {
    label: '自定义 / 学校企业邮箱',
    imapHost: '', imapPort: 993, imapSecure: true,
    smtpHost: '', smtpPort: 465, smtpSecure: true,
    note: '请向学校 / 单位信息中心索取 IMAP 与 SMTP 服务器地址及端口。',
  },
};

export function getProvider(key) {
  return MAIL_PROVIDERS[key] || MAIL_PROVIDERS.custom;
}

// ---------- 连接缓存（同一账户复用连接，避免每次操作都重新握手，操作更顺滑） ----------
const CONN_CACHE = new Map(); // accountId -> { client, lastUsed }
const CACHE_IDLE_MS = 5 * 60 * 1000;

function buildClient(account) {
  const opts = {
    host: account.imapHost,
    port: Number(account.imapPort) || 993,
    secure: account.imapSecure !== false,
    auth: { user: account.email, pass: account.password },
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 120000,
    // 网易邮箱强制要求客户端发送 ID 命令，否则会返回「Unsafe Login」
    clientInfo: { name: 'SciTerminal', version: '1.0.0', vendor: 'SciTerminal' },
  };
  if (account.allowSelfSigned) opts.tls = { rejectUnauthorized: false };
  return new ImapFlow(opts);
}

async function openClient(account) {
  const cached = CONN_CACHE.get(account.id);
  if (cached && cached.client.usable) {
    cached.lastUsed = Date.now();
    return cached.client;
  }
  if (cached) {
    CONN_CACHE.delete(account.id);
    try { cached.client.close(); } catch { /* ignore */ }
  }
  const client = buildClient(account);
  const entry = { client, lastUsed: Date.now() };
  // 必须监听 error，否则底层连接异常会导致进程崩溃
  client.on('error', () => {
    if (CONN_CACHE.get(account.id) === entry) CONN_CACHE.delete(account.id);
  });
  client.on('close', () => {
    if (CONN_CACHE.get(account.id) === entry) CONN_CACHE.delete(account.id);
  });
  await client.connect();
  CONN_CACHE.set(account.id, entry);
  return client;
}

export function dropConnection(accountId) {
  const cached = CONN_CACHE.get(accountId);
  if (!cached) return;
  CONN_CACHE.delete(accountId);
  try { cached.client.close(); } catch { /* ignore */ }
}

// 清理闲置连接（由 server 定时调用）
export function pruneConnections() {
  const now = Date.now();
  for (const [id, entry] of CONN_CACHE) {
    if (!entry.client.usable || now - entry.lastUsed > CACHE_IDLE_MS) dropConnection(id);
  }
}

async function withMailbox(account, folder, fn) {
  const client = await openClient(account);
  const lock = await client.getMailboxLock(folder || 'INBOX');
  try {
    return await fn(client);
  } finally {
    try { lock.release(); } catch { /* ignore */ }
  }
}

// ---------- 工具 ----------
function flagsOf(m) {
  if (m?.flags instanceof Set) return Array.from(m.flags);
  if (Array.isArray(m?.flags)) return m.flags;
  return [];
}

function hasAttachment(node) {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  if (Array.isArray(node.childNodes)) return node.childNodes.some(hasAttachment);
  return false;
}

function shapeMessage(m) {
  const env = m.envelope || {};
  const from = (env.from && env.from[0]) || {};
  const flags = flagsOf(m);
  return {
    uid: m.uid,
    subject: env.subject || '(无主题)',
    fromName: from.name || '',
    fromAddress: from.address || '',
    to: (env.to || []).map((x) => x.address).filter(Boolean).join(', '),
    date: env.date ? new Date(env.date).toISOString() : null,
    size: m.size || 0,
    seen: flags.includes('\\Seen'),
    flagged: flags.includes('\\Flagged'),
    hasAttachments: hasAttachment(m.bodyStructure),
  };
}

function addrList(field) {
  if (!field) return '';
  const groups = Array.isArray(field) ? field : [field];
  return groups
    .flatMap((g) => (g && Array.isArray(g.value) ? g.value : []))
    .map((v) => (v.name ? `${v.name} <${v.address}>` : v.address))
    .filter(Boolean)
    .join(', ');
}

export function describeMailError(e) {
  const raw = String(e?.responseText || e?.message || e || '');
  const low = raw.toLowerCase();
  if (/unsafe login/.test(low)) {
    return '网易邮箱拒绝了本次登录：请先在邮箱网页版开启 IMAP/SMTP 服务，并确认密码填的是授权码';
  }
  if (/auth|login|credential|invalid user|password|authenticate/.test(low)) {
    return '登录失败：邮箱地址或授权码不正确（网易 / QQ 邮箱必须使用授权码，不是网页登录密码）';
  }
  if (/certificate|self.signed|altnames|unable to verify/.test(low)) {
    return '服务器证书校验失败：若是学校 / 企业自建邮箱，可在账户设置中勾选「忽略证书校验」';
  }
  if (/etimedout|timeout|econnrefused|enotfound|getaddrinfo|ehostunreach|econnreset|socket|network/.test(low)) {
    return '无法连接邮件服务器：请检查网络、服务器地址与端口是否正确（' + raw + '）';
  }
  if (/nonexistent|no such mailbox|mailbox not found/.test(low)) {
    return '该邮件文件夹不存在或已被重命名，请刷新文件夹列表';
  }
  if (/too many|rate|limit|frequency/.test(low)) {
    return '操作过于频繁，请稍后再试';
  }
  return raw || '未知错误';
}

// ---------- 对外能力 ----------

// 测试连接 + 读取收件箱概况
export async function testAccount(account) {
  const client = await openClient(account);
  const lock = await client.getMailboxLock('INBOX');
  let inbox = 0;
  try { inbox = client.mailbox?.exists || 0; } finally { try { lock.release(); } catch { /* ignore */ } }
  const list = await client.list();
  return { ok: true, inboxMessages: inbox, folderCount: (list || []).length };
}

// 文件夹列表（INBOX / 已发送 / 草稿 / 已删除 / 垃圾邮件 + 用户自建）
export async function listFolders(account) {
  const client = await openClient(account);
  const raw = await client.list();
  const order = { '\\Inbox': 0, '\\Sent': 1, '\\Drafts': 2, '\\Trash': 3, '\\Junk': 4, '\\Archive': 5 };
  return (raw || [])
    .filter((f) => f.path)
    .map((f) => ({
      path: f.path,
      name: f.name || f.path,
      specialUse: f.specialUse || (/^inbox$/i.test(f.path) ? '\\Inbox' : ''),
      flagCount: 0,
    }))
    .sort((a, b) => {
      const oa = order[a.specialUse] ?? 9;
      const ob = order[b.specialUse] ?? 9;
      if (oa !== ob) return oa - ob;
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
}

// 邮件列表（分页；无关键词时走序列号范围，速度最快）
export async function listMessages(account, { folder = 'INBOX', page = 1, pageSize = 30, search = '' } = {}) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(5, parseInt(pageSize, 10) || 30));
  const keyword = String(search || '').trim();
  return withMailbox(account, folder, async (client) => {
    const exists = client.mailbox?.exists || 0;

    if (keyword) {
      let uids = [];
      try {
        uids = await client.search(
          { or: [{ subject: keyword }, { from: keyword }, { to: keyword }] },
          { uid: true }
        );
      } catch {
        uids = await client.search({ subject: keyword }, { uid: true });
      }
      const sorted = (uids || []).slice().sort((a, b) => a - b).reverse();
      const slice = sorted.slice((pg - 1) * size, pg * size);
      const messages = [];
      if (slice.length) {
        for await (const m of client.fetch(slice, { uid: true, envelope: true, flags: true, bodyStructure: true, size: true }, { uid: true })) {
          messages.push(shapeMessage(m));
        }
        messages.sort((a, b) => (b.uid || 0) - (a.uid || 0));
      }
      return { folder, page: pg, pageSize: size, total: sorted.length, exists, messages };
    }

    if (!exists) return { folder, page: pg, pageSize: size, total: 0, exists: 0, messages: [] };

    // 最新的邮件序列号最大，从尾部往前取
    const end = Math.max(1, exists - (pg - 1) * size);
    const start = Math.max(1, end - size + 1);
    if (end < start) return { folder, page: pg, pageSize: size, total: exists, exists, messages: [] };

    const messages = [];
    for await (const m of client.fetch(`${start}:${end}`, { uid: true, envelope: true, flags: true, bodyStructure: true, size: true })) {
      messages.push(shapeMessage(m));
    }
    messages.reverse(); // 新的排前面
    return { folder, page: pg, pageSize: size, total: exists, exists, messages };
  });
}

// 轻量收信检查：只取最新 N 封，用于新邮件提醒 / 未读角标轮询。
// 刻意不拉正文，只取 envelope + flags，单次开销很小。
export async function peekRecent(account, { folder = 'INBOX', limit = 10 } = {}) {
  const n = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
  return withMailbox(account, folder, async (client) => {
    const exists = client.mailbox?.exists || 0;
    if (!exists) return { folder, exists: 0, unseen: 0, latest: [] };
    const start = Math.max(1, exists - n + 1);
    const messages = [];
    for await (const m of client.fetch(`${start}:${exists}`, { uid: true, envelope: true, flags: true }, { uid: true })) {
      messages.push(shapeMessage(m));
    }
    messages.sort((a, b) => (b.uid || 0) - (a.uid || 0));
    return {
      folder,
      exists,
      unseen: messages.filter((m) => !m.seen).length,
      latest: messages.map((m) => ({
        uid: m.uid, subject: m.subject,
        fromName: m.fromName, fromAddress: m.fromAddress,
        date: m.date, seen: m.seen,
      })),
    };
  });
}

// 邮件详情（含正文与附件元数据）
export async function getMessage(account, { folder = 'INBOX', uid }) {  if (!uid) throw new Error('缺少邮件编号');
  return withMailbox(account, folder, async (client) => {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
    if (!msg || !msg.source) throw new Error('邮件不存在或已被删除');
    const parsed = await simpleParser(msg.source);

    const attachments = (parsed.attachments || []).map((a, i) => ({
      index: i,
      filename: a.filename || `附件${i + 1}`,
      contentType: a.contentType || 'application/octet-stream',
      size: a.size || (a.content ? a.content.length : 0),
      inline: !!a.related,
    }));

    let html = parsed.html || '';
    // 把内嵌图片（cid:）替换为内联 data URL，正文里的图片才能显示
    if (html && parsed.attachments?.length) {
      for (const a of parsed.attachments) {
        if (a.cid && a.content && a.content.length < 2 * 1024 * 1024) {
          const cid = String(a.cid).replace(/^<|>$/g, '');
          const dataUrl = `data:${a.contentType || 'image/png'};base64,${a.content.toString('base64')}`;
          html = html.split(`cid:${cid}`).join(dataUrl);
        }
      }
    }

    return {
      uid: Number(uid),
      subject: parsed.subject || '(无主题)',
      fromName: parsed.from?.value?.[0]?.name || '',
      fromAddress: parsed.from?.value?.[0]?.address || '',
      to: addrList(parsed.to),
      cc: addrList(parsed.cc),
      replyTo: parsed.replyTo?.value?.[0]?.address || '',
      date: parsed.date ? new Date(parsed.date).toISOString() : null,
      messageId: parsed.messageId || '',
      html,
      text: parsed.text || '',
      attachments,
      size: msg.source.length,
    };
  });
}

// 附件下载
export async function getAttachment(account, { folder = 'INBOX', uid, index }) {
  const idx = parseInt(index, 10);
  const msg = await withMailbox(account, folder, async (client) => {
    const one = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!one || !one.source) throw new Error('邮件不存在或已被删除');
    return one;
  });
  const parsed = await simpleParser(msg.source);
  const att = (parsed.attachments || [])[idx];
  if (!att || !att.content) throw new Error('该附件不存在');
  return {
    filename: att.filename || `附件${idx + 1}`,
    contentType: att.contentType || 'application/octet-stream',
    content: att.content,
  };
}

// 标记已读 / 未读
export async function setSeen(account, { folder = 'INBOX', uid, seen }) {
  return withMailbox(account, folder, async (client) => {
    if (seen) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    else await client.messageFlagsRemove(String(uid), ['\\Seen'], { uid: true });
    return { ok: true, seen: !!seen };
  });
}

// 将当前文件夹内所有未读邮件一次性标记为已读。只搜索 UID，不下载正文，适合大邮箱。
export async function markAllSeen(account, { folder = 'INBOX' } = {}) {
  return withMailbox(account, folder, async (client) => {
    const uids = await client.search({ seen: false }, { uid: true });
    const list = Array.isArray(uids) ? uids.filter((uid) => Number.isFinite(Number(uid))) : [];
    if (list.length) await client.messageFlagsAdd(list, ['\\Seen'], { uid: true });
    return { ok: true, seen: true, markedCount: list.length };
  });
}

// 删除邮件
export async function deleteMessage(account, { folder = 'INBOX', uid }) {
  return withMailbox(account, folder, async (client) => {
    await client.messageDelete(String(uid), { uid: true });
    return { ok: true };
  });
}

// 发送邮件
export async function sendMail(account, { to, cc, subject, text, html }) {
  if (!account.smtpHost) throw new Error('该账户未配置 SMTP 服务器，无法发信（可在邮箱管理中补填）');
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: Number(account.smtpPort) || 465,
    secure: account.smtpSecure !== false,
    auth: { user: account.email, pass: account.password },
    tls: account.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
  const info = await transporter.sendMail({
    from: account.displayName ? `"${account.displayName}" <${account.email}>` : account.email,
    to: String(to || '').trim(),
    cc: String(cc || '').trim() || undefined,
    subject: String(subject || '(无主题)'),
    text: text || undefined,
    html: html || undefined,
  });
  return { ok: true, messageId: info.messageId };
}
