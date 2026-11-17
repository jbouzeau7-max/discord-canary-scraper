'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { fetchAppHtml } = require('../src/lib/canary');

function response(status, headers = {}, body = 'error') {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized[String(name).toLowerCase()] || null },
    body: Readable.from([Buffer.from(body)]),
    text: async () => body,
  };
}

test('fetchAppHtml respecte une date HTTP Retry-After sans attendre dans le test', async () => {
  const waits = [];
  let calls = 0;
  const retryAt = new Date(Date.now() + 6000).toUTCString();
  const html = '<script>GLOBAL_ENV={"BUILD_NUMBER":"123456"};</script>';
  const result = await fetchAppHtml(2, async () => {
    calls++;
    return calls === 1
      ? response(503, { 'retry-after': retryAt })
      : response(200, {}, html);
  }, {
    maxRetryAfterMs: 10000,
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(result, html);
  assert.equal(calls, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 4000 && waits[0] <= 6000, `Retry-After wait was ${waits[0]}ms`);
});

test('fetchAppHtml abandonne explicitement si la date Retry-After dépasse le budget', async () => {
  let calls = 0;
  const waits = [];
  const retryAt = new Date(Date.now() + 10000).toUTCString();
  await assert.rejects(() => fetchAppHtml(3, async () => {
    calls++;
    return response(429, { 'retry-after': retryAt });
  }, {
    maxRetryAfterMs: 1000,
    sleep: async (ms) => waits.push(ms),
  }), /Retry-After .* exceeds budget/);
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('fetchAppHtml accepte les delay-seconds décimaux et retente après le délai', async () => {
  const waits = [];
  let calls = 0;
  const html = '<script>GLOBAL_ENV={"BUILD_NUMBER":"123457"};</script>';
  const result = await fetchAppHtml(2, async () => {
    calls++;
    return calls === 1
      ? response(429, { 'retry-after': '0.25' })
      : response(200, {}, html);
  }, {
    maxRetryAfterMs: 1000,
    sleep: async (ms) => waits.push(ms),
  });
  assert.equal(result, html);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);
});
