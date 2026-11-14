'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mobile = require('../src/mobile_versions');

const store = {
  size: '230 MB',
  requires: 'iOS 16.0+',
  releaseDate: '2026-11-09T19:34:18Z',
  releaseNotes: 'Bug fixes',
};

test('iOS stable provient de la version App Store et transporte les métadonnées', () => {
  const [stable, beta] = mobile.classifyIosChannels('353.0', store, []);
  assert.equal(stable.platform, 'ios');
  assert.equal(stable.channel, 'stable');
  assert.equal(stable.version, '353.0');
  assert.equal(stable.source, 'itunes_lookup');
  assert.equal(stable.available, true);
  assert.equal(stable.size, '230 MB');
  assert.equal(stable.releaseNotes, 'Bug fixes');
  assert.equal(beta.available, false);
  assert.equal(beta.version, null);
});

test('OTA iOS en avance sur App Store devient la bêta TestFlight', () => {
  const channels = mobile.classifyIosChannels('353.0', store, [
    { version: '354.0', build: '123456', commit: 'abc123' },
    { version: '353.0', build: '123455' },
  ]);
  const beta = channels.find((c) => c.channel === 'beta');
  assert.equal(beta.version, '354.0');
  assert.equal(beta.build, '123456');
  assert.equal(beta.commit, 'abc123');
  assert.equal(beta.source, 'discord_ota_manifest');
  assert.equal(beta.available, true);
  assert.match(beta.storeUrl, /testflight/);
});

test('fallback TestFlight est sélectionné seulement s’il est plus récent que stable', () => {
  const saved = { version: '354.1', build: '123999' };
  assert.equal(mobile.selectIosBetaFallback('353.0', [], saved), saved);
  const beta = mobile.classifyIosChannels('353.0', store, [], saved)[1];
  assert.equal(beta.version, '354.1');
  assert.equal(beta.build, '123999');
  assert.equal(beta.source, 'testflight_fallback');
  assert.match(beta.note, /fallback/);
  assert.equal(beta.available, true);
  const components = mobile.buildReleaseComponents({ type: 'new', channel: beta });
  assert.match(JSON.stringify(components), /TestFlight fallback/);
});

test('fallback iOS à la version stable ou en arrière est rejeté', () => {
  assert.equal(mobile.selectIosBetaFallback('353.0', [], { version: '353.0' }), null);
  assert.equal(mobile.selectIosBetaFallback('353.0', [], { version: '352.1' }), null);
  assert.equal(mobile.classifyIosChannels('353.0', store, [], { version: '352.1' })[1].available, false);
});

test('le fallback iOS conserve les versions Android déjà fusionnées', () => {
  const androidUpdate = mobile.mergeExternalVersionData(null, {
    android: {
      beta: { version: '355.2', track: 'beta' },
      alpha: { version: '355.3', track: 'alpha' },
    },
  });
  const withIos = mobile.mergeExternalVersionData(androidUpdate, {
    ios: { beta: { version: '354.0', build: '123456' } },
  });
  assert.equal(withIos.android.beta.version, '355.2');
  assert.equal(withIos.android.alpha.version, '355.3');
  assert.equal(withIos.ios.beta.version, '354.0');
});

test('OTA active prime sur le fallback sauvegardé', () => {
  const ota = [{ version: '354.0', build: '123500' }];
  assert.equal(mobile.selectIosBetaFallback('353.0', ota, { version: '355.0' }), null);
  const beta = mobile.classifyIosChannels('353.0', store, ota, { version: '355.0' })[1];
  assert.equal(beta.version, '354.0');
  assert.equal(beta.source, 'discord_ota_manifest');
});

test('aucune stable iOS disponible : ne pas inventer une bêta active', () => {
  assert.equal(mobile.selectIosBetaFallback(null, [], { version: '354.0' }), null);
  const channels = mobile.classifyIosChannels(null, null, [{ version: '354.0' }], { version: '355.0' });
  assert.equal(channels[0].available, false);
  assert.equal(channels[1].available, false);
});

test('composants de notification TestFlight conservent les liens Store et TestFlight', () => {
  const beta = mobile.classifyIosChannels('353.0', store, [{ version: '354.0', build: '123456' }])[1];
  const components = mobile.buildReleaseComponents({ type: 'updated', channel: beta, previous: { version: '353.0' } });
  const text = JSON.stringify(components);
  assert.match(text, /Join TestFlight/);
  assert.match(text, /testflight\.apple\.com/);
  assert.match(text, /App Store/);
  assert.match(text, /353\.0 → 354\.0/);
});
