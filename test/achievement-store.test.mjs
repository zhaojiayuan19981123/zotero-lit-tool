// achievement-store.test.mjs —— 成果管理数据层的单测
//
// 重点是「数据不串、不丢」：
//   · 没指定文件夹的新成果必须落在「数据文件夹」里（不能被丢掉）
//   · 删文件夹不能连带删成果，里面的成果要回到默认文件夹
//   · 白名单之外的字段（尤其 filePath）不能被前端改
//   · 附件清单的增删与公开输出（不能把本地磁盘路径泄露给前端）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as store from '../src/store.js';
import * as ach from '../src/achievementStore.js';
import { ALL_TEXT_FIELDS } from '../src/achievementFields.js';

function freshDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ach-${tag}-`));
  store.configure({ dataDir: dir });
  return dir;
}

test('blankAchievement 初始化所有文本字段，并默认落在数据文件夹', () => {
  freshDir('blank');
  const rec = ach.blankAchievement({ category: 'patent' });
  assert.ok(rec.id);
  assert.equal(rec.category, 'patent');
  assert.equal(rec.stage, 'done');
  assert.equal(rec.folderId, '', '空 folderId 就是「数据文件夹」');
  assert.equal(rec.isDraft, false);
  assert.deepEqual(rec.files, []);
  assert.deepEqual(rec.progressHistory, []);
  for (const f of ALL_TEXT_FIELDS) assert.equal(rec[f], '', `${f} 应该是空串`);
});

test('upsert：新建放最前，更新保留原位置', () => {
  freshDir('upsert');
  const a = ach.upsertAchievement(ach.blankAchievement({ title: 'A' }));
  const b = ach.upsertAchievement(ach.blankAchievement({ title: 'B' }));
  assert.deepEqual(ach.listAchievements().map((x) => x.title), ['B', 'A']);
  ach.upsertAchievement({ ...a, title: 'A2' });
  assert.deepEqual(ach.listAchievements().map((x) => x.title), ['B', 'A2'], '更新不该把记录顶到最前');
  assert.equal(ach.getAchievement('不存在'), null);
});

test('patch 只认白名单字段（filePath / files / status 改不动）', () => {
  freshDir('patch');
  const rec = ach.upsertAchievement(ach.blankAchievement({ title: '白名单' }));
  const out = ach.patchAchievement(rec.id, {
    authors: '张三, 李四',
    progressStatus: '外审',
    isDraft: true,
    filePath: '/etc/passwd',
    files: [{ id: 'x', filePath: '/etc/passwd' }],
    status: 'done',
    id: 'hacked',
    __evil: 1,
  });
  assert.equal(out.authors, '张三, 李四');
  assert.equal(out.progressStatus, '外审');
  assert.equal(out.isDraft, true);
  assert.equal(out.filePath, undefined, 'filePath 永远不落库');
  assert.deepEqual(out.files, [], '附件清单只能通过附件接口改');
  assert.equal(out.status, 'pending', 'status 由服务端维护');
  assert.equal(out.id, rec.id, 'id 不能被覆盖');
  assert.equal(out.__evil, undefined);
  assert.equal(ach.patchAchievement('不存在', { title: 'x' }), null);
});

test('patch：progressPercent 夹到 0–100 整数（表单口径，不做 0.x 猜测）', () => {
  freshDir('pct');
  const rec = ach.upsertAchievement(ach.blankAchievement({ title: '进度' }));
  assert.equal(ach.patchAchievement(rec.id, { progressPercent: '80%' }).progressPercent, '80');
  assert.equal(ach.patchAchievement(rec.id, { progressPercent: '120' }).progressPercent, '100');
  assert.equal(ach.patchAchievement(rec.id, { progressPercent: '-5' }).progressPercent, '0');
  assert.equal(ach.patchAchievement(rec.id, { progressPercent: 'abc' }).progressPercent, '');
  // 用户填 1 就是 1%（不是 100%）—— 进度条被猜满比不准更糟
  assert.equal(ach.patchAchievement(rec.id, { progressPercent: '1' }).progressPercent, '1');
});

test('patch：year 顺手清洗成 4 位年份', () => {
  freshDir('year');
  const rec = ach.upsertAchievement(ach.blankAchievement({ title: '年份' }));
  assert.equal(ach.patchAchievement(rec.id, { year: '2023年' }).year, '2023');
  assert.equal(ach.patchAchievement(rec.id, { year: '不确定' }).year, '');
});

test('文件夹：新建 / 改名 / 删除后成果回到数据文件夹（不连带删成果）', () => {
  freshDir('folder');
  const f = ach.upsertFolder({ id: store.newId(), name: '2026 投稿' });
  assert.equal(ach.listFolders().length, 1);
  const rec = ach.upsertAchievement(ach.blankAchievement({ title: '在投论文', folderId: f.id, stage: 'working' }));

  ach.upsertFolder({ ...f, name: '2026 年投稿' });
  assert.equal(ach.listFolders()[0].name, '2026 年投稿');

  const withDefault = ach.listFoldersWithDefault();
  assert.equal(withDefault[0].isDefault, true, '「数据文件夹」永远排第一');
  assert.equal(withDefault[0].name, ach.DEFAULT_FOLDER_NAME);
  assert.equal(withDefault[1].count, 1, '文件夹要带成果数');

  assert.equal(ach.deleteFolder(f.id), true);
  assert.equal(ach.listFolders().length, 0);
  assert.ok(ach.getAchievement(rec.id), '成果还在');
  assert.equal(ach.getAchievement(rec.id).folderId, '', '只是回到数据文件夹');
  assert.equal(ach.deleteFolder(f.id), false, '重复删除返回 false');
});

test('删除文件夹时默认文件夹与不存在 id 都不受影响', () => {
  freshDir('folder-edge');
  const rec = ach.upsertAchievement(ach.blankAchievement({ title: '默认夹里的' }));
  assert.equal(ach.deleteFolder(''), false, '数据文件夹不能删');
  assert.equal(ach.getAchievement(rec.id).folderId, '');
  assert.equal(ach.deleteFolder('不存在的 id'), false);
});

test('附件：挂载 / 查找 / 删除，且对外输出不含本地路径', () => {
  freshDir('files');
  const rec = ach.upsertAchievement(ach.blankAchievement({ title: '带附件' }));
  const withFile = ach.addFile(rec.id, {
    id: store.newId(), kind: 'searchReport', originalName: '检索报告.pdf',
    filename: '1_ab_检索报告.pdf', filePath: '/tmp/uploads/1_ab_检索报告.pdf',
    fileSize: 1234, ext: 'pdf', appHint: 'PDF 阅读器',
  });
  assert.equal(withFile.files.length, 1);
  assert.equal(withFile.files[0].kind, 'searchReport');

  // 非法 kind 落回 other；ext / appHint 没传就按文件名推出来
  const second = ach.addFile(rec.id, { originalName: 'x.py', filePath: '/tmp/x.py', kind: '乱写' });
  assert.equal(second.files[1].kind, 'other');
  assert.equal(second.files[1].ext, 'py');
  assert.match(second.files[1].appHint, /编辑器/);

  const found = ach.findFile(rec.id, withFile.files[0].id);
  assert.equal(found.file.originalName, '检索报告.pdf');

  const pub = ach.publicRecord(ach.getAchievement(rec.id));
  assert.equal(pub.files[0].filePath, undefined, '公开输出必须剥掉磁盘路径');
  assert.equal(pub.files[0].originalName, '检索报告.pdf');
  assert.ok(pub.files[0].id);

  const removed = ach.removeFile(rec.id, withFile.files[0].id);
  assert.equal(removed.record.files.length, 1);
  assert.equal(ach.removeFile(rec.id, '不存在的附件'), null);

  // 结构不对的附件（没有 filePath）读出来要被过滤掉，避免前端渲染出点不动的行
  const dbFile = path.join(store.getDataDir(), 'achievements.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
  db.items[0].files.push({ id: 'ghost', originalName: '幽灵' });
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf-8');
  assert.equal(ach.getAchievement(rec.id).files.length, 1);
});

test('deleteAchievement 返回要一并删掉的物理文件清单', () => {
  freshDir('delete');
  const rec = ach.upsertAchievement(ach.blankAchievement({ title: '待删' }));
  ach.addFile(rec.id, { originalName: 'a.pdf', filePath: '/tmp/a.pdf' });
  ach.addFile(rec.id, { originalName: 'b.pdf', filePath: '/tmp/b.pdf' });
  const out = ach.deleteAchievement(rec.id);
  assert.equal(out.removed, true);
  assert.deepEqual(out.files.sort(), ['/tmp/a.pdf', '/tmp/b.pdf']);
  assert.equal(ach.deleteAchievement(rec.id).removed, false);
});

test('summary 统计按类型、在投、草稿、附件', () => {
  freshDir('summary');
  ach.upsertAchievement(ach.blankAchievement({ category: 'paper', title: 'P', stage: 'working' }));
  ach.upsertAchievement(ach.blankAchievement({ category: 'paper', title: 'P2', isDraft: true }));
  ach.upsertAchievement(ach.blankAchievement({ category: 'patent', title: 'IP' }));
  const rec = ach.upsertAchievement(ach.blankAchievement({ category: 'certificate', title: 'C' }));
  ach.addFile(rec.id, { originalName: 'c.pdf', filePath: '/tmp/c.pdf' });
  ach.upsertFolder({ id: store.newId(), name: '夹子' });

  const s = ach.summary();
  assert.equal(s.total, 4);
  assert.equal(s.byCategory.paper, 2);
  assert.equal(s.byCategory.patent, 1);
  assert.equal(s.byCategory.certificate, 1);
  assert.equal(s.byCategory.textbook, 0);
  assert.equal(s.working, 1);
  assert.equal(s.draft, 1);
  assert.equal(s.files, 1);
  assert.equal(s.folders, 1);
});
