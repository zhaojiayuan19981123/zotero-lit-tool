import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const routes = fs.readFileSync(new URL('../src/mailRoutes.js', import.meta.url), 'utf8');
const mail = fs.readFileSync(new URL('../src/mail.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const updater = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
// 发布说明正文抽到了独立文件，由 workflow 通过 body_path 引用
const releaseBody = fs.readFileSync(new URL('../.github/release-body.md', import.meta.url), 'utf8');

test('邮箱支持当前文件夹一键标记全部已读', () => {
  assert.match(mail, /export async function markAllSeen/);
  assert.match(mail, /messageFlagsAdd\(list, \['\\\\Seen'\]/);
  assert.match(routes, /messages\/seen-all/);
  assert.match(html, /btnMailMarkAllRead/);
  assert.match(app, /async function markAllMailSeen/);
  assert.match(app, /messages\/seen-all/);
});

test('更新检查结果包含发布说明字段并在 Release 中列出变更', () => {
  assert.match(updater, /releaseNotes/);
  assert.match(html, /本次更新内容/);
  assert.match(app, /knownChanges/);
  // workflow 走 body_path 引用独立文件，正文内容在 release-body.md 里
  assert.match(workflow, /body_path:\s*\.github\/release-body\.md/);
  assert.match(releaseBody, /## 安装包说明/);
  assert.match(releaseBody, /本版本主要更新（v1\.\d+\.\d+）/);
  assert.match(releaseBody, /Windows 客户端自动更新还需要本 Release 中的同名 `\.blockmap` 和 `latest\.yml`/);
});

test('v1.11.0 AI 助手前端补齐 PDF 与本地知识库状态，避免初始化中断', () => {
  assert.match(app, /let chatAttachments = \[\]/);
  assert.match(app, /let chatKnowledge = \[\]/);
  assert.match(app, /async function uploadChatPdf\(file\)/);
  assert.match(app, /async function openChatKnowledgePicker\(\)/);
  assert.match(html, /id="chatContextPills"/);
  assert.match(html, /id="chatKnowledgeModal"/);
});
