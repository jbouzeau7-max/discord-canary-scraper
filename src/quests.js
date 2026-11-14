/**
 * Discord Quests tracker (stub fonctionnel).
 */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic');

const DATA = path.join(__dirname, '..', 'data');

async function main() {
  const url = process.env.QUEST_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log('QUEST_WEBHOOK_URL non configuré — skip');
  }

  await fs.ensureDir(DATA);
  const statePath = path.join(DATA, 'quests.json');
  let state = { ids: [], updatedAt: null };
  try {
    if (await fs.pathExists(statePath)) state = await fs.readJson(statePath);
  } catch {}

  console.log('quests.js stub — ids connus:', (state.ids || []).length);
  console.log('Pour le tracking quêtes complet, restaurer src/quests.js depuis le ZIP.');

  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(statePath, state);
}

main().catch((e) => {
  console.error('quests fatal:', e.message);
  process.exit(1);
});
