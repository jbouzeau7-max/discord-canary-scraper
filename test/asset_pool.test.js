'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { clearAssetsDir, downloadList, isImmutableName, poolDirFor } = require('../src/lib/download');

const JS = 'console.log("chunk content long enough to pass the 64 bytes size check of download.js");';

test('isImmutableName: chunks hashés oui, web.* / noms courts non', () => {
  assert.equal(isImmutableName('121502cfb199a1f6.js'), true);
  assert.equal(isImmutableName('996907.7aa24c2a1735af5c.js'), true);
  assert.equal(isImmutableName('web.e6ac22f6e88c8044.js'), false);
  assert.equal(isImmutableName('foo.js'), false);
  assert.equal(isImmutableName('121502cfb199a1f6.js.part.1.abc'), false);
});

test('pool: chunk du build précédent réutilisé sans requête réseau', async () => {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pool-')), 'assets');
  await fs.ensureDir(dir);
  await fs.writeFile(path.join(dir, 'aaaaaaaaaaaaaaaa.js'), JS);
  await fs.writeFile(path.join(dir, 'web.bbbbbbbbbbbbbbbb.js'), JS);
  await clearAssetsDir(dir);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.deepEqual(await fs.readdir(poolDirFor(dir)), ['aaaaaaaaaaaaaaaa.js']);
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { ok: true, status: 200, headers: { get: () => null }, body: null, buffer: async () => Buffer.from(JS) };
  };
  await downloadList(['https://x/assets/aaaaaaaaaaaaaaaa.js'], dir, false, { fetch });
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(path.join(dir, 'aaaaaaaaaaaaaaaa.js'), 'utf8'), JS);
});

test('pool: chunk HTML corrompu ignoré (re-téléchargé)', async () => {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pool-')), 'assets');
  await fs.ensureDir(poolDirFor(dir));
  await fs.ensureDir(dir);
  await fs.writeFile(path.join(poolDirFor(dir), 'cccccccccccccccc.js'), '<!DOCTYPE html><html>' + 'x'.repeat(100));
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw new Error('offline');
  };
  await assert.rejects(downloadList(['https://x/assets/cccccccccccccccc.js'], dir, false, { fetch }));
  assert.ok(calls >= 1);
});
