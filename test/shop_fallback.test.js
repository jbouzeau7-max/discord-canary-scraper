'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {
  normalizeShopPayload,
  fetchShopSnapshot,
  buildItemComponents,
  retryAfterMs,
  runShopTracker,
  SHOP_API_URL,
} = require('../src/shop');

function item(id, name, extra = {}) {
  return {
    id,
    itemKey: null,
    name,
    type: 'Avatar Decoration',
    price: { amount: 8.99, label: null, currency: 'USD' },
    images: { card: 'https://cdn.discordapp.com/example.png', render: null },
    soldOut: false,
    ...extra,
  };
}

function payload(items = [item('sku-1', 'Hoshimi')], options = {}) {
  return {
    data: {
      game: 'discord',
      shopDate: '2026-11-17',
      stale: false,
      itemCount: items.length,
      sections: [{ title: 'Current', upcoming: false, items }],
      ...options.data,
    },
    meta: {
      attribution: { url: 'https://itemshop.gg/discord' },
      ...options.meta,
    },
  };
}

function response(status, data = null, headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => normalizedHeaders[String(name).toLowerCase()] || null },
    text: async () => data == null ? '' : JSON.stringify(data),
  };
}

async function tempState() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shop-api-test-'));
  return { dir, statePath: path.join(dir, 'shop.json') };
}

test('normalizeShopPayload validates the API envelope and uses stable item IDs', () => {
  const future = item('future-1', 'Coming soon');
  const source = payload([
    item('sku-1', 'Hoshimi'),
    future,
  ], {
    data: {
      sections: [
        { title: 'Current', upcoming: false, items: [item('sku-1', 'Hoshimi')] },
        { title: 'Upcoming', upcoming: true, items: [future] },
      ],
    },
  });
  const normalized = normalizeShopPayload(source);
  assert.equal(normalized.game, 'discord');
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].key, 'sku-1');
  assert.equal(normalized.items[0].image, 'https://cdn.discordapp.com/example.png');
  assert.equal(normalized.attributionUrl, 'https://itemshop.gg/discord');
});

test('normalizeShopPayload fails closed on stale, malformed or incomplete data', () => {
  assert.throws(() => normalizeShopPayload(payload([], { data: { stale: true } })), /stale/);
  assert.throws(() => normalizeShopPayload(payload([], { data: { itemCount: 1 } })), /itemCount mismatch/);
  assert.throws(() => normalizeShopPayload(payload([], { meta: { attribution: { url: 'https://example.com/' } } })), /attribution/);
});

test('fetchShopSnapshot sends If-None-Match and handles 304 without parsing a body', async () => {
  let request;
  const snapshot = await fetchShopSnapshot({
    etag: '"known"',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(304, null, { etag: '"known"' });
    },
  });
  assert.equal(request.url, SHOP_API_URL);
  assert.equal(request.options.headers['If-None-Match'], '"known"');
  assert.equal(request.options.headers.Accept, 'application/json');
  assert.equal(snapshot.notModified, true);
});

test('fetchShopSnapshot retries 429 only after Retry-After', async () => {
  let calls = 0;
  const waits = [];
  const result = await fetchShopSnapshot({
    fetchImpl: async () => {
      calls++;
      return calls === 1 ? response(429, {}, { 'retry-after': '0.25' }) : response(200, payload(), { etag: '"new"' });
    },
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);
  assert.equal(result.etag, '"new"');
});

test('fetchShopSnapshot abandons un corps streaming au-delà de la limite', async () => {
  const chunk = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const largeResponse = {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: (async function* () { yield chunk; yield chunk; })(),
    text: async () => { throw new Error('le lecteur streaming aurait dû être utilisé'); },
  };
  await assert.rejects(
    fetchShopSnapshot({ fetchImpl: async () => largeResponse }),
    /response exceeds size limit/,
  );
});

test('buildItemComponents inclut une attribution visible et un lien vers la boutique Discord', () => {
  const parts = buildItemComponents({
    name: 'Hoshimi [NEW]', type: 'Avatar Decoration', priceLabel: '8.99 USD', image: null,
  });
  const text = JSON.stringify(parts);
  assert.match(text, /itemshop\.gg/);
  assert.match(text, /discord\.com\/shop/);
  assert.match(text, /Avatar Decoration/);
});

test('runShopTracker migre l’ancien état en seed silencieux sans notifier 1705 items', async () => {
  const { dir, statePath } = await tempState();
  await fs.writeJson(statePath, { count: 578, announced: { 'old|entry': '2026-11-16T00:00:00.000Z' } });
  let notified = 0;
  const result = await runShopTracker({
    fetchImpl: async () => response(200, payload([
      item('sku-1', 'First'), item('sku-2', 'Second'),
    ]), { etag: '"v2"' }),
    statePath,
    notify: async () => { notified++; return true; },
    sleepImpl: async () => {},
    now: () => new Date('2026-11-17T00:00:00.000Z'),
  });
  const state = await fs.readJson(statePath);
  assert.equal(result.seeded, true);
  assert.equal(notified, 0);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.etag, '"v2"');
  assert.deepEqual(Object.keys(state.announced).sort(), ['sku-1', 'sku-2']);
  await fs.remove(dir);
});

test('runShopTracker notifies only unseen IDs and persists successful sends', async () => {
  const { dir, statePath } = await tempState();
  const now = () => new Date('2026-11-17T00:00:00.000Z');
  await runShopTracker({
    fetchImpl: async () => response(200, payload([item('sku-1', 'Existing')]), { etag: '"v1"' }),
    statePath, notify: async () => true, sleepImpl: async () => {}, now,
  });
  let notification;
  const result = await runShopTracker({
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers['If-None-Match'], '"v1"');
      return response(200, payload([item('sku-1', 'Existing'), item('sku-2', 'New')]), { etag: '"v2"' });
    },
    statePath,
    notify: async (components) => { notification = components; return true; },
    sleepImpl: async () => {},
    now,
  });
  const state = await fs.readJson(statePath);
  assert.equal(result.notified, 1);
  assert.ok(state.announced['sku-2']);
  assert.match(JSON.stringify(notification), /Data from/);
  await fs.remove(dir);
});

test('runShopTracker ne marque pas un item annoncé après échec de webhook', async () => {
  const { dir, statePath } = await tempState();
  const now = () => new Date('2026-11-17T00:00:00.000Z');
  await runShopTracker({
    fetchImpl: async () => response(200, payload([item('sku-1', 'Existing')]), { etag: '"v1"' }),
    statePath, notify: async () => true, sleepImpl: async () => {}, now,
  });
  const result = await runShopTracker({
    fetchImpl: async () => response(200, payload([item('sku-1', 'Existing'), item('sku-2', 'Pending')]), { etag: '"v2"' }),
    statePath, notify: async () => false, sleepImpl: async () => {}, now,
  });
  const state = await fs.readJson(statePath);
  assert.equal(result.ok, false);
  assert.equal(Boolean(state.announced['sku-2']), false);
  assert.deepEqual(state.pendingNew, ['sku-2']);
  await fs.remove(dir);
});

test('retryAfterMs supports seconds and HTTP-date forms', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  assert.equal(retryAfterMs('1.25', now), 1250);
  assert.equal(retryAfterMs('Tue, 17 Nov 2026 00:00:03 GMT', now), 3000);
  assert.equal(retryAfterMs('invalid', now), 0);
});
