'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/mobile_versions');

const chan = (platform, channel, version) => ({ platform, channel, version, available: true });
const change = (platform, channel, from, to) => ({
  type: from ? 'updated' : 'new',
  channel: chan(platform, channel, to),
  previous: from ? chan(platform, channel, from) : null,
  fp: `${platform}|${channel}|${to}`,
});

test('deliverChanges : résumé puis une release par message, dans l’ordre iOS → Android', async () => {
  const posts = [];
  const changes = [change('android', 'alpha', '355.4', '355.5'), change('ios', 'stable', '352.0', '353.0')];
  const r = await m.deliverChanges(changes, async (components) => {
    posts.push(components);
  });
  assert.equal(r.error, null);
  assert.equal(posts.length, 3, '1 résumé + 2 releases');
  assert.deepEqual(r.sent.map((c) => c.fp), ['ios|stable|353.0', 'android|alpha|355.5']);
  assert.deepEqual(r.failed, []);
});

test('deliverChanges : une seule release → pas de résumé', async () => {
  let n = 0;
  const r = await m.deliverChanges([change('ios', 'stable', '352.0', '353.0')], async () => {
    n++;
  });
  assert.equal(n, 1);
  assert.equal(r.sent.length, 1);
});

test('deliverChanges : échec en cours de lot → livrées et échouées distinguées (ni doublon ni perte)', async () => {
  let n = 0;
  const changes = [
    change('ios', 'stable', '352.0', '353.0'),
    change('android', 'stable', '353.10', '353.11'),
    change('android', 'alpha', '355.4', '355.5'),
  ];
  const r = await m.deliverChanges(changes, async () => {
    n++;
    if (n === 3) throw new Error('Webhook failed after retries'); // résumé, iOS OK, Android stable KO
  });
  assert.match(r.error.message, /Webhook failed/);
  assert.deepEqual(r.sent.map((c) => c.fp), ['ios|stable|353.0']);
  assert.deepEqual(r.failed.map((c) => c.fp), ['android|stable|353.11', 'android|alpha|355.5']);
  assert.equal(n, 3, 'arrêt au premier échec');
});

test('deliverChanges : résumé en échec → rien n’est marqué livré', async () => {
  const changes = [change('ios', 'stable', '352.0', '353.0'), change('android', 'alpha', '355.4', '355.5')];
  const r = await m.deliverChanges(changes, async () => {
    throw new Error('Webhook HTTP 404');
  });
  assert.equal(r.sent.length, 0);
  assert.equal(r.failed.length, 2);
});

test('échec partiel : au run suivant seules les releases non livrées sont redétectées', async () => {
  const previous = {
    channels: [chan('ios', 'stable', '352.0'), chan('android', 'stable', '353.10')],
    notifiedFingerprints: ['ios|stable|352.0', 'android|stable|353.10'],
  };
  const fresh = () => ({
    channels: [chan('ios', 'stable', '353.0'), chan('android', 'stable', '353.11'), chan('android', 'alpha', '355.5')],
  });
  const first = m.detectChanges(previous, fresh());
  assert.equal(first.changes.length, 3);

  let n = 0;
  const out = await m.deliverChanges(first.changes, async () => {
    n++;
    if (n === 3) throw new Error('boom');
  });
  // État écrit après l'échec : livrées acquittées, échouées retenues.
  const state = m.holdBackFailedChannels(fresh(), out.failed);
  state.notifiedFingerprints = [...previous.notifiedFingerprints, ...out.sent.map((c) => c.fp)];
  assert.deepEqual(
    state.channels.map((c) => `${c.platform}/${c.channel}=${c.version}`),
    ['ios/stable=353.0', 'android/stable=353.10'],
    'iOS avance ; Android stable revient à l’ancienne version ; alpha inédit retiré',
  );

  const second = m.detectChanges(state, fresh());
  assert.deepEqual(
    second.changes.map((c) => `${c.type}:${c.fp}`).sort(),
    ['new:android|alpha|355.5', 'updated:android|stable|353.11'],
  );
});

test('holdBackFailedChannels : sans échec, instantané inchangé', () => {
  const snap = { channels: [chan('ios', 'stable', '353.0')] };
  assert.deepEqual(m.holdBackFailedChannels(snap, []).channels, [chan('ios', 'stable', '353.0')]);
});
