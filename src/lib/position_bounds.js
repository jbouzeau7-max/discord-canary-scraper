'use strict';
// Carte persistée : une position par centième de point de pourcentage.
const SPACE = 10000;
const emptyState = (revision = null) => ({ revision, map: '.'.repeat(SPACE), conflicts: 0, points: 0 });
const validMap = (m) => typeof m === 'string' && m.length === SPACE && !/[^.IO]/.test(m);
const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 0;

function normalize(state) {
  const revision = state?.revision ?? null;
  if (!validMap(state?.map)) return emptyState(revision);
  return { revision, map: state.map, conflicts: count(state.conflicts), points: count(state.points) };
}

function addPoint(state, position, isIn) {
  if (!Number.isInteger(position) || position < 0 || position >= SPACE || typeof isIn !== 'boolean') return state;
  const want = isIn ? 'I' : 'O';
  const cur = state.map[position];
  state.points++;
  if (cur === '.') state.map = state.map.slice(0, position) + want + state.map.slice(position + 1);
  else if (cur !== want) state.conflicts++;
  return state;
}

function* observations(state) {
  const map = state?.map;
  if (!validMap(map)) return;
  for (let i = 0; i < map.length; i++) if (map[i] !== '.') yield [i, map[i] === 'I'];
}

const knownPoints = (state) => Array.from(observations(state));

function runsOf(state) {
  const runs = [];
  for (const [p, isIn] of observations(state)) {
    const last = runs[runs.length - 1];
    if (last && last.in === isIn) { last.hi = p; last.n++; }
    else runs.push({ in: isIn, lo: p, hi: p, n: 1 });
  }
  return runs;
}

/** Bornes sous hypothèse de plages contiguës. Seul knownInPct est observé directement.
 * estPct est le milieu des couvertures admissibles, pas une fréquence utilisateur mesurée. */
function bounds(state) {
  const runs = runsOf(state);
  if (!runs.length) return null;
  let min = 0, max = 0, known = 0, inside = 0;
  runs.forEach((r, i) => {
    known += r.n;
    if (!r.in) return;
    inside += r.n;
    min += r.hi - r.lo + 1;
    const start = i ? runs[i - 1].hi + 1 : 0;
    const end = runs[i + 1]?.lo ?? SPACE;
    max += end - start;
  });
  return { minPct: min / 100, maxPct: inside ? max / 100 : null,
    estPct: inside ? Math.round((min + max) / 2) / 100 : null,
    widthPoints: inside ? (max - min) / 100 : null, knownInPct: inside / 100,
    knownPositions: known, inPositions: inside, outPositions: known - inside, runs: runs.length,
    points: state.points, conflicts: state.conflicts || 0 };
}

function unionRanges(ranges) {
  const list = (Array.isArray(ranges) ? ranges : [])
    .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]))
    .map(([a, b]) => [Math.max(0, a), Math.min(SPACE, b)])
    .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push(r);
  }
  return out;
}

function agreement(state, gistTreatmentRanges) {
  const union = unionRanges(gistTreatmentRanges);
  let consistent = 0, contradicting = 0, i = 0;
  const examples = [];
  for (const [p, isIn] of observations(state)) {
    while (i < union.length && union[i][1] <= p) i++;
    if ((i < union.length && union[i][0] <= p) === isIn) consistent++;
    else { contradicting++; if (examples.length < 3) examples.push([p, isIn]); }
  }
  const gistPct = union.reduce((s, [a, b]) => s + (b - a), 0) / 100;
  return { consistentPositions: consistent, contradictingPositions: contradicting, gistPct, examples };
}

module.exports = { SPACE, emptyState, normalize, addPoint, knownPoints, runsOf, bounds, unionRanges, agreement };
