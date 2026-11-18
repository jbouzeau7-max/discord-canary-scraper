'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runShopTracker, buildItemComponents } = require('../src/shop');

async function fixture(t, announced = {}, pendingNew = [], overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shop-delivery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  await fs.writeFile(statePath, JSON.stringify({ schemaVersion: 2, initialized: true, announced, etag: '"v1"', pendingNew, ...overrides }));
  const run = async (ids, options = {}) => runShopTracker({ statePath, sleepImpl: async () => {}, notify: async () => true,
    fetchImpl: async (_, { headers }) => {
      const tag = JSON.stringify(ids.join(','));
      if (headers['If-None-Match'] === tag) return { status: 304, headers: { get: () => tag } };
      return { ok: true, status: 200, headers: { get: k => k === 'etag' ? tag : null }, text: async () => JSON.stringify({
        data: { game: 'discord', stale: false, shopDate: '2026-11-17', itemCount: ids.length, sections: [{ items: ids.map(id => ({ id, name: id })) }] },
        meta: { attribution: { url: 'https://itemshop.gg/discord' } },
      }) };
    }, ...options });
  run.readState = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
  return run;
}

test('unchanged catalogue drains failed and overflow deliveries before reusing ETag', async t => {
  const run = await fixture(t);
  const ids = Array.from({ length: 21 }, (_, i) => `sku-${i}`);
  let calls = 0;
  assert.equal((await run(ids, { notify: async () => ++calls !== 1 })).pending, 2);
  assert.equal((await run(ids)).notified, 2);
  assert.equal((await run(ids)).unchanged, true);
});

test('present items are not reannounced after retention; reserved IDs work', async t => {
  const run = await fixture(t, { old: '2020-01-01T00:00:00Z' });
  assert.equal((await run(['old', '__proto__', 'constructor'])).notified, 2);
  assert.equal((await run(['old', '__proto__', 'constructor', 'next'])).notified, 1);
});

test('retention starts on removal after a long run of 304s', async t => {
  const run = await fixture(t);
  const at = (ids, date) => run(ids, { now: () => new Date(date) });
  const ids = ['quick-return', 'late-return'];
  assert.equal((await at(ids, '2026-01-01')).notified, 2);
  for (const date of ['2026-02-01', '2026-03-01', '2026-05-01']) {
    assert.equal((await at(ids, date)).unchanged, true);
  }
  assert.equal((await at([], '2026-05-02')).notified, 0);
  const removedAt = new Date('2026-05-02').toISOString();
  assert.equal((await run.readState()).announced['late-return'], removedAt);
  assert.equal((await at(['quick-return'], '2026-05-03')).notified, 0);
  assert.equal((await at(['quick-return'], '2026-07-01')).unchanged, true);
  assert.equal((await run.readState()).announced['late-return'], removedAt);
  assert.equal((await at(ids, '2026-08-02')).notified, 1);
});

test('valid 304 sends the cached validator and leaves state unchanged', async t => {
  const run = await fixture(t);
  const before = await run.readState();
  const result = await run([], { fetchImpl: async (_, { headers }) => {
    assert.equal(headers['If-None-Match'], before.etag);
    return { status: 304 };
  } });
  assert.equal(result.unchanged, true);
  assert.deepEqual(await run.readState(), before);
});

for (const [reason, state] of Object.entries({
  uninitialized: { initialized: false }, invalidBaseline: { announced: [] }, oldSchema: { schemaVersion: 1 },
  pending: { pendingNew: ['retry-me'] }, missingValidator: { etag: null },
})) {
  test(`unsolicited 304 leaves ${reason} state untouched`, async t => {
    const run = await fixture(t, {}, [], state);
    const before = await run.readState();
    await assert.rejects(run([], { fetchImpl: async (_, { headers }) => {
      assert.equal(Object.hasOwn(headers, 'If-None-Match'), false);
      return { status: 304 };
    } }), /unexpected 304/);
    assert.deepEqual(await run.readState(), before);
  });
}

test('only active announced IDs survive a full snapshot, not pending deliveries', async t => {
  const run = await fixture(t, {}, [], { initialized: false });
  assert.equal((await run(['seed'])).seeded, true);
  assert.deepEqual((await run.readState()).activeAnnounced, ['seed']);
  assert.equal((await run(['seed', 'failed'], { notify: async () => false })).pending, 1);
  assert.deepEqual((await run.readState()).activeAnnounced, ['seed']);
  assert.equal((await run([])).pending, 0);
  const state = await run.readState();
  assert.deepEqual(state.activeAnnounced, []);
  assert.deepEqual(state.pendingNew, []);
  assert.equal(Object.hasOwn(state.announced, 'failed'), false);
  assert.equal((await run([])).unchanged, true);
});

test('a single item does not pay an inter-message delay', async t => {
  const run = await fixture(t);
  const waits = [];
  await run(['a'], { sleepImpl: async ms => waits.push(ms) });
  assert.deepEqual(waits, []);
});

test('message identifies price and type in French', () => {
  const text = JSON.stringify(buildItemComponents({ name: 'Rose', type: 'Badge', priceLabel: '5 EUR' }));
  assert.match(text, /Prix : 5 EUR/);
  assert.match(text, /Type : Badge/);
});
