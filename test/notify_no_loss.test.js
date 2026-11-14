'use strict';

/**
 * Non-régression « aucun message oublié » :
 * - plus de plafond silencieux (1000 strings / 300 expériences)
 * - un lot « pending » (run interrompu) n'est PAS considéré comme envoyé
 * - le fichier de dedupe garde assez de clés
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const Module = require('module');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'noloss-test-'));
const DEDUPE = path.join(DATA, 'notify_dedupe.json');
process.env.NOTIFY_DEDUPE_FILE = DEDUPE;

const bodies = [];
let failAll = false;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node-fetch') {
    return async (url, opts) => {
      if (failAll) return { ok: false, status: 500, text: async () => '', headers: { get: () => null } };
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 204, text: async () => '', headers: { get: () => null } };
    };
  }
  return originalLoad(request, parent, isMain);
};
process.env.WEBHOOK_MAX_ATTEMPTS = '1';

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/webhook_dedupe|notify\.js|webhook\.js|components_v2/.test(k)) delete require.cache[k];
  }
  fs.removeSync(DEDUPE);
  bodies.length = 0;
  failAll = false;
  return require('../src/lib/notify');
}

function allText() {
  const out = [];
  const walk = (c) => {
    if (!c || typeof c !== 'object') return;
    if (c.type === 10) out.push(c.content);
    for (const x of c.components || []) walk(x);
  };
  for (const b of bodies) for (const c of b.components || []) walk(c);
  return out.join('\n');
}

const WH = 'https://discord.com/api/webhooks/1/abcdefghijklmnopqrstuvwxyz';

test.after(() => {
  Module._load = originalLoad;
  fs.removeSync(DATA);
});

test('1500 strings ajoutés : TOUS envoyés (plus de plafond à 1000)', async () => {
  const { notifyNormal } = fresh();
  const added = {};
  for (let i = 0; i < 1500; i++) added['KEY_' + i] = 'phrase numero ' + i + ' fin';
  const ok = await notifyNormal({ build: { buildNumber: 9001 }, strDiff: { added }, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok, true);
  const txt = allText();
  for (let i = 0; i < 1500; i++) assert.ok(txt.includes('phrase numero ' + i + ' fin'), 'manquant ' + i);
  assert.ok(!/de plus/.test(txt), 'aucune ligne « … +N de plus »');
});

test('400 expériences ajoutées : TOUTES envoyées (plus de plafond à 300)', async () => {
  const { notifyUrgent } = fresh();
  const added = [];
  for (let i = 0; i < 400; i++) added.push({ id: '2026-11_exp_noloss_' + i, kind: 'user' });
  const ok = await notifyUrgent({ build: { buildNumber: 9002 }, expDiff: { added }, webhookUrl: WH });
  assert.equal(ok, true);
  const txt = allText();
  for (let i = 0; i < 400; i++) assert.ok(new RegExp('exp_noloss_' + i + '\\b').test(txt), 'manquant ' + i);
});

test('lot resté « pending » (run interrompu) → échec, pas un faux succès', async () => {
  const { notifyNormal } = fresh();
  const dedupe = require('../src/lib/webhook_dedupe');
  const strDiff = { added: { A: 'alpha' } };
  const key = 'mapbatch:' + dedupe.stableMapKey('9003', 'Strings', { added: strDiff.added, modified: {}, removed: {} });
  assert.equal(await dedupe.claimState(key), 'claimed');
  const ok = await notifyNormal({ build: { buildNumber: 9003 }, strDiff, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok, false, 'pending ne doit pas faire avancer l\'état');
  assert.equal(bodies.length, 0);
});

test('lot déjà livré → succès sans renvoi (pas de doublon)', async () => {
  const { notifyNormal } = fresh();
  const strDiff = { added: { B: 'beta' } };
  assert.equal(await notifyNormal({ build: { buildNumber: 9004 }, strDiff, rtDiff: {}, webhookUrl: WH }), true);
  const n = bodies.length;
  assert.ok(n > 0);
  assert.equal(await notifyNormal({ build: { buildNumber: 9004 }, strDiff, rtDiff: {}, webhookUrl: WH }), true);
  assert.equal(bodies.length, n, 'aucun doublon');
});

test('échec HTTP puis retry : le message part au run suivant', async () => {
  const { notifyNormal } = fresh();
  const strDiff = { added: { C: 'gamma' } };
  failAll = true;
  assert.equal(await notifyNormal({ build: { buildNumber: 9005 }, strDiff, rtDiff: {}, webhookUrl: WH }), false);
  failAll = false;
  assert.equal(await notifyNormal({ build: { buildNumber: 9005 }, strDiff, rtDiff: {}, webhookUrl: WH }), true);
  assert.ok(allText().includes('gamma'));
});

test('dedupe : garde > 800 clés récentes', async () => {
  fresh();
  const d = require('../src/lib/webhook_dedupe');
  const keys = Array.from({ length: 2000 }, (_, i) => 'k' + i);
  await d.markPostedMany(keys);
  const s = await d.sentSet(keys);
  assert.equal(s.size, 2000);
});
