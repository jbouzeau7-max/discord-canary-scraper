/**
 * Discord Shop / Collectibles tracker (stub fonctionnel).
 */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic');

const DATA = path.join(__dirname, '..', 'data');

async function main() {
  const url = process.env.SHOP_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log('SHOP_WEBHOOK_URL non configuré — skip');
  }

  await fs.ensureDir(DATA);
  const statePath = path.join(DATA, 'shop_items.json');
  let state = { items: [], updatedAt: null };
  try {
    if (await fs.pathExists(statePath)) state = await fs.readJson(statePath);
  } catch {}

  console.log('shop.js stub — items connus:', (state.items || []).length);
  console.log('Pour le tracking boutique complet, restaurer src/shop.js depuis le ZIP.');

  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(statePath, state);
}

main().catch((e) => {
  console.error('shop fatal:', e.message);
  process.exit(1);
});
