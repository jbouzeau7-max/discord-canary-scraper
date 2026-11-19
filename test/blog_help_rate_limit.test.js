'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Le 429 Zendesk (support-apps / creator-support) venait d'un burst de requêtes
// simultanées sur la même IP, sans aucun respect du Retry-After. Ces tests
// verrouillent: reprise après 429, budget honnête, état préservé, concurrence
// bornée et autres sources intactes.

const RSS = '<rss><channel><item><link>https://discord.com/blog/a</link><title>A</title></item></channel></rss>';

function jsonRes(obj, status = 200, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const text = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (h.has(String(name).toLowerCase()) ? h.get(String(name).toLowerCase()) : null) },
    async text() {
      return text;
    },
  };
}

function textRes(text) {
  return { ok: true, status: 200, headers: { get: () => null }, async text() { return text; } };
}

/**
 * Monte le tracker avec I/O isolé. `handlers` reçoit chaque URL et renvoie une
 * réponse (ou undefined pour le défaut).
 */
function setup(t, { previous, handlers }) {
  const posts = [];
  const delays = [];
  const calls = [];
  let saved = null;
  let active = 0;
  let peak = 0;

  const mock = (id, value) => {
    const key = require.resolve(id);
    const original = require.cache[key];
    require.cache[key] = { id: key, filename: key, loaded: true, exports: value };
    t.after(() => {
      if (original) require.cache[key] = original;
      else delete require.cache[key];
    });
  };

  const state = structuredClone(previous);
  mock('fs-extra', {
    ensureDir: async () => {},
    pathExists: async () => true,
    readJson: async () => structuredClone(state),
  });
  mock('../src/lib/atomic', { writeJsonAtomic: async (_, s) => { saved = s; } });
  mock('../src/lib/webhook', {
    withComponentsUrl: (x) => x,
    sendWebhook: async (_, payload) => {
      posts.push(JSON.stringify(payload.components));
      return { ok: true };
    },
  });
  mock('../src/lib/utils', { ...require('../src/lib/utils'), sleep: async (ms) => { delays.push(ms || 0); } });
  mock('node-fetch', async (url, init) => {
    calls.push(url);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setImmediate(r));
    active--;
    const custom = handlers instanceof Function ? handlers(url, init, calls) : null;
    if (custom) return custom;
    if (String(url).endsWith('rss.xml')) return textRes(RSS);
    if (String(url).includes('/articles.json')) return jsonRes({ articles: [], next_page: null });
    if (String(url).includes('.json')) return jsonRes({});
    return textRes('{}');
  });

  const key = require.resolve('../src/blog_tracker');
  delete require.cache[key];
  t.after(() => { delete require.cache[key]; });
  const { main } = require('../src/blog_tracker');

  return {
    run: () => main(),
    posts,
    delays,
    calls,
    get saved() { return saved; },
    get peak() { return peak; },
  };
}

const prevState = () => ({
  scrapedAt: '2026-01-01T00:00:00.000Z',
  blog: [],
  help: {
    support: [{ id: '10', source: 'support', updatedAt: '2026-01-01T00:00:00.000Z' }],
    dev: [{ id: '20', source: 'dev', updatedAt: '2026-01-01T00:00:00.000Z' }],
    apps: [{ id: '1', source: 'apps', updatedAt: '2026-01-01T00:00:00.000Z' }],
    creator: [{ id: '7', source: 'creator', updatedAt: '2026-01-01T00:00:00.000Z' }],
  },
});

const article = (id) => ({ id, title: `Article ${id}`, body: '<p>body</p>', html_url: `https://x/${id}`, updated_at: '2026-06-01T00:00:00.000Z' });

test('429 sur apps: Retry-After respecté, source récupérée, état avancé, pas d\'alerte', async (t) => {
  const prevUrl = process.env.BLOG_WEBHOOK_URL;
  process.env.BLOG_WEBHOOK_URL = 'https://example.invalid/webhook';
  t.after(() => { if (prevUrl === undefined) delete process.env.BLOG_WEBHOOK_URL; else process.env.BLOG_WEBHOOK_URL = prevUrl; });

  let appsAttempts = 0;
  const h = setup(t, {
    previous: prevState(),
    handlers: (url) => {
      if (url.includes('support-apps') && url.includes('/articles.json')) {
        appsAttempts++;
        if (appsAttempts === 1) {
          return jsonRes({ error: 'Rate limit exceeded' }, 429, { 'retry-after': '2' });
        }
        return jsonRes({ articles: [article(1), article(2)], next_page: null });
      }
      if (url.includes('/articles.json')) {
        const host = url.match(/https:\/\/([^/]+)/)[1];
        const id = host.startsWith('support-dev') ? 20 : host.startsWith('creator') ? 7 : 10;
        return jsonRes({ articles: [article(id)], next_page: null });
      }
      return null;
    },
  });

  await h.run();

  assert.equal(appsAttempts, 2, 'le 429 doit être réessayé une fois');
  assert.ok(h.delays.includes(2000), `pause Retry-After attendue, reçue: ${h.delays.slice(0, 12)}`);
  assert.ok(!h.posts.some((p) => p.includes('Blog Tracker Error')), 'aucune alerte santé');
  assert.equal(h.saved.help.apps.length, 2, 'catalogue apps rafraîchi');
  assert.equal(h.saved.help.support.length, 1, 'support intact');
  assert.equal(h.saved.help.creator.length, 1, 'creator intact');
  assert.equal(h.saved.lastErrorNotifiedAt, null);
});

test('Retry-After hors budget: échec immédiat et explicite, état préservé', async (t) => {
  const prevUrl = process.env.BLOG_WEBHOOK_URL;
  process.env.BLOG_WEBHOOK_URL = 'https://example.invalid/webhook';
  t.after(() => { if (prevUrl === undefined) delete process.env.BLOG_WEBHOOK_URL; else process.env.BLOG_WEBHOOK_URL = prevUrl; });

  const prev = prevState();
  let creatorAttempts = 0;
  const h = setup(t, {
    previous: prev,
    handlers: (url) => {
      if (url.includes('creator-support') && url.includes('/articles.json')) {
        creatorAttempts++;
        return jsonRes({ error: 'Rate limit exceeded' }, 429, { 'retry-after': '3600' });
      }
      if (url.includes('/articles.json')) {
        const host = url.match(/https:\/\/([^/]+)/)[1];
        const id = host.startsWith('support-apps') ? 1 : host.startsWith('support-dev') ? 20 : 10;
        return jsonRes({ articles: [article(id)], next_page: null });
      }
      return null;
    },
  });

  await h.run();

  assert.equal(creatorAttempts, 1, 'aucun martèlement quand le Retry-After dépasse le budget');
  assert.ok(!h.delays.includes(3600000), 'le job ne doit pas dormir une heure');
  assert.deepEqual(h.saved.help.creator, prev.help.creator, 'état creator préservé tel quel');
  assert.ok(h.posts.some((p) => p.includes('rate limited')), 'alerte santé explicite sur le rate limit');
  assert.ok(h.posts.some((p) => p.includes('Creator Support')));
  assert.ok(h.saved.lastErrorNotifiedAt, 'alerte enregistrée pour la déduplication');
  // Les autres sources ne sont pas pénalisées.
  assert.equal(h.saved.help.apps.length, 1);
  assert.equal(h.saved.help.support.length, 1);
});

test('concurrence Zendesk bornée (<= 2) malgré 4 help centers en parallèle', async (t) => {
  const h = setup(t, {
    previous: prevState(),
    handlers: null,
  });
  await h.run();
  assert.ok(h.peak <= 2, `trop de requêtes simultanées: ${h.peak}`);
  assert.ok(h.calls.filter((u) => u.includes('/api/v2/help_center/')).length >= 8);
});
