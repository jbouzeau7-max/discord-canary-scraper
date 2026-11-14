'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { fetchJsonWithRetry, safeJson, stripBom } = require('../src/lib/http');
const { loadLastMap } = require('../src/index');

test('stripBom : BOM retiré, texte normal inchangé', () => {
  assert.equal(stripBom('\uFEFF{"a":1}'), '{"a":1}');
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
  assert.equal(stripBom(null), '');
  assert.equal(stripBom(undefined), '');
});

test('fetchJsonWithRetry : JSON préfixé d\'un BOM parsé', async () => {
  const res = {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async text() {
      return '\uFEFF{"ok":true}';
    },
  };
  const data = await fetchJsonWithRetry('https://x.test/a', {
    fetch: async () => res,
    baseDelayMs: 1,
    maxDelayMs: 2,
  });
  assert.deepEqual(data, { ok: true });
});

test('safeJson : BOM retiré', async () => {
  const data = await safeJson({
    headers: { get: () => 'application/json' },
    async text() {
      return '\uFEFF[1,2]';
    },
  });
  assert.deepEqual(data, [1, 2]);
});

test('loadLastMap : tableau legacy ignoré', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lastmap-'));
  const f = path.join(dir, 'last.json');
  await fs.writeJson(f, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(await loadLastMap(f), {});
});

test('loadLastMap : null / chaîne ignorés', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lastmap-'));
  const f = path.join(dir, 'last.json');
  await fs.writeJson(f, null);
  assert.deepEqual(await loadLastMap(f), {});
  await fs.writeFile(f, '"str"');
  assert.deepEqual(await loadLastMap(f), {});
});

test('loadLastMap : data imbriqué et clés de métadonnées exclues', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lastmap-'));
  const f = path.join(dir, 'last.json');
  await fs.writeJson(f, {
    buildNumber: '1',
    updatedAt: 'x',
    data: { alpha: 'v1', beta: 'v2' },
  });
  assert.deepEqual(await loadLastMap(f), { alpha: 'v1', beta: 'v2' });
});

test('loadLastMap : map plate legacy', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lastmap-'));
  const f = path.join(dir, 'last.json');
  await fs.writeJson(f, { alpha: 'v1', count: 3, buildNumber: '9' });
  assert.deepEqual(await loadLastMap(f), { alpha: 'v1' });
});

test('loadLastMap : fichier absent ou JSON invalide → objet vide', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lastmap-'));
  assert.deepEqual(await loadLastMap(path.join(dir, 'nope.json')), {});
  const bad = path.join(dir, 'bad.json');
  await fs.writeFile(bad, '{oops');
  assert.deepEqual(await loadLastMap(bad), {});
});
