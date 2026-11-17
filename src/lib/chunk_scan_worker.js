'use strict';

/**
 * Worker de scan des chunks : lit une liste de fichiers déjà téléchargés et
 * renvoie les routes / expériences / éléments dismissible trouvés, plus les
 * compteurs de couverture.
 *
 * Pourquoi : le scan des ~6700 chunks (≈150 Mo) coûtait ~6,6 s en séquentiel
 * juste avant l'envoi de la notification Discord. Réparti sur plusieurs
 * workers, il tombe à ~2 s.
 *
 * Le worker ne décide de rien : la fusion et les gardes de dégradation restent
 * dans src/lib/extract.js (ordre déterministe, mêmes seuils).
 */

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const {
  extractRoutes,
  extractExperiments,
  extractDismissibleContent,
} = require('./extract');

const files = Array.isArray(workerData?.files) ? workerData.files : [];
const dir = String(workerData?.dir || '');
const maxScanBytes = Number(workerData?.maxScanBytes) || 16_000_000;

const routes = {};
const dismissible = {};
const experiments = new Map();
const coverage = {
  scanned: 0,
  skippedEmpty: 0,
  skippedOversize: 0,
  readErrors: 0,
  bytesScanned: 0,
  bytesSkippedOversize: 0,
};

for (const f of files) {
  const fp = path.join(dir, f);
  let content;
  let size = 0;
  try {
    const st = fs.statSync(fp);
    size = st.size;
    if (size === 0) {
      coverage.skippedEmpty++;
      continue;
    }
    if (size > maxScanBytes) {
      coverage.skippedOversize++;
      coverage.bytesSkippedOversize += size;
      continue;
    }
    content = fs.readFileSync(fp, 'utf8');
  } catch {
    coverage.readErrors++;
    continue;
  }
  extractRoutes(content, routes);
  extractExperiments(content, experiments);
  extractDismissibleContent(content, dismissible);
  coverage.scanned++;
  coverage.bytesScanned += size;
}

parentPort.postMessage({
  routes,
  dismissible,
  experiments: [...experiments.values()],
  coverage,
});
