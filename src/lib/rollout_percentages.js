/**
 * Fusion des pourcentages de déploiement (guild + user) dans les expériences.
 *
 * Sources :
 *  - guild : data/apex_rollouts.json — traitements décodés du wire Discord
 *            (bucket 0 = contrôle, bucket > 0 = traitement, -1 = non éligible).
 *            Le % de déploiement = somme des buckets de TRAITEMENT.
 *  - user  : data/gist_user_rollouts.json — état acquitté du gist, où
 *            `treatment.pct` est déjà la somme des variantes de traitement.
 *
 * Avant ce module, les deux champs restaient « unknown » pour toutes les
 * expériences publiées : les trackers calculaient les % mais personne ne les
 * rattachait aux expériences.
 */
'use strict';

const fs = require('fs-extra');
const path = require('path');
const { attachPercentages } = require('./experiment_percentages');
const { createExperimentFingerprint } = require('./experiment_state');

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * % guild depuis une entrée apex : somme des buckets de traitement (> 0).
 * @returns {number|null} null si aucun traitement mesurable
 */
function guildPctFromApex(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const treatments = Array.isArray(entry.treatments) ? entry.treatments : [];
  let sum = 0;
  let seen = 0;
  for (const t of treatments) {
    if (!t || typeof t !== 'object') continue;
    const bucket = num(t.bucket);
    const pct = num(t.pct);
    if (bucket == null || bucket <= 0 || pct == null) continue;
    sum += pct;
    seen++;
  }
  if (!seen) return null;
  return round2(Math.max(0, Math.min(100, sum)));
}

/**
 * % user depuis une entrée gist : `treatment.pct` prioritaire, sinon somme
 * des variantes dont le rôle est « treatment ».
 * @returns {number|null}
 */
function userPctFromGist(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.hasData === false) return null;
  const direct = entry.treatment && num(entry.treatment.pct);
  if (direct != null) return round2(Math.max(0, Math.min(100, direct)));
  const byVariant = entry.byVariant && typeof entry.byVariant === 'object' ? entry.byVariant : {};
  let sum = 0;
  let seen = 0;
  for (const v of Object.values(byVariant)) {
    if (!v || typeof v !== 'object') continue;
    if (String(v.role || '').toLowerCase() !== 'treatment') continue;
    const p = num(v.pct);
    if (p == null) continue;
    sum += p;
    seen++;
  }
  if (!seen) return null;
  return round2(Math.max(0, Math.min(100, sum)));
}

/**
 * Construit les maps id → % depuis les états des deux trackers.
 * @returns {{guild: Map<string, number>, user: Map<string, number>}}
 */
function buildRolloutPercentageMaps(apexState, gistState) {
  const guild = new Map();
  const user = new Map();
  const apexList = Array.isArray(apexState && apexState.experiments)
    ? apexState.experiments
    : Array.isArray(apexState)
      ? apexState
      : [];
  for (const e of apexList) {
    if (!e || !e.id) continue;
    const p = guildPctFromApex(e);
    if (p != null) guild.set(String(e.id), p);
  }
  const gistMap =
    gistState && gistState.acknowledged && typeof gistState.acknowledged === 'object'
      ? gistState.acknowledged
      : {};
  for (const [id, e] of Object.entries(gistMap)) {
    if (!id) continue;
    const p = userPctFromGist(e);
    if (p != null) user.set(String(id), p);
  }
  return { guild, user };
}

/**
 * Applique les % des trackers à une expérience (normalisée ou brute).
 * Ne remplace jamais un % déjà fourni par le payload : seule une valeur
 * « unknown » est complétée. Respecte l'isolation de type (un % guild ne va
 * jamais sur une expérience user, et inversement).
 */
function applyRolloutPercentages(exp, maps) {
  if (!exp || typeof exp !== 'object' || !exp.id) return exp;
  const id = String(exp.id);
  const g = maps && maps.guild ? maps.guild.get(id) : undefined;
  const u = maps && maps.user ? maps.user.get(id) : undefined;
  if (g == null && u == null) return exp;

  // On calcule d'abord les % du payload (expérience brute ou normalisée) :
  // un pourcentage explicitement fourni ne doit jamais être écrasé.
  const base = attachPercentages(exp);
  const known = (field) =>
    base[field] && base[field].status !== 'unknown' && base[field].value != null;
  const overrides = {};
  if (g != null && !known('guildPercentage')) {
    overrides.guild = { value: g, source: 'apex_rollouts' };
  }
  if (u != null && !known('userPercentage')) {
    overrides.user = { value: u, source: 'gist_user_rollouts' };
  }
  if (!overrides.guild && !overrides.user) return base;

  const out = attachPercentages(base, overrides);
  out.fingerprint = createExperimentFingerprint(out);
  return out;
}

async function readJsonSafe(file) {
  try {
    if (await fs.pathExists(file)) return await fs.readJson(file);
  } catch {}
  return null;
}

/** Charge apex_rollouts.json + gist_user_rollouts.json et construit les maps. */
async function loadRolloutPercentageMaps(dataDir) {
  const [apex, gist] = await Promise.all([
    readJsonSafe(path.join(dataDir, 'apex_rollouts.json')),
    readJsonSafe(path.join(dataDir, 'gist_user_rollouts.json')),
  ]);
  return buildRolloutPercentageMaps(apex, gist);
}

module.exports = {
  guildPctFromApex,
  userPctFromGist,
  buildRolloutPercentageMaps,
  applyRolloutPercentages,
  loadRolloutPercentageMaps,
};
