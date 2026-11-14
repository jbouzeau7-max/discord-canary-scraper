'use strict';
const fs = require('fs-extra');
const path = require('path');
const STATE = 'dismissible_content.json';

/**
 * Extract Discord DismissibleContent enum values from JS assets.
 * Discord compiles the TypeScript enum into assignment patterns in the bundle.
 */
function extractDismissibleFromText(text) {
  const found = new Map();
  // Pattern: i[i.NAME=123]="NAME" or similar
  const re = /\b([A-Z][A-Z0-9_]{3,})\s*=\s*(\d{1,6})\b/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    const id = Number(m[2]);
    if (/DISMISSIBLE|UPSELL|NUX|COACH|BANNER|MODAL|TOOLTIP|NOTICE/i.test(name)) {
      if (!found.has(name) || found.get(name) !== id) found.set(name, id);
    }
  }
  return [...found.entries()].map(([name, id]) => ({ name, id })).sort((a, b) => a.id - b.id);
}

async function processDismissibleContent({ assetsDir, dataDir, assets }) {
  const texts = [];
  const names = assets || (await fs.readdir(assetsDir).catch(() => []));
  for (const name of names) {
    if (!name.endsWith('.js')) continue;
    try {
      const t = await fs.readFile(path.join(assetsDir, name), 'utf8');
      texts.push(t);
    } catch {}
  }
  const combined = texts.join('\n');
  const items = extractDismissibleFromText(combined);

  const outPath = path.join(dataDir, STATE);
  let prev = { items: [] };
  try {
    if (await fs.pathExists(outPath)) prev = await fs.readJson(outPath);
  } catch {}

  const prevIds = new Set((prev.items || []).map((x) => x.name));
  const added = items.filter((x) => !prevIds.has(x.name));

  await fs.writeJson(outPath, { items, updatedAt: new Date().toISOString() }, { spaces: 2 });
  return { items, added, count: items.length };
}

module.exports = { processDismissibleContent, extractDismissibleFromText };
