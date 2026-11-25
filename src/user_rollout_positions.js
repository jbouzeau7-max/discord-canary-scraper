#!/usr/bin/env node
/**
 * Cumule des positions observées (dedans / dehors) pour les expériences user nommées
 * visibles sur /experiments anonyme, afin de resserrer les bornes de leur rollout
 * (cf. lib/position_bounds.js). Lecture seule côté Discord (aucune authentification),
 * aucune notification. Écrit uniquement data/user_rollout_positions.json.
 *
 * Population : requêtes anonymes avec un seul User-Agent web. Les contextes
 * (web/desktop/Android/iOS) ont été mesurés identiques pour les expériences suivies,
 * mais ce n'est pas une garantie générale : la carte ne mélange jamais de révisions.
 *
 * Env : POSITIONS_SAMPLES (150), POSITIONS_DELAY_MS (350), POSITIONS_MAX_MS (90000),
 *       POSITIONS_MIN_OK (20).
 */
'use strict';
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { writeJsonAtomic } = require('./lib/atomic');
const { murmur3 } = require('./lib/murmur3');
const { extractRetryAfterMs, MAX_RESPONSE_BODY_BYTES } = require('./lib/http');
const P = require('./lib/position_bounds');

const DATA = path.join(__dirname, '..', 'data');
const URL_EXPERIMENTS = 'https://canary.discord.com/api/v9/experiments';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

async function readJson(file, fallback) {
  try { return await fs.readJson(file); } catch { return fallback; }
}

/** Échantillon valide : fingerprint « id.signature » et tableau d'assignments. */
function parseSample(j) {
  if (!j || typeof j.fingerprint !== 'string' || !Array.isArray(j.assignments)) return null;
  const m = j.fingerprint.match(/^(\d{10,25})\./);
  if (!m) return null;
  return { id: m[1], assignments: j.assignments };
}

/**
 * Applique un lot d'échantillons à l'état (pur, testable).
 * @param {object} prev  { [nom]: état position_bounds + hash }
 * @param {Array}  samples [{id, assignments}]
 * @param {string[]} names noms suivis (le hash est calculé par murmur3(nom))
 */
function processSamples(prev, samples, names) {
  const next = {};
  for (const [k, v] of Object.entries(prev || {})) {
    next[k] = { hash: v && v.hash, ...P.normalize(v) };
  }
  const diagnostics = [];
  const seen = new Set();
  const list = Array.isArray(samples) ? samples : [];
  const uniq = list.filter(
    (s) =>
      s &&
      typeof s === 'object' &&
      Array.isArray(s.assignments) &&
      !seen.has(s.id) &&
      seen.add(s.id),
  );
  for (const name of [...new Set(names)]) {
    const hash = murmur3(name);
    const rows = uniq.map((s) => {
      const a = s.assignments.find((x) => Array.isArray(x) && x[0] === hash);
      return { id: s.id, a: a || null, pos: murmur3(`${name}:${s.id}`) % P.SPACE };
    });
    const present = rows.filter((r) => r.a);
    const revisions = new Map();
    for (const r of present) revisions.set(r.a[1], (revisions.get(r.a[1]) || 0) + 1);
    if (revisions.size > 1) { diagnostics.push({ name, code: 'mixed_revision', revisions: Object.fromEntries(revisions) }); continue; }
    const revision = present.length ? present[0].a[1] : null;
    const cur = next[name];
    // Position annoncée par Discord ≠ formule : on ne fait pas confiance à ce modèle pour ce nom.
    const bad = present.filter((r) => Number.isInteger(r.a[5]) && r.a[5] !== r.pos).length;
    if (bad > 0) { diagnostics.push({ name, code: 'position_mismatch', count: bad }); continue; }
    if (!cur && !present.length) continue; // jamais vue : pas de suivi
    let state = cur ? P.normalize(cur) : P.emptyState(revision);
    if (cur && revision != null && state.revision != null && state.revision !== revision) {
      diagnostics.push({ name, code: 'revision_reset', from: state.revision, to: revision });
      state = P.emptyState(revision);
    }
    if (state.revision == null) state.revision = revision;
    const known = P.bounds(state);
    // Absente de tout le lot alors que la carte contient des « dedans » : retrait/panne temporaire,
    // on n'enregistre aucun « dehors » (indistinguable d'un rollout vraiment réduit).
    const skipOut = !present.length && known && known.inPositions > 0;
    if (skipOut) diagnostics.push({ name, code: 'absent_whole_batch' });
    for (const r of rows) {
      if (r.a) P.addPoint(state, r.pos, true);
      else if (!skipOut) P.addPoint(state, r.pos, false);
    }
    next[name] = { hash, ...state };
  }
  return { state: next, diagnostics };
}

async function sample(count, deps) {
  const fetchImpl = deps.fetch || fetch;
  const delay = deps.delayMs ?? num(process.env.POSITIONS_DELAY_MS, 350);
  const maxMs = deps.maxMs ?? num(process.env.POSITIONS_MAX_MS, 90000);
  const deadline = Date.now() + maxMs;
  const out = [];
  const seen = new Set();
  let fail = 0;
  let validResponses = 0;
  while (validResponses < count && Date.now() < deadline && fail < 15) {
    let wait = delay;
    try {
      const r = await fetchImpl(URL_EXPERIMENTS, { headers: { 'User-Agent': UA, 'X-Request-Id': crypto.randomUUID() }, size: MAX_RESPONSE_BODY_BYTES, timeout: Math.max(1, Math.min(15000, deadline - Date.now())) });
      if (r.status === 429) {
        fail++;
        let body;
        try { body = await r.json(); } catch { /* Retry-After peut aussi être dans les en-têtes. */ }
        wait = Math.max(delay, extractRetryAfterMs(r, body) || 3000);
      } else {
        const s = r.ok ? parseSample(await r.json()) : null;
        if (s) {
          validResponses++;
          if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
        } else fail++;
      }
    } catch { fail++; }
    if (validResponses >= count || fail >= 15 || wait >= deadline - Date.now()) break;
    if (wait > 0) await new Promise((s) => setTimeout(s, wait));
  }
  return { samples: out, fail };
}

/** Noms suivis : expériences nommées déjà publiées + noms connus (gist/définitions) vus sur le wire. */
function trackedNames(comparison, known, prev, samples) {
  const names = new Set(Object.keys(prev || {}));
  for (const e of Array.isArray(comparison && comparison.experiments) ? comparison.experiments : []) {
    if (e && e.id && !e.id.startsWith('hash:')) names.add(e.id);
  }
  const byHash = new Map();
  for (const n of Array.isArray(known) ? known : []) { const h = murmur3(n); byHash.set(h, byHash.has(h) ? null : n); }
  for (const s of Array.isArray(samples) ? samples : []) for (const a of Array.isArray(s && s.assignments) ? s.assignments : []) {
    const n = Array.isArray(a) && byHash.get(a[0]);
    if (n) names.add(n);
  }
  return [...names];
}

async function knownNames() {
  const out = new Set();
  const docs = await readJson(path.join(DATA, 'gist_user_rollouts_docs.json'), {});
  for (const e of Array.isArray(docs && docs.experiments) ? docs.experiments : []) if (e && e.id && e.type === 'user') out.add(e.id);
  for (const f of ['experiments.json', 'mobile_experiments.json']) {
    const j = await readJson(path.join(DATA, f), {});
    for (const e of Array.isArray(j && j.experiments) ? j.experiments : []) if (e && (e.id || e.name) && (e.type === 'user' || e.kind === 'user')) out.add(e.id || e.name);
  }
  return [...out];
}

async function main(deps = {}) {
  const file = deps.out || path.join(DATA, 'user_rollout_positions.json');
  const prevFile = await readJson(file, {});
  const prev =
    prevFile &&
    prevFile.experiments &&
    typeof prevFile.experiments === 'object' &&
    !Array.isArray(prevFile.experiments)
      ? prevFile.experiments
      : {};
  const comparison = deps.comparison !== undefined ? deps.comparison : await readJson(path.join(DATA, 'user_rollout_comparison.json'), {});
  const known = deps.knownNames || await knownNames();
  const count = deps.samples ?? num(process.env.POSITIONS_SAMPLES, 150);
  const minOk = deps.minOk ?? num(process.env.POSITIONS_MIN_OK, 20);
  const { samples, fail } = await sample(count, deps);
  const run = { at: new Date(deps.now ?? Date.now()).toISOString(), requested: count, ok: samples.length, fail };
  if (samples.length < minOk) {
    console.warn(`Positions: seulement ${samples.length} échantillons (min ${minOk}), état inchangé.`);
    const out = { ...prevFile, schemaVersion: 1, lastRun: { ...run, skipped: true } };
    await writeJsonAtomic(file, out, 1);
    return out;
  }
  const names = trackedNames(comparison, known, prev, samples);
  const { state, diagnostics } = processSamples(prev, samples, names);
  const out = {
    schemaVersion: 1,
    updatedAt: run.at,
    semantics: 'Carte des positions observées (I dedans, O dehors, . inconnu) par expérience nommée ; position = murmur3(nom:idFingerprint) % 10000. Requêtes anonymes du collecteur, pas un recensement des utilisateurs.',
    source: URL_EXPERIMENTS,
    lastRun: { ...run, diagnostics },
    experiments: state,
  };
  await writeJsonAtomic(file, out, 1);
  const summary = Object.fromEntries(Object.entries(state).map(([n, s]) => [n, P.bounds(s)]));
  console.log('Positions:', JSON.stringify({ ...run, tracked: Object.keys(state).length, diagnostics: diagnostics.length }));
  for (const [n, b] of Object.entries(summary)) if (b) console.log(` ${n}: ${b.minPct}–${b.maxPct ?? '?'} % (est. ${b.estPct}) · ${b.knownPositions} positions`);
  return out;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { main, processSamples, parseSample, trackedNames };
