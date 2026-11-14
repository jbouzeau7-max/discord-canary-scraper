'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchWithRetry,
  fetchJsonWithRetry,
  isRetryableStatus,
  extractRetryAfterMs,
} = require('../src/lib/http');

function res(status, { json, text = '', headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (h.has(String(name).toLowerCase()) ? h.get(String(name).toLowerCase()) : null) },
    async json() {
      if (json === undefined) throw new Error('no json');
      return json;
    },
    async text() {
      return text;
    },
  };
}

const fast = { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 };

test('isRetryableStatus : 408 et 425 ajoutés, 400 toujours non', () => {
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(425), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(400), false);
});

test('extractRetryAfterMs : date HTTP supportée', () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const r = res(429, { headers: { 'retry-after': future } });
  const ms = extractRetryAfterMs(r, null);
  assert.ok(ms > 3000 && ms <= 5000, String(ms));
});

test('fetchWithRetry : succès direct, aucune tentative supplémentaire', async () => {
  let calls = 0;
  const r = await fetchWithRetry('https://x.test/a', {
    ...fast,
    fetch: async () => {
      calls++;
      return res(200);
    },
  });
  assert.equal(r.status, 200);
  assert.equal(calls, 1);
});

test('fetchWithRetry : 500 puis 200 → retry réussi', async () => {
  let calls = 0;
  const r = await fetchWithRetry('https://x.test/a', {
    ...fast,
    fetch: async () => {
      calls++;
      return calls === 1 ? res(500) : res(200);
    },
  });
  assert.equal(r.status, 200);
  assert.equal(calls, 2);
});

test('fetchWithRetry : 404 non retryable, renvoyé tel quel', async () => {
  let calls = 0;
  const r = await fetchWithRetry('https://x.test/a', {
    ...fast,
    fetch: async () => {
      calls++;
      return res(404);
    },
  });
  assert.equal(r.status, 404);
  assert.equal(calls, 1);
});

test('fetchWithRetry : épuisement des tentatives → erreur explicite', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithRetry('https://x.test/a', {
      ...fast,
      label: 'T',
      fetch: async () => {
        calls++;
        return res(503);
      },
    }),
    /échec après 3 tentatives \(dernier HTTP 503\)/,
  );
  assert.equal(calls, 3);
});

test('fetchWithRetry : erreurs réseau retentées puis erreur', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithRetry('https://x.test/a', {
      ...fast,
      fetch: async () => {
        calls++;
        throw new Error('ECONNRESET');
      },
    }),
    /échec après 3 tentatives: ECONNRESET/,
  );
  assert.equal(calls, 3);
});

test('fetchWithRetry : Retry-After raisonnable respecté', async () => {
  let calls = 0;
  const t0 = Date.now();
  const r = await fetchWithRetry('https://x.test/a', {
    ...fast,
    fetch: async () => {
      calls++;
      return calls === 1 ? res(429, { headers: { 'retry-after': '0.05' } }) : res(200);
    },
  });
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 >= 40, 'pause retry-after non respectée');
});

test('fetchWithRetry : Retry-After trop long → échec immédiat sans marteler', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithRetry('https://x.test/a', {
      ...fast,
      maxRetryAfterMs: 1000,
      fetch: async () => {
        calls++;
        return res(429, { headers: { 'retry-after': '3600' } });
      },
    }),
    /Retry-After 3600s > 1s/,
  );
  assert.equal(calls, 1);
});

test('fetchWithRetry : AbortError de l\'appelant jamais retenté', async () => {
  let calls = 0;
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  await assert.rejects(
    fetchWithRetry('https://x.test/a', {
      ...fast,
      fetch: async () => {
        calls++;
        throw abort;
      },
    }),
    /aborted/,
  );
  assert.equal(calls, 1);
});

test('fetchWithRetry : method, body et options fetch transmis', async () => {
  let seen = null;
  await fetchWithRetry('https://x.test/a', {
    ...fast,
    method: 'POST',
    body: '{"a":1}',
    fetch: async (_url, init) => {
      seen = init;
      return res(200);
    },
  });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, '{"a":1}');
  assert.equal(seen.maxAttempts, undefined);
  assert.equal(seen.fetch, undefined);
  assert.ok(seen.agent, 'agent keep-alive présent');
});

test('fetchJsonWithRetry : JSON valide, null sur non-OK et JSON invalide', async () => {
  const ok = await fetchJsonWithRetry('https://x.test/a', {
    ...fast,
    fetch: async () => res(200, { headers: { 'content-type': 'application/json' }, text: '{"a":1}' }),
  });
  assert.deepEqual(ok, { a: 1 });

  const notOk = await fetchJsonWithRetry('https://x.test/a', {
    ...fast,
    fetch: async () => res(404),
  });
  assert.equal(notOk, null);

  const bad = await fetchJsonWithRetry('https://x.test/a', {
    ...fast,
    fetch: async () => res(200, { headers: { 'content-type': 'application/json' }, text: '<html>' }),
  });
  assert.equal(bad, null);
});
