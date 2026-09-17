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
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('research notes accept custom Study labels and organize drafts without mutating saved notes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sciterminal-note-test-'));
  const dataDir = path.join(root, 'data');
  const uploadDir = path.join(root, 'uploads');
  const requests = [];
  const llm = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw || '{}'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '## 实验观察\n\n- 初步结果：[待补充]\n\n| 后续事项 | 状态 |\n| --- | --- |\n| 核查样本 | 待完成 |' } }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });

  let appServer;
  try {
    const llmBaseUrl = await listen(llm);
    store.configure({ dataDir });
    store.saveSettings({
      aiProvider: 'custom', _modelMigrated: true, activeProfileId: 'mock-model',
      modelProfiles: [{
        id: 'mock-model', label: 'Test model', provider: 'custom', baseURL: llmBaseUrl,
        apiKey: 'test-key', model: 'mock-model', visionOverride: 'no', createdAt: new Date().toISOString(),
      }],
    });
    const { app } = createApp({ uploadDir });
    const baseUrl = await listen(appServer = createServer(app));

    const projectResponse = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '数字金融项目', description: '检验政策冲击与企业创新。' }),
    });
    assert.equal(projectResponse.status, 200);
    const project = await projectResponse.json();

    const noteResponse = await fetch(`${baseUrl}/api/notes`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '基准回归', content: '已有正文。', projectId: project.id, studyNo: 'Study 12' }),
    });
    assert.equal(noteResponse.status, 200);
    const note = await noteResponse.json();
    assert.equal(note.studyNo, 'Study 12');
    assert.equal(note.projectId, project.id);

    const organize = await fetch(`${baseUrl}/api/notes/organize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: note.title, studyNo: note.studyNo, projectId: project.id,
        existingContent: note.content, fragments: '系数为正，但样本处理还没有核对；下周补充稳健性检验。',
      }),
    });
    assert.equal(organize.status, 200);
    const stream = await organize.text();
    assert.match(stream, /实验观察/);
    assert.match(stream, /后续事项/);
    assert.equal(store.listNotes().find((item) => item.id === note.id).content, '已有正文。');
    assert.match(requests.at(-1).messages[0].content, /禁止编造研究发现/);
    assert.match(requests.at(-1).messages[0].content, /不.*替换已有内容/);
    assert.match(requests.at(-1).messages[1].content, /数字金融项目/);
    assert.match(requests.at(-1).messages[1].content, /<fragments_untrusted_data>/);

    const deleteProjectResponse = await fetch(`${baseUrl}/api/projects/${project.id}`, { method: 'DELETE' });
    assert.equal(deleteProjectResponse.status, 200);
    assert.equal(store.listNotes().find((item) => item.id === note.id).projectId, null);

    const deleteResponse = await fetch(`${baseUrl}/api/notes/${note.id}`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 200);
    assert.equal(store.listNotes().some((item) => item.id === note.id), false);

    const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.match(html, /id="noteStudy"[^>]+list="noteStudyOptions"/);
    assert.match(html, /value="Study 12"/);
    assert.match(html, /id="btnNoteDelete"/);
    assert.match(html, /id="btnNoteAiInsert"/);
  } finally {
    if (appServer) await close(appServer);
    await close(llm);
    await rm(root, { recursive: true, force: true });
  }
});
