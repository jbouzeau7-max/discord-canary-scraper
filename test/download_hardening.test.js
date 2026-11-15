'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {
  downloadList,
  resetDownloadStats,
  getDownloadStats,
} = require('../src/lib/download');

const JS = Buffer.from('!function(){console.log("discord chunk");}();'.repeat(10));

function res(status, buf, headers = {}) {
  const body = (async function* () {
    if (buf && buf.length) yield buf;
  })();
  body.destroy = () => {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (String(n).toLowerCase() in headers ? String(headers[String(n).toLowerCase()]) : null) },
    body,
  };
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dl-test-'));
}

const URL_A = 'https://cdn.test/assets/web.aaa.js';
const URL_B = 'https://cdn.test/assets/chunk.bbb.js';

test('downloadList : téléchargement réussi et stats', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  await downloadList([URL_A], dir, true, { fetch: async () => res(200, JS) });
  assert.ok(await fs.pathExists(path.join(dir, 'web.aaa.js')));
  const s = getDownloadStats();
  assert.equal(s.downloaded, 1);
  assert.equal(s.failed, 0);
  assert.equal(s.jobs, 1);
});

test('downloadList : 500 puis 200 → retry réussi', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  let calls = 0;
  await downloadList([URL_A], dir, true, {
    fetch: async () => {
      calls++;
      return calls === 1 ? res(500, Buffer.from('err')) : res(200, JS);
    },
  });
  assert.equal(calls, 2);
  assert.equal(getDownloadStats().retried, 1);
  assert.equal(getDownloadStats().http5xx, 1);
});

test('downloadList : 404 non retenté, fichier absent', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  let calls = 0;
  await assert.rejects(
    downloadList([URL_A], dir, true, {
      fetch: async () => {
        calls++;
        return res(404, Buffer.from('nope'));
      },
    }),
    /download success ratio/,
  );
  assert.equal(calls, 1);
  assert.equal(await fs.pathExists(path.join(dir, 'web.aaa.js')), false);
  assert.equal(getDownloadStats().failed, 1);
});

test('downloadList : 429 respecte Retry-After puis réussit', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  let calls = 0;
  await downloadList([URL_A], dir, true, {
    fetch: async () => {
      calls++;
      return calls === 1
        ? res(429, Buffer.from('slow down'), { 'retry-after': '0.01' })
        : res(200, JS);
    },
  });
  assert.equal(calls, 2);
  assert.equal(getDownloadStats().http429, 1);
  assert.ok(await fs.pathExists(path.join(dir, 'web.aaa.js')));
});

test('downloadList : corps HTML refusé (même pour un .css)', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  const html = Buffer.from('<!DOCTYPE html><html><body>blocked</body></html>');
  await assert.rejects(
    downloadList(['https://cdn.test/assets/app.zzz.css'], dir, true, {
      fetch: async () => res(200, html),
    }),
    /download success ratio/,
  );
  assert.equal(await fs.pathExists(path.join(dir, 'app.zzz.css')), false);
  assert.equal(getDownloadStats().failed, 1);
});

test('downloadList : noms de fichiers dupliqués → un seul téléchargement', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  let calls = 0;
  await downloadList(
    ['https://cdn.test/assets/web.aaa.js', 'https://cdn.test/assets/web.aaa.js?v=2'],
    dir,
    true,
    {
      fetch: async () => {
        calls++;
        return res(200, JS);
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(getDownloadStats().jobs, 1);
});

test('downloadList : cache HTML existant re-téléchargé', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'web.aaa.js'), '<!DOCTYPE html><html>oops</html>');
  let calls = 0;
  await downloadList([URL_A], dir, false, {
    fetch: async () => {
      calls++;
      return res(200, JS);
    },
  });
  assert.equal(calls, 1);
  const saved = await fs.readFile(path.join(dir, 'web.aaa.js'));
  assert.ok(saved.includes('discord chunk'));
});

test('downloadList : cache valide réutilisé sans requête', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'web.aaa.js'), JS);
  let calls = 0;
  await downloadList([URL_A], dir, false, {
    fetch: async () => {
      calls++;
      return res(200, JS);
    },
  });
  assert.equal(calls, 0);
  assert.equal(getDownloadStats().skipped, 1);
});

test('downloadList : ratio de succès insuffisant → erreur bloquante', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  const urls = Array.from({ length: 6 }, (_, i) => `https://cdn.test/assets/c${i}.js`);
  await assert.rejects(
    downloadList(urls, dir, true, { fetch: async () => res(404, Buffer.from('x')) }),
    /download success ratio/,
  );
});

test('downloadList : URLs hors /assets/ ou non JS/CSS ignorées', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  let calls = 0;
  await downloadList(
    ['https://cdn.test/other.js', 'https://cdn.test/assets/img.png', null, ''],
    dir,
    true,
    {
      fetch: async () => {
        calls++;
        return res(200, JS);
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(getDownloadStats().jobs, 0);
});

test('downloadList : contenu trop volumineux rejeté sans écriture', async () => {
  resetDownloadStats();
  const dir = await tmpDir();
  const big = Buffer.alloc(13 * 1024 * 1024, 1);
  await assert.rejects(
    downloadList([URL_B], dir, true, { fetch: async () => res(200, big) }),
    /download success ratio/,
  );
  assert.equal(await fs.pathExists(path.join(dir, 'chunk.bbb.js')), false);
  assert.equal(getDownloadStats().failed, 1);
});
