'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../src/lib/mobile_extract');
const f = require('../src/mobile_from_files');
const { sectionEmbeds } = require('../src/lib/notify');

const APEX = `
const obj = {
  name: "2026-05-electron-multilang-spellcheck",
  kind: "user",
  defaultConfig: { enableElectronMultilangSpellcheck: false },
  variations: null,
};
const obj2 = { 1: null, 2: null };
obj2[1] = { enableElectronMultilangSpellcheck: true };
obj2[2] = { enableElectronMultilangSpellcheck: true, extra: "x" };
obj.variations = obj2;
const apexExperiment = ApexExperiment.createApexExperiment(obj);
const label = intl.string(util.t.H6zNFz) + t["+4Empk"];
`;

const LEGACY = `
const obj = {
  kind: "guild",
  id: "2026-02_hangout_window",
  label: "Hangout Window",
  defaultConfig: { enableHangoutWindow: false },
  treatments: null,
};
const items = [{ id: 1, label: "Enable Hangout Window", config: { enableHangoutWindow: true } }];
obj.treatments = items;
const experiment = createExperiment.createExperiment(obj);
`;

const ROUTES = `
const obj = {
  INDEX: "/",
  APP: "/app",
  APP_WITH_GIFT_CODE(arg0) {
    return "/app/gifts/" + arg0;
  },
  ACTIVITY: "/activity",
};
obj.QUEST_PREVIEW = function QUEST_PREVIEW(arg0) {
  return "/quest-preview/" + arg0;
};
`;

test('mobile extract: apex experiment with variations', () => {
  const [e] = X.extractExperimentsFromSource(APEX);
  assert.equal(e.id, '2026-05-electron-multilang-spellcheck');
  assert.equal(e.kind, 'user');
  assert.equal(e.system, 'apex');
  assert.deepEqual(e.defaultConfig, { enableElectronMultilangSpellcheck: false });
  assert.deepEqual(Object.keys(e.variations), ['1', '2']);
  assert.equal(e.variations[2].extra, 'x');
});

test('mobile extract: legacy experiment with treatments + label', () => {
  const [e] = X.extractExperimentsFromSource(LEGACY);
  assert.equal(e.id, '2026-02_hangout_window');
  assert.equal(e.kind, 'guild');
  assert.equal(e.system, 'legacy');
  assert.equal(e.label, 'Hangout Window');
  assert.equal(e.treatments.length, 1);
  assert.equal(e.treatments[0].label, 'Enable Hangout Window');
});

test('mobile extract: string keys + routes (functions → :param)', () => {
  const keys = X.extractStringKeys(APEX);
  assert.ok(keys.has('H6zNFz'));
  assert.ok(keys.has('+4Empk'));
  const r = X.extractMobileRoutes(ROUTES, {});
  assert.equal(r.APP, '/app');
  assert.equal(r.APP_WITH_GIFT_CODE, '/app/gifts/:param');
  assert.equal(r.QUEST_PREVIEW, '/quest-preview/:param');
  const res = X.resolveStrings(new Set(['H6zNFz', 'zzzzzz']), { H6zNFz: 'Hello' });
  assert.equal(res.H6zNFz, 'Hello');
  assert.equal(res.zzzzzz, '[zzzzzz]');
});

test('mobile extract: loose ids are kept as fallback', () => {
  const r = X.scanContents([{ file: 'a.js', content: 'foo("2026-01-android-rmle")' }]);
  assert.equal(r.experiments.length, 1);
  assert.equal(r.experiments[0].system, 'unknown');
});

function mkExps(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `2026-01-exp-${String(i).padStart(3, '0')}`,
    kind: 'user',
    type: 'user',
    system: 'apex',
    variations: { 1: {} },
    ...extra,
  }));
}

test('computeMobileDiff: added / modified / removed / category / strings / routes', () => {
  const base = mkExps(40);
  const strings = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${String(i).padStart(5, '0')}`, `v${i}`]));
  const routes = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`ROUTE_${i}`, `/r/${i}`]));
  const previous = { format: f.STATE_FORMAT, experiments: base, strings, routes };

  const cur = base.slice(1).map((e) => ({ ...e }));
  cur[0] = { ...cur[0], variations: { 1: {}, 2: {} } }; // modified
  cur[1] = { ...cur[1], kind: 'guild', type: 'guild' }; // category
  cur.push({ id: '2026-11-brand-new', kind: 'user', type: 'user', system: 'apex' });
  const curStrings = { ...strings, newkey: 'Nouveau' };
  delete curStrings.k00000;
  const curRoutes = { ...routes, ROUTE_NEW: '/new', ROUTE_1: '/changed' };
  delete curRoutes.ROUTE_0;

  const known = new Set(base.map((e) => e.id));
  const d = f.computeMobileDiff(previous, { experiments: cur, strings: curStrings, routes: curRoutes }, { knownIds: known });
  assert.equal(d.degraded, null);
  assert.deepEqual(d.expDiff.added.map((e) => e.id), ['2026-11-brand-new']);
  assert.deepEqual(d.expDiff.removed.map((e) => e.id), ['2026-01-exp-000']);
  assert.equal(d.expDiff.modified.length, 1);
  assert.equal(d.expDiff.categoryChanged.length, 1);
  assert.deepEqual(Object.keys(d.strDiff.added), ['newkey']);
  assert.deepEqual(Object.keys(d.strDiff.removed), ['k00000']);
  assert.deepEqual(Object.keys(d.rtDiff.added), ['ROUTE_NEW']);
  assert.deepEqual(Object.keys(d.rtDiff.modified), ['ROUTE_1']);
  assert.deepEqual(Object.keys(d.rtDiff.removed), ['ROUTE_0']);
});

test('computeMobileDiff: degraded extraction refuses to diff', () => {
  const previous = { format: f.STATE_FORMAT, experiments: mkExps(100), strings: {}, routes: {} };
  const d = f.computeMobileDiff(previous, { experiments: mkExps(10), strings: {}, routes: {} });
  assert.match(d.degraded, /experiments/);
});

test('computeMobileDiff: legacy state migrates without flooding', () => {
  const previous = { experiments: mkExps(40), strings: { ABCDEF: 'x' } };
  const cur = [...mkExps(40), { id: '2026-11-new-one', kind: 'user', type: 'user' }];
  const d = f.computeMobileDiff(previous, { experiments: cur, strings: { A: 'b' }, routes: { X_Y_Z: '/x' } }, {
    knownIds: new Set(mkExps(40).map((e) => e.id)),
  });
  assert.equal(d.seeded, true);
  assert.deepEqual(d.expDiff.added.map((e) => e.id), ['2026-11-new-one']);
  assert.equal(Object.keys(d.strDiff.added).length, 0);
  assert.equal(Object.keys(d.rtDiff.added).length, 0);
});

test('buildLabel + Canary-style embeds titled Mobile', () => {
  assert.equal(f.buildLabel({ message: '355.5 (355205) runtime', commit: 'abc' }), '355.5 (355205)');
  assert.equal(f.buildLabel({ message: 'misc', commit: 'abc' }), 'abc');
  const [e] = sectionEmbeds(
    { label: 'Ajoutées · 1', color: 1, lines: ['+ 2026-11-x'] },
    { title: 'Mobile Experiments', bn: '355.5 (355205)', ts: '2026-11-16T00:00:00Z', footerLabel: 'Mobile' },
  );
  assert.match(e.title, /^Mobile Experiments · Build 355\.5/);
  assert.match(e.footer.text, /^Mobile 355\.5/);
  const [c] = sectionEmbeds(
    { label: 'x', color: 1, lines: ['+ a'] },
    { title: 'Experiments', bn: '1', ts: '2026-11-16T00:00:00Z' },
  );
  assert.match(c.footer.text, /^Canary 1/);
});

const mv = require('../src/mobile_versions');

test('mobile versions: intermediate versions are listed (no silent skip)', () => {
  const snapshot = {
    otaIndex: { android: [], ios: [{ version: '354.0' }, { version: '353.1' }, { version: '353.0' }] },
    sources: { androidTrackVersions: { alpha: ['355.5', '355.3', '355.2', '355.1'], beta: [] } },
    channels: [
      { platform: 'android', channel: 'alpha', version: '355.5' },
      { platform: 'ios', channel: 'stable', version: '354.0' },
    ],
  };
  const previous = {
    channels: [
      { platform: 'android', channel: 'alpha', version: '355.1' },
      { platform: 'ios', channel: 'stable', version: '353.0' },
    ],
  };
  const { changes } = mv.detectChanges(previous, snapshot);
  const alpha = changes.find((c) => c.channel.channel === 'alpha');
  assert.deepEqual(alpha.skipped, ['355.2', '355.3']);
  const ios = changes.find((c) => c.channel.platform === 'ios');
  assert.deepEqual(ios.skipped, ['353.1']);
  const comps = JSON.stringify(mv.buildReleaseComponents(alpha));
  assert.match(comps, /Also released since last check/);
});

test('mobile versions: same version with a new build is announced once', () => {
  const snapshot = {
    otaIndex: {},
    channels: [{ platform: 'android', channel: 'stable', version: '353.11', build: '35301100484760' }],
  };
  const previous = {
    notifiedFingerprints: ['android|stable|353.11'],
    channels: [{ platform: 'android', channel: 'stable', version: '353.11', build: '35301100484752' }],
  };
  const { changes } = mv.detectChanges(previous, snapshot);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'rebuild');
  const again = mv.detectChanges({ ...previous, notifiedFingerprints: [changes[0].fp] }, snapshot);
  assert.equal(again.changes.length, 0);
});
