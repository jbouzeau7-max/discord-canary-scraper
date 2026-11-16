#!/usr/bin/env node
/**
 * Rollouts FAST — un seul surveillant pour TOUS les % (user + guild).
 *
 * Pourquoi : les crons GitHub (*\/20 apex, *\/30 gist) sont best-effort
 * (souvent décalés de 10 min à 2 h) et le réveil gist_wake ne tournait plus
 * (user-rollouts.yml sans cron). Wumpus Central décode /experiments une fois
 * par HEURE. Ici on sonde toutes les 10 s, pour un coût quasi nul :
 *
 *   - % guild : GET canary /api/v10/experiments?with_guild_experiments=true
 *     (même source que Wumpus Central) → empreinte sha1 des guild_experiments.
 *     Empreinte changée → apex_rollouts.js (décodage exact + notif) + commit.
 *   - % user  : GET gist.githubusercontent.com (CDN raw) en requête
 *     CONDITIONNELLE (If-None-Match → 304, hors quota API) → contenu changé →
 *     gist_user_rollouts.js (+ positions + comparaison) + commit.
 *
 * Premier tick = passe complète des deux trackers (couvre le trou entre deux
 * jobs). Échec d'un tracker (webhook KO = exit 2, dégradé = exit 1) →
 * l'empreinte n'avance pas, retentative après RETRY_MS. Seul écrivain
 * automatique des états data/apex_rollouts.json et data/gist_user_rollouts.json
 * (workflow unique .github/workflows/rollouts.yml) → plus de doublons.
 *
 * Env :
 *   ROLLOUTS_FAST_WATCH_MS  durée du job (défaut 28 min ; cron *\/10 + relais)
 *   ROLLOUTS_FAST_TICK_MS   intervalle de sonde (défaut 10 s, min 5 s)
 *   ROLLOUTS_FAST_RETRY_MS  délai avant retentative après échec (défaut 60 s)
 *
 * v3 (vitesse max) : sondes guild anonymes + gist en parallèle, sonde guild
 * gist via CDN raw hors quota, trackers user/guild lancés en parallèle,
 * étapes annexes + commit en arrière-plan APRÈS la notification.
 *
 *   ROLLOUTS_FAST_MAX_TICKS borne de ticks (tests)
 *   GIST_TOKEN              optionnel (PAT) — voie API (vraie révision) au lieu du CDN
 */
'use strict';
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const { execFileSync, spawn: spawnAsync } = require('child_process');
const { DEFAULT_UA, sleep } = require('./lib/utils');

const ROOT = path.join(__dirname, '..');
const GIST_STATE = path.join(ROOT, 'data', 'gist_user_rollouts.json');
const DEFAULT_GIST = 'e3e99062983e6bd0feaef833f14fd931';
// Propriétaires connus → sonde via le CDN raw (hors quota API).
const RAW_OWNERS = { e3e99062983e6bd0feaef833f14fd931: 'agnonotdev', '192b2ce20539ce1021b5c8cb01b17ff0': 'agnonotdev' };
const GUILD_URLS = [
  'https://canary.discord.com/api/v10/experiments?with_guild_experiments=true',
  'https://discord.com/api/v9/experiments?with_guild_experiments=true',
];

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const WATCH_MS = num(process.env.ROLLOUTS_FAST_WATCH_MS, 28 * 60 * 1000);
// v3 : sonde toutes les 10 s par défaut (min 5 s). Les deux sondes sont hors
// quota (requête Discord anonyme, CDN raw du gist avec cache-buster).
const TICK_MS = Math.max(5000, num(process.env.ROLLOUTS_FAST_TICK_MS, 10 * 1000));
const RETRY_MS = num(process.env.ROLLOUTS_FAST_RETRY_MS, 60 * 1000);
const MAX_TICKS = Math.max(0, Math.floor(num(process.env.ROLLOUTS_FAST_MAX_TICKS, 0)));

const TRACKERS = {
  guild: {
    steps: [{ script: 'src/apex_rollouts.js', env: { APEX_MIN_PCT_DELTA: process.env.APEX_MIN_PCT_DELTA || '0.01', APEX_RECENT_YEAR: process.env.APEX_RECENT_YEAR || '2025' } }],
    // Étapes lourdes non bloquantes : lancées APRÈS la notification.
    post: [],
    files: ['data/apex_rollouts.json'],
    msg: 'apex rollouts state',
  },
  user: {
    steps: [{ script: 'src/gist_user_rollouts.js', env: { GIST_ROLLOUT_MIN_PCT_DELTA: process.env.GIST_ROLLOUT_MIN_PCT_DELTA || '0.05' } }],
    post: [
      { script: 'src/user_rollout_positions.js', optional: true },
      { script: 'src/user_rollout_comparison.js', optional: true },
    ],
    files: [
      'data/gist_user_rollouts.json',
      'data/gist_user_rollouts.md',
      'data/gist_user_rollouts_docs.json',
      'data/user_rollout_positions.json',
      'data/user_rollout_comparison.json',
      'data/experiment_types.json',
    ],
    msg: 'data: gist user rollouts',
  },
};

const ALL_FILES = [...new Set(Object.values(TRACKERS).flatMap((t) => t.files))];

/** Empreinte stable des guild_experiments (ordre des tuples ignoré). */
function guildSignature(guildExperiments) {
  if (!Array.isArray(guildExperiments)) return null;
  const parts = guildExperiments.map((t) => JSON.stringify(t)).sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

function clientHeaders() {
  return { 'User-Agent': DEFAULT_UA, Accept: 'application/json', 'X-Discord-Locale': 'en-US' };
}
/** Sonde guild anonyme uniquement : aucun jeton Discord n’est chargé ni transmis. */
async function probeGuild(fetchImpl = fetch) {
  for (const url of GUILD_URLS) {
    try {
      const res = await fetchImpl(url, { headers: clientHeaders(), timeout: 8000 });
      if (!res.ok) continue;
      const data = await res.json();
      const experiments = data && data.guild_experiments;
      const sig = guildSignature(experiments);
      if (sig) return { sig, count: experiments.length, authed: false };
    } catch (_) { /* URL suivante */ }
  }
  return null;
}

/**
 * Sonde conditionnelle du gist. Retourne
 * { status: 'unchanged' | 'changed' | 'error', revision?, etag?, code? }.
 *
 * Voie rapide (défaut) : CDN raw gist.githubusercontent.com + cache-buster +
 * If-None-Match → AUCUN quota (l'API anonyme est limitée à 60 req/h, 304
 * compris : à 30 s la sonde tombait en 403 au bout de 30 min). La « révision »
 * est alors l'ETag du contenu (hash sha256 servi par GitHub).
 * Voie API (GIST_TOKEN fourni, quota 5000/h, 304 gratuit) : vraie révision.
 */
async function probeGist(gistId, etag, fetchImpl = fetch, token = process.env.GIST_TOKEN || '', owner = RAW_OWNERS[gistId]) {
  if (!token && owner) {
    const headers = { 'User-Agent': 'canary-rollouts-fast', 'Cache-Control': 'no-cache' };
    if (etag) headers['If-None-Match'] = etag;
    const url = `https://gist.githubusercontent.com/${owner}/${encodeURIComponent(gistId)}/raw?cb=${Date.now().toString(36)}`;
    try {
      const res = await fetchImpl(url, { headers, timeout: 8000 });
      if (res.status === 304) return { status: 'unchanged', etag };
      if (!res.ok) return { status: 'error', code: res.status };
      let newEtag = (res.headers && typeof res.headers.get === 'function' && res.headers.get('etag')) || null;
      if (!newEtag && typeof res.text === 'function') {
        newEtag = 'sha1:' + crypto.createHash('sha1').update(await res.text()).digest('hex');
      } else if (res.body && typeof res.body.resume === 'function') res.body.resume();
      return { status: 'changed', revision: newEtag, etag: newEtag };
    } catch (e) {
      return { status: 'error', code: String((e && e.message) || e).slice(0, 60) };
    }
  }
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'canary-rollouts-fast' };
  if (etag) headers['If-None-Match'] = etag;
  if (token) headers.Authorization = 'Bearer ' + token;
  try {
    const res = await fetchImpl('https://api.github.com/gists/' + encodeURIComponent(gistId), { headers, timeout: 8000 });
    if (res.status === 304) return { status: 'unchanged', etag };
    if (!res.ok) return { status: 'error', code: res.status };
    const j = await res.json();
    const v = j && Array.isArray(j.history) && j.history[0] && j.history[0].version;
    const newEtag = (res.headers && typeof res.headers.get === 'function' && res.headers.get('etag')) || null;
    return { status: 'changed', revision: typeof v === 'string' ? v : null, etag: newEtag };
  } catch (e) {
    return { status: 'error', code: String((e && e.message) || e).slice(0, 60) };
  }
}

/**
 * Décision pure : faut-il lancer un tracker ?
 * st = { lastSig, okSig, lastFailAt }, cur = signature courante (null = inconnue).
 */
function shouldRun({ first, cur, okSig, lastFailAt, now, retryMs }) {
  if (first) return { run: true, reason: 'initial' };
  if (!cur) return { run: false, reason: 'probe_failed' };
  if (cur === okSig) return { run: false, reason: 'unchanged' };
  if (lastFailAt && now - lastFailAt < retryMs) return { run: false, reason: 'backoff' };
  return { run: true, reason: okSig ? 'changed' : 'retry' };
}

function gitRefresh(files) {
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' });
    if (dirty.trim()) return;
    execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: ROOT, stdio: 'ignore' });
    for (const f of files) {
      try { execFileSync('git', ['checkout', 'origin/main', '--', f], { cwd: ROOT, stdio: 'ignore' }); } catch (_) { /* fichier absent */ }
    }
  } catch (e) {
    console.warn('git refresh skip:', String((e && e.message) || e).slice(0, 80));
  }
}

/** Commit + push ASYNCHRONE : ne bloque plus la boucle de sonde (~2-5 s). */
function commit(files, msg) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnAsync('bash', ['scripts/commit-state.sh', msg, ...files], { cwd: ROOT, env: { ...process.env, COMMIT_SOFT_FAIL: '1' }, stdio: 'inherit' });
    } catch (e) {
      console.warn('commit-state fail:', String((e && e.message) || e).slice(0, 80));
      return resolve({ code: 1 });
    }
    child.on('error', (e) => {
      console.warn('commit-state fail:', String((e && e.message) || e).slice(0, 80));
      resolve({ code: 1 });
    });
    child.on('close', (code) => resolve({ code: typeof code === 'number' ? code : 1 }));
  });
}

function spawnStep(step, spawnImpl = spawnAsync) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => { if (!done) { done = true; resolve(code); } };
    let child;
    try {
      child = spawnImpl(process.execPath, [step.script], { cwd: ROOT, env: { ...process.env, ...(step.env || {}) }, stdio: 'inherit' });
    } catch (_) { return finish(1); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* déjà fini */ } finish(124); }, 5 * 60 * 1000);
    if (timer.unref) timer.unref();
    child.on('error', () => { clearTimeout(timer); finish(1); });
    child.on('close', (code) => { clearTimeout(timer); finish(typeof code === 'number' ? code : 1); });
  });
}

// Les commits sont sérialisés (index git partagé) mais n'attendent jamais les
// notifications : le message part d'abord, l'état est poussé ensuite.
//
// Verrou notif/commit : commit-state.sh fait rebase (arbre propre requis) et,
// sur conflit, reset --hard → un tracker qui écrit son état PENDANT un commit
// perdrait son acquittement (doublon au run suivant). Donc : un commit attend
// qu'aucune étape critique ne tourne, et une étape critique attend la fin du
// commit en cours (quelques secondes au pire, rare).
let commitChain = Promise.resolve();
let committing = null;
let activeMain = 0;
let commitFailures = 0;
const idleWaiters = [];
function mainStart() {
  activeMain++;
}
function mainEnd() {
  activeMain = Math.max(0, activeMain - 1);
  if (!activeMain) while (idleWaiters.length) idleWaiters.shift()();
}
function whenMainIdle() {
  return activeMain ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve();
}
function queueCommit(files, msg, impl = commit) {
  commitChain = commitChain
    .then(async () => {
      let release;
      // Verrou posé AVANT d'attendre l'inactivité : sinon un tracker pouvait
      // démarrer dans le microtask entre whenMainIdle() et l'affectation,
      // puis tourner PENDANT le commit (reset --hard → acquittement perdu).
      committing = new Promise((r) => { release = r; });
      await whenMainIdle();
      try {
        const result = await impl(files, msg);
        if (result && typeof result === 'object' && result.code !== 0) {
          commitFailures++;
          console.warn(`commit-state: échec (exit ${result.code}) — ${msg}`);
        }
      } finally {
        committing = null;
        release();
      }
    })
    .catch((e) => {
      commitFailures++;
      console.warn('commit-state: exception —', String((e && e.message) || e).slice(0, 80));
    });
  return commitChain;
}

/**
 * Lance un tracker : étapes critiques (notification) d'abord, puis étapes
 * annexes (positions/comparaison) et commit en ARRIÈRE-PLAN — ils ne
 * retardent plus la prochaine sonde ni l'autre tracker.
 * Retourne true si l'étape principale a réussi.
 */
async function runTracker(name, deps = {}) {
  const t = TRACKERS[name];
  const runStep = deps.runStep || ((step) => spawnStep(step, deps.spawn));
  const git = deps.git !== false;
  // Refresh depuis origin uniquement à la passe initiale (dispatch manuel
  // possible entre deux jobs) : ensuite ce job est le seul écrivain → on
  // n'ajoute pas un git fetch (~1 s) devant chaque notification.
  if (git && deps.refresh) gitRefresh(t.files);
  const t0 = Date.now();
  let ok = true;
  while (committing) await committing;
  mainStart();
  try {
    for (const step of t.steps) {
      const code = await runStep(step);
      console.log(`  [${name}] ${step.script} → exit ${code} (${Date.now() - t0} ms)`);
      if (code !== 0 && !step.optional) { ok = false; if (code !== 2) break; }
    }
  } finally {
    mainEnd();
  }
  // Annexes chaînées PAR tracker : deux passes successives n'écrivent jamais
  // les mêmes fichiers en même temps.
  const prevTail = tails.get(name) || Promise.resolve();
  const tail = prevTail.then(async () => {
    for (const step of t.post || []) {
      while (committing) await committing;
      mainStart();
      try {
        const code = await runStep(step);
        console.log(`  [${name}] ${step.script} → exit ${code}`);
      } finally {
        mainEnd();
      }
    }
    // Union des fichiers de TOUS les trackers : commit-state.sh fait un reset
    // --hard sur conflit et ne restaure que les chemins passés → on protège
    // aussi l'état de l'autre tracker qui tourne en parallèle.
    if (git) await queueCommit(ALL_FILES, t.msg, deps.commit);
  }).catch((e) => console.warn(`[${name}] annexes:`, String((e && e.message) || e).slice(0, 80)));
  tails.set(name, tail);
  if (deps.awaitTail) await tail;
  else pending.add(tail.finally(() => pending.delete(tail)));
  return ok;
}
const pending = new Set();
const tails = new Map();

async function readGistId() {
  try {
    const s = await fs.readJson(GIST_STATE);
    return (s && s.source && s.source.gistId) || DEFAULT_GIST;
  } catch (_) {
    return DEFAULT_GIST;
  }
}

async function main(deps = {}) {
  commitFailures = 0;
  const now = deps.now || (() => Date.now());
  const wait = deps.sleep || sleep;
  const run = deps.runTracker || ((name, opts) => runTracker(name, opts));
  const pGuild = deps.probeGuild || (() => probeGuild());
  const pGist = deps.probeGist || ((id, etag) => probeGist(id, etag));
  const watchMs = deps.watchMs || WATCH_MS;
  const tickMs = deps.tickMs || TICK_MS;
  const retryMs = deps.retryMs || RETRY_MS;
  const maxTicks = deps.maxTicks != null ? deps.maxTicks : MAX_TICKS;
  const gistId = deps.gistId || (await readGistId());
  const deadline = now() + watchMs;
  const st = { guild: { okSig: null, lastFailAt: 0 }, user: { okSig: null, lastFailAt: 0, etag: null, rev: null, gistBackoffUntil: 0 } };
  const log = [];
  let ticks = 0;
  let failures = 0;
  console.log(`Rollouts FAST v3 — sonde toutes les ${Math.round(tickMs / 1000)} s pendant ${Math.round(watchMs / 60000)} min (gist ${gistId})`);

  const guildPass = async (reason, sigBefore, first) => {
    console.log(`[guild] ${reason} → apex_rollouts`);
    const ok = await run('guild', { refresh: first });
    log.push({ tick: ticks, tracker: 'guild', reason, ok });
    if (ok) { st.guild.okSig = sigBefore && sigBefore.sig; st.guild.lastFailAt = 0; } else { st.guild.lastFailAt = now(); failures++; }
  };
  const userPass = async (reason, first) => {
    console.log(`[user] ${reason} → gist_user_rollouts`);
    const revBefore = st.user.rev;
    const ok = await run('user', { refresh: first });
    log.push({ tick: ticks, tracker: 'user', reason, ok });
    if (ok) {
      // Si la première sonde n'avait pas encore de révision, acquitter la
      // révision courante ; sinon le tracker se relancerait à chaque tick.
      // Si le gist a changé PENDANT le tracker, on garde l'ancienne valeur :
      // le prochain tick détecte le changement et relance correctement.
      st.user.okSig = revBefore || st.user.rev || null;
      st.user.lastFailAt = 0;
    } else { st.user.lastFailAt = now(); failures++; }
  };

  while (now() < deadline && !(maxTicks > 0 && ticks >= maxTicks)) {
    const first = ticks === 0;
    const t0 = now();

    // Les deux sondes en PARALLÈLE (avant : en série → latence additionnée).
    const gistDue = now() >= st.user.gistBackoffUntil;
    const [g, p] = await Promise.all([
      pGuild(),
      gistDue ? pGist(gistId, st.user.etag) : Promise.resolve(null),
    ]);

    const gCur = g && g.sig;
    const gd = shouldRun({ first, cur: gCur, okSig: st.guild.okSig, lastFailAt: st.guild.lastFailAt, now: t0, retryMs });

    let uCur = st.user.rev;
    if (p) {
      if (p.status === 'changed') { st.user.etag = p.etag || null; st.user.rev = p.revision || p.etag || st.user.rev; uCur = st.user.rev; }
      else if (p.status === 'error') {
        if (p.code === 403 || p.code === 429) st.user.gistBackoffUntil = now() + retryMs;
        uCur = null;
      }
    } else if (!first) uCur = null;
    const ud = shouldRun({ first, cur: uCur, okSig: st.user.okSig, lastFailAt: st.user.lastFailAt, now: t0, retryMs });

    // Les deux trackers en PARALLÈLE : un ramp-up guild n'attend plus la
    // passe gist (et inversement).
    const jobs = [];
    if (gd.run) jobs.push(guildPass(gd.reason, g, first));
    if (ud.run) jobs.push(userPass(ud.reason, first));
    if (jobs.length) await Promise.all(jobs);

    ticks++;
    const remaining = deadline - now();
    if (remaining <= 0 || (maxTicks > 0 && ticks >= maxTicks)) break;
    await wait(Math.max(0, Math.min(tickMs - (now() - t0), remaining)));
  }
  // Laisse finir les étapes annexes + commits en arrière-plan.
  if (pending.size) await Promise.allSettled([...pending]);
  await commitChain;
  console.log(`Rollouts FAST terminé — ${ticks} ticks, ${log.length} passes, ${failures} échec(s)`);
  return { ticks, log, failures, commitFailures };
}

if (require.main === module) {
  main().then((r) => {
    if (r.commitFailures || (r.failures && !r.log.some((x) => x.ok))) process.exitCode = 1;
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  main,
  shouldRun,
  guildSignature,
  probeGuild,
  probeGist,
  runTracker,
  queueCommit,
  spawnStep,
  TRACKERS,
  ALL_FILES,
};
