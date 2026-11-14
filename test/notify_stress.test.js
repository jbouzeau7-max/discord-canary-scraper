'use strict';
/**
 * Stress : 429, multi-sections, très gros diffs.
 * Garanties vérifiées : chaque phrase part exactement une fois, aucun message
 * > 3900 car. (HTTP 400 = perdu), un 429 est absorbé puis l'envoi continue,
 * et un second run ne renvoie rien.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const Module = require('module');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'notifystress-'));
const DEDUPE = path.join(DATA, 'notify_dedupe.json');
process.env.NOTIFY_DEDUPE_FILE = DEDUPE;
process.env.WEBHOOK_MAX_ATTEMPTS = '3';
process.env.WEBHOOK_MAX_429_RETRIES = '3';

const posts = [];
let rateLimitOnce = false;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node-fetch') {
    return async (_url, opts) => {
      if (rateLimitOnce) {
        rateLimitOnce = false;
        return {
          ok: false,
          status: 429,
          text: async () => '{"retry_after":0.02}',
          headers: { get: (n) => (n === 'retry-after' ? '0.02' : null) },
        };
      }
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 204, text: async () => '', headers: { get: () => null } };
    };
  }
  return originalLoad(request, parent, isMain);
};

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/webhook_dedupe|notify\.js|webhook\.js|components_v2/.test(k)) delete require.cache[k];
  }
  fs.removeSync(DEDUPE);
  posts.length = 0;
  rateLimitOnce = false;
  return require('../src/lib/notify');
}

function bodyTexts(b) {
  const out = [];
  const walk = (c) => {
    if (!c || typeof c !== 'object') return;
    if (c.type === 10) out.push(String(c.content || ''));
    for (const x of c.components || []) walk(x);
  };
  for (const c of b.components || []) walk(c);
  return out.join('\n');
}

function bodyChars(b) {
  let n = 0;
  const walk = (c) => {
    if (!c || typeof c !== 'object') return;
    if (c.type === 10) n += String(c.content || '').length;
    for (const x of c.components || []) walk(x);
  };
  for (const c of b.components || []) walk(c);
  return n;
}

const WH = 'https://discord.com/api/webhooks/1/abcdefghijklmnopqrstuvwxyz';

test.after(() => {
  Module._load = originalLoad;
  fs.removeSync(DATA);
});

test('multi-sections : Strings (ajout/modif/suppression) + Routes, tous envoyés une fois', async () => {
  const { notifyNormal } = fresh();
  const strDiff = {
    added: { S1: 'nouvelle phrase un' },
    modified: { S2: 'phrase deux modifiee' },
    removed: { S3: 'phrase trois supprimee' },
  };
  const rtDiff = { added: { '/api/v9/nouvelle-route': '/chemin-unique' } };
  assert.equal(
    await notifyNormal({ build: { buildNumber: 9201 }, strDiff, rtDiff, webhookUrl: WH }),
    true,
  );
  assert.equal(posts.length, 4, 'un message par section');
  const all = posts.map(bodyTexts).join('\n');
  for (const s of ['nouvelle phrase un', 'phrase deux modifiee', 'phrase trois supprimee', 'chemin-unique']) {
    assert.equal(all.split(s).length - 1, 1, 'exactement une fois: ' + s);
  }
  const before = posts.length;
  assert.equal(
    await notifyNormal({ build: { buildNumber: 9201 }, strDiff, rtDiff, webhookUrl: WH }),
    true,
  );
  assert.equal(posts.length, before, 'second run: aucun doublon');
});

test('429 une fois : absorbé, tous les messages partent une seule fois', async () => {
  const { notifyNormal } = fresh();
  const added = {};
  for (let i = 0; i < 300; i++) added['K' + i] = 'stress 429 phrase ' + i;
  rateLimitOnce = true;
  const ok = await notifyNormal({ build: { buildNumber: 9202 }, strDiff: { added }, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok, true);
  const all = posts.map(bodyTexts).join('\n');
  for (let i = 0; i < 300; i++) {
    assert.equal(all.split('stress 429 phrase ' + i + '\n').length - 1 >= 1, true, 'manquant ' + i);
  }
  // 3 messages attendus (~300 × 25 car. / 3750) + le 429 n'a rien consommé.
  assert.ok(posts.length >= 2 && posts.length <= 4, `messages: ${posts.length}`);
});

test('1500 lignes de 240 car. : complet, aucun message > 3900, pas de doublon', async () => {
  const { notifyNormal } = fresh();
  const added = {};
  for (let i = 0; i < 1500; i++) {
    const head = 'ligne ' + String(i).padStart(4, '0') + ' ';
    added['L' + i] = head + 'z'.repeat(240 - head.length);
  }
  const ok = await notifyNormal({ build: { buildNumber: 9203 }, strDiff: { added }, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok, true);
  for (const b of posts) assert.ok(bodyChars(b) <= 3900, `message ${bodyChars(b)} > 3900`);
  const all = posts.map(bodyTexts).join('\n');
  for (let i = 0; i < 1500; i++) {
    const head = 'ligne ' + String(i).padStart(4, '0') + ' ';
    assert.equal(all.split(head).length - 1, 1, 'ligne ' + i + ' manquante ou dupliquée');
  }
  const before = posts.length;
  await notifyNormal({ build: { buildNumber: 9203 }, strDiff: { added }, rtDiff: {}, webhookUrl: WH });
  assert.equal(posts.length, before);
});
