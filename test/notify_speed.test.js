'use strict';

/**
 * Vitesse d'envoi SANS perte :
 * - moins de messages (champs 3750 → 1 message par bloc, ≤ 3900 car./message)
 * - réservation groupée (1 écriture de dedupe au lieu de N avant l'envoi)
 * - échec partiel : seuls les messages ratés repartent (aucun doublon, rien d'oublié)
 * - lot « pending » (crash) : jamais considéré comme envoyé
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const Module = require('module');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'notifyspeed-'));
const DEDUPE = path.join(DATA, 'notify_dedupe.json');
process.env.NOTIFY_DEDUPE_FILE = DEDUPE;
process.env.WEBHOOK_MAX_ATTEMPTS = '1';

const posts = []; // { body, ok }
let failOnCall = 0; // numéro d'appel (1-based) à faire échouer
let call = 0;

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'node-fetch') {
    return async (_url, opts) => {
      call++;
      const body = JSON.parse(opts.body);
      const fail = call === failOnCall;
      posts.push({ body, ok: !fail });
      if (fail) return { ok: false, status: 500, text: async () => 'boom', headers: { get: () => null } };
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
  failOnCall = 0;
  call = 0;
  return require('../src/lib/notify');
}

function textsOf(body) {
  const out = [];
  const walk = (c) => {
    if (!c || typeof c !== 'object') return;
    if (c.type === 10) out.push(String(c.content || ''));
    for (const x of c.components || []) walk(x);
  };
  for (const c of body.components || []) walk(c);
  return out;
}

function bodyChars(body) {
  return textsOf(body).reduce((s, t) => s + t.length, 0);
}

function allText() {
  return posts.filter((p) => p.ok).map((p) => textsOf(p.body).join('\n')).join('\n');
}

const WH = 'https://discord.com/api/webhooks/1/abcdefghijklmnopqrstuvwxyz';

function bigDiff(n = 1500) {
  const added = {};
  for (let i = 0; i < n; i++) added['KEY_' + i] = 'phrase numero ' + i + ' fin';
  return added;
}

test.after(() => {
  Module._load = originalLoad;
  fs.removeSync(DATA);
});

test('1500 strings : tous envoyés, 1 message par bloc ≤ 3900 car., ~30 % de messages en moins', async () => {
  const { notifyNormal } = fresh();
  const added = bigDiff(1500);
  const ok = await notifyNormal({ build: { buildNumber: 9101 }, strDiff: { added }, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok, true);

  const txt = allText();
  for (let i = 0; i < 1500; i++) assert.ok(txt.includes('phrase numero ' + i + ' fin'), 'manquant ' + i);

  // Aucun message ne peut dépasser la limite Components V2 (400 = message perdu).
  for (const p of posts) {
    assert.ok(bodyChars(p.body) <= 3900, `message trop long: ${bodyChars(p.body)}`);
  }
  const totalChars = Object.values(added).reduce((s, v) => s + v.length + 3, 0);
  const n = posts.length;
  assert.ok(n <= Math.ceil(totalChars / 3600) + 2, `trop de messages: ${n}`);
  const oldCount = 2 * Math.ceil(totalChars / 5100); // ancien: 5 champs de 1020 → 2 messages
  assert.ok(n < oldCount, `pas d'amélioration: ${n} >= ${oldCount}`);
});

test('réservation groupée : ≤ N+4 écritures de dedupe (au lieu de 2N)', async () => {
  const { notifyNormal } = fresh();
  const added = bigDiff(800);
  const realWrite = fs.writeJson.bind(fs);
  let writes = 0;
  fs.writeJson = (...args) => {
    writes++;
    return realWrite(...args);
  };
  try {
    const ok = await notifyNormal({ build: { buildNumber: 9102 }, strDiff: { added }, rtDiff: {}, webhookUrl: WH });
    assert.equal(ok, true);
  } finally {
    fs.writeJson = realWrite;
  }
  const n = posts.length;
  assert.ok(n > 3, 'test doit produire plusieurs messages');
  assert.ok(writes <= n + 4, `${writes} écritures pour ${n} messages (claim groupé attendu)`);
});

test('échec du 3e message : seuls les ratés repartent, aucun doublon, rien d\'oublié', async () => {
  const { notifyNormal } = fresh();
  const added = bigDiff(1200);
  failOnCall = 3;
  const ok1 = await notifyNormal({ build: { buildNumber: 9103 }, strDiff: { added }, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok1, false);
  const failedBody = posts.find((p) => !p.ok).body;
  const failedText = textsOf(failedBody).join('\n');
  const sentFirst = posts.filter((p) => p.ok).length;
  assert.ok(sentFirst >= 2);

  failOnCall = 0;
  call = 0;
  const before = posts.length;
  const ok2 = await notifyNormal({ build: { buildNumber: 9103 }, strDiff: { added }, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok2, true);
  const resent = posts.slice(before);
  assert.equal(resent.length, 1, 'seul le message raté doit repartir');
  assert.ok(textsOf(resent[0].body).join('\n') === failedText, 'contenu raté renvoyé à l\'identique');

  // Aucune phrase en double dans les messages réellement livrés.
  const delivered = posts.filter((p) => p.ok).map((p) => textsOf(p.body).join('\n')).join('\n');
  for (let i = 0; i < 1200; i += 97) {
    const phrase = 'phrase numero ' + i + ' fin';
    assert.equal(delivered.split(phrase).length - 1, 1, 'doublon pour ' + i);
  }
});

test('lot « pending » (crash avant envoi) : échec, aucun message, rien marqué livré', async () => {
  const { notifyNormal } = fresh();
  const dedupe = require('../src/lib/webhook_dedupe');
  const added = { A: 'alpha', B: 'beta' };
  // Simule un crash : toutes les clés du lot restent pending.
  const { sectionEmbeds, COMPONENT_FIELD_MAX } = require('../src/lib/notify');
  const embeds = sectionEmbeds({ label: 'Ajoutés · 2', color: 1, count: 2, lines: ['+ alpha', '+ beta'] }, { title: 'Strings', bn: '9104', ts: new Date().toISOString(), maxFieldChars: COMPONENT_FIELD_MAX });
  const batchKey = 'mapbatch:' + dedupe.stableMapKey('9104', 'Strings', { added, modified: {}, removed: {} });
  const keys = embeds.map((_, i) => `${batchKey}:s0:p${i}:${embeds.length}`);
  await dedupe.claimMany(keys);
  // Le lot lui-même doit aussi être pending (claimBatch avant envoi).
  await dedupe.claimState(batchKey);

  const ok = await notifyNormal({ build: { buildNumber: 9104 }, strDiff: { added }, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok, false);
  assert.equal(posts.length, 0, 'aucun message pendant un pending');
  for (const k of keys) assert.equal(await dedupe.claimState(k), 'pending');
});
