'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuest, buildQuestComponentsV2, buildQuestEmbed, orbImageUrl } = require('../src/quests');

const RAW = {
  id: '1234567890',
  starts_at: '2026-11-01T10:00:00Z',
  expires_at: '2026-11-15T10:00:00Z',
  features: [14, 15],
  application: { id: '42', name: 'Some Game', link: 'https://example.com' },
  assets: { hero: 'hero.png', game_tile_dark: 'tile_dark.png' },
  messages: {
    quest_name: 'Quête Test',
    game_title: 'Some Game',
    game_publisher: 'Publisher',
  },
  task_config_v2: {
    join_operator: 'OR',
    tasks: {
      t1: { type: 'WATCH_VIDEO', target: 90, assets: { video: { url: 'task.mp4' } } },
    },
  },
  rewards_config: {
    platforms: [1, 2],
    rewards: [
      { type: 4, orb_quantity: 100, premium_orb_quantity: 250, sku_id: 'sku1' },
      { type: 3, asset: 'deco.mp4', asset_video: 'deco.mp4', messages: { name: 'Déco' } },
    ],
  },
};

test('orbImageUrl utilise un fallback Twemoji public et respecte le seuil des récompenses', () => {
  const low = new URL(orbImageUrl(200));
  const high = new URL(orbImageUrl(700));
  assert.equal(low.hostname, 'cdn.jsdelivr.net');
  assert.match(low.pathname, /1f7e3\.png$/);
  assert.match(high.pathname, /1f48e\.png$/);
  assert.ok(!low.href.includes('kmljkjj/discord-canary-scraper'));
});

test('normalizeQuest: lien quête + plateformes numériques + poster webp', () => {
  const q = normalizeQuest(RAW, new Map());
  assert.equal(q.questUrl, 'https://canary.discord.com/quests/1234567890');
  assert.equal(q.platforms, 'Xbox, PlayStation');
  const deco = q.rewards.find((r) => r.type === 3);
  assert.ok(deco.assetPoster && deco.assetPoster.endsWith('?format=webp'));
  assert.ok(deco.assetVideo.endsWith('deco.mp4'));
});

test('normalizeQuest: support ancien format config imbriqué', () => {
  const old = { id: '999', config: { ...RAW, id: undefined } };
  const q = normalizeQuest(old, new Map());
  assert.equal(q.id, '999');
  assert.equal(q.name, 'Quête Test');
});

test('buildQuestComponentsV2: titre cliquable + timestamps Discord', () => {
  const q = normalizeQuest(RAW, new Map());
  const payload = buildQuestComponentsV2(q);
  assert.equal(payload.flags, 32768);
  const container = payload.components[0];
  const texts = container.components
    .filter((b) => b.type === 10)
    .map((b) => b.content)
    .join('\n');
  assert.ok(texts.includes('https://canary.discord.com/quests/1234567890'));
  assert.ok(/<t:\d+:F>/.test(texts), 'timestamps Discord présents');
  assert.ok(texts.includes('Xbox'));
  const buttons = container.components.find((b) => b.type === 1);
  assert.ok(buttons.components.some((b) => b.label === 'Ouvrir la quête'));
});

test('buildQuestEmbed: url + timestamps + fallback plateformes', () => {
  const q = normalizeQuest(RAW, new Map());
  const embed = buildQuestEmbed(q);
  assert.equal(embed.url, 'https://canary.discord.com/quests/1234567890');
  assert.ok(/<t:\d+:F>/.test(embed.description));
  assert.ok(embed.thumbnail && /cdn\.discordapp\.com/.test(embed.thumbnail.url));
});

test('normalizeQuest: quête sans récompense ni tâche ne casse rien', () => {
  const q = normalizeQuest({ id: '1', messages: {} }, new Map());
  assert.equal(q.rewards.length, 0);
  assert.equal(q.tasksText, null);
  assert.equal(q.platforms, 'Multiplateforme');
});
