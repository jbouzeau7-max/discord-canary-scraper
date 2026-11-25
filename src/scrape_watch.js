#!/usr/bin/env node
/**
 * Scrape watcher — détection quasi temps réel des nouveaux builds Canary.
 *
 * Pourquoi : la chaîne historique (cron toutes les 5 min ou trigger externe toutes les
 * 20-50 s → démarrage runner → npm ci → scrape) ajoutait 30 s à plusieurs
 * minutes avant la première notification. Ici le runner est déjà chaud :
 *  - sonde légère `version.canary.json` (≈70 octets) toutes les SCRAPE_WATCH_TICK_MS
 *    (2 s) + l'HTML /app toutes les SCRAPE_WATCH_HTML_EVERY ticks (filet de sécurité) ;
 *  - dès que le hash/BUILD_NUMBER diffère de l'état local → `node src/index.js`
 *    immédiatement (process enfant : index.js garde ses process.exit) ;
 *  - commit de l'état APRÈS la notification (le webhook part pendant le scrape).
 *
 * Env :
 *   SCRAPE_WATCH_MS          durée du watch (défaut 28 min)
 *   SCRAPE_WATCH_TICK_MS     intervalle de sonde (défaut 2000)
 *   SCRAPE_WATCH_HTML_EVERY  sonde HTML tous les N ticks (défaut 5)
 *   SCRAPE_WATCH_COMMIT=0    désactive le commit (tests/local)
 */
'use strict';
const path = require('path');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const { spawn } = require('child_process');
const { DEFAULT_UA, sleep, envNumber } = require('./lib/utils');
const { parseGlobalEnv, CANARY_APP } = require('./lib/canary');

const ROOT = path.join(__dirname, '..');
const BUILD_FILE = path.join(ROOT, 'data', 'build.json');
const VERSION_URL = 'https://canary.discord.com/assets/version.canary.json';

const WATCH_MS = envNumber('SCRAPE_WATCH_MS', 28 * 60 * 1000, { min: 0 });
const TICK_MS = envNumber('SCRAPE_WATCH_TICK_MS', 2000, { min: 250 });
const HTML_EVERY = envNumber('SCRAPE_WATCH_HTML_EVERY', 5, { min: 1, int: true });
const SCRAPE_TIMEOUT_MS = envNumber('SCRAPE_WATCH_RUN_TIMEOUT_MS', 10 * 60 * 1000, { min: 10000 });
const PROBE_TIMEOUT_MS = envNumber('SCRAPE_WATCH_PROBE_TIMEOUT_MS', 4000, { min: 500 });

const HEADERS = { 'User-Agent': DEFAULT_UA, 'Cache-Control': 'no-cache', Pragma: 'no-cache' };

/** Hash distant léger (cache-buster pour éviter un HIT Cloudflare périmé). */
async function probeVersionHash(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(VERSION_URL + '?_=' + Date.now(), { headers: HEADERS, timeout: PROBE_TIMEOUT_MS });
    if (!res.ok) return null;
    const j = await res.json();
    return j && typeof j.hash === 'string' && /^[a-f0-9]{7,64}$/i.test(j.hash) ? j.hash : null;
  } catch {
    return null;
  }
}

/** BUILD_NUMBER + VERSION_HASH depuis l'HTML /app (plus lourd, ~75 Ko). */
async function probeHtml(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(CANARY_APP + '?_=' + Date.now(), {
      headers: { ...HEADERS, Accept: 'text/html' },
      timeout: PROBE_TIMEOUT_MS * 2,
    });
    if (!res.ok) return null;
    const env = parseGlobalEnv(await res.text());
    if (!env.BUILD_NUMBER || !/^\d{4,12}$/.test(String(env.BUILD_NUMBER))) return null;
    return { buildNumber: String(env.BUILD_NUMBER), versionHash: env.VERSION_HASH || null };
  } catch {
    return null;
  }
}

async function readLocal() {
  try {
    const b = await fs.readJson(BUILD_FILE);
    return { buildNumber: b.buildNumber ? String(b.buildNumber) : null, versionHash: b.versionHash || null };
  } catch {
    return { buildNumber: null, versionHash: null };
  }
}

/** Décision pure : faut-il lancer un scrape ? */
function shouldScrape(local, remote) {
  if (!remote) return false;
  if (remote.buildNumber && local.buildNumber) {
    const delta = Number(remote.buildNumber) - Number(local.buildNumber);
    if (delta < 0) return false; // Un ancien edge a généralement aussi un autre hash.
    if (delta > 0) return true;
  }
  if (remote.versionHash && local.versionHash && remote.versionHash !== local.versionHash) return true;
  if (!local.versionHash && !local.buildNumber) return true;
  return false;
}

function runChild(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (c) => {
      if (!done) {
        done = true;
        resolve(c);
      }
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: ROOT, env: process.env, stdio: 'inherit' });
    } catch {
      return finish(1);
    }
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(124);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(t);
      finish(1);
    });
    child.on('close', (c) => {
      clearTimeout(t);
      finish(typeof c === 'number' ? c : 1);
    });
  });
}

let commitChain = Promise.resolve();
let commitFailureCode = 0;
function commitState() {
  if (process.env.SCRAPE_WATCH_COMMIT === '0') return commitChain;
  commitChain = commitChain.then(() =>
    runChild('bash', ['scripts/commit-state.sh', 'scrape: state', 'data/'], 3 * 60 * 1000).then((c) => {
      commitFailureCode = c === 0 ? 0 : c;
      if (c !== 0) console.warn('[watch] commit-state code', c, '(rejoué au prochain scrape)');
      return c;
    }),
  );
  return commitChain;
}

async function scrapeOnce(reason, deps = {}) {
  const t = Date.now();
  // jamais de scrape pendant un commit (rebase --autostash sur data/)
  await (deps.waitForCommit ? deps.waitForCommit() : commitChain);
  if (commitFailureCode !== 0) return commitFailureCode;
  console.log(`[watch] SCRAPE (${reason}) @ ${new Date().toISOString()}`);
  const code = deps.runScrape
    ? await deps.runScrape(reason)
    : await runChild(process.execPath, [path.join(__dirname, 'index.js')], SCRAPE_TIMEOUT_MS);
  console.log(`[watch] scrape exit=${code} en ${Date.now() - t}ms`);
  if (code === 0) {
    // commit en arrière-plan : la sonde reprend tout de suite
    (deps.commitState || commitState)();
  } else {
    // La publication peut avoir échoué en milieu de promotion; ne pas réutiliser
    // cet état local. Le prochain job repartira d'un checkout propre.
    console.warn('[watch] scrape failed; skip state commit and stop this runner');
  }
  return code;
}

async function main({ fetchImpl = fetch, scrape = scrapeOnce, watchMs = WATCH_MS, tickMs = TICK_MS } = {}) {
  const t0 = Date.now();
  console.log(`[watch] start tick=${tickMs}ms html/${HTML_EVERY} ticks watch=${Math.round(watchMs / 1000)}s`);
  // passe initiale : couvre le trou entre deux jobs (FAST SKIP si rien de neuf)
  const startupCode = await scrape('startup');
  if (startupCode !== 0) {
    await commitChain;
    return { ok: false, reason: 'startup-scrape-failed', code: startupCode };
  }
  let tick = 0;
  let failStreak = 0;
  let lastAttemptKey = null;
  let lastAttemptAt = 0;
  while (Date.now() - t0 < watchMs) {
    const started = Date.now();
    tick++;
    const withHtml = tick % HTML_EVERY === 0;
    const [hash, html] = await Promise.all([
      probeVersionHash(fetchImpl),
      withHtml ? probeHtml(fetchImpl) : Promise.resolve(null),
    ]);
    const remote = html || (hash ? { versionHash: hash, buildNumber: null } : null);
    if (remote && hash && !remote.versionHash) remote.versionHash = hash;
    const local = await readLocal();
    if (shouldScrape(local, remote)) {
      const key = (remote.versionHash || '') + ':' + (remote.buildNumber || '');
      // Si le hash a changé mais que /app sert encore l'ancien build, index.js
      // fait un FAST SKIP : on réessaie, mais pas plus d'une fois toutes les 4 s.
      if (key !== lastAttemptKey || Date.now() - lastAttemptAt > Math.max(4000, tickMs)) {
        lastAttemptKey = key;
        lastAttemptAt = Date.now();
        const code = await scrape(`remote ${remote.buildNumber || '?'} ${String(remote.versionHash || '').slice(0, 8)} vs local ${local.buildNumber} ${String(local.versionHash || '').slice(0, 8)}`);
        failStreak = code === 0 ? 0 : failStreak + 1;
        if (code !== 0) {
          await commitChain;
          return { ok: false, reason: 'remote-scrape-failed', code };
        }
        if (failStreak >= 3) await sleep(Math.min(60000, 5000 * failStreak));
      }
    }
    const wait = tickMs - (Date.now() - started);
    if (wait > 0) await sleep(wait);
  }
  await commitChain;
  console.log('[watch] fin du budget temps');
  if (commitFailureCode !== 0) {
    return { ok: false, reason: 'state-commit-failed', code: commitFailureCode };
  }
  return { ok: true };
}

if (require.main === module) {
  main()
    .then((result) => {
      if (result && result.ok === false) process.exitCode = 1;
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}

module.exports = { main, scrapeOnce, shouldScrape, probeVersionHash, probeHtml, VERSION_URL };
