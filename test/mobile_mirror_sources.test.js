'use strict';

/**
 * Sources « beta » mobiles : APKMirror / Aptoide (texte de page) et page
 * publique TestFlight. Ces tests verrouillent le parsing et la fusion, pas le
 * réseau : une source bloquée doit laisser l'état intact, jamais inventer une
 * version.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isCloudflareBlocked,
  parseVersionTrackPairs,
  latestByTrack,
  compareVersions,
  parseTestFlightJoinPage,
} = require('../src/lib/mirror_parse');
const { mergeTracks, probeTestFlight } = require('../scripts/mobile_mirrors');

// Texte réellement rendu par la page APKMirror « Latest uploads ».
const APKMIRROR_TEXT = `
[DMCAed NAME] - Talk, Play, Hang Out 356.0 - Alpha by [DMCAed NAME] Inc.
Version:356.0 - Alpha
Uploaded:November 16, 2026 at 6:48PM EST
[DMCAed NAME] - Talk, Play, Hang Out 355.6 - Beta by [DMCAed NAME] Inc.
Version:355.6 - Beta
Uploaded:November 16, 2026 at 6:48PM EST
[DMCAed NAME] - Talk, Play, Hang Out 354.13 - Beta by [DMCAed NAME] Inc.
Version:354.13 - Beta
[DMCAed NAME] - Talk, Play, Hang Out 354.12 - Stable by [DMCAed NAME] Inc.
Version:354.12 - Stable
`;

test('détecte les challenges Cloudflare', () => {
  assert.equal(isCloudflareBlocked('<title>Just a moment...</title>'), true);
  assert.equal(isCloudflareBlocked('Attention Required! | Cloudflare'), true);
  assert.equal(isCloudflareBlocked('Version:355.6 - Beta'), false);
  assert.equal(isCloudflareBlocked(''), false);
});

test('extrait les paires version/track de la page APKMirror', () => {
  const pairs = parseVersionTrackPairs(APKMIRROR_TEXT);
  assert.deepEqual(
    pairs.map((p) => `${p.version}:${p.track}`),
    ['356.0:alpha', '355.6:beta', '354.13:beta', '354.12:stable'],
  );
});

test('Aptoide (sans préfixe « Version: ») est lu par le même parseur', () => {
  const pairs = parseVersionTrackPairs('347.8 - Beta — 22/9/2026\n346.13 - Stable');
  assert.deepEqual(pairs.map((p) => p.version), ['347.8', '346.13']);
});

test('la dernière version par track est choisie numériquement', () => {
  const latest = latestByTrack(parseVersionTrackPairs(APKMIRROR_TEXT));
  assert.equal(latest.beta.version, '355.6');
  assert.equal(latest.alpha.version, '356.0');
  assert.equal(latest.stable.version, '354.12');
  assert.equal(compareVersions('355.10', '355.9'), 1);
});

test('un track absent reste null (aucune version inventée)', () => {
  const latest = latestByTrack(parseVersionTrackPairs('354.12 - Stable'));
  assert.equal(latest.beta, null);
  assert.equal(latest.alpha, null);
});

test('parseVersionTrackPairs tolère les entrées vides', () => {
  assert.deepEqual(parseVersionTrackPairs(''), []);
  assert.deepEqual(parseVersionTrackPairs(null), []);
  assert.equal(latestByTrack(null).count, 0);
});

test('page TestFlight pleine → aucune version', () => {
  const parsed = parseTestFlightJoinPage('<title>Join the Discord beta</title> This beta is full.');
  assert.equal(parsed.status, 'full');
  assert.equal(parsed.version, null);
  assert.equal(parsed.available, false);
});

test('page TestFlight ouverte → version exposée', () => {
  const parsed = parseTestFlightJoinPage('{"appStoreVersion":"355.0","beta":true}');
  assert.equal(parsed.status, 'open');
  assert.equal(parsed.version, '355.0');
  assert.equal(parsed.available, true);
});

test('probeTestFlight lit la page via un fetch injecté', async () => {
  const full = await probeTestFlight(async () => ({
    ok: true,
    text: async () => 'This beta is full.',
  }));
  assert.equal(full.status, 'full');
  const open = await probeTestFlight(async () => ({
    ok: true,
    text: async () => '"appStoreVersion":"355.0"',
  }));
  assert.equal(open.version, '355.0');
  await assert.rejects(
    probeTestFlight(async () => ({ ok: false, status: 503, text: async () => '' })),
    /TestFlight HTTP 503/,
  );
});

test('mergeTracks ajoute beta/alpha sans écraser une version plus récente', () => {
  const previous = {
    android: { beta: { version: '356.0', track: 'beta' }, alpha: null },
    ios: { beta: { version: '355.0' } },
  };
  const latest = latestByTrack(parseVersionTrackPairs(APKMIRROR_TEXT));
  const { state, updated } = mergeTracks(previous, latest, '2026-11-17T12:00:00Z');
  assert.equal(state.android.beta.version, '356.0', 'pas de régression de version');
  assert.equal(state.android.alpha.version, '356.0');
  assert.equal(state.ios.beta.version, '355.0', 'iOS intact (APKMirror est Android)');
  assert.deepEqual(updated, ['alpha 356.0']);
});

test('mergeTracks enregistre une beta TestFlight plus récente', () => {
  const { state, updated } = mergeTracks(
    { ios: { beta: { version: '354.1' } } },
    { beta: null },
    '2026-11-17T12:00:00Z',
    'apkmirror',
    { version: '356.0' },
  );
  assert.equal(state.ios.beta.version, '356.0');
  assert.equal(state.ios.beta.source, 'testflight_page');
  assert.deepEqual(updated, ['ios beta 356.0']);
});

test('mergeTracks signale la source et la date', () => {
  const { state } = mergeTracks(null, { beta: { version: '355.6' } }, '2026-11-17T12:00:00Z');
  assert.equal(state.android.beta.source, 'apkmirror');
  assert.equal(state.android.beta.date, '2026-11-17T12:00:00Z');
  assert.equal(state.sources.apkmirror.lastAccessible, true);
  assert.equal(state.updatedAt, '2026-11-17T12:00:00Z');
});
