import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UTD_JOURNALS,
  JOURNAL_PRESETS,
  checkInAndCreateDelivery,
  createTopJournalState,
  deliveryArticles,
  deliveredArticleIds,
  historyArticles,
  setArticleFavorite,
  removeFavorites,
  removeHistoryArticles,
  mapCrossrefWork,
  syncJournals,
} from '../src/topJournals.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('UTD 期刊目录固定为 24 本，且所有预设只引用目录中的期刊', () => {
  assert.equal(UTD_JOURNALS.length, 24);
  assert.equal(new Set(UTD_JOURNALS.map((journal) => journal.id)).size, 24);
  assert.equal(new Set(UTD_JOURNALS.map((journal) => journal.issn)).size, 24);
  const known = new Set(UTD_JOURNALS.map((journal) => journal.id));
  for (const preset of Object.values(JOURNAL_PRESETS)) {
    assert.ok(preset.journalIds.length > 0);
    assert.ok(preset.journalIds.every((id) => known.has(id)));
  }
});

test('Crossref 映射保留文章详细信息：标题、作者、单位、摘要、期刊、DOI 和原文链接', () => {
  const article = mapCrossrefWork({
    DOI: '10.1234/ABC.1',
    title: ['A research title'],
    'container-title': ['Journal of Marketing'],
    author: [
      { given: 'Ada', family: 'Lovelace', affiliation: [{ name: 'University of Example' }] },
      { given: 'Grace', family: 'Hopper', affiliation: [{ name: 'Institute of Testing' }] },
    ],
    abstract: '<jats:p>An <b>abstract</b> &amp; contribution.</jats:p>',
    URL: 'https://doi.org/10.1234/ABC.1',
    volume: '90', issue: '2', page: '10-28', type: 'journal-article',
    'published-online': { 'date-parts': [[2026, 9, 20]] },
  }, UTD_JOURNALS.find((journal) => journal.id === 'jm'));
  assert.equal(article.id, 'doi:10.1234/abc.1');
  assert.deepEqual(article.authors, ['Ada Lovelace', 'Grace Hopper']);
  assert.deepEqual(article.affiliations, ['University of Example', 'Institute of Testing']);
  assert.equal(article.abstract, 'An abstract & contribution.');
  assert.equal(article.doi, '10.1234/ABC.1');
  assert.equal(article.originalUrl, 'https://doi.org/10.1234/ABC.1');
  assert.equal(article.publishedAt, '2026-09-20');
});

test('签到按期刊分配最多 5 篇，并在后续日期确保个人投递不重复', () => {
  const articles = Array.from({ length: 7 }, (_v, index) => ({
    id: `doi:example-${index + 1}`,
    journalId: 'jm', title: `Article ${index + 1}`,
    publishedAt: `2026-09-${String(index + 1).padStart(2, '0')}`,
  }));
  let state = createTopJournalState({ selectedJournalIds: ['jm'], articles });
  let first = checkInAndCreateDelivery(state, { date: '2026-09-20', perJournal: 5 });
  assert.equal(first.delivery.items.length, 5);
  assert.equal(first.delivery.shortages.length, 0);
  state = first.state;
  const second = checkInAndCreateDelivery(state, { date: '2026-09-21', perJournal: 5 });
  assert.equal(second.delivery.items.length, 2);
  assert.deepEqual(second.delivery.shortages, [{ journalId: 'jm', available: 2, requested: 5 }]);
  const delivered = [...first.delivery.items, ...second.delivery.items].map((entry) => entry.articleId);
  assert.equal(new Set(delivered).size, 7);
  const sameDay = checkInAndCreateDelivery(second.state, { date: '2026-09-21', perJournal: 5 });
  assert.equal(sameDay.alreadyCheckedIn, true);
  assert.equal(deliveryArticles(second.state, '2026-09-20').articles.length, 5);
});

test('同步仅合并新元数据，并正常记录单个期刊失败信息', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/0022-2429/')) {
      return new Response(JSON.stringify({ message: { items: [{ DOI: '10.9/jm', title: ['JM paper'], 'published-print': { 'date-parts': [[2026, 9, 20]] } }] } }), { status: 200 });
    }
    return new Response('unavailable', { status: 503 });
  };
  const result = await syncJournals(createTopJournalState(), ['jm', 'jmr'], { fetchImpl, rows: 10 });
  assert.deepEqual(result.synced, [{ journalId: 'jm', count: 1 }]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.state.articles.length, 1);
  assert.equal(result.state.articles[0].journalId, 'jm');
});

test('顶刊前端包含追踪视图、签到、期刊多选、原文链接与翻译入口', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  for (const id of ['viewTopJournals', 'btnTopJournalSync', 'btnTopJournalCheckin', 'topJournalTabs', 'topJournalContent']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const token of ['data-tj-journal', 'data-tj-translate', 'data-tj-opened', 'topJournalCheckin', 'saveTopJournalSubscriptions']) {
    assert.match(app, new RegExp(token));
  }
});


test('顶刊状态兼容旧版；收藏与历史批量删除不会破坏投递去重', () => {
  const old = {
    version: 1,
    selectedJournalIds: ['jm'],
    articles: [
      { id: 'doi:a', journalId: 'jm', title: 'A', publishedAt: '2026-09-20' },
      { id: 'doi:b', journalId: 'jm', title: 'B', publishedAt: '2026-09-19' },
    ],
    deliveries: { '2026-09-20': { date: '2026-09-20', items: [{ journalId: 'jm', articleId: 'doi:a', slot: 1 }] } },
  };
  let state = createTopJournalState(old);
  assert.equal(state.version, 2);
  assert.deepEqual(state.favorites, {});
  state = setArticleFavorite(state, 'doi:a', true);
  assert.ok(state.favorites['doi:a']);
  ({ state } = removeFavorites(state, ['doi:a', 'missing']));
  assert.equal(Object.keys(state.favorites).length, 0);
  const removed = removeHistoryArticles(state, ['doi:a']);
  assert.deepEqual(removed.deletedIds, ['doi:a']);
  assert.equal(historyArticles(removed.state).length, 0);
  assert.ok(deliveredArticleIds(removed.state).has('doi:a'), '软删除后仍必须保留去重记录');
});

test('同日新增订阅仅补推新期刊，旧期刊文章绝不重复', () => {
  const articles = ['jm', 'jmr'].flatMap((journalId) => Array.from({ length: 6 }, (_v, i) => ({
    id: `doi:${journalId}-${i + 1}`, journalId, title: `${journalId}-${i + 1}`,
    publishedAt: `2026-09-${String(20 - i).padStart(2, '0')}`,
  })));
  let state = createTopJournalState({ selectedJournalIds: ['jm'], articles });
  const first = checkInAndCreateDelivery(state, { date: '2026-09-20', perJournal: 5 });
  state = first.state;
  state.selectedJournalIds.push('jmr');
  const second = checkInAndCreateDelivery(state, { date: '2026-09-20', perJournal: 5 });
  assert.equal(second.alreadyCheckedIn, true);
  assert.equal(second.addedCount, 5);
  const delivery = second.delivery;
  assert.equal(delivery.items.filter((x) => x.journalId === 'jm').length, 5);
  assert.equal(delivery.items.filter((x) => x.journalId === 'jmr').length, 5);
  assert.equal(new Set(delivery.items.map((x) => x.articleId)).size, 10);
  const third = checkInAndCreateDelivery(second.state, { date: '2026-09-20', perJournal: 5 });
  assert.equal(third.addedCount, 0);
});

test('顶刊前端包含收藏、历史记录、批量选择、AI 分析和发表日期', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  for (const token of ['收藏', '历史记录', 'topJournalAnalysisModal']) assert.match(html, new RegExp(token));
  for (const token of ['data-tj-favorite', 'data-tj-select', 'topJournalAnalyze', 'topJournalDeleteHistory', '发表日期']) {
    assert.match(app, new RegExp(token));
  }
});
