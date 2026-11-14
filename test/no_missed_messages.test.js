/** Régressions « messages oubliés » : réapparitions, repli 400, 429, dedupe. */
const test = require('node:test');
const assert = require('node:assert');
const es = require('../src/lib/experiment_state');
const { sendEmbeds, sendWebhook, plainChunks, _resetBucket } = require('../src/lib/webhook');
const { sentOnly } = require('../scripts/dedupe-sent-only');

const exp = (id) => ({ id, kind: 'user', variations: { 0: {}, 1: {} } });
const HOOK = 'https://discord.com/api/webhooks/1/abcdefghijklmnopqrstuvwxyz';

test('expérience annoncée supprimée puis revenue → ré-annoncée', () => {
  const prev = [exp('a')];
  const cur = [exp('a'), exp('b'), exp('c')];
  const known = new Set(['a', 'b', 'c']);
  const silent = es.diffExperiments(prev, cur, true, { knownIds: known });
  assert.deepStrictEqual(silent.added.map((e) => e.id), []);
  const d = es.diffExperiments(prev, cur, true, { knownIds: known, removedIds: new Set(['b']) });
  assert.deepStrictEqual(d.added.map((e) => e.id), ['b']);
});

test('updateRemovedExperiments purge les expériences revenues', () => {
  const out = es.updateRemovedExperiments({
    previousCurrent: [exp('a')],
    current: [exp('a'), exp('b')],
    existingRemoved: [{ id: 'b' }, { id: 'z' }],
    allowRemovals: false,
    buildNumber: '1',
  });
  assert.deepStrictEqual(out.map((e) => e.id), ['z']);
});

test('webhook: 400 Components V2 → repli en texte brut', async () => {
  _resetBucket();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const ok = !body.components;
    return {
      ok,
      status: ok ? 204 : 400,
      headers: { get: () => null },
      text: async () => (ok ? '' : '{"message":"Invalid Form Body"}'),
    };
  };
  const r = await sendEmbeds(
    HOOK,
    { username: 'x' },
    [{ title: 'T', fields: [{ name: 'N', value: '```diff\n+ a\n```' }] }],
    { fetchImpl },
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].body.content.includes('+ a'));
  assert.ok(!/with_components/.test(calls[1].url));
  assert.deepStrictEqual(calls[1].body.allowed_mentions, { parse: [] });
});

test('plainChunks : ≤ 2000 caractères et blocs de code toujours fermés', () => {
  const text = '## T\n```diff\n' + Array.from({ length: 400 }, (_, i) => `+ ligne ${i}`).join('\n') + '\n```';
  const parts = plainChunks(text);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 2000);
    assert.strictEqual((p.match(/```/g) || []).length % 2, 0);
  }
  assert.strictEqual(parts.join('\n').match(/\+ ligne \d+/g).length, 400);
});

test('webhook: les 429 ne consomment pas le budget de tentatives', async () => {
  _resetBucket();
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n <= 3)
      return {
        ok: false,
        status: 429,
        headers: { get: (h) => (h === 'retry-after' ? '0.01' : null) },
        text: async () => '{"retry_after":0.01}',
      };
    return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
  };
  const r = await sendWebhook(HOOK.replace('/1/', '/2/'), { content: 'x' }, { fetchImpl, maxAttempts: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(n, 4);
});

test('dedupe sent-only : seules les entrées livrées sont conservées', () => {
  const d = sentOnly({
    fps: {
      a: { ts: 1, status: 'sent' },
      b: { ts: 1, status: 'pending' },
      c: { ts: 1, status: 'failed' },
      d: 123,
      e: { ts: 1, status: 'done' },
    },
  });
  assert.deepStrictEqual(Object.keys(d.fps).sort(), ['a', 'd', 'e']);
});

test('webhook: 429 avec attente déraisonnable → échec immédiat (pas de blocage)', async () => {
  _resetBucket();
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return {
      ok: false,
      status: 429,
      headers: { get: (h) => (h === 'retry-after' ? '3600' : null) },
      text: async () => '{"retry_after":3600}',
    };
  };
  const t0 = Date.now();
  const r = await sendWebhook(HOOK.replace('/1/', '/3/'), { content: 'x' }, { fetchImpl });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(n, 1);
  assert.ok(Date.now() - t0 < 2000);
});
