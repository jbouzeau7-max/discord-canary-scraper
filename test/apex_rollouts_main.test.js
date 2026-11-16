'use strict';
// Rollouts serveurs (apex) : pannes réseau, collections vides, buckets retirés,
// plages hors bornes, env invalide, échecs webhook — sans réseau réel.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const apex = require('../src/apex_rollouts.js');
const { rangesToPct, decodeGuildWire, diffExperiments, fetchDiscordGuild, envPositive, main } = apex;

const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apex-')), 'apex_rollouts.json');
const tuple = (name, positions, hash = 1) => [hash, name, 1, [[positions, []]], []];
const wire = (name, pct, bucket = 1) => tuple(name, [[bucket, [{ s: 0, e: Math.round(pct * 100) }]]]);
const exp = (id, treatments) => ({ id, hasGlobalPct: true, treatments });
const t = (bucket, pct) => ({ bucket, label: bucket === 0 ? 'Control' : 'Variant ' + bucket, pct });
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const quiet = async (fn) => {
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, keep); }
};
/** Lance main() avec une réponse Discord simulée ; retourne { r, exits, posts, state }. */
async function run(stateFile, guildExperiments, extra = {}) {
  const exits = [];
  const posts = [];
  const r = await quiet(() => main({
    stateFile,
    hashMap: new Map(),
    exit: (c) => exits.push(c),
    fetchGuild: async (hm) => (guildExperiments === null
      ? { experiments: [], okResponses: 0, failedResponses: 1 }
      : { experiments: guildExperiments.map((g) => decodeGuildWire(g, hm)), okResponses: 1, failedResponses: 0 }),
    postWebhook: extra.post || (async (embeds) => { posts.push(embeds); return { ok: true, status: 204 }; }),
  }));
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  return { r, exits, posts, state };
}

// ── rangesToPct : précision et cas limites ──────────────────────────────────
test('rangesToPct : vide, null, non-tableau → 0', () => {
  for (const v of [[], null, undefined, 'x', 42, {}]) assert.strictEqual(rangesToPct(v), 0);
});
test('rangesToPct : 0 % et 100 % exacts', () => {
  assert.strictEqual(rangesToPct([{ s: 0, e: 0 }]), 0);
  assert.strictEqual(rangesToPct([{ s: 0, e: 10000 }]), 100);
  assert.strictEqual(rangesToPct([{ s: 0, e: 5000 }, { s: 5000, e: 10000 }]), 100);
});
test('rangesToPct : plages adjacentes, chevauchantes, désordonnées, dupliquées', () => {
  assert.strictEqual(rangesToPct([{ s: 5000, e: 7500 }, { s: 0, e: 1500 }, { s: 3000, e: 4000 }]), 50);
  assert.strictEqual(rangesToPct([{ s: 0, e: 100 }, { s: 0, e: 100 }, { s: 50, e: 150 }]), 1.5);
  assert.strictEqual(rangesToPct([{ s: 0, e: 1 }, { s: 2, e: 3 }]), 0.02, 'le trou [1,2) n’est pas comblé');
});
test('rangesToPct : plage qui déborde de l’espace → bornée, pas surestimée', () => {
  assert.strictEqual(rangesToPct([{ s: 9000, e: 20000 }]), 10);
  assert.strictEqual(rangesToPct([{ s: -500, e: 500 }]), 5);
  assert.strictEqual(rangesToPct([{ s: 12000, e: 13000 }]), 0);
});
test('rangesToPct : entrées invalides ignorées (NaN, inversées, null, chaînes)', () => {
  assert.strictEqual(rangesToPct([null, undefined, 'a', 7, {}, { s: 'x', e: 10 }, { s: 500, e: 100 }, [1], { s: 0, e: 250 }]), 2.5);
  assert.strictEqual(rangesToPct([[0, 250], { start: 250, end: 500 }]), 5, 'formats tableau et start/end');
  assert.strictEqual(rangesToPct([{ s: '0', e: '1234' }]), 12.34, 'nombres en chaîne');
});

// ── decodeGuildWire ─────────────────────────────────────────────────────────
test('decodeGuildWire : entrées invalides → null, jamais d’exception', () => {
  for (const v of [null, undefined, 'x', 1, {}, [], [1, 'a', 2]]) assert.strictEqual(decodeGuildWire(v, new Map()), null);
});
test('decodeGuildWire : populations / positions malformées tolérées', () => {
  const e = decodeGuildWire([5, 'exp-a', 3, [null, 'x', [null], [[null, 'y', [1, [{ s: 0, e: 2500 }, null, 'z']]], []]], null], new Map());
  assert.strictEqual(e.id, 'exp-a');
  assert.deepStrictEqual(e.treatments.map((x) => [x.bucket, x.pct]), [[1, 25]]);
  assert.strictEqual(e.overrideIdCount, 0);
});
test('decodeGuildWire : même bucket sur plusieurs populations = union, pas somme', () => {
  const e = decodeGuildWire([5, 'exp-b', 1, [[[[1, [{ s: 0, e: 5000 }]]], []], [[[1, [{ s: 2500, e: 7500 }]]], []]], []], new Map());
  assert.strictEqual(e.treatments[0].pct, 75);
});
test('decodeGuildWire : nom absent → résolu par le hash, sinon hash:<n>', () => {
  assert.strictEqual(decodeGuildWire([77, null, 1, [], []], new Map([[77, 'named']])).id, 'named');
  assert.strictEqual(decodeGuildWire([78, '', 1, [], []], new Map()).id, 'hash:78');
  assert.strictEqual(decodeGuildWire([78, '', 1, [], []], new Map()).hasGlobalPct, false, 'aucun bucket → pas de % global');
});

// ── diffExperiments ─────────────────────────────────────────────────────────
test('diff : montée, baisse, ajout, retrait', () => {
  const d = diffExperiments(
    [exp('a', [t(1, 10)]), exp('b', [t(1, 50)]), exp('gone', [t(1, 5)])],
    [exp('a', [t(1, 25)]), exp('b', [t(1, 40)]), exp('new', [t(1, 1)])],
  );
  assert.deepStrictEqual(d.added.map((e) => e.id), ['new']);
  assert.deepStrictEqual(d.removed.map((e) => e.id), ['gone']);
  assert.deepStrictEqual(d.changed.map((c) => [c.after.id, c.deltas[0].delta]), [['a', 15], ['b', -10]]);
});
test('diff : bucket RETIRÉ (présent avant, absent après) → baisse à 0 % notifiée', () => {
  const d = diffExperiments([exp('a', [t(1, 10), t(2, 20)])], [exp('a', [t(1, 10)])]);
  assert.strictEqual(d.changed.length, 1);
  assert.deepStrictEqual(d.changed[0].deltas, [{ label: 'Variant 2', bucket: 2, from: 20, to: 0, delta: -20, dropped: true }]);
  assert.strictEqual(d.changed[0].maxAbs, 20);
});
test('diff : bucket apparu → montée depuis 0 %', () => {
  const d = diffExperiments([exp('a', [t(1, 10)])], [exp('a', [t(1, 10), t(2, 5)])]);
  assert.deepStrictEqual(d.changed[0].deltas.map((x) => [x.bucket, x.from, x.to, x.delta]), [[2, 0, 5, 5]]);
});
test('diff : identique, 0 % ↔ 0 %, 100 % ↔ 100 % → aucun changement', () => {
  const d = diffExperiments(
    [exp('z', [t(1, 0)]), exp('f', [t(1, 100)]), exp('m', [t(1, 33.33)])],
    [exp('z', [t(1, 0)]), exp('f', [t(1, 100)]), exp('m', [t(1, 33.33)])],
  );
  assert.deepStrictEqual([d.added.length, d.changed.length, d.removed.length], [0, 0, 0]);
});
test('diff : plus petite variation mesurable (0,01 pt) détectée, bruit flottant ignoré', () => {
  assert.strictEqual(diffExperiments([exp('a', [t(1, 12.34)])], [exp('a', [t(1, 12.35)])]).changed[0].deltas[0].delta, 0.01);
  assert.strictEqual(diffExperiments([exp('a', [t(1, 0.3)])], [exp('a', [t(1, 0.1 + 0.2)])]).changed.length, 0);
});
test('diff : 0 → 100 et 100 → 0', () => {
  assert.strictEqual(diffExperiments([exp('a', [t(1, 0)])], [exp('a', [t(1, 100)])]).changed[0].deltas[0].delta, 100);
  assert.strictEqual(diffExperiments([exp('a', [t(1, 100)])], [exp('a', [t(1, 0)])]).changed[0].deltas[0].delta, -100);
});
test('diff : % précédent manquant / invalide traité comme 0, jamais NaN', () => {
  for (const bad of [null, undefined, '', 'abc', NaN]) {
    const d = diffExperiments([exp('a', [{ bucket: 1, label: 'Variant 1', pct: bad }])], [exp('a', [t(1, 7)])]);
    assert.strictEqual(d.changed[0].deltas[0].from, 0);
    assert.strictEqual(d.changed[0].deltas[0].delta, 7);
  }
});
test('diff : expériences hash:* et sans % ignorées ; listes vides sans erreur', () => {
  const d = diffExperiments([exp('hash:1', [t(1, 5)])], [exp('hash:2', [t(1, 5)]), { id: 'nopct', hasGlobalPct: false, treatments: [] }, exp('empty', [])]);
  assert.deepStrictEqual([d.added.length, d.changed.length, d.removed.length], [0, 0, 0]);
  assert.deepStrictEqual(diffExperiments([], []), { added: [], changed: [], removed: [] });
});
test('diff : trié par plus grande variation', () => {
  const d = diffExperiments([exp('a', [t(1, 1)]), exp('b', [t(1, 1)])], [exp('a', [t(1, 2)]), exp('b', [t(1, 90)])]);
  assert.deepStrictEqual(d.changed.map((c) => c.after.id), ['b', 'a']);
});

// ── envPositive ─────────────────────────────────────────────────────────────
test('envPositive : valeur illisible → défaut (un seuil NaN bloquait toute notification)', () => {
  for (const bad of [undefined, null, '', '  ', 'abc', '0', '-1', 'NaN', 'Infinity']) assert.strictEqual(envPositive(bad, 0.01), 0.01, String(bad));
  assert.strictEqual(envPositive('0.5', 0.01), 0.5);
  assert.strictEqual(envPositive(' 2 ', 0.01), 2);
});

// ── fetchDiscordGuild : erreurs réseau et retries ───────────────────────────
const fetchOpts = (fetchImpl, more = {}) => ({ fetch: fetchImpl, sleep: async () => {}, ...more });
test('fetch : réponse OK → décodée, okResponses = 1', async () => {
  const r = await quiet(() => fetchDiscordGuild(new Map(), fetchOpts(async () => res(200, { guild_experiments: [wire('a', 25)] }))));
  assert.deepStrictEqual([r.experiments.map((e) => e.id), r.okResponses, r.failedResponses], [['a'], 1, 0]);
});
test('fetch : collection réellement vide ≠ panne (okResponses = 1)', async () => {
  const r = await quiet(() => fetchDiscordGuild(new Map(), fetchOpts(async () => res(200, { guild_experiments: [] }))));
  assert.deepStrictEqual([r.experiments.length, r.okResponses, r.failedResponses], [0, 1, 0]);
});
test('fetch : erreurs réseau partout → okResponses = 0, après retries', async () => {
  let calls = 0;
  const r = await quiet(() => fetchDiscordGuild(new Map(), fetchOpts(async () => { calls++; throw new Error('ECONNRESET'); }, { fetchRounds: 3 })));
  assert.deepStrictEqual([r.okResponses, r.failedResponses, calls], [0, 1, 6], '3 passes × 2 URL');
});
test('fetch : canary KO → repli sur stable', async () => {
  const r = await quiet(() => fetchDiscordGuild(new Map(), fetchOpts(async (url) => (url.includes('canary') ? res(503, '') : res(200, { guild_experiments: [wire('a', 1)] })))));
  assert.strictEqual(r.okResponses, 1);
});
test('fetch : échec puis succès à la 2e passe', async () => {
  let calls = 0;
  const r = await quiet(() => fetchDiscordGuild(new Map(), fetchOpts(async () => (++calls <= 2 ? res(500, '') : res(200, { guild_experiments: [wire('a', 1)] })), { fetchRounds: 2 })));
  assert.deepStrictEqual([r.okResponses, calls], [1, 3]);
});
test('fetch : 401/403 anonyme → pas de 2e passe inutile', async () => {
  let calls = 0;
  const r = await quiet(() => fetchDiscordGuild(new Map(), fetchOpts(async () => { calls++; return res(401, '{}'); }, { fetchRounds: 4 })));
  assert.deepStrictEqual([r.okResponses, calls], [0, 1]);
});
test('fetch : HTML Cloudflare, JSON null, guild_experiments non tableau → échec, pas d’exception', async () => {
  for (const body of ['<html>blocked</html>', 'null', { guild_experiments: 'x' }, {}, '']) {
    const r = await quiet(() => fetchDiscordGuild(new Map(), fetchOpts(async () => res(200, body), { fetchRounds: 1 })));
    assert.strictEqual(r.okResponses, 0, JSON.stringify(body));
  }
});
test('fetch : tuple illisible ignoré, les autres gardés', async () => {
  const r = await quiet(() => fetchDiscordGuild(new Map(), fetchOpts(async () => res(200, { guild_experiments: [null, 'x', [1], wire('ok', 10)] }))));
  assert.deepStrictEqual(r.experiments.map((e) => e.id), ['ok']);
});
test('fetch : aucune requête ne transmet d’en-tête Authorization', async () => {
  let calls = 0;
  const f = async (_url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, undefined);
    return res(200, { guild_experiments: [wire('a', 10)] });
  };
  const r = await quiet(() => fetchDiscordGuild(new Map(), fetchOpts(f)));
  assert.deepStrictEqual([r.okResponses, r.failedResponses, r.experiments.length, calls], [1, 0, 1, 1]);
});

// ── main : scénarios complets ───────────────────────────────────────────────
test('main : premier run = amorçage silencieux', async () => {
  const f = tmpState();
  const { r, posts, state, exits } = await run(f, [wire('a', 10), wire('b', 50)]);
  assert.deepStrictEqual([r.ok, r.seeded, posts.length, exits.length], [true, 2, 0, 0]);
  assert.strictEqual(state.ackExperiments.length, 2);
  assert.strictEqual(state.pctPrecision, 2);
});
test('main : PANNE RÉSEAU → état intact, aucune notification, exit 1', async () => {
  const f = tmpState();
  await run(f, [wire('a', 10), wire('b', 50)]);
  const before = fs.readFileSync(f, 'utf8');
  const { r, posts, exits } = await run(f, null);
  assert.deepStrictEqual([r.ok, r.reason, exits, posts.length], [false, 'fetch_failed', [1], 0]);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before, 'aucun faux « retiré »');
});
test('main : panne réseau au tout premier run → pas d’état créé', async () => {
  const f = tmpState();
  const { r, state } = await run(f, null);
  assert.deepStrictEqual([r.reason, state], ['fetch_failed', null]);
});
test('main : collection vide alors qu’on suivait des expériences → refusée puis acceptée après confirmation', async () => {
  const f = tmpState();
  await run(f, [wire('a', 10), wire('b', 50)]);
  const one = await run(f, []);
  assert.deepStrictEqual([one.r.reason, one.exits, one.posts.length, one.state.emptyStreak, one.state.experiments.length], ['empty_collection', [1], 0, 1, 2]);
  const two = await run(f, []);
  assert.deepStrictEqual([two.r.reason, two.state.emptyStreak], ['empty_collection', 2]);
  const three = await run(f, []);
  assert.strictEqual(three.r.ok, true, '3e vide consécutif = vrai retrait');
  assert.strictEqual(three.posts.flat().length, 2);
  assert.strictEqual(three.state.experiments.length, 0);
});
test('main : un run normal remet le compteur de vides à zéro', async () => {
  const f = tmpState();
  await run(f, [wire('a', 10)]);
  await run(f, []);
  const ok = await run(f, [wire('a', 10)]);
  assert.strictEqual(ok.state.emptyStreak, undefined);
  assert.strictEqual((await run(f, [])).state.emptyStreak, 1);
});
test('main : montée notifiée une seule fois', async () => {
  const f = tmpState();
  await run(f, [wire('a', 10)]);
  const up = await run(f, [wire('a', 25)]);
  assert.deepStrictEqual([up.r.delivered, up.posts.length], [1, 1]);
  assert.match(up.posts[0][0].title, /Montée/);
  assert.match(up.posts[0][0].description, /10,00 % → \*\*25,00 %\*\*/);
  const again = await run(f, [wire('a', 25)]);
  assert.deepStrictEqual([again.r.changes, again.posts.length], [0, 0]);
});
test('main : passage à 100 % puis retour à 0 %', async () => {
  const f = tmpState();
  await run(f, [wire('a', 10)]);
  const full = await run(f, [wire('a', 100)]);
  assert.match(full.posts[0][0].description, /100,00 %/);
  const zero = await run(f, [tuple('a', [[1, [{ s: 0, e: 0 }]], [0, [{ s: 0, e: 10000 }]]])]);
  assert.match(zero.posts[0][0].title, /Baisse|Changement/);
});
test('main : ÉCHEC WEBHOOK → exit 2, changement rejoué au run suivant', async () => {
  const f = tmpState();
  await run(f, [wire('a', 10)]);
  const ko = await run(f, [wire('a', 25)], { post: async () => ({ ok: false, status: 500, text: 'boom' }) });
  assert.deepStrictEqual([ko.r.reason, ko.exits], ['webhook_failed', [2]]);
  assert.strictEqual(ko.state.ackExperiments[0].treatments[0].pct, 10, 'acquittement non avancé');
  const retry = await run(f, [wire('a', 25)]);
  assert.strictEqual(retry.r.delivered, 1);
});
test('main : exception du webhook = échec propre (pas de crash, pas de perte)', async () => {
  const f = tmpState();
  await run(f, [wire('a', 10)]);
  const ko = await run(f, [wire('a', 25)], { post: async () => { throw new Error('socket hang up'); } });
  assert.deepStrictEqual(ko.exits, [2]);
  for (const bad of [null, undefined, 'x']) assert.deepStrictEqual((await run(f, [wire('a', 25)], { post: async () => bad })).exits, [2]);
  assert.strictEqual((await run(f, [wire('a', 25)])).r.delivered, 1);
});
test('main : retrait notifié une seule fois, réapparition notifiée', async () => {
  const f = tmpState();
  await run(f, [wire('a', 10), wire('b', 50)]);
  assert.match((await run(f, [wire('a', 10)])).posts[0][0].title, /retiré/);
  assert.strictEqual((await run(f, [wire('a', 10)])).posts.length, 0);
  assert.match((await run(f, [wire('a', 10), wire('b', 50)])).posts[0][0].title, /Nouveau/);
});
test('main : 25 changements → 3 lots, échec au 2e lot = 10 acquittés seulement', async () => {
  const f = tmpState();
  const ids = Array.from({ length: 25 }, (_, i) => 'exp-' + String(i).padStart(2, '0'));
  await run(f, ids.map((id) => wire(id, 10)));
  let n = 0;
  const ko = await run(f, ids.map((id) => wire(id, 20)), { post: async () => ({ ok: ++n !== 2, status: n === 2 ? 500 : 204 }) });
  assert.deepStrictEqual(ko.exits, [2]);
  assert.strictEqual(ko.state.ackExperiments.filter((e) => e.treatments[0].pct === 20).length, 10);
  const retry = await run(f, ids.map((id) => wire(id, 20)));
  assert.deepStrictEqual([retry.r.delivered, retry.posts.length], [15, 2]);
});
test('main : état corrompu (JSON invalide, mauvais types) → réamorçage sans crash', async () => {
  for (const content of ['{not json', '[]', 'null', '{"experiments":"x","announced":7}', '']) {
    const f = tmpState();
    fs.writeFileSync(f, content);
    const { r, posts } = await run(f, [wire('a', 10)]);
    assert.deepStrictEqual([r.ok, posts.length], [true, 0], content);
  }
});
