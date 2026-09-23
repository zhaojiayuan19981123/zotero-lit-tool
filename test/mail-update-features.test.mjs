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
  // ★ 保持 generate_release_notes: false，正文一律以 .github/release-body.md 为准。
  //   注意：曾经以为它才是「Release 正文为空」的元凶，其实不是 ——
  //   真正原因是发版作业缺 checkout，body_path 读不到文件（见下一条测试）。
  assert.match(workflow, /generate_release_notes:\s*false/);
  assert.doesNotMatch(workflow, /generate_release_notes:\s*true/, '不得再打开自动生成发布说明');
  assert.match(releaseBody, /## 安装包说明/);
  assert.match(releaseBody, /本版本主要更新（v1\.\d+\.\d+）/);
  assert.match(releaseBody, /Windows 客户端自动更新还需要本 Release 中的同名 `\.blockmap` 和 `latest\.yml`/);
});

test('发布作业检出源码并校验发布说明非空（防止再发出空正文的 Release）', () => {
  // 实测根因：release 作业只 actions/download-artifact、不检出源码，
  //   body_path 指向的 .github/release-body.md 不存在 → action 只打一条 warning
  //   就继续执行，静默发出**空正文**的 Release（v1.12/v1.13/v1.15.0/v1.15.1/v1.16.0 都踩过）。
  const releaseJob = workflow.split(/\n  release:/)[1] || '';
  assert.ok(releaseJob.length > 0, '未能从 workflow 中切出 release 作业');
  assert.match(releaseJob, /actions\/checkout@v\d/, 'release 作业必须检出源码，否则 body_path 读不到文件');
  assert.match(releaseJob, /Verify release notes file/, '必须有「发布说明文件非空」的校验步骤');
  assert.match(releaseJob, /test -s \.github\/release-body\.md/, '校验步骤必须真的判断文件非空');
  // 正文本身也要够长，避免被误清空后仍然发出去
  assert.ok(releaseBody.trim().length > 300, 'release-body.md 内容过短，疑似被清空');
});

test('主 AI 助手的「导入笔记」写入 Markdown 笔记并可新建（v1.16.1）', () => {
  // 落点改为独立的「Markdown 笔记」库（/api/markdown-notes），不再写进某篇文献的笔记
  assert.match(app, /async function chatImportToNote/);
  assert.match(app, /async function appendToMarkdownNote/);
  assert.match(app, /async function createMarkdownNoteFromAnswer/);
  assert.match(app, /function askMarkdownNoteTarget\(/, '弹窗选择器应存在');
  assert.match(app, /'\/api\/markdown-notes'|\/api\/markdown-notes\//, '导入必须落到 Markdown 笔记端点');
  assert.match(app, /data-np-new/, '弹窗必须提供「新建一篇笔记」入口');
  assert.match(app, /AI 问答 ·/, '新建笔记的标题应由提问生成');
  // 旧行为不应残留
  assert.doesNotMatch(app, /askPaperForNote/, '主助手不应再弹「导入到哪篇文献的笔记」');
  assert.doesNotMatch(app, /导入到哪篇文献的笔记/, '旧文案不应残留');
  assert.doesNotMatch(app, /ensureLiteratureLoaded/, '为挑文献而做的缓存查询应已移除');
});

test('v1.11.0 AI 助手前端补齐 PDF 与本地知识库状态，避免初始化中断', () => {
  assert.match(app, /let chatAttachments = \[\]/);
  assert.match(app, /let chatKnowledge = \[\]/);
  assert.match(app, /async function uploadChatPdf\(file\)/);
  assert.match(app, /async function openChatKnowledgePicker\(\)/);
  assert.match(html, /id="chatContextPills"/);
  assert.match(html, /id="chatKnowledgeModal"/);
});
