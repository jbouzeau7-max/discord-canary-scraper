/**
 * Extract experiments, routes and strings from Discord Canary assets.
 * Simplified functional version compatible with current download.js API.
 */
const fs = require('fs-extra');
const path = require('path');
const { downloadAll } = require('./download');
const { inferType } = require('./infer_type');

async function analyzeAssets(build, { assetsDir, forceRefresh, onCore }) {
  await fs.ensureDir(assetsDir);

  if (forceRefresh) {
    const existing = await fs.readdir(assetsDir).catch(() => []);
    for (const f of existing) {
      if (f.endsWith('.js') || f.endsWith('.css')) {
        try { await fs.remove(path.join(assetsDir, f)); } catch {}
      }
    }
  }

  const urls = [...(build.assets || []), ...(build.cssAssets || [])];
  const dl = await downloadAll(urls, assetsDir);
  console.log('Downloaded', dl.ok, 'assets,', dl.failed, 'failed');

  const names = await fs.readdir(assetsDir);
  const jsFiles = names.filter((n) => n.endsWith('.js'));

  const experiments = new Map();
  const routes = {};
  const strings = {};

  for (const name of jsFiles) {
    let content;
    try {
      content = await fs.readFile(path.join(assetsDir, name), 'utf8');
    } catch {
      continue;
    }
    extractExperiments(content, experiments);
    extractRoutes(content, routes);
    extractLocaleStrings(content, strings);
  }

  const expList = [...experiments.values()];
  if (typeof onCore === 'function') {
    try {
      await onCore({ experiments: expList, routes, strings });
    } catch (e) {
      console.warn('onCore failed:', e.message);
    }
  }

  return {
    experiments: expList,
    routes,
    strings,
    downloadStats: dl,
    assetCount: jsFiles.length,
  };
}

function extractExperiments(content, map) {
  // Common patterns: experiment id strings near treatment / rollout keywords
  const re = /["']([a-z0-9][a-z0-9_-]{6,80})["']\s*[,:]/gi;
  let m;
  while ((m = re.exec(content))) {
    const id = m[1];
    if (!/^[a-z]/.test(id)) continue;
    if (/^(https?|application|text|image|audio|video|multipart)/i.test(id)) continue;
    if (map.has(id)) continue;
    // Heuristic: keep ids that look like experiment keys
    if (/[-_]/.test(id) || /experiment|rollout|treatment|guild|user/i.test(id)) {
      map.set(id, {
        id,
        type: inferType(id),
        title: null,
        description: null,
      });
    }
  }
}

function extractRoutes(content, out) {
  const re = /["'](\/[a-zA-Z0-9/_\-{}:.]+)["']/g;
  let m;
  while ((m = re.exec(content))) {
    const p = m[1];
    if (p.length < 2 || p.length > 120) continue;
    if (/\.(js|css|png|jpg|svg|woff)/i.test(p)) continue;
    const key = p.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
    if (key && !out[key]) out[key] = p;
  }
}

function extractLocaleStrings(content, out) {
  // Very light string extraction from locale-like objects
  const re = /["']([A-Z][A-Z0-9_]{2,60})["']\s*:\s*["']([^"']{2,200})["']/g;
  let m;
  while ((m = re.exec(content))) {
    const k = m[1];
    const v = m[2];
    if (!out[k]) out[k] = v;
  }
}

module.exports = {
  analyzeAssets,
  extractExperiments,
  extractRoutes,
  extractLocaleStrings,
};
