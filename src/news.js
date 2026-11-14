/**
 * Actus générales → Discord webhook (stub fonctionnel).
 * Remplacer par la version complète du ZIP pour les 17 catégories RSS.
 */
const fs = require('fs-extra');
const path = require('path');
const { postWebhook } = require('./lib/webhook');
const { webhookIdentity } = require('./lib/webhook_identity');
const { writeJsonAtomic } = require('./lib/atomic');

const DATA = path.join(__dirname, '..', 'data');
const SEEN = path.join(DATA, 'seen_news.json');

async function main() {
  const url = process.env.NEWS_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log('NEWS_WEBHOOK_URL non configuré — skip');
    return;
  }

  await fs.ensureDir(DATA);
  let seen = { ids: [] };
  try {
    if (await fs.pathExists(SEEN)) seen = await fs.readJson(SEEN);
  } catch {}

  // Stub: pas de fetch RSS ici (version complète dans le ZIP original)
  console.log('news.js stub — seen ids:', (seen.ids || []).length);
  console.log('Pour le tracking RSS complet, restaurer src/news.js depuis le ZIP.');

  await writeJsonAtomic(SEEN, seen);
}

main().catch((e) => {
  console.error('news fatal:', e.message);
  process.exit(1);
});
