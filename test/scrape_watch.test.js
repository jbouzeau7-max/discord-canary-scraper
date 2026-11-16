const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { shouldScrape, probeVersionHash, probeHtml, main } = require('../src/scrape_watch');

const res = (body, ok = true) => ({ ok, json: async () => JSON.parse(body), text: async () => body });

describe('scrape_watch', () => {
  test('shouldScrape: hash changé → oui', () => {
    assert.equal(shouldScrape({ versionHash: 'aaa1111', buildNumber: '100' }, { versionHash: 'bbb2222' }), true);
  });
  test('shouldScrape: identique → non', () => {
    assert.equal(shouldScrape({ versionHash: 'aaa1111', buildNumber: '100' }, { versionHash: 'aaa1111' }), false);
    assert.equal(shouldScrape({ versionHash: 'aaa1111' }, null), false);
  });
  test('shouldScrape: build plus récent seulement', () => {
    assert.equal(shouldScrape({ buildNumber: '100' }, { buildNumber: '101' }), true);
    assert.equal(shouldScrape({ buildNumber: '100' }, { buildNumber: '99' }), false);
  });
  test('shouldScrape: pas d’état local → oui', () => {
    assert.equal(shouldScrape({}, { versionHash: 'abcdef1' }), true);
  });
  test('probeVersionHash parse + erreurs', async () => {
    assert.equal(await probeVersionHash(async () => res('{"hash":"b205f700c2d6","required":false}')), 'b205f700c2d6');
    assert.equal(await probeVersionHash(async () => res('{}', false)), null);
    assert.equal(await probeVersionHash(async () => { throw new Error('net'); }), null);
    assert.equal(await probeVersionHash(async () => res('{"hash":"<x>"}')), null);
  });
  test('probeHtml extrait BUILD_NUMBER', async () => {
    const html = '<script>window.GLOBAL_ENV = {"BUILD_NUMBER":"673959","VERSION_HASH":"b205f700"};</script>';
    const r = await probeHtml(async () => res(html));
    assert.equal(r && r.buildNumber, '673959');
  });
  test('main: scrape au démarrage puis sur changement uniquement', async () => {
    process.env.SCRAPE_WATCH_COMMIT = '0';
    const calls = [];
    let n = 0;
    const fetchImpl = async () => res(JSON.stringify({ hash: n++ < 2 ? '0000000' : 'fffffff1' }));
    await main({
      fetchImpl,
      scrape: async (r) => { calls.push(r); return 0; },
      watchMs: 1200,
      tickMs: 250,
    });
    assert.equal(calls[0], 'startup');
    assert.ok(calls.length >= 2 && /remote/.test(calls[1]), JSON.stringify(calls));
  });
});
