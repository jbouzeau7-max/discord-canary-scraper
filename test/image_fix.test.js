'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { looksRenderable } = require('../src/lib/image_check');
const { parseRssItems, firstImage, metaImage } = require('../src/blog_tracker');
const { pickImageCandidates, buildItemComponents } = require('../src/shop');

test('looksRenderable rejette SVG / non-http', () => {
  assert.equal(looksRenderable('https://x/a/Discrod_MainLogo.svg'), false);
  assert.equal(looksRenderable('data:image/png;base64,xx'), false);
  assert.equal(looksRenderable('/rel.png'), false);
  assert.equal(looksRenderable('https://cdn.x/a.png'), true);
});

test('RSS: image prise depuis media:content', () => {
  const xml = '<rss><item><title>T</title><link>https://d/b/1</link><media:content url="https://cdn/x_1540x616.png" medium="image"/></item></rss>';
  const [it] = parseRssItems(xml);
  assert.equal(it.image, 'https://cdn/x_1540x616.png');
});

test('firstImage ignore logo SVG', () => {
  const html = '<img src="https://c/Discrod_MainLogo.svg"><img src="https://c/logo.png"><img src="https://c/hero.jpg">';
  assert.equal(firstImage(html), 'https://c/hero.jpg');
});

test('metaImage lit og:image', () => {
  assert.equal(metaImage('<meta property="og:image" content="https://c/og.png">'), 'https://c/og.png');
  assert.equal(metaImage('<meta content="https://c/og.svg" property="og:image">'), null);
});

test('shop: nameplate -> assets/collectibles/.../static.png', () => {
  const c = pickImageCandidates({ sku_id: '1', items: [{ asset: 'nameplates/deadpool/wolverine/1564419285638582383/' }] });
  assert.equal(c[0], 'https://cdn.discordapp.com/assets/collectibles/nameplates/deadpool/wolverine/1564419285638582383/static.png');
  assert.ok(c.includes('https://cdn.discordapp.com/media/v1/collectibles-shop/1/static'));
});

test('shop: decoration -> avatar-decoration-presets png', () => {
  const c = pickImageCandidates({ items: [{ asset: 'a_902e7a3cb3bf4575007f5f2bf428ab50' }] });
  assert.equal(c[0], 'https://cdn.discordapp.com/avatar-decoration-presets/a_902e7a3cb3bf4575007f5f2bf428ab50.png');
});

test('shop: pas de gallery si image non vérifiée (null)', () => {
  const comps = buildItemComponents({ name: 'X', image: null });
  assert.ok(!comps.some((c) => c.type === 12));
});
