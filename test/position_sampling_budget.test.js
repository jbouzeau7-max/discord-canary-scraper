'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { main } = require('../src/user_rollout_positions');

async function options(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'positions-budget-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { out: path.join(dir, 'state.json'), samples: 3, minOk: 2, delayMs: 0, comparison: {}, knownNames: [] };
}

test('positions: les réponses identiques ne valident pas le seuil de publication', async (t) => {
  const opts = await options(t);
  const old = { updatedAt: 'previous', experiments: {} };
  await fs.writeFile(opts.out, JSON.stringify(old));
  const out = await main({ ...opts, fetch: async () => ({ ok: true, json: async () => ({ fingerprint: '1564852841112404028.sig', assignments: [] }) }) });
  assert.equal(out.lastRun.skipped, true);
  assert.equal(out.lastRun.ok, 1);
  assert.equal(out.updatedAt, old.updatedAt);
});

test('positions: un Retry-After supérieur au budget termine le lot sans nouvel appel', async (t) => {
  const opts = await options(t);
  let calls = 0;
  const out = await main({ ...opts, maxMs: 5000, fetch: async () => {
    calls++;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ retry_after: 60 }) };
  } });
  assert.equal(out.lastRun.skipped, true);
  assert.equal(calls, 1);
});
