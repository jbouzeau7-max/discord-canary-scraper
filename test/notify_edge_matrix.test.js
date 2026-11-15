'use strict';

/**
 * Matrice de fiabilité dédiée à notify.js. Tous les envois sont interceptés au
 * niveau de node-fetch ; aucun appel réseau ni temporisation réelle n'est fait.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('fs-extra');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-edge-matrix-'));
const dedupeFile = path.join(scratch, 'notify_dedupe.json');
process.env.NOTIFY_DEDUPE_FILE = dedupeFile;
process.env.WEBHOOK_MAX_ATTEMPTS = '1';
process.env.WEBHOOK_MAX_429_RETRIES = '0';
process.env.WEBHOOK_MIN_GAP_MS = '0';
process.env.NOTIFY_FIELD_MAX_CHARS = '3750';

const WH = 'https://discord.com/api/webhooks/321/abcdefghijklmnopqrstuvwxyz';
const TS = '2026-01-02T03:04:05.000Z';
const posts = [];
let nextResponse = () => ({ ok: true, status: 204, text: '' });
const originalLoad = Module._load;
const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => {};
console.warn = () => {};
Module._load = function (request, parent, isMain) {
  if (request === 'node-fetch') {
    return async (url, opts) => {
      posts.push({ url, body: JSON.parse(opts.body) });
      const r = nextResponse();
      return {
        ok: r.ok,
        status: r.status,
        text: async () => r.text || '',
        headers: { get: (name) => (r.headers && r.headers[name.toLowerCase()]) || null },
      };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function fresh() {
  for (const k of Object.keys(require.cache)) {
    if (/webhook_dedupe|notify\.js|webhook\.js|components_v2|webhook_identity/.test(k)) delete require.cache[k];
  }
  fs.removeSync(dedupeFile);
  posts.length = 0;
  nextResponse = () => ({ ok: true, status: 204, text: '' });
  return require('../src/lib/notify');
}

function textOf(body) {
  const out = [];
  const walk = (c) => {
    if (!c || typeof c !== 'object') return;
    if (c.type === 10 && typeof c.content === 'string') out.push(c.content);
    for (const child of c.components || []) walk(child);
  };
  for (const c of body.components || []) walk(c);
  return out.join('\n');
}
function sentText() { return posts.map((p) => textOf(p.body)).join('\n'); }
function makeSection(lines, extra = {}) {
  return { label: 'Éléments', color: 0x123456, lines, ...extra };
}
function sectionEmbeds(lines, maxFieldChars, extra = {}) {
  const { sectionEmbeds: render } = fresh();
  return render(makeSection(lines, extra), {
    title: 'Routes', bn: '42', ts: TS, maxFieldChars,
  });
}
function allFields(embeds) { return embeds.flatMap((e) => e.fields || []); }
function addCase(list, name, fn) { list.push([name, fn]); }
const cases = [];

// 50 cas sur les frontières et métadonnées du rendu pur des sections.
for (const [name, value] of [
  ['section null', null],
  ['section undefined', undefined],
  ['lignes absentes', { label: 'x' }],
  ['lignes nulles', { label: 'x', lines: null }],
  ['tableau de lignes vide', makeSection([])],
]) {
  addCase(cases, `section vide — ${name}`, () => {
    const { sectionEmbeds: render } = fresh();
    assert.deepEqual(render(value, { title: 'T', bn: '1', ts: TS }), []);
  });
}
for (const [name, limit, expected] of [
  ['199 sous le plancher', 199, 1],
  ['200 au plancher inclus', 200, 1],
  ['201 juste au-dessus du plancher', 201, 1],
  ['1020 champ classique', 1020, 1],
  ['1899 dernier seuil multi-champ', 1899, 1],
  ['1900 seuil un champ par embed', 1900, 1],
  ['3800 plafond admis', 3800, 1],
  ['NaN revient à la limite standard', NaN, 1],
]) {
  addCase(cases, `limite de champ — ${name}`, () => {
    const embeds = sectionEmbeds(['une ligne courte'], limit);
    assert.equal(embeds.length, expected);
    assert.equal(allFields(embeds)[0].value, '```diff\nune ligne courte\n```');
  });
}
for (let n = 1; n <= 5; n++) {
  addCase(cases, `petite section de ${n} entrée${n > 1 ? 's' : ''} tient dans un champ`, () => {
    const lines = Array.from({ length: n }, (_, i) => `+ item ${i}`);
    const embeds = sectionEmbeds(lines, 1020);
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0].fields.length, 1);
    assert.equal(embeds[0].fields[0].value, '```diff\n' + lines.join('\n') + '\n```');
  });
}
addCase(cases, 'six entrées quittent le format petite section', () => {
  const embeds = sectionEmbeds(Array.from({ length: 6 }, (_, i) => `L${i}`), 1020);
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0].fields.length, 1);
  assert.match(embeds[0].fields[0].value, /L0[\s\S]*L5/);
});
addCase(cases, 'exactement 200 caractères clôtures comprises restent dans le petit bloc', () => {
  const embeds = sectionEmbeds(['x'.repeat(188)], 200);
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0].fields[0].value.length, 200);
});
addCase(cases, 'limite décimale de champ est arrondie vers le bas sans perdre la ligne', () => {
  const embeds = sectionEmbeds(['abc'], 200.9);
  assert.equal(embeds[0].fields[0].value, '```diff\nabc\n```');
});
addCase(cases, 'valeur infinie de limite utilise la valeur par défaut', () => {
  const embeds = sectionEmbeds(['z'], Infinity);
  assert.equal(embeds.length, 1);
  assert.equal(embeds[0].fields[0].value, '```diff\nz\n```');
});
addCase(cases, 'titre de l’embed combine le titre et le build', () => {
  assert.equal(sectionEmbeds(['x'], 1020)[0].title, 'Routes · Build 42');
});
addCase(cases, 'couleur de section est conservée', () => {
  assert.equal(sectionEmbeds(['x'], 1020, { color: 0xabcdef })[0].color, 0xabcdef);
});
addCase(cases, 'libellé de section est conservé comme nom du champ', () => {
  assert.equal(sectionEmbeds(['x'], 1020, { label: 'Ajoutées · 1' })[0].fields[0].name, 'Ajoutées · 1');
});
addCase(cases, 'champ reste explicitement non-inline', () => {
  assert.equal(sectionEmbeds(['x'], 1020)[0].fields[0].inline, false);
});
addCase(cases, 'timestamp explicite est reproduit tel quel', () => {
  assert.equal(sectionEmbeds(['x'], 1020)[0].timestamp, TS);
});
addCase(cases, 'footer contient build et timestamp Discord', () => {
  assert.equal(sectionEmbeds(['x'], 1020)[0].footer.text, 'Canary 42 · <t:1767323045:f>');
});
addCase(cases, 'timestamp invalide est omis du texte de footer', () => {
  const { sectionEmbeds: render } = fresh();
  const e = render(makeSection(['x']), { title: 'T', bn: '?', ts: 'invalid' });
  assert.equal(e[0].footer.text, 'Canary ?');
});
addCase(cases, 'titre et timestamp survivent au passage en chemin multi-bloc', () => {
  const e = sectionEmbeds(Array.from({ length: 6 }, (_, i) => `r${i}`), 200);
  assert.equal(e[0].title, 'Routes · Build 42');
  assert.equal(e[0].timestamp, TS);
});
addCase(cases, 'fences triples client sont neutralisées dans le code diff', () => {
  const e = sectionEmbeds(['mot ```injecté'], 1020);
  assert.match(e[0].fields[0].value, /'''injecté/);
  assert.equal((e[0].fields[0].value.match(/```/g) || []).length, 2);
});
addCase(cases, 'plusieurs séquences de fence dans une ligne sont toutes neutralisées', () => {
  const e = sectionEmbeds(['```a```b```'], 1020);
  assert.equal(e[0].fields[0].value, "```diff\n'''a'''b'''\n```");
});
addCase(cases, 'fence intégrée à une ligne de suite est neutralisée', () => {
  const e = sectionEmbeds(Array.from({ length: 6 }, (_, i) => 'ligne' + i + ' ```'), 200);
  assert.ok(allFields(e).every((f) => !f.value.includes('```\nligne')));
});
addCase(cases, 'lignes vides internes ne sont pas supprimées', () => {
  const e = sectionEmbeds(['A', '', 'B'], 1020);
  assert.equal(e[0].fields[0].value, '```diff\nA\n\nB\n```');
});
addCase(cases, 'texte Unicode est gardé intact dans le rendu', () => {
  const e = sectionEmbeds(['+ café 東京 🛰️'], 1020);
  assert.ok(e[0].fields[0].value.includes('café 東京 🛰️'));
});
addCase(cases, 'repli des lignes en fields conserve exactement leur ordre', () => {
  const lines = Array.from({ length: 6 }, (_, i) => `entrée-${i}`);
  const e = sectionEmbeds(lines, 200);
  const got = allFields(e).flatMap((f) => f.value.slice(8, -4).split('\n'));
  assert.deepEqual(got, lines);
});
addCase(cases, 'mode multi-field conserve le libellé une fois puis champs sans nom', () => {
  const e = sectionEmbeds(Array.from({ length: 7 }, (_, i) => `r${i}`), 200);
  assert.equal(e[0].fields[0].name, 'Éléments');
  assert.ok(e[0].fields.slice(1).every((f) => f.name === ''));
});
addCase(cases, 'seuil 1899 permet plusieurs fields par embed', () => {
  const e = sectionEmbeds(Array.from({ length: 6 }, (_, i) => String(i) + 'r'.repeat(950)), 1899);
  assert.ok(e[0].fields.length > 1);
});
addCase(cases, 'seuil 1900 impose un field par embed', () => {
  const e = sectionEmbeds(Array.from({ length: 6 }, (_, i) => String(i) + 'r'.repeat(950)), 1900);
  assert.ok(e.every((x) => x.fields.length === 1));
});
addCase(cases, 'suite possède un numéro de partie incrémenté', () => {
  const e = sectionEmbeds(Array.from({ length: 7 }, (_, i) => 'r'.repeat(189) + i), 200);
  assert.ok(e.length >= 2);
  assert.equal(e[1].title, 'Routes · Build 42 · suite 2');
});
addCase(cases, 'footer est absent de la première partie non finale', () => {
  const e = sectionEmbeds(Array.from({ length: 7 }, (_, i) => 'r'.repeat(189) + i), 200);
  assert.equal(e[0].footer, undefined);
});
addCase(cases, 'footer est présent sur la dernière partie', () => {
  const e = sectionEmbeds(Array.from({ length: 7 }, (_, i) => 'r'.repeat(189) + i), 200);
  assert.equal(e[e.length - 1].footer.text, 'Canary 42 · <t:1767323045:f>');
});
addCase(cases, 'parties ultérieures gardent la couleur de la section', () => {
  const e = sectionEmbeds(Array.from({ length: 7 }, (_, i) => 'r'.repeat(189) + i), 200, { color: 123 });
  assert.ok(e.length > 1 && e.every((x) => x.color === 123));
});
addCase(cases, 'dernier caractère sans fence parasite du contenu est préservé', () => {
  const e = sectionEmbeds(['tail.'], 1020);
  assert.ok(e[0].fields[0].value.endsWith('tail.\n```'));
});
addCase(cases, 'longueur du bloc inclut les fences définies', () => {
  const e = sectionEmbeds(['abc'], 1020);
  assert.equal(e[0].fields[0].value.length, '```diff\nabc\n```'.length);
});
addCase(cases, 'frontière de 5 éléments reste petite si contenu cumulé tient', () => {
  const e = sectionEmbeds(['1', '2', '3', '4', '5'], 200);
  assert.equal(e[0].fields.length, 1);
  assert.equal(e[0].fields[0].value, '```diff\n1\n2\n3\n4\n5\n```');
});
addCase(cases, 'cinq éléments trop longs basculent proprement en sections découpées', () => {
  const e = sectionEmbeds(Array.from({ length: 5 }, (_, i) => `${i}:` + 'x'.repeat(60)), 200);
  assert.ok(e.length >= 1);
  assert.ok(allFields(e).some((f) => f.value.includes('4:')));
});
addCase(cases, 'les contenus du bloc reconstituent les lignes sur plusieurs pages', () => {
  const lines = Array.from({ length: 12 }, (_, i) => 'n' + i + ':' + 'v'.repeat(180));
  const e = sectionEmbeds(lines, 200);
  const recovered = allFields(e).flatMap((f) => f.value.slice(8, -4).split('\n'));
  assert.deepEqual(recovered, lines);
});
addCase(cases, 'deux champs de continuation ne rajoutent pas de libellé numéroté', () => {
  const e = sectionEmbeds(Array.from({ length: 8 }, (_, i) => 'q'.repeat(189) + i), 200);
  assert.ok(e.flatMap((x) => x.fields).every((f) => !/\.\.\. \(\d+\)/.test(f.name)));
});

// 50 cas d'intégration notify : formes d'entrée, texte construit et dedupe.
for (const [name, input] of [
  ['strDiff null', null],
  ['strDiff tableau sans propriétés de diff', []],
  ['strDiff nombre', 0],
  ['strDiff added invalide', { added: 'non-map' }],
  ['strDiff modified tableau', { modified: ['x'] }],
  ['strDiff removed null', { removed: null }],
  ['rtDiff null', null],
  ['rtDiff valeur scalaire', 'x'],
  ['rtDiff added tableau', { added: [] }],
  ['rtDiff modified invalide', { modified: false }],
]) {
  addCase(cases, `normalisation map vide — ${name}`, async () => {
    const { notifyNormal } = fresh();
    const ok = await notifyNormal({ build: { buildNumber: 700 }, strDiff: input, rtDiff: {}, webhookUrl: WH });
    assert.equal(ok, true);
    assert.equal(posts.length, 0);
  });
}
addCase(cases, 'webhook vide neutralise notifyNormal même si des diffs existent', async () => {
  const { notifyNormal } = fresh();
  assert.equal(await notifyNormal({ build: { buildNumber: 1 }, strDiff: { added: { A: 'a' } }, rtDiff: {}, webhookUrl: '' }), true);
  assert.equal(posts.length, 0);
});
addCase(cases, 'webhook absent neutralise notifyUrgent avant normalisation', async () => {
  const { notifyUrgent } = fresh();
  assert.equal(await notifyUrgent({ build: {}, expDiff: { added: ['x'] } }), true);
  assert.equal(posts.length, 0);
});
addCase(cases, 'webhook vide neutralise sendDismissible', async () => {
  const { sendDismissible } = fresh();
  assert.equal(await sendDismissible('', 'b', { added: { K: 1 } }), true);
  assert.equal(posts.length, 0);
});
addCase(cases, 'notifyAll sans webhook résout true sans émission', async () => {
  const { notifyAll } = fresh();
  assert.equal(await notifyAll({ build: {}, webhookUrl: '' }), true);
  assert.equal(posts.length, 0);
});
addCase(cases, 'buildNumber zéro utilise le repli ? dans le titre', async () => {
  const { notifyNormal } = fresh();
  assert.equal(await notifyNormal({ build: { buildNumber: 0 }, strDiff: { added: { A: 'alpha' } }, rtDiff: {}, webhookUrl: WH }), true);
  assert.ok(sentText().includes('Build ?'));
});
addCase(cases, 'buildNumber numérique est converti en texte dans le titre', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 704 }, strDiff: { added: { A: 'alpha' } }, rtDiff: {}, webhookUrl: WH });
  assert.ok(sentText().includes('Build 704'));
});
addCase(cases, 'build absent utilise le build de repli', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: {}, expDiff: { added: ['exp'] }, webhookUrl: WH });
  assert.ok(sentText().includes('Build ?'));
});
addCase(cases, 'string map affiche la phrase mais pas sa clé', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 1 }, strDiff: { added: { HASH_PRIVATE: 'phrase lisible' } }, rtDiff: {}, webhookUrl: WH });
  assert.ok(sentText().includes('phrase lisible'));
  assert.ok(!sentText().includes('HASH_PRIVATE'));
});
addCase(cases, 'string map replie les espaces et retours de ligne', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 2 }, strDiff: { added: { K: '  une\tphrase\n sur deux  ' } }, rtDiff: {}, webhookUrl: WH });
  assert.ok(sentText().includes('une phrase sur deux'));
});
addCase(cases, 'string vide utilise la clé comme texte de secours', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 3 }, strDiff: { added: { 'clé`': '' } }, rtDiff: {}, webhookUrl: WH });
  assert.ok(sentText().includes("clé'"));
});
addCase(cases, 'valeur string dépassant 240 est tronquée avec ellipse visible', async () => {
  const { notifyNormal } = fresh();
  const v = 'a'.repeat(260);
  await notifyNormal({ build: { buildNumber: 4 }, strDiff: { added: { K: v } }, rtDiff: {}, webhookUrl: WH });
  assert.ok(sentText().includes('a'.repeat(239) + '…'));
  assert.ok(!sentText().includes('a'.repeat(240)));
});
addCase(cases, 'route affiche clé et valeur', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 5 }, strDiff: {}, rtDiff: { added: { '/api/v9/x': '/route/fichier' } }, webhookUrl: WH });
  assert.ok(sentText().includes('/api/v9/x → /route/fichier'));
});
addCase(cases, 'route à valeur vide affiche uniquement sa clé', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 6 }, strDiff: {}, rtDiff: { added: { '/r': '' } }, webhookUrl: WH });
  assert.ok(sentText().includes('+ /r'));
  assert.ok(!sentText().includes('/r →'));
});
addCase(cases, 'clé de route neutralise les backticks', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 7 }, strDiff: {}, rtDiff: { added: { '/`route`': '' } }, webhookUrl: WH });
  assert.ok(sentText().includes("/’route’") || sentText().includes("/'route'"));
});
addCase(cases, 'valeur de route applique sa limite de 100 caractères', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 8 }, strDiff: {}, rtDiff: { added: { '/r': 'v'.repeat(130) } }, webhookUrl: WH });
  assert.ok(sentText().includes('v'.repeat(99) + '…'));
  assert.ok(!sentText().includes('v'.repeat(100)));
});
addCase(cases, 'libellé string différencie l’ajout', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 9 }, strDiff: { added: { K: 'x' } }, rtDiff: {}, webhookUrl: WH });
  assert.ok(sentText().includes('Ajoutés · 1'));
});
addCase(cases, 'libellé route différencie la suppression', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 10 }, strDiff: {}, rtDiff: { removed: { '/gone': 'old' } }, webhookUrl: WH });
  assert.ok(sentText().includes('Supprimées · 1'));
});
addCase(cases, 'diff normal envoie les sections ajoutée, modifiée et retirée', async () => {
  const { notifyNormal } = fresh();
  await notifyNormal({ build: { buildNumber: 11 }, strDiff: { added: { A: 'add' }, modified: { M: 'mod' }, removed: { R: 'rem' } }, rtDiff: {}, webhookUrl: WH });
  const text = sentText();
  for (const s of ['+ add', '~ mod', '- rem']) assert.ok(text.includes(s));
});
addCase(cases, 'notifyNormal renvoie false si une section échoue', async () => {
  const { notifyNormal } = fresh();
  nextResponse = () => ({ ok: false, status: 400, text: 'bad request' });
  const ok = await notifyNormal({ build: { buildNumber: 12 }, strDiff: { added: { A: 'a' } }, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok, false);
});
addCase(cases, 'post direct conserve les composants et retourne true au succès', async () => {
  const { post } = fresh();
  const ok = await post(WH, { embeds: [{ title: 'Direct', description: 'payload' }] }, 'direct-key', 'strings');
  assert.equal(ok, true);
  assert.ok(sentText().includes('Direct'));
});
addCase(cases, 'post direct réutilisant sa clé ne renvoie pas le payload', async () => {
  const { post } = fresh();
  const body = { embeds: [{ title: 'Unique' }] };
  await post(WH, body, 'one-key', 'strings');
  const n = posts.length;
  assert.equal(await post(WH, body, 'one-key', 'strings'), true);
  assert.equal(posts.length, n);
});
addCase(cases, 'post direct sans clé déduplique via empreinte du payload', async () => {
  const { post } = fresh();
  const body = { embeds: [{ title: 'Fingerprint' }] };
  await post(WH, body, null, 'strings');
  const n = posts.length;
  assert.equal(await post(WH, body, null, 'strings'), true);
  assert.equal(posts.length, n);
});
addCase(cases, 'expérience stringée est rendue avec son identifiant', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 13 }, expDiff: { added: ['2026_exp_shop'] }, webhookUrl: WH });
  assert.ok(sentText().includes('2026_exp_shop'));
});
addCase(cases, 'expérience objet utilise type et label', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 14 }, expDiff: { added: [{ id: 'exp-x', type: 'guild', label: 'Libellé' }] }, webhookUrl: WH });
  assert.ok(sentText().includes('guild'));
  assert.ok(sentText().includes('Libellé'));
});
addCase(cases, 'pourcentage unknown n’est pas affiché', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 15 }, expDiff: { added: [{ id: 'exp-x', userPercentage: { status: 'unknown', value: 40 } }] }, webhookUrl: WH });
  assert.ok(!sentText().includes('40%'));
});
addCase(cases, 'pourcentage connu inclut valeur et statut', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 16 }, expDiff: { added: [{ id: 'exp-x', userPercentage: { status: 'active', value: 25 } }] }, webhookUrl: WH });
  assert.ok(sentText().includes('25% (active)'));
});
addCase(cases, 'expérience shop produit son tag thématique', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 17 }, expDiff: { added: ['shop_offer'] }, webhookUrl: WH });
  assert.ok(sentText().includes('#shop'));
});
addCase(cases, 'expérience avec variations expose les configurations triées', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 18 }, expDiff: { added: [{ id: 'exp-vars', variations: { 1: { z: true, a: 3 } } }] }, webhookUrl: WH });
  assert.ok(sentText().includes('a=3 · z=true'));
});
addCase(cases, 'expérience legacy expose traitements comme variantes indexées', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 19 }, expDiff: { added: [{ id: 'exp-legacy', treatments: [{ label: 'A' }, 'B'] }] }, webhookUrl: WH });
  assert.ok(sentText().includes('V0 label=A'));
  assert.ok(sentText().includes('V1 value=B'));
});
addCase(cases, 'diff de configuration expérience modifiée rend l’ancienne et nouvelle valeur', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 20 }, expDiff: { modified: [{ id: 'exp-mod', _before: { defaultConfig: { mode: 'old' } }, defaultConfig: { mode: 'new' } }] }, webhookUrl: WH });
  assert.ok(sentText().includes('defaultConfig.mode: old → new'));
});
addCase(cases, 'catégorie changée rend provenance et catégorie cible', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 21 }, expDiff: { categoryChanged: [{ id: 'exp-cat', from: 'user', to: 'guild' }] }, webhookUrl: WH });
  assert.ok(sentText().includes('exp-cat  user → guild'));
});
addCase(cases, 'suppression expérience string conserve son identifiant', async () => {
  const { notifyUrgent } = fresh();
  await notifyUrgent({ build: { buildNumber: 22 }, expDiff: { removed: ['exp-removed'] }, webhookUrl: WH });
  assert.ok(sentText().includes('- exp-removed'));
});
addCase(cases, 'expDiff sans tableaux reconnus équivaut à aucun changement', async () => {
  const { notifyUrgent } = fresh();
  assert.equal(await notifyUrgent({ build: { buildNumber: 23 }, expDiff: { added: 'bad' }, webhookUrl: WH }), true);
  assert.equal(posts.length, 0);
});
addCase(cases, 'sendDismissible diff vide ne déclenche aucun post', async () => {
  const { sendDismissible } = fresh();
  assert.equal(await sendDismissible(WH, '24', {}), true);
  assert.equal(posts.length, 0);
});
addCase(cases, 'sendDismissible garde une clé ajoutée et sa valeur', async () => {
  const { sendDismissible } = fresh();
  await sendDismissible(WH, '25', { added: { 'flag-x': 4 } }, TS);
  assert.ok(sentText().includes('+ flag-x = 4'));
});
addCase(cases, 'sendDismissible modifié rend from vers to', async () => {
  const { sendDismissible } = fresh();
  await sendDismissible(WH, '26', { modified: { m: { from: 'off', to: 'on' } } }, TS);
  assert.ok(sentText().includes('~ m = off → on'));
});
addCase(cases, 'sendDismissible tri les suppressions par identifiant numérique', async () => {
  const { sendDismissible } = fresh();
  await sendDismissible(WH, '27', { removed: { '9': 9, '2': 2, '10': 10 } }, TS);
  const s = sentText();
  assert.ok(s.indexOf('- 2 = 2') < s.indexOf('- 9 = 9'));
  assert.ok(s.indexOf('- 9 = 9') < s.indexOf('- 10 = 10'));
});
addCase(cases, 'sendDismissible écrit le build de repli pour valeur vide', async () => {
  const { sendDismissible } = fresh();
  await sendDismissible(WH, '', { added: { K: 1 } }, TS);
  assert.ok(sentText().includes('Build ?'));
});
addCase(cases, 'notifyAll échoue si le sous-système urgent échoue', async () => {
  const { notifyAll } = fresh();
  nextResponse = () => ({ ok: false, status: 400, text: 'invalid' });
  const ok = await notifyAll({ build: { buildNumber: 28 }, expDiff: { added: ['exp'] }, strDiff: {}, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok, false);
});
addCase(cases, 'notifyAll échoue si le sous-système normal échoue', async () => {
  const { notifyAll } = fresh();
  nextResponse = () => ({ ok: false, status: 400, text: 'invalid' });
  const ok = await notifyAll({ build: { buildNumber: 29 }, expDiff: {}, strDiff: { added: { K: 'v' } }, rtDiff: {}, webhookUrl: WH });
  assert.equal(ok, false);
});
addCase(cases, 'notifyAll retourne true lorsque les deux familles sont vides', async () => {
  const { notifyAll } = fresh();
  assert.equal(await notifyAll({ build: { buildNumber: 30 }, expDiff: {}, strDiff: {}, rtDiff: {}, webhookUrl: WH }), true);
  assert.equal(posts.length, 0);
});

if (cases.length !== 100) throw new Error(`Matrice invalide : ${cases.length} cas au lieu de 100`);
for (const [name, fn] of cases) test(name, fn);

test.after(() => {
  Module._load = originalLoad;
  console.log = originalLog;
  console.warn = originalWarn;
  fs.removeSync(scratch);
});
