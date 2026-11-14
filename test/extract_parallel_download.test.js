'use strict';
/**
 * Vitesse du scrape : les téléchargements (chunks + locale) démarrent AVANT
 * l'extraction CORE et la notification urgente, au lieu de les suivre.
 * Vérifie aussi :
 *  - locale et chunks téléchargés en parallèle
 *  - locale exclu du lot massif (pas deux écritures concurrentes du même fichier)
 *  - une erreur de téléchargement remonte toujours (pas avalée)
 *  - les strings de locale sont extraites après les téléchargements
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');

process.env.MIN_WEB_BYTES = '10';
process.env.MAX_CHUNK_SCAN_BYTES = '1000000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEB = 'web.aaaa1111bbbb2222.js';
const LOCALE_HASH = 'a1b2c3d4e5f60718';
const CHUNK_HASH = 'b1b2c3d4e5f60718';
const WEB_CONTENT =
  'var c={123:"' + LOCALE_HASH + '",999:"' + CHUNK_HASH + '"};' +
  '"./en-US.json":"123";"en-US":()=>n.e("123");';

let calls = [];
let onCoreSnapshot = null;
let failChunks = false;

const downloadPath = require.resolve('../src/lib/download');
const realDownload = require(downloadPath);
realDownload.downloadList = async (urls, dir, force) => {
  const call = { urls: [...urls], force, started: Date.now(), done: false };
  calls.push(call);
  for (const u of urls) {
    const name = path.basename(String(u).split('?')[0]);
    let body;
    if (/^web\./i.test(name)) body = WEB_CONTENT;
    else if (name.startsWith(LOCALE_HASH)) body = 'JSON.parse(\'{"hello1":"Bonjour tout le monde"}\')';
    else body = 'var routes={"/api/v9/test":1};';
    await sleep(25);
    if (failChunks && name.startsWith(CHUNK_HASH)) {
      call.done = true;
      throw new Error('EXTRACTION_ERROR: simulated download failure');
    }
    await fs.writeFile(path.join(dir, name), body);
  }
  call.done = true;
  return true;
};

delete require.cache[require.resolve('../src/lib/extract')];
const { analyzeAssets } = require('../src/lib/extract');

async function run(opts = {}) {
  calls = [];
  onCoreSnapshot = null;
  failChunks = false;
  const assetsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paraldl-'));
  const build = {
    assets: ['https://canary.discord.com/assets/' + WEB],
    cssAssets: [],
  };
  const res = await analyzeAssets(build, {
    forceRefresh: true,
    assetsDir,
    onCore: async () => {
      onCoreSnapshot = {
        calls: calls.length,
        started: calls.filter((c) => c.started).length,
        done: calls.filter((c) => c.done).length,
      };
    },
    ...opts,
  });
  return { res, assetsDir };
}

test('chunks + locale démarrent avant onCore et tournent en parallèle', async () => {
  const { res } = await run();
  assert.ok(onCoreSnapshot, 'onCore doit être appelé');
  assert.equal(onCoreSnapshot.calls, 3, 'web + chunks + locale lancés');
  assert.ok(onCoreSnapshot.done < onCoreSnapshot.calls, 'au moins un téléchargement encore en cours pendant onCore');
  assert.equal(res.strings.hello1, 'Bonjour tout le monde');
  // Le chunk hors locale a bien été téléchargé puis scanné.
  assert.ok(res.coverage.scanned >= 1);
  assert.ok(res.coverage.chunkUrlsMapped >= 2);
});

test('locale exclu du lot massif (une seule requête par fichier)', async () => {
  await run();
  const chunkCall = calls.find((c) => c.urls.some((u) => u.includes(CHUNK_HASH)));
  assert.ok(chunkCall);
  assert.equal(chunkCall.urls.filter((u) => u.includes(LOCALE_HASH)).length, 0);
  const localeCall = calls.find((c) => c.urls.some((u) => u.includes(LOCALE_HASH)));
  assert.ok(localeCall);
  assert.equal(localeCall.force, true, 'locale récupéré en force (plus frais)');
});

test('échec du téléchargement des chunks : analyzeAssets rejette (jamais avalé)', async () => {
  await assert.rejects(
    () =>
      run({
        onCore: async () => {
          failChunks = true; // l'échec survient pendant onCore
        },
      }),
    /simulated download failure/,
  );
});
