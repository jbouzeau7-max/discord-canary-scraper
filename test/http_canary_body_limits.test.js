'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchWithRetry,
  fetchTextWithRetry,
  fetchJsonWithRetry,
  readResponseBody,
  MAX_RESPONSE_BODY_BYTES,
} = require('../src/lib/http');
const { fetchAppHtml } = require('../src/lib/canary');

function response(status, { body, text, json, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => h.get(String(name).toLowerCase()) || null },
    ...(body ? { body } : {}),
    ...(text !== undefined ? { text: async () => text } : {}),
    ...(json !== undefined ? { json: async () => json } : {}),
  };
}

function streamResponse(status, chunks, { headers = {} } = {}) {
  let destroyed = 0;
  let reads = 0;
  const body = (async function* stream() {
    for (const chunk of chunks) {
      reads++;
      yield chunk;
    }
  })();
  body.destroy = () => { destroyed++; };
  return {
    response: response(status, { body, headers }),
    stats: () => ({ destroyed, reads }),
  };
}

const quick = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

test('fetchWithRetry ne rejoue pas POST/PATCH après une erreur réseau ambiguë', async () => {
  for (const method of ['POST', 'PATCH']) {
    let calls = 0;
    await assert.rejects(fetchWithRetry('https://x.test/mutate', {
      ...quick,
      method,
      body: 'mutation',
      fetch: async () => { calls++; throw new Error('ECONNRESET'); },
    }), /échec après 1 tentative: ECONNRESET/);
    assert.equal(calls, 1, `${method} doit être envoyé une seule fois`);
  }
});

test('fetchWithRetry laisse les méthodes sûres retenter une erreur réseau', async () => {
  let calls = 0;
  const res = await fetchWithRetry('https://x.test/read', {
    ...quick,
    fetch: async () => (++calls === 1 ? Promise.reject(new Error('ECONNRESET')) : response(200)),
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test('les retries mutation sont possibles avec un opt-in clair ou Idempotency-Key', async () => {
  for (const extra of [
    { retryUnsafeMethods: true },
    { headers: { 'Idempotency-Key': 'request-123' } },
  ]) {
    let calls = 0;
    const res = await fetchWithRetry('https://x.test/mutate', {
      ...quick,
      method: 'POST',
      body: 'mutation',
      ...extra,
      fetch: async () => (++calls === 1 ? Promise.reject(new Error('ECONNRESET')) : response(200)),
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  }
});

test('un statut HTTP retryable sur POST est rendu tel quel sans opt-in', async () => {
  let calls = 0;
  const res = await fetchWithRetry('https://x.test/mutate', {
    ...quick,
    method: 'POST',
    fetch: async () => { calls++; return response(503, { text: 'retry later' }); },
  });
  assert.equal(res.status, 503);
  assert.equal(calls, 1);
});

test('readResponseBody ferme le flux dès le dépassement et ne consomme pas la suite', async () => {
  const { response: res, stats } = streamResponse(200, [Buffer.from('123456789'), Buffer.from('ignored')]);
  await assert.rejects(readResponseBody(res, { maxBytes: 8 }), /exceeds 8 byte limit/);
  assert.deepEqual(stats(), { destroyed: 1, reads: 1 });
});

test('fetchTextWithRetry et fetchJsonWithRetry appliquent le plafond au flux', async () => {
  const textStream = streamResponse(200, [Buffer.from('0123456789')]);
  await assert.rejects(fetchTextWithRetry('https://x.test/text', {
    maxAttempts: 1,
    maxBodyBytes: 8,
    fetch: async () => textStream.response,
  }), /exceeds 8 byte limit/);
  assert.equal(textStream.stats().destroyed, 1);

  const jsonStream = streamResponse(200, [Buffer.from('{"too":"large"}')], {
    headers: { 'content-type': 'application/json' },
  });
  const value = await fetchJsonWithRetry('https://x.test/json', {
    maxAttempts: 1,
    maxBodyBytes: 8,
    fetch: async () => jsonStream.response,
  });
  assert.equal(value, null);
  assert.equal(jsonStream.stats().destroyed, 1);
});

test('les bodies d’erreur retryables sont lus avec plafond puis abandonnés proprement', async () => {
  const first = streamResponse(500, [Buffer.alloc(32, 0x61)], { headers: { 'content-length': '32' } });
  let calls = 0;
  const res = await fetchWithRetry('https://x.test/error', {
    ...quick,
    maxBodyBytes: 8,
    fetch: async () => (++calls === 1 ? first.response : response(200)),
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.equal(first.stats().destroyed, 1);
  assert.equal(first.stats().reads, 0, 'Content-Length permet de fermer avant lecture');
});

test('fetchAppHtml plafonne le flux et le ferme si le HTML est excessif', async () => {
  const overLimit = streamResponse(200, [Buffer.alloc(MAX_RESPONSE_BODY_BYTES + 1, 0x61)]);
  await assert.rejects(fetchAppHtml(1, async () => overLimit.response), /exceeds 5242880 byte limit/);
  assert.equal(overLimit.stats().destroyed, 1);
});

test('les mocks historiques sans body stream restent compatibles', async () => {
  const textOnly = response(200, { text: '{"ok":true}' });
  assert.deepEqual(await fetchJsonWithRetry('https://x.test/json', {
    maxAttempts: 1,
    fetch: async () => textOnly,
  }), { ok: true });

  const jsonOnly = response(200, { json: { legacy: true } });
  assert.equal(await readResponseBody(jsonOnly), '{"legacy":true}');
  assert.deepEqual(await fetchJsonWithRetry('https://x.test/json-legacy', {
    maxAttempts: 1,
    fetch: async () => response(200, { json: { legacy: true } }),
  }), { legacy: true });
});
