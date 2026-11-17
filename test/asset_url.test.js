'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAssetUrl, isAllowedAssetUrl } = require('../src/lib/asset_url');

test('normalizeAssetUrl accepts only HTTPS Discord asset endpoints', () => {
  assert.equal(
    normalizeAssetUrl('/assets/web.123.js?build=2#top'),
    'https://canary.discord.com/assets/web.123.js',
  );
  assert.equal(
    normalizeAssetUrl('//cdn.discordapp.com/assets/chunk.js?v=2'),
    'https://cdn.discordapp.com/assets/chunk.js',
  );
  for (const url of [
    'http://canary.discord.com/assets/x.js',
    'https://127.0.0.1/assets/x.js',
    'https://localhost/assets/x.js',
    'https://canary.discord.com.evil.test/assets/x.js',
    'https://user@canary.discord.com/assets/x.js',
    'https://canary.discord.com:8443/assets/x.js',
    'https://canary.discord.com/assets/../admin.js',
    'https://canary.discord.com/assets/image.png',
    'file:///assets/x.js',
  ]) {
    assert.equal(normalizeAssetUrl(url), null, `${url} must be rejected`);
  }
  assert.equal(isAllowedAssetUrl('https://canary.discord.com/assets/a.css'), true);
  assert.equal(isAllowedAssetUrl('https://evil.test/assets/a.css'), false);
});
