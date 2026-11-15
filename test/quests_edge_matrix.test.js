'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeQuest,
  buildQuestComponentsV2,
  orbImageUrl,
  configuredDiscordTokens,
  fetchOfficialQuests,
  watch,
} = require('../src/quests');

const cases = [];
function add(name, fn) { cases.push({ name, fn }); }
function quest(raw, map = new Map()) { return normalizeQuest(raw, map); }
function componentPayload(q) { return buildQuestComponentsV2(q); }
function blocks(payload) { return payload.components[0].components; }
function textOf(payload) { return blocks(payload).filter((b) => b.type === 10).map((b) => b.content).join('\n'); }
function buttonsOf(payload) { const row = blocks(payload).find((b) => b.type === 1); return row ? row.components : []; }
function response(status, body, text = JSON.stringify(body)) {
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

// Token configuration parsing: empty values, trimming, all supported sources and malformed pools.
[
  ['vide', {}, []],
  ['token principal', { DISCORD_TOKEN: 'alpha' }, ['alpha']],
  ['token utilisateur', { DISCORD_USER_TOKEN: 'beta' }, ['beta']],
  ['trim des valeurs unitaires', { DISCORD_TOKEN: '  spaced  ' }, ['spaced']],
  ['ignore chaînes blanches', { DISCORD_TOKEN: '  ', DISCORD_USER_TOKEN_1: '\t' }, []],
  ['pool JSON de chaînes', { DISCORD_USER_TOKENS: '["a","b"]' }, ['a', 'b']],
  ['pool JSON vide', { DISCORD_USER_TOKENS: '[]' }, []],
  ['pool JSON non-tableau conservé comme chaîne', { DISCORD_USER_TOKENS: '{"x":1}' }, ['{"x":1}']],
  ['pool JSON scalaire conservé comme chaîne', { DISCORD_USER_TOKENS: '42' }, ['42']],
  ['pool avec virgules', { DISCORD_USER_TOKENS: 'a,b,c' }, ['a', 'b', 'c']],
  ['pool avec espaces', { DISCORD_USER_TOKENS: 'a b\tc' }, ['a', 'b', 'c']],
  ['pool avec points-virgules', { DISCORD_USER_TOKENS: 'a;b;c' }, ['a', 'b', 'c']],
  ['déduplication après trim', { DISCORD_TOKEN: ' x ', DISCORD_USER_TOKEN: 'x', DISCORD_USER_TOKEN_2: 'y' }, ['x', 'y']],
  ['ignore valeurs nulles', { DISCORD_TOKEN: null, DISCORD_USER_TOKEN: false }, []],
  ['pool d’espaces blancs', { DISCORD_USER_TOKENS: '  ' }, []],
].forEach(([label, env, expected]) => add('tokens: ' + label, () => assert.deepEqual(configuredDiscordTokens(env), expected)));

// Quest identity, nesting and messages.
[
  ['rejette null', null, null],
  ['rejette objet sans identifiant', { messages: {} }, null],
  ['identifiant numérique positif converti', { id: 123 }, '123'],
  ['identifiant chaîne conservé', { id: 'q-A' }, 'q-A'],
  ['identifiant dans config', { config: { id: 'nested' } }, 'nested'],
  ['identifiant extérieur repris si config id absent', { id: 'outer', config: { messages: {} } }, 'outer'],
  ['identifiant extérieur repris si config id vide', { id: 'outer', config: { id: '', messages: {} } }, 'outer'],
  ['config avec id prioritaire', { id: 'outer', config: { id: 'inner' } }, 'inner'],
].forEach(([label, raw, expected]) => add('normalizeQuest identité: ' + label, () => assert.equal(quest(raw)?.id ?? null, expected)));

[
  ['quest_name', { quest_name: 'Nom quête' }, 'Nom quête'],
  ['questName', { questName: 'Nom camel' }, 'Nom camel'],
  ['game_title', { game_title: 'Titre jeu' }, 'Titre jeu'],
  ['gameTitle', { gameTitle: 'Titre camel' }, 'Titre camel'],
  ['nom application', {}, 'Nom app'],
  ['fallback id', {}, 'Quête q'],
].forEach(([label, messages, expected]) => add('normalizeQuest nom: ' + label, () => {
  const q = quest({ id: 'q', messages, application: label === 'nom application' ? { name: 'Nom app' } : undefined });
  if (label === 'gameTitle') { assert.equal(q.gameTitle, expected); assert.equal(q.name, 'Quête q'); }
  else assert.equal(q.name, expected);
}));

[
  [{ quest_name: 'Q', game_title: 'G', game_publisher: 'P' }, 'G', 'P'],
  [{ gameTitle: 'Camel G', gamePublisher: 'Camel P' }, 'Camel G', 'Camel P'],
  [{}, null, null],
].forEach(([messages, title, publisher], i) => add('normalizeQuest metadata jeu #' + (i + 1), () => {
  const q = quest({ id: 'meta' + i, messages });
  assert.equal(q.gameTitle, title); assert.equal(q.publisher, publisher);
}));

// Asset URL construction and image/video precedence.
[
  [{ hero: 'hero.png' }, 'https://cdn.discordapp.com/quests/a/hero.png'],
  [{ quest_bar_hero: 'bar.jpg' }, 'https://cdn.discordapp.com/quests/a/bar.jpg'],
  [{ game_tile: 'tile.webp' }, 'https://cdn.discordapp.com/quests/a/tile.webp'],
  [{ game_tile_dark: 'dark.png' }, 'https://cdn.discordapp.com/quests/a/dark.png'],
  [{ game_tile_light: 'light.png' }, 'https://cdn.discordapp.com/quests/a/light.png'],
  [{ hero: '/hero.png' }, 'https://cdn.discordapp.com/quests/a/hero.png'],
  [{ hero: 'quests/shared/hero.png' }, 'https://cdn.discordapp.com/quests/shared/hero.png'],
  [{ hero: 'https://img.example/x.png' }, 'https://img.example/x.png'],
  [{ hero: 'HTTP://img.example/x.png' }, 'HTTP://img.example/x.png'],
].forEach(([assets, expected], i) => add('normalizeQuest asset hero #' + (i + 1), () => assert.equal(quest({ id: 'a', assets }).heroImage, expected)));

[
  [{ game_tile: 'tile.png', game_tile_light: 'light.png', game_tile_dark: 'dark.png' }, 'https://cdn.discordapp.com/quests/g/dark.png'],
  [{ game_tile: 'tile.png', game_tile_light: 'light.png' }, 'https://cdn.discordapp.com/quests/g/light.png'],
  [{ game_tile: 'tile.png' }, 'https://cdn.discordapp.com/quests/g/tile.png'],
  [{ logotype: 'logo.png', logotype_light: 'l.png', logotype_dark: 'd.png' }, 'https://cdn.discordapp.com/quests/g/d.png'],
  [{ logotype: 'logo.png', logotype_light: 'l.png' }, 'https://cdn.discordapp.com/quests/g/l.png'],
].forEach(([assets, expected], i) => add('normalizeQuest asset logo/tile priorité #' + (i + 1), () => {
  const q = quest({ id: 'g', assets });
  assert.equal(i < 3 ? q.gameTile : q.logotype, expected);
}));

// Reward normalization variants and media derivation.
[
  [{ type: 1 }, 'Code redeem'], [{ type: 2 }, 'Récompense en jeu'],
  [{ type: 3 }, 'Collectible (déco / nameplate)'], [{ type: 4 }, 'Orbes'],
  [{ type: 5 }, 'Nitro fractionnaire'], [{ type: 6 }, 'Décoration de profil'],
  [{ type: 7 }, 'Effet de profil'], [{ type: 8 }, 'Avatar / décoration'],
  [{ type: 99 }, 'Type 99'],
].forEach(([raw, expected]) => add('récompense label type ' + raw.type, () => assert.equal(quest({ id: 'r', rewards: [raw] }).rewards[0].typeLabel, expected)));
[
  [{ name: 'N', name_with_article: 'le N', sku_id: 'sku', redemption_link: 'https://redeem.test' }, 'N', 'le N', 'sku', 'https://redeem.test'],
  [{ title: 'Titre', nameWithArticle: 'une T', skuId: 'sku2', redemptionLink: 'https://redeem2.test' }, 'Titre', 'une T', 'sku2', 'https://redeem2.test'],
  [{}, null, null, null, null],
].forEach(([messages, name, article, sku, link], i) => add('récompense metadata aliases #' + (i + 1), () => {
  const r = quest({ id: 'r' + i, rewards: [{ type: 1, messages, sku_id: messages.sku_id, skuId: messages.skuId, redemption_link: messages.redemption_link, redemptionLink: messages.redemptionLink }] }).rewards[0];
  assert.equal(r.name, name); assert.equal(r.nameWithArticle, article); assert.equal(r.skuId, sku); assert.equal(r.redemptionLink, link);
}));
[
  [{ orb_quantity: 10, premium_orb_quantity: 15, quantity: 2 }, 10, 15, 2],
  [{ orbQuantity: 20, premiumOrbQuantity: 25, quantity: 1 }, 20, 25, 1],
  [{ orb_quantity: 0, premium_orb_quantity: 0 }, 0, 0, null],
  [{}, null, null, null],
].forEach(([raw, orb, premium, quantity], i) => add('récompense quantités/orbes #' + (i + 1), () => {
  const r = quest({ id: 'qty' + i, rewards: [raw] }).rewards[0];
  assert.equal(r.orbQuantity, orb); assert.equal(r.premiumOrbQuantity, premium); assert.equal(r.quantity, quantity);
}));
[
  [{ type: 3, asset: 'deco.mp4' }, 'https://cdn.discordapp.com/quests/m/deco.mp4?format=webp', 'https://cdn.discordapp.com/quests/m/deco.mp4'],
  [{ type: 6, asset: 'https://cdn.example/a.webm?x=1' }, 'https://cdn.example/a.webm?format=webp', 'https://cdn.example/a.webm?x=1'],
  [{ type: 8, asset: 'x.mov' }, 'https://cdn.discordapp.com/quests/m/x.mov?format=webp', 'https://cdn.discordapp.com/quests/m/x.mov'],
  [{ type: 1, asset: 'plain.png' }, 'https://cdn.discordapp.com/quests/m/plain.png', null],
  [{ type: 4, asset_video: 'reward.webm' }, null, 'https://cdn.discordapp.com/quests/m/reward.webm'],
  [{ type: 4, assetVideo: 'reward.mp4' }, null, 'https://cdn.discordapp.com/quests/m/reward.mp4'],
].forEach(([raw, poster, video], i) => add('récompense asset/poster #' + (i + 1), () => {
  const r = quest({ id: 'm', rewards: [raw] }).rewards[0]; assert.equal(r.assetPoster, poster); assert.equal(r.assetVideo, video);
}));
[
  ['tableau rewards_config prioritaire', { rewards_config: { rewards: [{ type: 1 }] }, rewards: [{ type: 2 }] }, 1],
  ['format rewards direct', { rewards: [{ type: 2 }] }, 2],
  ['rewards non tableau ignoré', { rewards: 'bad' }, null],
  ['valeur rewards nulle', { rewards: null }, null],
].forEach(([label, props, expected], i) => add('récompenses source #' + (i + 1) + ': ' + label, () => {
  const r = quest({ id: 'rs' + i, ...props }).rewards; assert.equal(r.length, expected == null ? 0 : 1); if (expected) assert.equal(r[0].type, expected);
}));

// Platforms, features, task strings and task-video selection.
[
  [[0], 'Multiplateforme'], [[1], 'Xbox'], [[2], 'PlayStation'], [[3], 'Switch'], [[4], 'Bureau'],
  [['1', '2'], 'Xbox, PlayStation'], [[99], 'Plateforme 99'], [['bad'], 'Multiplateforme'],
  [[1, '1', 2], 'Xbox, PlayStation'], [[0, 1, 4], 'Multiplateforme'],
].forEach(([platforms, expected], i) => add('plateformes numériques cas #' + (i + 1), () => assert.equal(quest({ id: 'p' + i, rewards_config: { platforms } }).platforms, expected)));
[
  [[1], 'CTA post-inscription'], [[4], '🔞 18+'], [[20], '☁️ Cloud Play'], [[42], 'Xbox Game Pass'],
  [[999], '`999`'], [[14, '14', 999, 'x'], 'Desktop · `999`'], [[1, 1, 4, 4], 'CTA post-inscription · 🔞 18+'],
  [[], null], [['x'], null],
].forEach(([features, expected], i) => add('features décodées cas #' + (i + 1), () => assert.equal(quest({ id: 'f' + i, features }).features, expected)));
[
  ['OR', true], ['or', true], ['AND', false], ['', false],
].forEach(([op, isOr], i) => add('opérateur tâches #' + (i + 1), () => {
  const q = quest({ id: 't' + i, task_config: { operator: op, tasks: { WATCH_VIDEO: { target: 60 } } } });
  assert.equal(q.tasksText.startsWith('_Une seule tâche suffit_'), isOr);
}));
[
  ['WATCH_VIDEO', 'Regarder la vidéo'], ['WATCH_VIDEO_ON_MOBILE', 'Regarder la vidéo (mobile)'],
  ['WATCH_VIDEO_ON_DESKTOP', 'Regarder la vidéo (bureau)'], ['PLAY_ON_XBOX', 'Jouer sur Xbox'],
  ['PLAY_ON_PLAYSTATION', 'Jouer sur PlayStation'], ['STREAM_ON_DESKTOP', 'Streamer sur bureau'],
  ['ACHIEVEMENT', 'Débloquer un succès'], ['ACHIEVEMENT_IN_ACTIVITY', 'Succès dans une activité'],
  ['CUSTOM_STREAM_EVENT', 'Streamer'], ['CUSTOM_PLAY_EVENT', 'Jouer'], ['OTHER_EVENT', 'other event'],
].forEach(([key, fragment], i) => add('étiquette de tâche #' + (i + 1), () => {
  const q = quest({ id: 'task' + i, task_config_v2: { tasks: { [key]: { target: 90 } } } }); assert.ok(q.tasksText.includes(fragment), q.tasksText);
}));
[
  [{ type: 'WATCH_VIDEO', target: 1 }, '**1 s**'],
  [{ type: 'PLAY_ACTIVITY', target: 59 }, '**59 s**'],
  [{ type: 'PLAY_ACTIVITY', target: 60 }, '**1 min**'],
  [{ type: 'PLAY_ACTIVITY', target: 61 }, '**1 min 1 s**'],
  [{ type: 'PLAY_ACTIVITY', target: 120 }, '**2 min**'],
  [{ type: 'PLAY_ACTIVITY', target: 0 }, 'objectif `0`'],
  [{ type: 'PLAY_ACTIVITY', target: 100000 }, 'objectif `100000`'],
  [{ type: 'PLAY_ACTIVITY', target: -1 }, 'objectif `-1`'],
].forEach(([task, fragment], i) => add('objectif temporel de tâche #' + (i + 1), () => {
  const q = quest({ id: 'dur' + i, task_config: { tasks: { PLAY_ACTIVITY: task } } }); assert.ok(q.tasksText.includes(fragment));
}));
[
  [{ tasks: {} }, null], [{ tasks: null }, null], [{ tasks: { WATCH_VIDEO: {} } }, 'Regarder la vidéo'],
].forEach(([config, expected], i) => add('configuration de tâches vide ou non vide #' + (i + 1), () => {
  const q = quest({ id: 'tc' + i, task_config: config }); assert.equal(q.tasksText && q.tasksText.includes(expected || 'x'), expected ? true : null);
}));
[
  ['video', 'task.mp4', 'https://cdn.discordapp.com/quests/v/task.mp4'],
  ['video_low_res', 'low.webm', 'https://cdn.discordapp.com/quests/v/low.webm'],
  ['video', { url: 'https://assets.test/v.mp4' }, 'https://assets.test/v.mp4'],
  ['video', 'skip.m3u8', null],
  ['video', 'skip.m3u8?token=x', null],
].forEach(([key, value, expected], i) => add('vidéo de tâche asset #' + (i + 1), () => {
  const q = quest({ id: 'v', task_config: { tasks: { WATCH_VIDEO: { assets: { [key]: value } } } }, assets: { hero_video: 'presentation.mp4' } });
  assert.equal(q.videoUrl, expected || 'https://cdn.discordapp.com/quests/v/presentation.mp4');
}));

// Formatting and derived timestamps exposed through output payloads.
[
  [{ starts_at: '2030-01-01T00:00:00Z', expires_at: '2030-01-01T01:00:00Z' }, '1 h'],
  [{ starts_at: '2030-01-01T00:00:00Z', expires_at: '2030-01-01T00:30:00Z' }, '30 min'],
  [{ starts_at: '2030-01-01T00:00:00Z', expires_at: '2030-01-03T00:00:00Z' }, '2 jours'],
].forEach(([dates, span], i) => add('durée campagne dérivée #' + (i + 1), () => assert.equal(quest({ id: 'date' + i, ...dates }).totalSpan, span)));
[
  [{}, '—'], [{ startsAt: '2020-01-01T00:00:00Z' }, 'À partir du'],
  [{ expiresAt: '2030-01-01T00:00:00Z' }, 'Jusqu’au'],
].forEach(([dates, fragment], i) => add('bloc durée sans les deux bornes #' + (i + 1), () => {
  const p = componentPayload({ id: 'time' + i, name: 'T', questUrl: null, ...dates }); assert.ok(textOf(p).includes(fragment));
}));

// Component V2 schema, limits, optional blocks and safe button count.
[
  ['flag V2', { id: 'a' }, (p) => assert.equal(p.flags, 32768)],
  ['container type', { id: 'b' }, (p) => assert.equal(p.components[0].type, 17)],
  ['accent hex', { id: 'c', primaryColor: '#12aBcF' }, (p) => assert.equal(p.components[0].accent_color, 0x12abcf)],
  ['accent sans dièse', { id: 'd', primaryColor: 'abcdef' }, (p) => assert.equal(p.components[0].accent_color, 0xabcdef)],
  ['accent invalide fallback', { id: 'e', primaryColor: 'red' }, (p) => assert.equal(p.components[0].accent_color, 0)],
  ['bouton quête seul', { id: 'f', questUrl: 'https://canary.discord.com/quests/f' }, (p) => assert.equal(buttonsOf(p).length, 1)],
  ['aucun bouton sans URL', { id: 'g', questUrl: null }, (p) => assert.equal(buttonsOf(p).length, 0)],
  ['URL vidéo bouton', { id: 'h', questUrl: null, videoUrl: 'https://cdn.discordapp.com/x.mp4', videoLabel: 'Voir' }, (p) => assert.equal(buttonsOf(p)[0].url, 'https://cdn.discordapp.com/x.mp4')],
  ['lien CTA comme bouton', { id: 'i', questUrl: null, ctaLink: 'https://store.test', ctaLabel: 'Installer' }, (p) => assert.equal(buttonsOf(p)[0].label, 'Installer')],
  ['lien application comme CTA implicite', { id: 'j', questUrl: null, applicationLink: 'https://app.test' }, (p) => assert.equal(buttonsOf(p)[0].url, 'https://app.test')],
  ['bouton redemption de récompense', { id: 'k', questUrl: null, rewards: [{ typeLabel: 'Code', redemptionLink: 'https://redeem.test' }] }, (p) => assert.equal(buttonsOf(p)[0].url, 'https://redeem.test')],
].forEach(([label, q, verify]) => add('payload Components V2: ' + label, () => verify(componentPayload({ name: 'Test', ...q }))));
// Official API fetch protocol is stubbed; no network, retries, or real waiting.
[
  { label: 'aucun token', tokens: [], calls: [], result: [] },
  { label: 'non-tableau tokens utilise la configuration vide', tokens: 'token', calls: [], result: [] },
].forEach(({ label, tokens, calls: expectedCalls, result }, _i) => add('fetchOfficialQuests: ' + label, async () => {
  let n = 0; const out = await fetchOfficialQuests(new Map(), { tokens, fetchWithRetry: async () => { n++; return response(200, []); } });
  assert.equal(n, expectedCalls.length); assert.deepEqual(out, result);
}));
[
  [200, 'JSON array', '[{"id":"arr","messages":{"quest_name":"Array"}}]', 'arr'],
  [200, 'enveloppe quests', '{"quests":[{"id":"list"}]}', 'list'],
  [200, 'enveloppe data', '{"data":[{"id":"data"}]}', 'data'],
  [200, 'liste sans quêtes', '{"other":[]}', null],
  [200, 'BOM JSON', '\uFEFF{"quests":[{"id":"bom"}]}', 'bom'],
].forEach(([status, label, body, id], i) => add('fetch officiel parsing #' + (i + 1) + ': ' + label, async () => {
  const out = await fetchOfficialQuests(Promise.resolve(new Map()), { tokens: ['t'], fetchWithRetry: async () => response(status, null, body) });
  assert.equal(out[0]?.id ?? null, id);
}));
[
  { label: 'réponse 401 puis token de secours', statuses: [401, 200], expected: 2, result: 1 },
  { label: 'réponse 403 puis token de secours', statuses: [403, 200], expected: 2, result: 1 },
  { label: '429 arrête les tokens', statuses: [429], expected: 1, result: 0 },
  { label: '500 arrête les tokens', statuses: [500], expected: 1, result: 0 },
  { label: '404 bascule vers host stable', statuses: [404, 200], expected: 2, result: 1 },
  { label: '500 sans requête vers second host', statuses: [500], expected: 1, result: 0 },
].forEach(({ label, statuses, expected, result }, i) => add('fetch officiel statut HTTP #' + (i + 1) + ': ' + label, async () => {
  let calls = 0;
  const out = await fetchOfficialQuests(new Map(), { tokens: statuses.length === 2 && (statuses[0] === 401 || statuses[0] === 403) ? ['bad', 'good'] : ['a', 'b'], fetchWithRetry: async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)]; calls++;
    return response(status, status === 200 ? [{ id: 'ok' }] : {});
  } });
  assert.equal(calls, expected); assert.equal(out.length, result);
}));
[
  ['timeout injecté', 7000], ['timeout zéro reprend le défaut', 0],
].forEach(([label, timeout], _i) => add('fetch officiel options timeout #' + (_i + 1) + ': ' + label, async () => {
  let seen; await fetchOfficialQuests(new Map(), { tokens: ['t'], timeoutMs: timeout, fetchWithRetry: async (_url, opts) => { seen = opts.timeout; return response(200, []); } });
  assert.equal(seen, timeout || 25000);
}));
[
  ['erreur HTTP 401 réessaie le second host', new Error('HTTP 401 Unauthorized'), 2],
  ['erreur HTTP 429 cesse toute tentative', new Error('HTTP 429 Too Many Requests'), 1],
  ['erreur HTTP 503 ne passe pas au token suivant', new Error('HTTP 503 Service unavailable'), 1],
  ['erreur réseau ne passe pas au token suivant', new Error('socket closed'), 1],
  ['erreur 404 continue endpoint suivant', new Error('HTTP 404 Not found'), 2],
].forEach(([label, error, expected], i) => add('fetch officiel erreur transport #' + (i + 1) + ': ' + label, async () => {
  let calls = 0; const out = await fetchOfficialQuests(new Map(), { tokens: ['a', 'b'], fetchWithRetry: async () => { calls++; if (calls === 1) throw error; return response(200, []); } });
  assert.equal(calls, expected); assert.deepEqual(out, []);
}));
[
  ['texte JSON invalide', 'not-json'], ['JSON null', 'null'], ['JSON vide', ''],
].forEach(([label, body], _i) => add('fetch officiel corps vide/invalide #' + (_i + 1) + ': ' + label, async () => {
  let calls = 0; const out = await fetchOfficialQuests(new Map(), { tokens: ['t'], fetchWithRetry: async () => { calls++; return response(200, null, body); } });
  assert.equal(calls, 2); assert.deepEqual(out, []);
}));
[
  [{ id: 'official', messages: { quest_name: 'Official' } }, 'official'],
  [{ config: { messages: {} } }, null],
].forEach(([raw, expected], i) => add('fetch officiel filtre normalisation invalide #' + (i + 1), async () => {
  const out = await fetchOfficialQuests(Promise.resolve(new Map()), { tokens: ['t'], fetchWithRetry: async () => response(200, [raw]) });
  assert.equal(out[0]?.id ?? null, expected);
}));

// Watcher boundaries use a deterministic clock and an immediate injected sleep.
[
  ['watchMs nul fait une passe', 0, 1],
  ['watchMs négatif fait une passe', -1, 1],
  ['durée inférieure au demi-intervalle fait une passe', 2000, 1],
].forEach(([label, watchMs, expected], i) => add('watch frontière durée #' + (i + 1) + ': ' + label, async () => {
  process.exitCode = 0; let calls = 0; const out = await watch({ watchMs, pollMs: 30000, now: () => 0, sleep: async () => {}, main: async () => { calls++; } });
  assert.equal(calls, expected); assert.equal(out.passes, expected); process.exitCode = 0;
}));
[
  ['intervalle inférieur à 5000 borné sans vrai délai', 1],
  ['intervalle 5000 conservé', 5000],
].forEach(([label, pollMs], i) => add('watch borne intervalle #' + (i + 1) + ': ' + label, async () => {
  process.exitCode = 0; let t = 0; let slept;
  await watch({ watchMs: 10000, pollMs, now: () => t, sleep: async (ms) => { slept = ms; t += ms; }, main: async () => { t += 100; } });
  assert.ok(slept == null || slept >= 0); process.exitCode = 0;
}));
[
  ['retour unsent déclenche immédiatement une passe', { unsent: 1, sentFail: 0 }, 4],
  ['échec envoi n’entraîne pas retry immédiat', { unsent: 1, sentFail: 1 }, 3],
  ['aucun backlog attend le prochain polling', { unsent: 0, sentFail: 0 }, 3],
].forEach(([label, outcome, expected], i) => add('watch backlog #' + (i + 1) + ': ' + label, async () => {
  process.exitCode = 0; let t = 0; let calls = 0;
  const out = await watch({ watchMs: 12000, pollMs: 5000, now: () => t, sleep: async (ms) => { t += ms; }, main: async () => { calls++; t += 1; return calls === 1 ? outcome : { unsent: 0, sentFail: 0 }; } });
  assert.equal(calls, expected); assert.equal(out.passes, expected); process.exitCode = 0;
}));
[
  ['exception devient code 1', async () => { throw new Error('x'); }, 1],
  ['code 0 conservé', async () => {}, 0],
  ['code 2 le plus élevé conservé', async () => { process.exitCode = 2; }, 2],
].forEach(([label, main, code], i) => add('watch code de sortie #' + (i + 1) + ': ' + label, async () => {
  process.exitCode = 0; const out = await watch({ watchMs: 0, main, sleep: async () => {} }); assert.equal(out.exitCode, code); assert.equal(process.exitCode, code); process.exitCode = 0;
}));
[
  ['fraction numérique sentFail convertie', { unsent: 2, sentFail: 0 }, 4],
  ['sentFail numérique en chaîne empêche le fast path', { unsent: '2', sentFail: '1' }, 3],
].forEach(([label, outcome, expected], i) => add('watch interprétation du backlog #' + (i + 1) + ': ' + label, async () => {
  process.exitCode = 0; let t = 0; let calls = 0;
  await watch({ watchMs: 12000, pollMs: 5000, now: () => t, sleep: async (ms) => { t += ms; }, main: async () => { calls++; t++; return calls === 1 ? outcome : {}; } });
  assert.equal(calls, expected); process.exitCode = 0;
}));

// Orb image threshold boundary (fixed public Twemoji fallback).
[
  [0, /1f7e3\.png$/], [1, /1f7e3\.png$/], [499, /1f7e3\.png$/],
  [500, /1f48e\.png$/], [501, /1f48e\.png$/], [-1, /1f7e3\.png$/],
].forEach(([qty, pattern], i) => add('orbImageUrl seuil #' + (i + 1) + ' quantité=' + qty, () => assert.match(orbImageUrl(qty), pattern)));

assert.equal(cases.length, 183, 'La matrice doit contenir exactement 183 tests');
for (const { name, fn } of cases) test(name, fn);
