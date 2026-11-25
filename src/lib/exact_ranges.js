'use strict';

const { DEFAULT_SCALE, mergeIntervalsHalfOpen } = require('./rollout_math');

// ─── V15 : plages EXACTES depuis positions positives ET négatives ──────────
//
// La position d'un échantillon dans une expérience user est déterministe :
//   position = murmur3(`${experimentId}:${fingerprintId}`) % 10000
// Pour une expérience NOMMÉE, on calcule donc la position de CHAQUE
// échantillon — y compris ceux qui ne sont PAS dans le rollout. Avec des
// points positifs ET négatifs, chaque borne de plage est encadrée entre deux
// points voisins de labels différents → précision ≈ 10000/n (≈ 0,02 % avec
// quelques milliers d'échantillons) au lieu de ±0,5 % pour k/n.

const SNAP_STEPS = [1000, 500, 250, 100, 50, 25, 10, 5, 1];

/**
 * Choisit une borne b avec lo < b ≤ hi (plages demi-ouvertes) en préférant
 * les valeurs « rondes » (Discord configure ses rollouts en 0-500, 0-1000…).
 */
function snapBoundary(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return hi;
  const mid = (lo + hi) / 2;
  for (const step of SNAP_STEPS) {
    const first = Math.floor(lo / step) * step + step; // plus petit multiple > lo
    if (first > hi) continue;
    // Forme close (O(1)) : l'ancienne boucle v += step était O(hi/step) et
    // bloquait le process sur des bornes énormes/aberrantes.
    const last = Math.floor(hi / step) * step;
    const clamp = (v) => Math.min(last, Math.max(first, v));
    const below = clamp(Math.floor(mid / step) * step);
    const above = clamp(below + step);
    // Égalité → plus petit multiple (comportement historique).
    return Math.abs(above - mid) < Math.abs(below - mid) ? above : below;
  }
  return hi;
}

/**
 * Reconstruit les plages exactes de chaque label depuis des points
 * étiquetés [{ pos, label }] (label = bucket ; -99 = hors rollout).
 * @returns {null | { ok, runs, ranges: {label: [[a,b),...]],
 *   pct: {label: number}, uncertainty: {label: number}, points }}
 *   ok = false si le modèle « une plage = un label » est contredit
 *   (rollout filtré par plateforme/âge du compte… → repli sur k/n).
 */
function inferExactRanges(points, scale = DEFAULT_SCALE, opts = {}) {
  opts = opts && typeof opts === 'object' ? opts : {};
  const maxRuns = opts.maxRuns ?? 16;
  const observed = (Array.isArray(points) ? points : [])
    .filter(
      (p) =>
        p &&
        Number.isInteger(p.pos) &&
        p.pos >= 0 &&
        p.pos < scale &&
        p.label != null &&
        p.label !== '' &&
        Number.isFinite(Number(p.label)),
    )
    .map((p) => ({ pos: p.pos, label: Number(p.label) }))
    .sort((a, b) => a.pos - b.pos);
  // Une collision de hash n'apporte pas une nouvelle preuve spatiale.
  const pts = [];
  let conflicts = 0;
  for (const p of observed) {
    const last = pts[pts.length - 1];
    if (!last || p.pos !== last.pos) pts.push(p);
    else if (last.label !== p.label) conflicts++;
  }
  if (pts.length < 20) return null;

  const runs = [];
  for (const p of pts) {
    const last = runs[runs.length - 1];
    if (last && last.label === p.label) {
      last.hi = p.pos;
      last.count++;
    } else {
      runs.push({ label: p.label, lo: p.pos, hi: p.pos, count: 1 });
    }
  }

  // Bornes entre runs consécutifs.
  const ranges = {};
  const unc = {};
  let start = 0;
  let startUnc = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    let end;
    let endUnc = 0;
    if (i === runs.length - 1) end = scale;
    else {
      const next = runs[i + 1];
      end = snapBoundary(r.hi, next.lo);
      // Le snap n'est pas nécessairement au milieu de l'intervalle admissible.
      endUnc = Math.max(end - (r.hi + 1), next.lo - end);
    }

    const key = String(r.label);
    (ranges[key] = ranges[key] || []).push([start, end]);
    unc[key] = (unc[key] || 0) + startUnc + endUnc;
    start = end;
    startUnc = endUnc;
  }

  const pct = {};
  const uncertainty = {};
  for (const [key, rs] of Object.entries(ranges)) {
    const merged = mergeIntervalsHalfOpen(rs);
    ranges[key] = merged;
    const cov = merged.reduce((s, [a, b]) => s + (b - a), 0);
    pct[key] = Math.round((cov / scale) * 10000) / 100;
    uncertainty[key] = Math.round((unc[key] / scale) * 10000) / 100;
  }

  // Run isolé d'un seul point ENTRE deux runs du même label = point
  // contradictoire typique d'un filtre (plateforme, ancienneté…).
  let isolated = 0;
  for (let i = 1; i < runs.length - 1; i++) {
    if (runs[i].count === 1 && runs[i - 1].label === runs[i + 1].label) isolated++;
  }
  const ok = conflicts === 0 && isolated === 0 && runs.length <= maxRuns;
  return { ok, runs: runs.length, conflicts, isolated, ranges, pct, uncertainty, points: observed.length, distinctPositions: pts.length };
}

module.exports = { SNAP_STEPS, snapBoundary, inferExactRanges };
