'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PING_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ping-test-'));

const m = require('../src/lib/mentions');
const { stripEmojiText, stripEmojiDeep } = require('../src/lib/webhook');

test('experiments et quêtes : ping à chaque fois', () => {
  assert.equal(m.claimPing('EXP_ADDED'), '1569711030718693396');
  assert.equal(m.claimPing('EXP_ADDED'), '1569711030718693396');
  assert.equal(m.claimPing('EXP_MODIFIED'), '1569711177561284618');
  assert.equal(m.claimPing('EXP_REMOVED'), '1569711113304543345');
  assert.equal(m.claimPing('QUESTS'), '1569711825627516938');
  assert.equal(m.claimPing('QUESTS'), '1569711825627516938');
});

test('strings : seuil minimal + délai entre deux pings', () => {
  assert.equal(m.claimPing('STR_ADDED', { count: 1 }), null); // trop peu
  const now = Date.now();
  assert.equal(m.claimPing('STR_ADDED', { count: 10, now }), '1569711339197304982');
  assert.equal(m.claimPing('STR_ADDED', { count: 10, now: now + 60000 }), null); // cooldown
  assert.equal(m.claimPing('STR_ADDED', { count: 10, now: now + 7 * 3600e3 }), '1569711339197304982');
  assert.equal(m.claimPing('STR_REMOVED', { count: 3, now }), '1569711391978430646');
  assert.equal(m.claimPing('STR_MODIFIED', { count: 5, now }), '1569711452187529246');
});

test('routes : 1 ping puis délai', () => {
  const now = Date.now();
  assert.equal(m.claimPing('ROUTE_ADDED', { count: 1, now }), '1569711585784635492');
  assert.equal(m.claimPing('ROUTE_ADDED', { count: 1, now: now + 1000 }), null);
  assert.equal(m.claimPing('ROUTE_REMOVED', { count: 1, now }), '1569711925494026280');
});

test('déploiements : seulement les changements significatifs + délai', () => {
  assert.equal(m.isSignificantRollout({ kind: 'new' }), true);
  assert.equal(m.isSignificantRollout({ deltas: [{ from: 10, to: 11, delta: 1 }] }), false);
  assert.equal(m.isSignificantRollout({ deltas: [{ from: 10, to: 20, delta: 10 }] }), true);
  assert.equal(m.isSignificantRollout({ deltas: [{ from: 98, to: 100, delta: 2 }] }), true);
  assert.equal(m.isSignificantRollout({ kind: 'changed', deltaPct: 0.5 }), false);
  const now = Date.now();
  assert.equal(m.claimPing('ROLLOUTS', { now }), '1440702716677722202');
  assert.equal(m.claimPing('ROLLOUTS', { now: now + 1000 }), null);
  assert.equal(m.claimPing('ROLLOUTS', { now: now + 61 * 60e3 }), '1440702716677722202');
});

test('PING_DISABLE coupe tout ; allowed_mentions strict', () => {
  process.env.PING_DISABLE = '1';
  assert.equal(m.claimPing('EXP_ADDED'), null);
  delete process.env.PING_DISABLE;
  assert.deepEqual(m.allowedMentions([]), { parse: [] });
  assert.deepEqual(m.allowedMentions(['1', '1']), { parse: [], roles: ['1'] });
  assert.equal(m.mentionText(['5']), '<@&5>');
});

test('emoji retirés du texte, code/mentions/timestamps conservés', () => {
  assert.equal(stripEmojiText('🆕 Nouveau rollout'), 'Nouveau rollout');
  assert.equal(stripEmojiText('📈 Montée · 🇫🇷 ✅ ok'), 'Montée · FR ok');
  assert.equal(stripEmojiText('<@&123> <t:1:R> `🙂`'), '<@&123> <t:1:R> `🙂`');
  assert.equal(stripEmojiText('```diff\n+ 🎉 x\n```'), '```diff\n+ 🎉 x\n```');
  assert.equal(stripEmojiText('A → B · 50 %'), 'A → B · 50 %');
  const out = stripEmojiDeep({ username: 'Bot 🤖', components: [{ type: 10, content: '🔔 Quête' }], embeds: [{ title: '🧪 T', fields: [{ name: '👤 user', value: '1' }] }] });
  assert.equal(out.components[0].content, 'Quête');
  assert.equal(out.embeds[0].title, 'T');
  assert.equal(out.embeds[0].fields[0].name, 'user');
});

test('ping auto : quêtes à chaque fois, déploiements seulement si significatif', () => {
  assert.deepEqual(m.autoPingRoles('quests', [{ title: 'Nouvelle quête', description: 'En cours' }]), ['1569711825627516938']);
  assert.deepEqual(m.autoPingRoles('quests', [{ title: 'Q', description: 'Expirée' }]), []);
  assert.deepEqual(m.autoPingRoles('alerts', [{ title: 'x' }]), []);
  const big = [{ title: 'Montée de rollout serveur — x', description: '**T1** · 10,00 % → **30,00 %** (`+20,00 pt`)' }];
  const small = [{ title: 'Montée de rollout serveur — x', description: '**T1** · 10,00 % → **10,50 %** (`+0,50 pt`)' }];
  assert.deepEqual(m.autoPingRoles('apex', small), []);
  const r1 = m.autoPingRoles('apex', big, null);
  assert.ok(Array.isArray(r1));
  assert.equal(m.textDeltas('(+12,00 pt) -3,5 pts').length, 2);
});

test('drapeaux → codes pays, globe → Monde', () => {
  assert.equal(stripEmojiText('**Pays** · 🇫🇷 🇺🇸'), '**Pays** · FR US');
  assert.equal(stripEmojiText('**Pays** · 🌍'), '**Pays** · Monde');
  assert.equal(stripEmojiText('🚫🇷🇺'), 'sauf RU');
});

test('ping auto experiments/strings/routes depuis le libellé de section', () => {
  const sec = (title, name) => [{ title, fields: [{ name, value: '```diff\n+ x\n```' }] }];
  assert.deepEqual(m.autoPingRoles('experiments', sec('Experiments · Build 1', 'Ajoutées · 2')), ['1569711030718693396']);
  assert.deepEqual(m.autoPingRoles('experiments', sec('Experiments · Build 1', 'Modifiées · 1')), ['1569711177561284618']);
  assert.deepEqual(m.autoPingRoles('experiments', sec('Experiments · Build 1', 'Supprimées · 1')), ['1569711113304543345']);
  assert.deepEqual(m.autoPingRoles('experiments', sec('Experiments · Build 1 · suite 2', '')), []);
  assert.deepEqual(m.autoPingRoles('strings', sec('Strings · Build 1', 'Ajoutés · 1')), []); // sous le seuil
  assert.deepEqual(m.autoPingRoles('routes', sec('Routes · Build 1', 'Modifiées · 4')), []); // pas de rôle
  assert.deepEqual(m.autoPingRoles('dismissible', sec('Dismissible Content · Build 1', 'Ajoutés · 9')), []);
});
