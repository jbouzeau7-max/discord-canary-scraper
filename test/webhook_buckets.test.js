const test = require('node:test');
const assert = require('node:assert/strict');
const { sendWebhook, _resetBucket } = require('../src/lib/webhook');
const a = 'https://discord.com/api/webhooks/1/test';
const b = 'https://discord.com/api/webhooks/2/test';
const response = (headers = {}, status = 204, body = '') => ({ ok: status === 204, status, headers: { get: k => headers[k] ?? null }, text: async () => body });
const send = (url, fn, max429WaitMs = 200) => sendWebhook(url, {}, { fetchImpl: fn, maxDelayMs: 5, maxAttempts: 1, minGapMs: 0, max429WaitMs });

test('un quota local ne retarde pas un autre webhook et reste valable avec query', async () => {
  _resetBucket();
  await send(a, () => response({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.08' }));
  const order = [];
  await Promise.all([send(a + '?wait=true', () => { order.push('same'); return response(); }), send(b, () => { order.push('other'); return response(); })]);
  assert.deepEqual(order, ['other', 'same']);
});

test('un 429 global hors budget protège aussi le prochain webhook', async () => {
  _resetBucket();
  const start = Date.now();
  await send(a, () => response({}, 429, '{"global":true,"retry_after":0.08}'), 10);
  const result = await send(b, () => { assert.ok(Date.now() - start >= 80); return response(); });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
});

test('les alias Discord partagent la file et le quota du même ID', async () => {
  _resetBucket();
  const aliases = [
    'https://discord.com/api/v10/webhooks/1/rotated',
    'https://canary.discord.com/api/webhooks/1/test?wait=true',
    'https://discordapp.com/api/webhooks/1/test',
    'https://ptb.discordapp.com/api/v9/webhooks/1/test',
  ];
  const first = send(a, () => response({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '60' }));
  const results = await Promise.all(aliases.map(url => send(url, () => response(), 10)));
  assert.equal((await first).ok, true);
  for (const result of results) assert.deepEqual([result.status, result.attempts], [429, 0]);
});

test('deux endpoints non Discord restent indépendants', async () => {
  _resetBucket();
  const url = 'https://discord.com.example/api/webhooks/1/test';
  await send(url + '?route=a', () => response({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '60' }));
  assert.equal((await send(url + '?route=b', () => response(), 10)).ok, true);
  assert.equal((await send(a, () => response(), 10)).ok, true);
});
