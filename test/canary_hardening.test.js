'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchBuild,
  fetchAppHtml,
  extractAssetUrls,
  prioritizeAssets,
  parseGlobalEnv,
} = require('../src/lib/canary');

const HTML_OK = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/assets/app.abc.css?v=1">
</head><body>
<script src="/assets/web.123.js"></script>
<script src="/assets/chunk.456.js"></script>
<script>window.GLOBAL_ENV = {"BUILD_NUMBER":"671591","VERSION_HASH":"deadbeef"};</script>
</body></html>`;

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (n.toLowerCase() in headers ? String(headers[n.toLowerCase()]) : null) },
    async text() {
      return body;
    },
  };
}

test('extractAssetUrls : URLs normales, query et doublons', () => {
  const { js, css } = extractAssetUrls(HTML_OK);
  assert.deepEqual(js.sort(), [
    'https://canary.discord.com/assets/chunk.456.js',
    'https://canary.discord.com/assets/web.123.js',
  ]);
  assert.deepEqual(css, ['https://canary.discord.com/assets/app.abc.css']);
});

test('extractAssetUrls : URL protocole-relative ne reçoit pas le mauvais hôte', () => {
  const html = '<script src="//cdn.discordapp.com/assets/web.abc.js"></script>';
  const { js } = extractAssetUrls(html);
  assert.deepEqual(js, ['https://cdn.discordapp.com/assets/web.abc.js']);
});

test('extractAssetUrls : fragment ignoré, rel multiples, preload as=style', () => {
  const html = `
    <link rel="stylesheet preload" href="/assets/a.css#x">
    <link rel="preload" as="style" href="/assets/b.css">
    <link rel="preload" as="script" href="/assets/nope.css">
    <script src="/assets/c.js#frag"></script>`;
  const { js, css } = extractAssetUrls(html);
  assert.ok(css.includes('https://canary.discord.com/assets/a.css'));
  assert.ok(css.includes('https://canary.discord.com/assets/b.css'));
  assert.deepEqual(js, ['https://canary.discord.com/assets/c.js']);
});

test('extractAssetUrls : aucune URL /assets/ valide → listes vides', () => {
  const { js, css } = extractAssetUrls('<script src="/static/app.js"></script><link rel="stylesheet" href="/x.css">');
  assert.deepEqual(js, []);
  assert.deepEqual(css, []);
  assert.deepEqual(extractAssetUrls(''), { js: [], css: [] });
});

test('parseGlobalEnv : valeurs quotées et BUILD_NUMBER non quoté', () => {
  assert.equal(parseGlobalEnv('"BUILD_NUMBER": 671591').BUILD_NUMBER, '671591');
  assert.equal(parseGlobalEnv('"BUILD_NUMBER":"671591"').BUILD_NUMBER, '671591');
  const e = parseGlobalEnv(HTML_OK);
  assert.equal(e.BUILD_NUMBER, '671591');
  assert.equal(e.VERSION_HASH, 'deadbeef');
});

test('parseGlobalEnv : bloc window.GLOBAL_ENV de secours', () => {
  const e = parseGlobalEnv("window.GLOBAL_ENV = {BUILD_NUMBER:'671600', RELEASE_CHANNEL:'canary'}");
  assert.equal(e.BUILD_NUMBER, '671600');
});

test('parseGlobalEnv : HTML vide → objet vide', () => {
  assert.deepEqual(parseGlobalEnv(''), {});
});

test('prioritizeAssets : web.* d\'abord, sentry en dernier', () => {
  const out = prioritizeAssets([
    'https://x/assets/sentry.a.js',
    'https://x/assets/chunk.b.js',
    'https://x/assets/web.c.js',
  ]);
  assert.match(out[0], /web\./);
  assert.match(out[2], /sentry\./);
});

test('fetchBuild : métadonnées et assets extraits', async () => {
  const b = await fetchBuild({ fetch: async () => res(200, HTML_OK) });
  assert.equal(b.buildNumber, '671591');
  assert.equal(b.versionHash, 'deadbeef');
  assert.equal(b.assets.length, 2);
  assert.equal(b.cssAssets.length, 1);
  assert.match(b.assets[0], /web\./);
});

test('fetchBuild : BUILD_NUMBER absent → erreur explicite', async () => {
  await assert.rejects(
    fetchBuild({ fetch: async () => res(200, '<html>no env</html>') }),
    /BUILD_NUMBER_MISSING/,
  );
});

test('fetchBuild : aucun asset JS → erreur explicite', async () => {
  const html = '"BUILD_NUMBER":"671591"';
  await assert.rejects(fetchBuild({ fetch: async () => res(200, html) }), /NO_JS_ASSETS/);
});

test('fetchAppHtml : 500 puis 200 → réussi', async () => {
  let calls = 0;
  const html = await fetchAppHtml(3, async () => {
    calls++;
    return calls === 1 ? res(500, 'boom') : res(200, HTML_OK);
  });
  assert.match(html, /BUILD_NUMBER/);
  assert.equal(calls, 2);
});

test('fetchAppHtml : 403 non retenté', async () => {
  let calls = 0;
  await assert.rejects(
    fetchAppHtml(3, async () => {
      calls++;
      return res(403, 'forbidden');
    }),
    /HTTP 403/,
  );
  assert.equal(calls, 1);
});

test('fetchAppHtml : page challenge Cloudflare retentée', async () => {
  let calls = 0;
  const html = await fetchAppHtml(2, async () => {
    calls++;
    if (calls === 1) return res(200, '<html>Just a moment... BUILD_NUMBER</html>');
    return res(200, HTML_OK);
  });
  assert.match(html, /web\.123/);
  assert.equal(calls, 2);
});

test('fetchAppHtml : script jsd Cloudflare (présent sur toute page normale) ≠ challenge → aucun retry', async () => {
  const { isCompleteAppHtml } = require('../src/lib/canary');
  const real =
    HTML_OK +
    "<script>var u='/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=abc',a=document.createElement('script');</script>";
  assert.equal(isCompleteAppHtml(real), true);
  let calls = 0;
  const t0 = Date.now();
  const html = await fetchAppHtml(3, async () => {
    calls++;
    return res(200, real);
  });
  assert.equal(calls, 1, 'une page valide ne doit jamais être retentée');
  assert.ok(Date.now() - t0 < 300, 'aucune attente de retry');
  assert.match(html, /web\.123/);
});

test('isCompleteAppHtml : interstitiels et pages sans build numérique refusés', () => {
  const { isCompleteAppHtml } = require('../src/lib/canary');
  assert.equal(isCompleteAppHtml('<html>Just a moment... BUILD_NUMBER</html>'), false);
  assert.equal(isCompleteAppHtml('<script>window._cf_chl_opt={};</script>"BUILD_NUMBER":"671591"'), false);
  assert.equal(isCompleteAppHtml('<html>BUILD_NUMBER</html>'), false);
  assert.equal(isCompleteAppHtml(''), false);
  assert.equal(isCompleteAppHtml(null), false);
});
