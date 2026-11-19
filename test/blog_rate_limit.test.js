'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('rate limits pause only the affected centers until Retry-After expires', async t => {
  const mock = (id, value) => {
    const key = require.resolve(id), original = require.cache[key];
    require.cache[key] = { id: key, filename: key, loaded: true, exports: value };
    t.after(() => { if (original) require.cache[key] = original; else delete require.cache[key]; });
  };
  const start = Date.UTC(2025, 0, 1);
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const oldApps = [{ source: 'apps', id: '1' }];
  let state = { scrapedAt: '2024-12-31', blog: [], help: { apps: oldApps } };
  let requests = [];
  mock('fs-extra', { ensureDir: async () => {}, pathExists: async () => true, readJson: async () => state });
  mock('../src/lib/atomic', { writeJsonAtomic: async (_, next) => { state = next; } });
  mock('../src/lib/utils', { ...require('../src/lib/utils'), sleep: async () => {} });
  mock('../src/lib/webhook', { withComponentsUrl: x => x, sendWebhook: async () => ({ ok: true }) });
  mock('node-fetch', async url => {
    requests.push(url);
    if (now === start && (url.includes('support-apps') || (url.includes('creator-support') && url.includes('articles.json')))) {
      return { ok: false, status: 429, headers: { get: () => url.includes('support-apps') ? '1200' : new Date(start + 1200000).toUTCString() } };
    }
    return { ok: true, text: async () => url.endsWith('rss.xml') ? '<rss><channel><item><link>x</link><content:encoded>body</content:encoded></item></channel></rss>' : JSON.stringify({ articles: [], next_page: null }) };
  });
  const { main } = require('../src/blog_tracker');
  await main();
  assert.equal(requests.filter(u => u.includes('support-apps')).length, 1, 'no articles request after metadata 429');
  assert.deepEqual(state.help.apps, oldApps);
  requests = []; now += 600000;
  await main();
  assert.equal(requests.filter(u => /support-apps|creator-support/.test(u)).length, 0);
  assert.ok(requests.some(u => u.includes('support-dev') && u.includes('articles.json')));
  assert.deepEqual(state.help.apps, oldApps);
  requests = []; now += 600000;
  await main();
  for (const host of ['support-apps', 'creator-support']) assert.ok(requests.some(u => u.includes(host) && u.includes('articles.json')));
});
