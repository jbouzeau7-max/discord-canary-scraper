'use strict';

// Fixer les paramètres avant le chargement du module : une tentative, limites
// modestes pour tester leurs frontières sans gros buffers ni attente réseau.
process.env.DOWNLOAD_RETRIES = '1';
process.env.MAX_ASSET_BYTES = '1024';
process.env.MAX_WEB_BYTES = '2048';
process.env.MIN_WEB_BYTES = '1024';
process.env.MIN_DOWNLOAD_SUCCESS_RATIO = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { loadLastMap } = require('../src/index');
const {
  downloadList,
  getDownloadStats,
  resetDownloadStats,
} = require('../src/lib/download');

async function makeDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'canary-extra-matrix-'));
}

function response(status, bytes, headers = {}) {
  const body = (async function* () {
    if (bytes.length) yield bytes;
  })();
  body.destroy = () => {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(headers, key)
          ? String(headers[key])
          : null;
      },
    },
    body,
  };
}

const ASSET_CSS = 'https://cdn.discordapp.com/assets/theme.css';
const ASSET_JS = 'https://cdn.discordapp.com/assets/chunk.js';
const WEB_JS = 'https://cdn.discordapp.com/assets/web.canary.js';

// 1
test('un Content-Length supérieur au plafond est rejeté avant lecture et libère le corps', async () => {
  resetDownloadStats();
  const dir = await makeDir();
  let reads = 0;
  let destroys = 0;
  const body = (async function* () {
    reads++;
    yield Buffer.from('unreachable');
  })();
  body.destroy = () => { destroys++; };
  try {
    await assert.rejects(
      downloadList([ASSET_CSS], dir, true, {
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: { get: (name) => name === 'content-length' ? '1025' : null },
          body,
        }),
      }),
      /download success ratio/,
    );
    assert.equal(reads, 0);
    assert.equal(destroys, 1);
    assert.equal(getDownloadStats().failed, 1);
    assert.equal(await fs.pathExists(path.join(dir, 'theme.css')), false);
  } finally {
    await fs.remove(dir);
  }
});

// 2
test('un asset CSS de taille exactement égale au plafond de 1024 octets est accepté', async () => {
  resetDownloadStats();
  const dir = await makeDir();
  const bytes = Buffer.alloc(1024, 0x78);
  try {
    await downloadList([ASSET_CSS], dir, true, {
      fetch: async () => response(200, bytes),
    });
    assert.deepEqual(await fs.readFile(path.join(dir, 'theme.css')), bytes);
    assert.equal(getDownloadStats().downloaded, 1);
    assert.equal(getDownloadStats().failed, 0);
  } finally {
    await fs.remove(dir);
  }
});

// 3
test('un fichier JavaScript de 63 octets est rejeté juste sous son minimum', async () => {
  resetDownloadStats();
  const dir = await makeDir();
  try {
    await assert.rejects(
      downloadList([ASSET_JS], dir, true, {
        fetch: async () => response(200, Buffer.alloc(63, 0x78)),
      }),
      /download success ratio/,
    );
    assert.equal(await fs.pathExists(path.join(dir, 'chunk.js')), false);
    assert.equal(getDownloadStats().failed, 1);
  } finally {
    await fs.remove(dir);
  }
});

// 4
test('un fichier JavaScript de 64 octets est accepté à la borne minimale', async () => {
  resetDownloadStats();
  const dir = await makeDir();
  const bytes = Buffer.alloc(64, 0x78);
  try {
    await downloadList([ASSET_JS], dir, true, {
      fetch: async () => response(200, bytes),
    });
    assert.deepEqual(await fs.readFile(path.join(dir, 'chunk.js')), bytes);
    assert.equal(getDownloadStats().downloaded, 1);
  } finally {
    await fs.remove(dir);
  }
});

// 5
test('un asset CSS de 15 octets est refusé sous le minimum générique du corps', async () => {
  resetDownloadStats();
  const dir = await makeDir();
  try {
    await assert.rejects(
      downloadList([ASSET_CSS], dir, true, {
        fetch: async () => response(200, Buffer.alloc(15, 0x78)),
      }),
      /download success ratio/,
    );
    assert.equal(await fs.pathExists(path.join(dir, 'theme.css')), false);
    assert.equal(getDownloadStats().failed, 1);
  } finally {
    await fs.remove(dir);
  }
});

// 6
test('un asset CSS de 16 octets passe la taille minimale générique du corps', async () => {
  resetDownloadStats();
  const dir = await makeDir();
  const bytes = Buffer.alloc(16, 0x78);
  try {
    await downloadList([ASSET_CSS], dir, true, {
      fetch: async () => response(200, bytes),
    });
    assert.deepEqual(await fs.readFile(path.join(dir, 'theme.css')), bytes);
    assert.equal(getDownloadStats().downloaded, 1);
  } finally {
    await fs.remove(dir);
  }
});

// 7
test('un cache de 64 octets n’est pas considéré comme suffisamment fiable et est revalidé', async () => {
  resetDownloadStats();
  const dir = await makeDir();
  const cached = Buffer.alloc(64, 0x78);
  const fresh = Buffer.alloc(80, 0x79);
  try {
    await fs.writeFile(path.join(dir, 'web.canary.js'), cached);
    let calls = 0;
    await downloadList([WEB_JS], dir, false, {
      fetch: async () => {
        calls++;
        return response(200, fresh);
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(await fs.readFile(path.join(dir, 'web.canary.js')), fresh);
    assert.equal(getDownloadStats().downloaded, 1);
    assert.equal(getDownloadStats().skipped, 0);
  } finally {
    await fs.remove(dir);
  }
});

// 8
test('loadLastMap ignore un tableau JSON historique au lieu de créer des clés numériques', async () => {
  const dir = await makeDir();
  const file = path.join(dir, 'last_extract.json');
  try {
    await fs.writeJson(file, ['ancienne valeur', { route: '/legacy' }]);
    assert.deepEqual(await loadLastMap(file), {});
  } finally {
    await fs.remove(dir);
  }
});
