'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mobile = require('../src/mobile_versions');

function commit(message, date = '2026-11-12T10:00:00Z') {
  return { commit: { message, author: { date } } };
}

const androidPrior = [
  { platform: 'android', channel: 'stable', version: '353.11', source: 'discord_ota_manifest' },
  { platform: 'android', channel: 'beta', version: '354.2', source: 'datamining_commits' },
  { platform: 'android', channel: 'alpha', version: '354.6', source: 'datamining_commits' },
];

test('parse Android tracks beta et alpha depuis les titres de commits', () => {
  const parsed = mobile.parseAndroidDataminingCommits([
    commit('355.3 (355103) beta build'),
    commit('355.3 (355203) runtime'),
  ]);
  assert.equal(parsed.source, 'datamining_commits');
  assert.deepEqual(parsed.beta, {
    version: '355.3', track: 1, date: '2026-11-12T10:00:00Z', source: 'datamining_commits',
  });
  assert.equal(parsed.alpha.version, '355.3');
  assert.equal(parsed.alpha.track, 2);
});

test('choisit indépendamment la plus grande version beta et alpha', () => {
  const parsed = mobile.parseAndroidDataminingCommits([
    commit('354.9 (354109) beta'),
    commit('355.2 (355102) beta'),
    commit('355.1 (355201) alpha'),
    commit('354.8 (354208) alpha'),
    commit('356.0 (356000) stable'),
  ]);
  assert.equal(parsed.beta.version, '355.2');
  assert.equal(parsed.alpha.version, '355.1');
  assert.equal(parsed.beta.track, 1);
  assert.equal(parsed.alpha.track, 2);
});

test('les numéros de version sont comparés numériquement, pas lexicographiquement', () => {
  const parsed = mobile.parseAndroidDataminingCommits([
    commit('355.9 (355109) beta'),
    commit('355.10 (355110) beta'),
  ]);
  assert.equal(parsed.beta.version, '355.10');
});

test('égalité de version : garde la date la plus récente', () => {
  const parsed = mobile.parseAndroidDataminingCommits([
    commit('355.3 (355203) alpha', '2026-11-10T10:00:00Z'),
    commit('355.3 (355203) runtime', '2026-11-12T10:00:00Z'),
  ]);
  assert.equal(parsed.alpha.date, '2026-11-12T10:00:00Z');
});

test('rejette les commits incohérents, malformés, stables ou track inconnu', () => {
  const parsed = mobile.parseAndroidDataminingCommits([
    commit('355.3 (354203) mismatched major'),
    commit('355.4 (355203) mismatched minor'),
    commit('355.3 (355003) stable'),
    commit('355.3 (355303) dev'),
    commit('355.3 (355203x) extra malformed'),
    commit('Release 355.3 (355203)'),
  ]);
  assert.equal(parsed, null);
});

test('une date de commit invalide n’efface pas une version valide', () => {
  const parsed = mobile.parseAndroidDataminingCommits([
    { commit: { message: '355.3 (355203)', author: { date: 'not-a-date' } } },
  ]);
  assert.equal(parsed.alpha.version, '355.3');
  assert.equal(parsed.alpha.date, null);
});

test('données API incorrectes ou vides n’inventent pas de version', () => {
  assert.equal(mobile.parseAndroidDataminingCommits(null), null);
  assert.equal(mobile.parseAndroidDataminingCommits({ message: 'rate limited' }), null);
  assert.equal(mobile.parseAndroidDataminingCommits([]), null);
  assert.equal(mobile.parseAndroidDataminingCommits([null, {}, { commit: null }]), null);
});

test('source GitHub envoie les en-têtes API et retourne les deux tracks', async () => {
  const original = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  try {
    let called;
    const result = await mobile.androidFromDataminingRepo(async (url, options) => {
      called = { url, options };
      return [commit('355.3 (355103) beta'), commit('355.3 (355203) alpha')];
    }, 'https://api.example/commits');
    assert.equal(called.url, 'https://api.example/commits');
    assert.equal(called.options.headers.Accept, 'application/vnd.github+json');
    assert.equal(called.options.headers.Authorization, 'Bearer test-token');
    assert.equal(result.beta.version, '355.3');
    assert.equal(result.alpha.version, '355.3');
  } finally {
    if (original === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = original;
  }
});

test('une erreur réseau ou un HTTP error ne bloque pas la collecte', async () => {
  const result = await mobile.androidFromDataminingRepo(async () => {
    throw new Error('GitHub API unavailable');
  }, 'https://api.example/commits');
  assert.equal(result, null);
});

test('une source moins récente ne fait pas régresser un track déjà découvert', () => {
  const current = { version: '355.4', source: 'aptoide' };
  assert.equal(mobile.preferNewerTrackVersion(current, { version: '355.3' }), current);
  assert.equal(mobile.preferNewerTrackVersion(current, null), current);
});

test('une version plus récente remplace un fallback plus ancien', () => {
  const selected = mobile.preferNewerTrackVersion(
    { version: '354.9', source: 'aptoide' },
    { version: '355.3', source: 'datamining_commits' },
  );
  assert.equal(selected.version, '355.3');
  assert.equal(selected.source, 'datamining_commits');
});

test('une mise à jour Aptoide partielle ne supprime pas beta/alpha ni iOS du fallback', () => {
  const previous = {
    updatedAt: '2026-11-10T00:00:00Z',
    sources: { oldSource: { lastAccessible: true } },
    android: {
      beta: { version: '354.9', source: 'aptoide', track: 'beta' },
      alpha: { version: '354.8', source: 'datamining_commits', track: 'alpha' },
    },
    ios: { beta: { version: '355.0', source: 'testflight' } },
  };
  const merged = mobile.mergeExternalVersionData(previous, {
    updatedAt: '2026-11-12T00:00:00Z',
    sources: { aptoide: { lastAccessible: true } },
    android: {
      beta: { version: '355.1', source: 'aptoide', track: 'beta' },
      alpha: null,
    },
  });
  assert.equal(merged.android.beta.version, '355.1');
  assert.equal(merged.android.alpha.version, '354.8');
  assert.equal(merged.ios.beta.version, '355.0');
  assert.ok(merged.sources.oldSource);
  assert.ok(merged.sources.aptoide);
});

test('une mise à jour externe vide conserve les deux versions Android', () => {
  const previous = { android: {
    beta: { version: '354.9' },
    alpha: { version: '355.1' },
  } };
  const merged = mobile.mergeExternalVersionData(previous, {
    android: { beta: null, alpha: null },
  });
  assert.equal(merged.android.beta.version, '354.9');
  assert.equal(merged.android.alpha.version, '355.1');
});

test('classification publie stable, beta et alpha Android dans le même snapshot', () => {
  const channels = mobile.classifyAndroidChannels(
    '353.11',
    [{ version: '353.11', build: '35301100483127' }],
    { version: '355.3', source: 'datamining_commits' },
    { version: '355.4', source: 'datamining_commits' },
  );
  assert.deepEqual(channels.map((c) => c.channel), ['stable', 'beta', 'alpha']);
  assert.deepEqual(channels.map((c) => c.version), ['353.11', '355.3', '355.4']);
  assert.ok(channels.every((c) => c.platform === 'android' && c.available));
});

test('chaque track Android évolue et produit son propre changement', () => {
  const previous = { channels: androidPrior, notifiedFingerprints: [] };
  const snapshot = {
    channels: [
      { platform: 'android', channel: 'stable', version: '353.11' },
      { platform: 'android', channel: 'beta', version: '355.3' },
      { platform: 'android', channel: 'alpha', version: '355.4' },
    ],
  };
  const changes = mobile.detectChanges(previous, snapshot).changes;
  assert.deepEqual(changes.map((c) => c.channel.channel).sort(), ['alpha', 'beta']);
  assert.equal(changes.length, 2);
});

test('version beta et alpha au même numéro restent deux tracks distincts', () => {
  const channels = mobile.classifyAndroidChannels(
    '353.11', [{ version: '353.11' }],
    { version: '355.3', source: 'datamining_commits' },
    { version: '355.3', source: 'datamining_commits' },
  );
  assert.equal(channels.filter((c) => c.version === '355.3').length, 2);
  assert.deepEqual(channels.filter((c) => c.version === '355.3').map((c) => c.channel), ['beta', 'alpha']);
});

test('sources vides : garde les canaux connus et ne les signale pas comme nouveaux', () => {
  const previous = { channels: androidPrior };
  const snapshot = { channels: [
    { platform: 'android', channel: 'stable', version: null, available: false },
    { platform: 'android', channel: 'beta', version: null, available: false },
  ] };
  mobile.preserveUnavailableChannels(previous, snapshot);
  assert.equal(snapshot.channels.find((c) => c.channel === 'beta').version, '354.2');
  assert.equal(snapshot.channels.find((c) => c.channel === 'alpha').version, '354.6');
  assert.equal(snapshot.channels.filter((c) => c.stale).length, 3);
  assert.equal(mobile.detectChanges(previous, snapshot).changes.length, 0);
});

test('une réponse fraîche compare avec la dernière version conservée et détecte la mise à jour', () => {
  const previous = { channels: androidPrior };
  const snapshot = { channels: [
    { platform: 'android', channel: 'stable', version: '353.11' },
    { platform: 'android', channel: 'beta', version: '355.3' },
    { platform: 'android', channel: 'alpha', version: null },
  ] };
  mobile.preserveUnavailableChannels(previous, snapshot);
  const changes = mobile.detectChanges(previous, snapshot).changes;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].channel.channel, 'beta');
  assert.equal(changes[0].previous.version, '354.2');
});

test('un canal complètement absent du résultat n’est pas supprimé de l’état', () => {
  const previous = { channels: androidPrior };
  const snapshot = { channels: [{ platform: 'android', channel: 'stable', version: '353.11' }] };
  mobile.preserveUnavailableChannels(previous, snapshot);
  assert.ok(snapshot.channels.some((c) => c.channel === 'beta' && c.version === '354.2' && c.stale));
  assert.ok(snapshot.channels.some((c) => c.channel === 'alpha' && c.version === '354.6' && c.stale));
});

test('une nouvelle valeur fraîche efface son indicateur stale', () => {
  const previous = { channels: [{ platform: 'android', channel: 'beta', version: '354.2', stale: true }] };
  const snapshot = { channels: [{ platform: 'android', channel: 'beta', version: '355.3' }] };
  mobile.preserveUnavailableChannels(previous, snapshot);
  assert.equal(snapshot.channels[0].stale, undefined);
  assert.equal(snapshot.channels[0].version, '355.3');
});
