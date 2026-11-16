'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sendWebhook, sendEmbeds } = require('../src/lib/webhook');
const { IDENTITIES } = require('../src/lib/webhook_identity');

const reply = { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };

test('chaque type de notification fournit son nom et son avatar dédiés', async () => {
  const sent = [];
  const opts = {
    identity: 'quests',
    minGapMs: 0,
    fetchImpl: async (_url, req) => { sent.push(JSON.parse(req.body)); return reply; },
  };
  await sendWebhook('https://example.com/webhook', { content: 'hello', username: 'ancien' }, opts);
  assert.equal(sent[0].username, 'Datamining · Quêtes');
  assert.equal(sent[0].avatar_url, IDENTITIES.quests[1]);
  assert.equal(sent[0].content, 'hello');
});

test('les messages Components V2 conservent une icône mobile dédiée', async () => {
  let sent;
  const opts = {
    identity: 'mobile',
    minGapMs: 0,
    fetchImpl: async (_url, req) => { sent = JSON.parse(req.body); return reply; },
  };
  await sendEmbeds('https://example.com/webhook', { username: 'ancien' }, [{ title: 'Une version' }], opts);
  assert.equal(sent.username, 'Datamining · Mobile');
  assert.equal(sent.avatar_url, IDENTITIES.mobile[1]);
  assert.equal(sent.flags, 32768);
});

test('chaque identité a un badge public distinct et adapté à son domaine', () => {
  const { webhookIdentity, IDENTITIES: identities, AVATAR_URLS } = require('../src/lib/webhook_identity');
  const entries = Object.entries(identities);
  const avatars = entries.map(([, [, avatar]]) => avatar);
  assert.equal(entries.length, 29);
  assert.equal(new Set(avatars).size, entries.length, 'aucune identité ne doit partager son avatar');
  assert.equal(Object.keys(AVATAR_URLS).length, entries.length);

  for (const [key, [label, avatar]] of entries) {
    const identity = webhookIdentity(key);
    assert.equal(identity.username, `Datamining · ${label}`);
    assert.equal(identity.avatar_url, avatar);
    assert.match(avatar, /^https:\/\/files\.manuscdn\.com\/user_upload_by_module\/session_file\/.+\.png$/);
    const imagePath = path.join(__dirname, '..', 'assets', 'webhook-avatars', `${key}.png`);
    const image = fs.readFileSync(imagePath);
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(identity.username.length <= 80);
  }
});

test('chaque catégorie actualité conserve une icône différente', () => {
  const { webhookIdentity } = require('../src/lib/webhook_identity');
  const { CATEGORY } = require('../src/news');
  const avatars = Object.entries(CATEGORY).map(([category, value]) => [
    category,
    webhookIdentity(value.identity).avatar_url,
  ]);
  assert.equal(new Set(avatars.map(([, avatar]) => avatar)).size, avatars.length);
  for (const [category, avatar] of avatars) {
    assert.ok(avatar, `avatar absent pour ${category}`);
  }
});
