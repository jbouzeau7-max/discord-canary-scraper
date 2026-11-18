'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Run the actual tracker with isolated I/O: no live Discord messages or disk writes.
test('invalid catalogues preserve state; rejected health alerts remain retryable', async (t) => {
  const previous = { scrapedAt: '2020-01-01', blog: [{ id: 'old', source: 'blog' }], help: { support: [{ id: '1', source: 'support' }] } };
  let saved;
  const posts = [];
  let rss = '<html>Unavailable</html>';
  let articles = '{}';
  let active = 0;
  let peak = 0;
  const prevUrl = process.env.BLOG_WEBHOOK_URL;
  process.env.BLOG_WEBHOOK_URL = 'https://example.invalid/webhook';
  const prevRemoved = process.env.BLOG_NOTIFY_REMOVED;
  process.env.BLOG_NOTIFY_REMOVED = '1';
  t.after(() => { if (prevRemoved === undefined) delete process.env.BLOG_NOTIFY_REMOVED; else process.env.BLOG_NOTIFY_REMOVED = prevRemoved; });
  t.after(() => { if (prevUrl === undefined) delete process.env.BLOG_WEBHOOK_URL; else process.env.BLOG_WEBHOOK_URL = prevUrl; });
  const mock = (id, value) => {
    const key = require.resolve(id);
    const original = require.cache[key];
    require.cache[key] = { id: key, filename: key, loaded: true, exports: value };
    t.after(() => { if (original) require.cache[key] = original; else delete require.cache[key]; });
  };
  mock('fs-extra', { ensureDir: async () => {}, pathExists: async () => true, readJson: async () => previous });
  mock('../src/lib/atomic', { writeJsonAtomic: async (_, state) => { saved = state; } });
  mock('../src/lib/webhook', { withComponentsUrl: x => x, sendWebhook: async (_, payload) => {
    const message = JSON.stringify(payload.components);
    posts.push(message);
    return message.includes('Blog Tracker Error') ? { ok: false, status: 503 } : { ok: true };
  } });
  mock('../src/lib/utils', { ...require('../src/lib/utils'), sleep: async () => {} });
  mock('node-fetch', async url => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    const text = url.endsWith('rss.xml') ? rss : url.includes('/articles.json') ? articles : '{}';
    return { ok: true, text: async () => text };
  });
  const { main } = require('../src/blog_tracker');
  await main();
  assert.equal(posts.length, 1);
  assert.equal(saved.lastErrorNotifiedAt, null);
  assert.deepEqual(saved.blog, previous.blog);
  assert.deepEqual(saved.help.support, previous.help.support);
  assert.ok(peak > 1, 'independent help centers should overlap');
  const item = '<item><link>https://example.invalid/post</link></item>';
  for (const [label, feed] of [
    ['truncated after a complete item', `<rss><channel>${item}`],
    ['unterminated item in a closed envelope', `<rss><channel>${item}<item><link>x</link></channel></rss>`],
    ['missing channel', `<rss>${item}</rss>`],
  ]) {
    await t.test(label, async () => {
      rss = feed;
      posts.length = 0;
      await main();
      assert.ok(!posts.some(message => message.includes('Removed')), 'no removal notifications');
      assert.deepEqual(saved.blog, previous.blog);
    });
  }
  rss = '<html>Unavailable</html>';
  for (const next_page of [undefined, '', ' ', false, 0]) {
    await t.test(`invalid Zendesk next_page: ${JSON.stringify(next_page)}`, async () => {
      articles = JSON.stringify({ articles: [], count: 100, next_page });
      posts.length = 0;
      await main();
      assert.ok(!posts.some(message => message.includes('Removed')), 'no removal notifications');
      assert.deepEqual(saved.help.support, previous.help.support);
    });
  }
});
