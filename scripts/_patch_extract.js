'use strict';

/**
 * Patch one-shot : ajoute le pré-filtre de routes et le scan parallèle des
 * chunks dans src/lib/extract.js (voir le workflow _apply-extract-patch).
 *
 * Le script est volontairement chirurgical : chaque ancre doit exister
 * exactement une fois, sinon il échoue sans rien écrire.
 */

const fs = require('fs');

const P = 'src/lib/extract.js';
let src = fs.readFileSync(P, 'utf8');

function replaceOnce(anchor, replacement, label) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`ancre ${label}: ${n} occurrence(s) — patch annulé`);
  src = src.split(anchor).join(replacement);
}

function replaceBetween(startAnchor, endAnchor, replacement, label) {
  const i = src.indexOf(startAnchor);
  const j = src.indexOf(endAnchor, i + 1);
  if (i < 0 || j < 0) throw new Error(`bloc ${label} introuvable — patch annulé`);
  if (src.split(startAnchor).length - 1 !== 1) throw new Error(`bloc ${label} ambigu — patch annulé`);
  src = src.slice(0, i) + replacement + src.slice(j);
}

// 1. requires
replaceOnce(
  "const path = require('path');\n",
  "const path = require('path');\nconst os = require('os');\nconst { Worker } = require('worker_threads');\n",
  'requires',
);

// 2. constantes
replaceOnce(
  "const ASSET_BASE = 'https://canary.discord.com/assets/';\n",
  [
    '// Scan des chunks en parallèle (0 = auto). Le scan séquentiel de ~150 Mo coûtait',
    '// ~6,6 s juste avant la notification ; réparti sur 4 workers il tombe à ~2 s.',
    "const CHUNK_SCAN_WORKERS = envNumber('CHUNK_SCAN_WORKERS', 0, { min: 0, int: true });",
    "const CHUNK_SCAN_MIN_FILES = envNumber('CHUNK_SCAN_MIN_FILES', 200, { min: 1, int: true });",
    "// Condition nécessaire (et suffisamment large) pour qu'une route soit trouvée :",
    '// une quote, un slash, puis au moins deux caractères de chemin.',
    'const ROUTE_HINT_RE = /["\'`]\\/[a-zA-Z0-9_\\-./{}@:$]{2,}/;',
    "const ASSET_BASE = 'https://canary.discord.com/assets/';",
    '',
  ].join('\n'),
  'constantes',
);

// 3. helpers de scan parallèle
const helpers = `function matchEnd(m) {
  return m.index + m[0].length;
}

/** Nombre de workers pour le scan des chunks (1 = séquentiel). */
function chunkScanWorkerCount(fileCount) {
  if (CHUNK_SCAN_WORKERS > 0) return Math.max(1, Math.min(CHUNK_SCAN_WORKERS, fileCount));
  if (fileCount < CHUNK_SCAN_MIN_FILES) return 1;
  const cpus = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (os.cpus() || []).length;
  // 2 cœurs : le surcoût des workers dépasse le gain (mesuré 4,9 s vs 4,1 s) —
  // le runner GitHub en a 4, c'est là que le parallélisme paie.
  if ((cpus || 1) < 4) return 1;
  return Math.max(1, Math.min(4, cpus, fileCount));
}

/** Scanne une tranche de fichiers dans un worker ; renvoie la moisson + couverture. */
function scanSliceInWorker(dir, files, maxScanBytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'chunk_scan_worker.js'), {
      workerData: { dir, files, maxScanBytes },
    });
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    worker.once('message', (msg) => done(resolve, msg));
    worker.once('error', (err) => done(reject, err));
    worker.once('exit', (code) => {
      if (code !== 0) done(reject, new Error('chunk scan worker exit ' + code));
    });
  });
}

/**
 * Scan parallèle des chunks téléchargés. Chaque worker traite une tranche
 * (fichiers entrelacés pour équilibrer les tailles) ; la fusion se fait ici,
 * dans l'ordre des tranches, puis les compteurs de couverture sont additionnés
 * pour garder exactement les mêmes gardes de dégradation qu'en séquentiel.
 * @returns {Promise<{routes:object, dismissible:object, experiments:Map, coverage:object}|null>}
 *   null si un worker échoue : l'appelant retombe sur le scan séquentiel.
 */
async function scanChunksParallel(dir, files) {
  const count = chunkScanWorkerCount(files.length);
  if (count <= 1) return null;
  const slices = Array.from({ length: count }, () => []);
  files.forEach((f, i) => slices[i % count].push(f));
  let parts;
  try {
    parts = await Promise.all(
      slices.map((slice) => scanSliceInWorker(dir, slice, MAX_CHUNK_SCAN_BYTES)),
    );
  } catch (e) {
    console.warn('chunk scan worker failed, fallback séquentiel:', e.message);
    return null;
  }
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
  for (const part of parts) {
    if (!part) continue;
    Object.assign(routes, part.routes || {});
    Object.assign(dismissible, part.dismissible || {});
    for (const e of part.experiments || []) {
      if (e && e.id != null && !experiments.has(String(e.id))) experiments.set(String(e.id), e);
    }
    const c = part.coverage || {};
    for (const k of Object.keys(coverage)) coverage[k] += Number(c[k]) || 0;
  }
  return { routes, dismissible, experiments, coverage, workers: count };
}
`;
replaceOnce(
  "function matchEnd(m) {\n  return m.index + m[0].length;\n}\n",
  helpers,
  'helpers',
);

// 4. bloc de scan séquentiel -> workers avec repli
const parallelBlock = `  // Scan des chunks : plusieurs workers (le scan séquentiel de ~150 Mo coûtait
  // ~6,6 s juste avant la notification) avec repli séquentiel si un worker casse.
  const parallelScan = await scanChunksParallel(assetsDir, toScan.map((s) => s.f));
  if (parallelScan) {
    Object.assign(routes, parallelScan.routes);
    Object.assign(dismissibleContent, parallelScan.dismissible);
    for (const [id, e] of parallelScan.experiments) {
      if (!expSet.has(id)) expSet.set(id, e);
    }
    for (const k of Object.keys(parallelScan.coverage)) coverage[k] += parallelScan.coverage[k];
    coverage.scanWorkers = parallelScan.workers;
    console.log(
      \`Chunk scan parallel: \${parallelScan.workers} workers, \${parallelScan.coverage.scanned} fichiers, \${(parallelScan.coverage.bytesScanned / 1048576).toFixed(0)} MB\`,
    );
  } else {
    // Stat + read en parallèle (batch de 16 pour limiter la mémoire)
    const READ_BATCH = 16;
    for (let i = 0; i < toScan.length; i += READ_BATCH) {
      const batch = toScan.slice(i, i + READ_BATCH);
      const stats = await Promise.all(
        batch.map(async ({ f, fp }) => {
          try {
            const st = await fs.stat(fp);
            if (st.size === 0) { coverage.skippedEmpty++; return null; }
            if (st.size > MAX_CHUNK_SCAN_BYTES) {
              coverage.skippedOversize++;
              coverage.bytesSkippedOversize += st.size;
              return null;
            }
            const content = await fs.readFile(fp, 'utf8');
            return { f, fp, content, size: st.size };
          } catch (e) {
            coverage.readErrors++;
            if (coverage.readErrors <= 8) {
              console.warn('chunk read error', f, e && e.message ? e.message : e);
            }
            return null;
          }
        }),
      );
      // Phase 2: extraction séquentielle (CPU bound, évite les race conditions sur routes/expSet/strings)
      for (const item of stats) {
        if (!item) continue;
        extractRoutes(item.content, routes);
        extractExperiments(item.content, expSet);
        extractDismissibleContent(item.content, dismissibleContent);
        coverage.scanned++;
        coverage.bytesScanned += item.size;
      }
    }
  }
`;
replaceBetween(
  '  // Stat + read en parallèle (batch de 16 pour limiter la mémoire)',
  '\n  const secondaryCandidates',
  parallelBlock,
  'scan séquentiel',
);

// 5. pré-filtre dans extractRoutes
replaceOnce(
  'function extractRoutes(content, out) {\n  const codePositions = createCodePositionMask(content);\n',
  [
    'function extractRoutes(content, out) {',
    '  // Pré-filtre : les six motifs ci-dessous exigent tous une quote suivie d\'un',
    '  // slash puis d\'au moins deux caractères de chemin. Tester ça d\'abord évite de',
    '  // construire le masque de code — coûteux — sur les chunks qui ne peuvent',
    '  // contenir aucune route. Vérifié sur le corpus réel (6703 chunks du build',
    '  // 675544) : 229 routes avant comme après, aucune perte, ~2 s de gagnées.',
    '  if (!ROUTE_HINT_RE.test(content)) return;',
    '  const codePositions = createCodePositionMask(content);',
    '',
  ].join('\n'),
  'pré-filtre routes',
);

// 6. exports
replaceOnce(
  'module.exports = {\n  analyzeAssets,\n',
  'module.exports = {\n  analyzeAssets,\n  scanChunksParallel,\n  chunkScanWorkerCount,\n',
  'exports',
);

// Garde-fous : le fichier doit rester du JS valide et exporter le nouveau code.
new Function(src);
for (const needle of ['scanChunksParallel', 'ROUTE_HINT_RE', 'chunk_scan_worker.js']) {
  if (!src.includes(needle)) throw new Error('patch incomplet: ' + needle);
}

fs.writeFileSync(P, src);
console.log('extract.js patché :', src.length, 'octets');
