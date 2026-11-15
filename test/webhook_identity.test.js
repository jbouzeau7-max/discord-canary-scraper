'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendWebhook, sendEmbeds } = require('../src/lib/webhook');

const reply = { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };

test('chaque type de notification fournit son nom et son avatar aux messages', async () => {
  const sent = [];
  const opts = { identity: 'quests', minGapMs: 0, fetchImpl: async (_url, req) => { sent.push(JSON.parse(req.body)); return reply; } };
  await sendWebhook('https://example.com/webhook', { content: 'hello', username: 'ancien' }, opts);
  assert.equal(sent[0].username, 'Datamining · Quêtes');
  assert.match(sent[0].avatar_url, /^https:\/\/files\.manuscdn\.com\/.*\.png$/);
  assert.equal(sent[0].content, 'hello');
});

test('les messages Components V2 conservent leur identité', async () => {
  let sent;
  const opts = { identity: 'mobile', minGapMs: 0, fetchImpl: async (_url, req) => { sent = JSON.parse(req.body); return reply; } };
  await sendEmbeds('https://example.com/webhook', { username: 'ancien' }, [{ title: 'Une version' }], opts);
  assert.equal(sent.username, 'Datamining · Mobile');
  assert.match(sent.avatar_url, /^https:\/\/files\.manuscdn\.com\/.*\.png$/);
  assert.equal(sent.flags, 32768);
});

test('identités actus : toutes définies et partagent la photo de marque', () => {
  const { webhookIdentity, IDENTITIES } = require('../src/lib/webhook_identity');
  const { CATEGORY } = require('../src/news');
  const avatars = new Set(Object.values(IDENTITIES).map(([, avatar]) => avatar));
  assert.equal(avatars.size, 1);
  assert.match([...avatars][0], /^https:\/\/files\.manuscdn\.com\/.*\.png$/);
  for (const [cat, c] of Object.entries(CATEGORY)) {
    const id = webhookIdentity(c.identity);
    assert.ok(id.username.startsWith('Datamining · Actus · '), cat);
    assert.ok(id.username.length <= 80);
    assert.equal(id.avatar_url, [...avatars][0]);
  }
});
