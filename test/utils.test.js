'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sleep,
  redactSecrets,
  DEFAULT_UA,
  DEFAULT_BOT_NAME,
  DEFAULT_AVATAR_URL,
} = require('../src/lib/utils');

test('sleep returns a promise that resolves', async () => {
  const start = Date.now();
  await sleep(50);
  assert.ok(Date.now() - start >= 40, 'sleep should wait at least the requested duration');
});

test('redactSecrets masque les JWT', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456789';
  const redacted = redactSecrets('Token: ' + jwt);
  assert.ok(!redacted.includes(jwt), 'JWT should be redacted');
  assert.ok(redacted.includes('[REDACTED_JWT]'));
});

test('redactSecrets masque les MFA tokens', () => {
  const token = 'mfa.abcdef1234567890123456789012345';
  const redacted = redactSecrets('Error: ' + token);
  assert.ok(!redacted.includes(token));
  assert.ok(redacted.includes('[REDACTED_TOKEN]'));
});

test('redactSecrets masque les Bot tokens', () => {
  const token = 'Bot abcdefghijklmnopqrstuvwxyz1234567890';
  const redacted = redactSecrets('Auth: ' + token);
  assert.ok(!redacted.includes(token));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('redactSecrets gère les entrées nulles ou vides', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
});

test('redactSecrets ne modifie pas les messages normaux', () => {
  const msg = 'Build 123456 updated successfully';
  assert.equal(redactSecrets(msg), msg);
});

test('DEFAULT_UA est une chaîne non vide', () => {
  assert.equal(typeof DEFAULT_UA, 'string');
  assert.ok(DEFAULT_UA.length > 20);
  assert.ok(DEFAULT_UA.includes('Chrome'));
});

test('DEFAULT_BOT_NAME est une chaîne non vide', () => {
  assert.equal(typeof DEFAULT_BOT_NAME, 'string');
  assert.ok(DEFAULT_BOT_NAME.length > 0);
});

test('DEFAULT_AVATAR_URL est une URL valide', () => {
  assert.ok(DEFAULT_AVATAR_URL.startsWith('https://'));
  assert.match(DEFAULT_AVATAR_URL, /^https:\/\/files\.manuscdn\.com\/.*\.png$/);
  assert.ok(!DEFAULT_AVATAR_URL.includes('kmljkjj/discord-canary-scraper'));
});

test('aucun chargeur de jetons Discord n’est exposé', () => {
  const utils = require('../src/lib/utils');
  assert.equal('loadTokens' in utils, false);
  assert.equal('firstToken' in utils, false);
});
