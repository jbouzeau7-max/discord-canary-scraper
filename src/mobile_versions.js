/**
 * Mobile versions tracker (stub fonctionnel).
 */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic');

const DATA = path.join(__dirname, '..', 'data');

async function main() {
  await fs.ensureDir(DATA);
  const statePath = path.join(DATA, 'mobile_versions.json');
  let state = { ios: [], android: [], updatedAt: null };
  try {
    if (await fs.pathExists(statePath)) state = await fs.readJson(statePath);
  } catch {}

  console.log('mobile_versions.js stub');
  console.log('Pour le tracking mobile complet, restaurer src/mobile_versions.js depuis le ZIP.');

  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(statePath, state);
}

main().catch((e) => {
  console.error('mobile fatal:', e.message);
  process.exit(1);
});
