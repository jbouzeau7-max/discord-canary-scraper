/**
 * Flat chunks system — publication plate et diffable des chunks du build.
 *
 * Publie le build courant dans un format plat et diffable sur GitHub :
 * - chunks/{chunkId}.js  (tous les chunks webpack, hash strippé du nom)
 * - css/{hash}.css       (tous les fichiers CSS)
 * - info.json
 */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./atomic');

async function publishFlatChunks({ assetsDir, chunksDir, cssDir, infoPath, build }) {
  await fs.ensureDir(chunksDir);
  await fs.ensureDir(cssDir);

  const names = await fs.readdir(assetsDir).catch(() => []);
  let jsCount = 0;
  let cssCount = 0;

  for (const name of names) {
    const src = path.join(assetsDir, name);
    try {
      if (name.endsWith('.js')) {
        // Strip content-hash from webpack names when possible
        const flat = name.replace(/\.[a-f0-9]{8,}\.js$/i, '.js');
        await fs.copy(src, path.join(chunksDir, flat), { overwrite: true });
        jsCount++;
      } else if (name.endsWith('.css')) {
        await fs.copy(src, path.join(cssDir, name), { overwrite: true });
        cssCount++;
      }
    } catch (e) {
      console.warn('flat_chunks copy fail', name, e.message);
    }
  }

  const info = {
    buildNumber: build && build.buildNumber,
    versionHash: build && build.versionHash,
    jsCount,
    cssCount,
    publishedAt: new Date().toISOString(),
  };
  if (infoPath) await writeJsonAtomic(infoPath, info, 2);
  console.log('Flat chunks published', info);
  return info;
}

module.exports = { publishFlatChunks };
