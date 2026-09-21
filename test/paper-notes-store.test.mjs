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
