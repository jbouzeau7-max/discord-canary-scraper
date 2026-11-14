/**
 * Blog + Zendesk tracker (stub fonctionnel).
 */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic');

const DATA = path.join(__dirname, '..', 'data');

async function main() {
  await fs.ensureDir(DATA);
  const statePath = path.join(DATA, 'blog_tracker.json');
  let state = { posts: [], updatedAt: null };
  try {
    if (await fs.pathExists(statePath)) state = await fs.readJson(statePath);
  } catch {}

  console.log('blog_tracker.js stub — posts connus:', (state.posts || []).length);
  console.log('Pour le tracking blog/Zendesk complet, restaurer src/blog_tracker.js depuis le ZIP.');

  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(statePath, state);
}

main().catch((e) => {
  console.error('blog fatal:', e.message);
  process.exit(1);
});
