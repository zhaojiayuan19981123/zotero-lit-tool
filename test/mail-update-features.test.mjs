import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const routes = fs.readFileSync(new URL('../src/mailRoutes.js', import.meta.url), 'utf8');
const mail = fs.readFileSync(new URL('../src/mail.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const updater = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('邮箱支持当前文件夹一键标记全部已读', () => {
  assert.match(mail, /export async function markAllSeen/);
  assert.match(mail, /messageFlagsAdd\(list, \['\\\\Seen'\]/);
  assert.match(routes, /messages\/seen-all/);
  assert.match(html, /btnMailMarkAllRead/);
  assert.match(app, /async function markAllMailSeen/);
  assert.match(app, /messages\/seen-all/);
});

test('更新检查结果包含发布说明字段并在 Release 中列出 v1.10.1 变更', () => {
  assert.match(updater, /releaseNotes/);
  assert.match(html, /本次更新内容/);
  assert.match(app, /knownChanges/);
  assert.match(workflow, /本版本主要更新（v1\.10\.1）/);
  assert.match(workflow, /Responses API/);
  assert.match(workflow, /全部未读邮件标记为已读/);
});
