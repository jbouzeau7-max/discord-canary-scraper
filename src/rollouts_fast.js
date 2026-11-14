/**
 * Rollouts fast probe (stub fonctionnel).
 * Version complète dans le ZIP : sondes guild + gist en parallèle.
 */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic');

const DATA = path.join(__dirname, '..', 'data');

async function main() {
  await fs.ensureDir(DATA);
  console.log('rollouts_fast.js stub');
  console.log('Pour les rollouts complets, restaurer src/rollouts_fast.js + modules associés depuis le ZIP.');

  await writeJsonAtomic(path.join(DATA, 'rollouts_fast_meta.json'), {
    stub: true,
    updatedAt: new Date().toISOString(),
  });
}

main().catch((e) => {
  console.error('rollouts_fast fatal:', e.message);
  process.exit(1);
});
