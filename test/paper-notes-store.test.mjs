import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server.js';
import * as store from '../src/store.js';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const json = (res) => res.json();

// ---------------------------------------------------------------------------
// store 层
// ---------------------------------------------------------------------------

test('笔记与对话按文献 id 持久化，且两种视图互不覆盖', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-paper-note-'));
  const dataDir = path.join(root, 'data');
  try {
    store.configure({ dataDir });

    // 一本文献：先只存 Markdown
    store.savePaperNote({ litId: 'lit-A', md: '# 笔记\n\n- 要点' });
    let note = store.getPaperNote('lit-A');
    assert.equal(note.md, '# 笔记\n\n- 要点');
    assert.ok(note.createdAt && note.updatedAt);

    // 再存思维导图，md 必须原样保留（两种视图是同一份笔记）
    const mindmap = { data: { text: '中心主题' }, children: [{ data: { text: '分支' }, children: [] }] };
    store.savePaperNote({ litId: 'lit-A', mindmap });
    note = store.getPaperNote('lit-A');
    assert.equal(note.md, '# 笔记\n\n- 要点', '存导图不应清掉 Markdown');
    assert.equal(note.mindmap.data.text, '中心主题');

    // 反过来：改 md 不应清掉导图
    store.savePaperNote({ litId: 'lit-A', md: '改过的笔记' });
    note = store.getPaperNote('lit-A');
    assert.equal(note.md, '改过的笔记');
    assert.equal(note.mindmap.data.text, '中心主题', '改 Markdown 不应清掉导图');

    // 另一本文献互不干扰
    store.savePaperNote({ litId: 'lit-B', md: '另一篇' });
    assert.equal(store.listPaperNotes().length, 2);
    assert.equal(store.getPaperNote('lit-B').md, '另一篇');
    assert.equal(store.getPaperNote('lit-A').md, '改过的笔记');

    // 重复保存是 upsert，不新增记录
    store.savePaperNote({ litId: 'lit-A', md: '再改一次' });
    assert.equal(store.listPaperNotes().length, 2);

    // 缺失 litId 直接报错，避免写出脏数据
    assert.throws(() => store.savePaperNote({ md: 'x' }), /文献标识/);

    // 删除只影响目标文献
    assert.equal(store.deletePaperNote('lit-A'), true);
    assert.equal(store.deletePaperNote('lit-A'), false, '重复删除返回 false');
    assert.equal(store.getPaperNote('lit-A'), null);
    assert.equal(store.getPaperNote('lit-B').md, '另一篇');

    // 确实落盘成文件
    const raw = JSON.parse(await readFile(path.join(dataDir, 'paper-notes.json'), 'utf8'));
    assert.ok(Array.isArray(raw));
    assert.deepEqual(raw.map((r) => r.litId), ['lit-B']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('AI 对话按文献持久化，退出重进后仍在', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-paper-chat-'));
  const dataDir = path.join(root, 'data');
  try {
    store.configure({ dataDir });

    store.savePaperChat('lit-A', [
      { role: 'user', content: '这篇文章的方法是什么？' },
      { role: 'assistant', content: '它用了对比学习。' },
    ]);
    let chat = store.getPaperChat('lit-A');
    assert.equal(chat.messages.length, 2);
    assert.equal(chat.messages[0].role, 'user');

    // 追加一条（前端每次整体覆盖）
    store.savePaperChat('lit-A', [...chat.messages, { role: 'user', content: '有没有局限？' }]);
    assert.equal(store.getPaperChat('lit-A').messages.length, 3);

    // 另一本文献独立
    store.savePaperChat('lit-B', [{ role: 'user', content: 'B 的问题' }]);
    assert.equal(store.listPaperChats().length, 2);
    assert.equal(store.getPaperChat('lit-A').messages.length, 3);

    // 传非数组时落成空数组而不是崩掉
    store.savePaperChat('lit-A', 'not-an-array');
    assert.deepEqual(store.getPaperChat('lit-A').messages, []);

    assert.throws(() => store.savePaperChat('', []), /文献标识/);

    // 清除记录
    assert.equal(store.deletePaperChat('lit-A'), true);
    assert.equal(store.getPaperChat('lit-A'), null);
    assert.equal(store.getPaperChat('lit-B').messages.length, 1);

    const raw = JSON.parse(await readFile(path.join(dataDir, 'paper-chats.json'), 'utf8'));
    assert.deepEqual(raw.map((r) => r.litId), ['lit-B']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP 端点
// ---------------------------------------------------------------------------

test('笔记与对话 HTTP 端点支持读写与清除', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-paper-api-'));
  const dataDir = path.join(root, 'data');
  let server;
  try {
    store.configure({ dataDir });
    server = createServer(createApp({ uploadDir: path.join(root, 'uploads') }).app);
    const base = await listen(server);

    // 空态
    let res = await fetch(`${base}/api/paper-notes/lit-1`);
    assert.equal(res.status, 200);
    let body = await json(res);
    assert.equal(body.litId, 'lit-1');
    assert.equal(body.md, '');

    // 写入 Markdown
    res = await fetch(`${base}/api/paper-notes/lit-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ md: '# 标题\n\n正文' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).ok, true);

    // 只写导图，Markdown 不能被清掉（部分更新语义）
    res = await fetch(`${base}/api/paper-notes/lit-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mindmap: { data: { text: '根' }, children: [] } }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${base}/api/paper-notes/lit-1`);
    body = await json(res);
    assert.equal(body.md, '# 标题\n\n正文', '只传 mindmap 不应清空 md');
    assert.equal(body.mindmap.data.text, '根');

    // 两个字段都不传 → 400，避免无意义写入
    res = await fetch(`${base}/api/paper-notes/lit-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);

    // 清除笔记
    res = await fetch(`${base}/api/paper-notes/lit-1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).removed, true);

    // ---- 对话 ----
    res = await fetch(`${base}/api/paper-chat/lit-1`);
    assert.equal(res.status, 200);
    assert.deepEqual((await json(res)).messages, []);

    res = await fetch(`${base}/api/paper-chat/lit-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'user', content: '问题一' },
          { role: 'assistant', content: '回答一' },
          { role: 'system', content: '不该被保留的角色' },
          { role: 'user', content: '' },
          'not-an-object',
        ],
      }),
    });
    assert.equal(res.status, 200);
    const putBody = await json(res);
    assert.equal(putBody.count, 2, '只保留合法且非空的消息');

    res = await fetch(`${base}/api/paper-chat/lit-1`);
    body = await json(res);
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant']);

    res = await fetch(`${base}/api/paper-chat/lit-1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal((await json(res)).removed, true);

    res = await fetch(`${base}/api/paper-chat/lit-1`);
    assert.deepEqual((await json(res)).messages, []);
  } finally {
    if (server) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('笔记与对话文件已纳入备份与导出清单', async () => {
  const source = await readFile(new URL('../src/store.js', import.meta.url), 'utf8');
  assert.match(source, /'paper-notes\.json'/);
  assert.match(source, /'paper-chats\.json'/);
});

// ---------------------------------------------------------------------------
// 附件上传 / 删除：只清解析字段，不能抹掉用户填的 title
// （title 被抹掉会让导图根节点退化成文件名、AI 上下文丢标题）
// ---------------------------------------------------------------------------

/** 造一份最小合法 PDF */
function tinyPdf() {
  const content = 'BT /F1 12 Tf 40 700 Td (Hello) Tj ET';
  const objs = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    4: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  };
  let out = '%PDF-1.4\n';
  const off = [];
  for (let i = 1; i <= 5; i++) { off[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) out += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('重新上传附件不会抹掉已填写的 title', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-attach-'));
  const dataDir = path.join(root, 'data');
  let server;
  try {
    store.configure({ dataDir });
    ({ app: server } = { app: createServer(createApp({ dataDir }).app) });
    const base = await listen(server);

    // 建记录并手填标题（模拟用户输入 / 从别处导入）
    const created = await (await fetch(`${base}/api/literature`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json();
    const id = created.id;
    const TITLE = 'AI辅助经管类学术文献精读系统研究';
    await fetch(`${base}/api/literature/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: TITLE, authors: '张三' }),
    });
    assert.equal((await (await fetch(`${base}/api/literature/${id}`)).json()).title, TITLE);

    // 上传附件：解析字段该清空，但 title 必须留下
    const form = new FormData();
    form.append('file', new Blob([tinyPdf()], { type: 'application/pdf' }), 'paper.pdf');
    const up = await (await fetch(`${base}/api/literature/${id}/attachment`, { method: 'POST', body: form })).json();
    assert.equal(up.title, TITLE, '上传附件后标题应保留');
    assert.ok(up.filename, '附件应已挂上');
    assert.equal(up.abstract, '', '解析字段应被清空');

    // 再上传一次（换附件）也要保留
    const form2 = new FormData();
    form2.append('file', new Blob([tinyPdf()], { type: 'application/pdf' }), 'paper2.pdf');
    const up2 = await (await fetch(`${base}/api/literature/${id}/attachment`, { method: 'POST', body: form2 })).json();
    assert.equal(up2.title, TITLE, '换附件后标题仍应保留');

    // 删除附件同样保留 title
    const del = await (await fetch(`${base}/api/literature/${id}/attachment`, { method: 'DELETE' })).json();
    assert.equal(del.title, TITLE, '删除附件后标题仍应保留');
    assert.equal(del.filename, '', '文件名应已清空');
  } finally {
    if (server) await close(server);
    await rm(root, { recursive: true, force: true });
  }
});
