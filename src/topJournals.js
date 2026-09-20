// topJournals.js —— UTD 24 顶刊跟踪：期刊目录、Crossref 元数据同步与个人不重复投递队列
//
// 本模块只同步公开的书目信息/摘要/DOI/出版社文章页；不抓取或分发受版权保护的 PDF 全文。

const DAY = 24 * 60 * 60 * 1000;
const CROSSREF_API = 'https://api.crossref.org/journals';

export const UTD_JOURNALS = [
  { id: 'tar', title: 'The Accounting Review', shortTitle: 'TAR', category: '会计', issn: '0001-4826', publisherUrl: 'https://publications.aaahq.org/accounting-review' },
  { id: 'jae', title: 'Journal of Accounting and Economics', shortTitle: 'JAE', category: '会计', issn: '0165-4101', publisherUrl: 'https://www.sciencedirect.com/journal/journal-of-accounting-and-economics' },
  { id: 'jar', title: 'Journal of Accounting Research', shortTitle: 'JAR', category: '会计', issn: '0021-8456', publisherUrl: 'https://onlinelibrary.wiley.com/journal/1475679x' },
  { id: 'jof', title: 'The Journal of Finance', shortTitle: 'JoF', category: '金融', issn: '0022-1082', publisherUrl: 'https://onlinelibrary.wiley.com/journal/15406261' },
  { id: 'jfe', title: 'Journal of Financial Economics', shortTitle: 'JFE', category: '金融', issn: '0304-405X', publisherUrl: 'https://www.sciencedirect.com/journal/journal-of-financial-economics' },
  { id: 'rfs', title: 'The Review of Financial Studies', shortTitle: 'RFS', category: '金融', issn: '0893-9454', publisherUrl: 'https://academic.oup.com/rfs' },
  { id: 'isr', title: 'Information Systems Research', shortTitle: 'ISR', category: '信息系统', issn: '1047-7047', publisherUrl: 'https://pubsonline.informs.org/journal/isre' },
  { id: 'ijoc', title: 'INFORMS Journal on Computing', shortTitle: 'INFORMS JOC', category: '信息系统', issn: '1091-9856', publisherUrl: 'https://pubsonline.informs.org/journal/ijoc' },
  { id: 'misq', title: 'MIS Quarterly', shortTitle: 'MISQ', category: '信息系统', issn: '0276-7783', publisherUrl: 'https://misq.umn.edu/' },
  { id: 'jcr', title: 'Journal of Consumer Research', shortTitle: 'JCR', category: '营销', issn: '0093-5301', publisherUrl: 'https://academic.oup.com/jcr' },
  { id: 'jm', title: 'Journal of Marketing', shortTitle: 'JM', category: '营销', issn: '0022-2429', publisherUrl: 'https://journals.sagepub.com/home/jmx' },
  { id: 'jmr', title: 'Journal of Marketing Research', shortTitle: 'JMR', category: '营销', issn: '0022-2437', publisherUrl: 'https://journals.sagepub.com/home/mrj' },
  { id: 'mksc', title: 'Marketing Science', shortTitle: 'Marketing Science', category: '营销', issn: '0732-2399', publisherUrl: 'https://pubsonline.informs.org/journal/mksc' },
  { id: 'ms', title: 'Management Science', shortTitle: 'Management Science', category: '运营与供应链', issn: '0025-1909', publisherUrl: 'https://pubsonline.informs.org/journal/mnsc' },
  { id: 'or', title: 'Operations Research', shortTitle: 'Operations Research', category: '运营与供应链', issn: '0030-364X', publisherUrl: 'https://pubsonline.informs.org/journal/opre' },
  { id: 'jom', title: 'Journal of Operations Management', shortTitle: 'JOM', category: '运营与供应链', issn: '0272-6963', publisherUrl: 'https://onlinelibrary.wiley.com/journal/18731317' },
  { id: 'msom', title: 'Manufacturing & Service Operations Management', shortTitle: 'M&SOM', category: '运营与供应链', issn: '1523-4614', publisherUrl: 'https://pubsonline.informs.org/journal/msom' },
  { id: 'pom', title: 'Production and Operations Management', shortTitle: 'POM', category: '运营与供应链', issn: '1059-1478', publisherUrl: 'https://onlinelibrary.wiley.com/journal/19375956' },
  { id: 'amj', title: 'Academy of Management Journal', shortTitle: 'AMJ', category: '综合管理与战略', issn: '0001-4273', publisherUrl: 'https://journals.aom.org/journal/amj' },
  { id: 'amr', title: 'Academy of Management Review', shortTitle: 'AMR', category: '综合管理与战略', issn: '0363-7425', publisherUrl: 'https://journals.aom.org/journal/amr' },
  { id: 'asq', title: 'Administrative Science Quarterly', shortTitle: 'ASQ', category: '综合管理与战略', issn: '0001-8392', publisherUrl: 'https://journals.sagepub.com/home/asq' },
  { id: 'os', title: 'Organization Science', shortTitle: 'Organization Science', category: '综合管理与战略', issn: '1047-7039', publisherUrl: 'https://pubsonline.informs.org/journal/orsc' },
  { id: 'jibs', title: 'Journal of International Business Studies', shortTitle: 'JIBS', category: '综合管理与战略', issn: '0047-2506', publisherUrl: 'https://link.springer.com/journal/41267' },
  { id: 'smj', title: 'Strategic Management Journal', shortTitle: 'SMJ', category: '综合管理与战略', issn: '0143-2095', publisherUrl: 'https://onlinelibrary.wiley.com/journal/10970266' },
];

export const JOURNAL_PRESETS = {
  marketing: { label: '营销', journalIds: ['jcr', 'jm', 'jmr', 'mksc'] },
  management: { label: '企业管理', journalIds: ['amj', 'amr', 'asq', 'os', 'jibs', 'smj'] },
  technologyEconomics: { label: '技术经济 / 管理科学', journalIds: ['isr', 'ijoc', 'misq', 'ms', 'or', 'jom', 'msom', 'pom'] },
  tourism: { label: '旅游（交叉）', journalIds: ['jcr', 'jm', 'jmr', 'mksc', 'jibs', 'smj'] },
  accounting: { label: '会计', journalIds: ['tar', 'jae', 'jar'] },
  finance: { label: '金融', journalIds: ['jof', 'jfe', 'rfs'] },
  informationSystems: { label: '信息系统', journalIds: ['isr', 'ijoc', 'misq'] },
  operations: { label: '运营与供应链', journalIds: ['ms', 'or', 'jom', 'msom', 'pom'] },
};

export function dayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function createTopJournalState(value = {}) {
  // v2 新增收藏与历史软删除。保留投递记录，以便“删历史”后仍能保证文章永不重复投递。
  const favoriteSource = value?.favorites && typeof value.favorites === 'object' ? value.favorites : {};
  const deletedSource = value?.deletedHistoryArticleIds && typeof value.deletedHistoryArticleIds === 'object'
    ? value.deletedHistoryArticleIds : {};
  return {
    version: 2,
    selectedJournalIds: Array.isArray(value?.selectedJournalIds) ? [...new Set(value.selectedJournalIds.filter((id) => UTD_JOURNALS.some((j) => j.id === id)))] : [],
    articles: Array.isArray(value?.articles) ? value.articles : [],
    checkins: value?.checkins && typeof value.checkins === 'object' ? value.checkins : {},
    deliveries: value?.deliveries && typeof value.deliveries === 'object' ? value.deliveries : {},
    sync: value?.sync && typeof value.sync === 'object' ? value.sync : {},
    favorites: Object.fromEntries(Object.entries(favoriteSource).filter(([id]) => typeof id === 'string' && id)),
    deletedHistoryArticleIds: Object.fromEntries(Object.entries(deletedSource).filter(([id]) => typeof id === 'string' && id)),
    preferences: { fillWithRecentUnseen: true, ...(value?.preferences || {}) },
  };
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function firstDate(message) {
  for (const key of ['published-online', 'published-print', 'published', 'issued', 'created']) {
    const part = message?.[key];
    const values = part?.['date-parts']?.[0];
    if (Array.isArray(values) && values.length) {
      const [year, month = 1, day = 1] = values;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return '';
}

function articleIdFor(item) {
  const doi = String(item?.DOI || '').trim().toLowerCase();
  if (doi) return `doi:${doi}`;
  return `fallback:${String(item?.title?.[0] || '').trim().toLowerCase()}|${firstDate(item)}`;
}

export function mapCrossrefWork(work, journal) {
  const doi = String(work?.DOI || '').trim();
  const authors = Array.isArray(work?.author) ? work.author.map((author) => [author.given, author.family].filter(Boolean).join(' ').trim()).filter(Boolean) : [];
  const affiliations = Array.from(new Set((work?.author || []).flatMap((author) => (author.affiliation || []).map((row) => String(row?.name || '').trim()).filter(Boolean))));
  return {
    id: articleIdFor(work),
    journalId: journal.id,
    journal: String(work?.['container-title']?.[0] || journal.title).trim(),
    title: String(work?.title?.[0] || '').trim(),
    authors,
    affiliations,
    abstract: htmlToText(work?.abstract),
    doi,
    originalUrl: String(work?.URL || (doi ? `https://doi.org/${doi}` : '')).trim(),
    publishedAt: firstDate(work),
    volume: String(work?.volume || ''),
    issue: String(work?.issue || ''),
    pages: String(work?.page || work?.article_number || ''),
    articleType: String(work?.type || ''),
    source: 'Crossref',
    discoveredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    translations: work?.translations && typeof work.translations === 'object' ? work.translations : {},
  };
}

function mergeArticles(existing, incoming) {
  const byId = new Map(existing.map((article) => [article.id, article]));
  for (const next of incoming) {
    if (!next.title) continue;
    const old = byId.get(next.id);
    byId.set(next.id, {
      ...old,
      ...next,
      abstract: next.abstract || old?.abstract || '',
      authors: next.authors?.length ? next.authors : (old?.authors || []),
      affiliations: next.affiliations?.length ? next.affiliations : (old?.affiliations || []),
      translations: old?.translations || next.translations || {},
      discoveredAt: old?.discoveredAt || next.discoveredAt,
    });
  }
  return [...byId.values()]
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) || String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')))
    .slice(0, 6000);
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

export async function syncJournals(stateInput, journalIds, { fetchImpl = globalThis.fetch, rows = 50 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求，无法同步期刊元数据');
  const state = createTopJournalState(stateInput);
  const wanted = [...new Set((journalIds || []).filter((id) => UTD_JOURNALS.some((journal) => journal.id === id)))];
  if (!wanted.length) return { state, synced: [], failed: [] };
  const synced = [];
  const failed = [];
  const fetched = [];
  // 限制并发为 3，既比逐刊串行快，也避免对 Crossref 造成突发请求。
  const queue = [...wanted];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const id = queue.shift();
      const journal = UTD_JOURNALS.find((candidate) => candidate.id === id);
      try {
        const params = new URLSearchParams({ filter: 'type:journal-article', sort: 'published', order: 'desc', rows: String(Math.max(1, Math.min(100, rows))) });
        const response = await fetchImpl(`${CROSSREF_API}/${encodeURIComponent(journal.issn)}/works?${params}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'zotero-lit-tool/1.9 (mailto:research@example.invalid)' },
        });
        if (!response.ok) throw new Error(`Crossref ${response.status}`);
        const payload = await response.json();
        const articles = (payload?.message?.items || []).map((item) => mapCrossrefWork(item, journal));
        fetched.push(...articles);
        state.sync[id] = { lastSuccessAt: new Date().toISOString(), source: 'Crossref', count: articles.length, error: '' };
        synced.push({ journalId: id, count: articles.length });
      } catch (error) {
        const message = error?.message || '未知同步错误';
        state.sync[id] = { ...(state.sync[id] || {}), lastAttemptAt: new Date().toISOString(), error: message };
        failed.push({ journalId: id, error: message });
      }
    }
  });
  await Promise.all(workers);
  state.articles = mergeArticles(state.articles, fetched);
  return { state, synced, failed };
}

function articleDateMillis(article) {
  const parsed = Date.parse(`${article.publishedAt || ''}T12:00:00`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function deliveredIdsFor(state, journalId) {
  const ids = new Set();
  for (const batch of Object.values(state.deliveries)) {
    for (const entry of batch?.items || []) if (entry.journalId === journalId) ids.add(entry.articleId);
  }
  return ids;
}

export function checkInAndCreateDelivery(stateInput, { date = dayKey(), perJournal = 5 } = {}) {
  if (!isValidDate(date)) throw new Error('签到日期格式无效');
  const state = createTopJournalState(stateInput);
  const existing = state.deliveries[date];
  if (!state.selectedJournalIds.length && !existing) throw new Error('请先在「期刊管理」勾选至少一本 UTD 期刊');

  // 同一天再次签到不会重置旧投递；如果用户随后新增期刊（或旧期刊此前不足 5 篇），仅追加未投递文章。
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(10, Number(perJournal) || 5));
  const delivery = existing
    ? { ...existing, items: Array.isArray(existing.items) ? [...existing.items] : [] }
    : { date, createdAt: now, items: [], shortages: [] };
  const addedEntries = [];
  const shortages = [];
  for (const journalId of state.selectedJournalIds) {
    const currentCount = delivery.items.filter((item) => item.journalId === journalId).length;
    const missing = Math.max(0, limit - currentCount);
    const previouslyDelivered = deliveredIdsFor(state, journalId);
    const candidates = state.articles
      .filter((article) => article.journalId === journalId && !previouslyDelivered.has(article.id))
      .sort((a, b) => articleDateMillis(b) - articleDateMillis(a) || String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')));
    const chosen = candidates.slice(0, missing);
    for (const article of chosen) {
      const entry = { journalId, articleId: article.id, slot: currentCount + addedEntries.filter((item) => item.journalId === journalId).length + 1, openedAt: '', savedAt: '' };
      delivery.items.push(entry);
      addedEntries.push(entry);
    }
    const totalForJournal = currentCount + chosen.length;
    if (totalForJournal < limit) shortages.push({ journalId, available: totalForJournal, requested: limit });
  }
  delivery.shortages = shortages;
  delivery.updatedAt = now;
  state.checkins[date] = { ...(state.checkins[date] || {}), checkedInAt: state.checkins[date]?.checkedInAt || now, deliveredCount: delivery.items.length };
  state.deliveries[date] = delivery;
  return { state, delivery, alreadyCheckedIn: Boolean(existing), addedCount: addedEntries.length };
}

export function deliveryArticles(stateInput, date = dayKey()) {
  const state = createTopJournalState(stateInput);
  const delivery = state.deliveries[date] || null;
  if (!delivery) return { delivery: null, articles: [] };
  const order = new Map(delivery.items.map((entry, index) => [entry.articleId, index]));
  return {
    delivery,
    articles: delivery.items.map((entry) => state.articles.find((article) => article.id === entry.articleId)).filter(Boolean)
      .sort((a, b) => order.get(a.id) - order.get(b.id)),
  };
}

export function recentArticles(stateInput, { journalIds = [], limit = 120 } = {}) {
  const state = createTopJournalState(stateInput);
  const ids = journalIds.length ? new Set(journalIds) : new Set(state.selectedJournalIds);
  return state.articles.filter((article) => !ids.size || ids.has(article.journalId))
    .sort((a, b) => articleDateMillis(b) - articleDateMillis(a) || String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 120)));
}

export function deliveredArticleIds(stateInput) {
  const state = createTopJournalState(stateInput);
  return new Set(Object.values(state.deliveries).flatMap((batch) => (batch?.items || []).map((entry) => entry.articleId)));
}

export function historyArticles(stateInput, { includeDeleted = false } = {}) {
  const state = createTopJournalState(stateInput);
  const ids = deliveredArticleIds(state);
  return state.articles
    .filter((article) => ids.has(article.id) && (includeDeleted || !state.deletedHistoryArticleIds[article.id]))
    .sort((a, b) => articleDateMillis(b) - articleDateMillis(a) || String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')));
}

export function setArticleFavorite(stateInput, articleId, favorite = true) {
  const state = createTopJournalState(stateInput);
  if (!state.articles.some((article) => article.id === articleId)) throw new Error('文章不存在或已从本地缓存清理');
  if (favorite) state.favorites[articleId] = { ...(state.favorites[articleId] || {}), savedAt: state.favorites[articleId]?.savedAt || new Date().toISOString() };
  else delete state.favorites[articleId];
  return state;
}

export function removeFavorites(stateInput, articleIds) {
  const state = createTopJournalState(stateInput);
  const ids = [...new Set((Array.isArray(articleIds) ? articleIds : []).filter((id) => typeof id === 'string' && id))];
  let removedCount = 0;
  for (const id of ids) if (state.favorites[id]) { delete state.favorites[id]; removedCount += 1; }
  return { state, removedCount };
}

export function removeHistoryArticles(stateInput, articleIds) {
  const state = createTopJournalState(stateInput);
  const delivered = deliveredArticleIds(state);
  const ids = [...new Set((Array.isArray(articleIds) ? articleIds : []).filter((id) => typeof id === 'string' && id))];
  const deletedIds = [];
  for (const id of ids) {
    if (!delivered.has(id) || state.deletedHistoryArticleIds[id]) continue;
    state.deletedHistoryArticleIds[id] = { deletedAt: new Date().toISOString() };
    deletedIds.push(id);
  }
  return { state, deletedIds };
}

export function calendarSummary(stateInput, now = new Date()) {
  const state = createTopJournalState(stateInput);
  const today = dayKey(now);
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthPrefix = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-`;
  const checkinDays = Object.keys(state.checkins).filter((date) => date.startsWith(monthPrefix)).sort();
  let streak = 0;
  const walk = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  while (state.checkins[dayKey(walk)]) { streak += 1; walk.setDate(walk.getDate() - 1); }
  const libraryIds = deliveredArticleIds(state);
  const historyCount = [...libraryIds].filter((id) => !state.deletedHistoryArticleIds[id]).length;
  return { today, todayCheckedIn: Boolean(state.checkins[today]), streak, checkinDays, libraryCount: historyCount, historyCount, favoriteCount: Object.keys(state.favorites).length, selectedCount: state.selectedJournalIds.length };
}

export function markArticleOpened(stateInput, articleId, date = dayKey()) {
  const state = createTopJournalState(stateInput);
  const delivery = state.deliveries[date];
  if (!delivery) return state;
  const entry = delivery.items.find((item) => item.articleId === articleId);
  if (entry && !entry.openedAt) entry.openedAt = new Date().toISOString();
  return state;
}

export function pruneTopJournalState(stateInput, now = Date.now()) {
  const state = createTopJournalState(stateInput);
  // 文章元数据保留两年，已投递论文永不因清理而删除。
  const protectedIds = new Set([...deliveredArticleIds(state), ...Object.keys(state.favorites)]);
  state.articles = state.articles.filter((article) => protectedIds.has(article.id) || !article.publishedAt || Date.parse(article.publishedAt) >= now - 730 * DAY);
  return state;
}
