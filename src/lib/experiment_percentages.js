/**
 * Guild / User experiment percentages with explicit provenance.
 * status: provided | calculated | unknown
 * Never invent a percentage when data is incomplete.
 */
'use strict';

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Convertit une valeur « numérique » éventuellement textuelle.
 * Accepte "25", "25%", "12,5 %" (virgule décimale), refuse le reste.
 * @returns {number|null}
 */
function parseNumericValue(v) {
  if (isFiniteNumber(v)) return v;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  if (s.endsWith('%')) s = s.slice(0, -1).trim();
  // "12,5" → "12.5" ; "1,500" (groupe de 3 chiffres) est un séparateur de
  // milliers ambigu → refusé plutôt que de choisir 1,5 % ou 1500 %.
  if (/^-?\d{1,3},\d{3}$/.test(s)) return null;
  if (/^-?\d+,\d{1,6}$/.test(s)) s = s.replace(',', '.');
  else if (s.includes(',')) return null;
  if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clampPct(n) {
  if (!isFiniteNumber(n)) return null;
  if (n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

function normalizeStatusValue(status, value, extra) {
  const out = {
    status: status === 'provided' || status === 'calculated' ? status : 'unknown',
    value: status === 'unknown' ? null : clampPct(value),
  };
  if (out.status !== 'unknown' && out.value == null) {
    return { status: 'unknown', value: null };
  }
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v != null) out[k] = v;
    }
  }
  return out;
}

/**
 * Coerce a numeric percentage without inventing units.
 * - rate/fraction fields: 0..1 → *100
 * - percentage/percent/pct/rollout*: (0,1) exclusive → null (ambiguous)
 *   0 and 1 and 2..100 accepted as literal percent values
 */
function coerceProvidedNumber(n, { isRate } = {}) {
  if (!isFiniteNumber(n)) return null;
  if (isRate) {
    if (n >= 0 && n <= 1) return clampPct(n * 100);
    return clampPct(n);
  }
  if (n > 0 && n < 1) return null;
  return clampPct(n);
}

function readProvidedPercentage(obj) {
  if (!obj || typeof obj !== 'object') return null;

  // Toutes les valeurs fournies sont collectées puis comparées : un payload
  // qui contient rate: 0.5 ET percentage: 25 est incohérent → unknown plutôt
  // que de choisir silencieusement l'un des deux (l'ancien ordre donnait 50).
  const values = [];
  for (const c of [obj.rate, obj.fraction]) {
    const n = parseNumericValue(c);
    if (n == null) continue;
    const v = coerceProvidedNumber(n, { isRate: true });
    if (v != null) values.push(v);
  }
  for (const c of [
    obj.percentage,
    obj.percent,
    obj.rollout,
    obj.rolloutPercentage,
    obj.pct,
  ]) {
    const n = parseNumericValue(c);
    if (n == null) continue;
    const v = coerceProvidedNumber(n, { isRate: false });
    if (v != null) values.push(v);
  }
  if (!values.length) return null;
  const first = values[0];
  return values.every((v) => v === first) ? first : null;
}

function calculateFromRanges(variations, opts = {}) {
  if (!variations || typeof variations !== 'object') return null;
  const entries = Object.values(variations);
  if (!entries.length) return null;

  const ranges = [];
  let skippedEmpty = false;
  for (const v of entries) {
    if (!v || typeof v !== 'object') return null;
    const start = parseNumericValue(v.start ?? v.min ?? v.from ?? v.low);
    const end = parseNumericValue(v.end ?? v.max ?? v.to ?? v.high);
    if (!isFiniteNumber(start) || !isFiniteNumber(end) || end < start) return null;
    // Plage vide [x, x) : aucune couverture, jamais une erreur globale.
    if (end === start) {
      skippedEmpty = true;
      continue;
    }
    ranges.push([start, end]);
  }
  if (!ranges.length) return skippedEmpty ? 0 : null;

  // Échelle explicite prioritaire : l'API Discord travaille TOUJOURS en
  // buckets 0..10000, un rollout 0-50 vaut 0,5 % (et non 50 % comme le
  // laissait croire l'heuristique maxEnd ≤ 100).
  let scale = isFiniteNumber(opts.scale) && opts.scale > 0 ? opts.scale : null;
  const maxEnd = ranges.reduce((m, r) => Math.max(m, r[1]), 0);
  if (!scale) scale = maxEnd <= 100 ? 100 : maxEnd <= 10000 ? 10000 : null;
  if (!scale) return null;

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of ranges) {
    if (!merged.length || s > merged[merged.length - 1][1]) {
      merged.push([s, e]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    }
  }

  let covered = 0;
  for (const [s, e] of merged) {
    const a = Math.max(0, Math.min(scale, s));
    const b = Math.max(0, Math.min(scale, e));
    if (b > a) covered += b - a;
  }
  if (covered <= 0) return null;
  return clampPct((covered / scale) * 100);
}

function calculateFromPopulations(variations) {
  if (!variations || typeof variations !== 'object') return null;
  const entries = Object.values(variations);
  if (!entries.length) return null;

  let enabledSum = 0;
  let totalSum = 0;
  for (const v of entries) {
    if (!v || typeof v !== 'object') return null;
    const enabled = parseNumericValue(v.enabled ?? v.population ?? v.count);
    const total = parseNumericValue(v.total ?? v.populationTotal ?? v.size);
    if (!isFiniteNumber(enabled) || !isFiniteNumber(total) || total <= 0) return null;
    if (enabled < 0 || enabled > total) return null;
    enabledSum += enabled;
    totalSum += total;
  }
  if (totalSum <= 0) return null;
  return clampPct((enabledSum / totalSum) * 100);
}

function readRootProvided(experiment) {
  if (!experiment || typeof experiment !== 'object') return null;
  const fromRoot = readProvidedPercentage(experiment);
  if (fromRoot != null) return fromRoot;
  if (experiment.defaultConfig) {
    const fromCfg = readProvidedPercentage(experiment.defaultConfig);
    if (fromCfg != null) return fromCfg;
  }
  const vars = experiment.variations || experiment.treatments;
  if (vars && typeof vars === 'object') {
    const values = [];
    for (const v of Object.values(vars)) {
      const p = readProvidedPercentage(v);
      if (p != null) values.push(p);
    }
    if (values.length && values.every((x) => x === values[0])) return values[0];
    if (values.length === 1) return values[0];
  }
  return null;
}

function computeAudiencePercentage(experiment, audience, opts = {}) {
  const kind = String(experiment?.kind || experiment?.type || '').toLowerCase();
  // Strict audience isolation: never attribute a % to the wrong kind
  if (audience === 'guild' && kind && kind !== 'guild' && kind !== 'server') {
    return normalizeStatusValue('unknown', null);
  }
  if (audience === 'user' && kind && kind !== 'user') {
    return normalizeStatusValue('unknown', null);
  }

  // Nested audience payload first (guild.rollout / user.percentage, etc.)
  const nest =
    audience === 'guild'
      ? experiment?.guild || experiment?.server || null
      : audience === 'user'
        ? experiment?.user || null
        : null;
  if (nest != null && typeof nest !== 'object') {
    const v = coerceProvidedNumber(parseNumericValue(nest), { isRate: false });
    if (v != null) {
      return normalizeStatusValue('provided', v, { source: 'audience_nested' });
    }
  }
  if (nest && typeof nest === 'object') {
    const nested = readProvidedPercentage(nest);
    if (nested != null) {
      return normalizeStatusValue('provided', nested, { source: 'audience_nested' });
    }
  }

  const provided = readRootProvided(experiment);
  if (provided != null) {
    return normalizeStatusValue('provided', provided, { source: 'payload' });
  }

  // Calculated only when kind matches the requested audience (or kind unknown)
  const vars = experiment?.variations || experiment?.treatments;
  const fromPop = calculateFromPopulations(vars);
  if (fromPop != null) {
    return normalizeStatusValue('calculated', fromPop, {
      source: 'variation_populations',
    });
  }

  const fromRanges = calculateFromRanges(vars, { scale: opts.scale });
  if (fromRanges != null) {
    return normalizeStatusValue('calculated', fromRanges, {
      source: 'bucket_ranges',
    });
  }

  return normalizeStatusValue('unknown', null);
}

/**
 * @param {object} experiment
 * @param {{guild?: {value:number, source?:string},
 *          user?: {value:number, source?:string}}} [overrides]
 *   Valeurs provenant des trackers de rollouts (apex / gist). Appliquées
 *   seulement si le type de l'expérience correspond à l'audience.
 */
function attachPercentages(experiment, overrides = {}) {
  if (!experiment || typeof experiment !== 'object') return experiment;
  const kind = String(experiment.kind || experiment.type || '').toLowerCase();
  const allows = (audience) =>
    !kind ||
    (audience === 'guild' ? kind === 'guild' || kind === 'server' : kind === 'user');
  const pick = (audience) => {
    const o = overrides && overrides[audience];
    if (!o || o.value == null || !allows(audience)) return null;
    const r = normalizeStatusValue('provided', o.value, {
      source: o.source || 'rollouts',
    });
    return r.status === 'provided' ? r : null;
  };
  return {
    ...experiment,
    guildPercentage: pick('guild') || computeAudiencePercentage(experiment, 'guild'),
    userPercentage: pick('user') || computeAudiencePercentage(experiment, 'user'),
  };
}

module.exports = {
  isFiniteNumber,
  parseNumericValue,
  clampPct,
  readProvidedPercentage,
  coerceProvidedNumber,
  calculateFromRanges,
  calculateFromPopulations,
  computeAudiencePercentage,
  attachPercentages,
};
