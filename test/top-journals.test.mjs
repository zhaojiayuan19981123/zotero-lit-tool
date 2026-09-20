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
