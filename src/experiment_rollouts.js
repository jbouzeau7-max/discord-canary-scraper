/**
 * Experiment Rollouts Fetcher
 *
 * Fetches the latest experiment rollout percentages from multiple sources:
 *
 * 1. Discord API /experiments (no auth required) — returns guild experiment
 *    rollouts with bucket ranges. This gives the most up-to-date guild data.
 * 2. Local experiments.json — experiment IDs extracted from the client JS bundle.
 *
 * For GUILD experiments: calculates exact percentages from bucket ranges.
 * For USER experiments: the Discord API only returns assignments for the current
 *   fingerprint (not overall rollout). Overall user rollout percentages require
 *   token-based sampling (see user_rollouts.js).
 *
 * Output: data/experiment_rollouts.json with percentages per experiment.
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./lib/atomic');
const { murmur3 } = require('./lib/murmur3');
const {
  mergeIntervalsHalfOpen,
  rangesPercentExclusive,
  DEFAULT_SCALE,
} = require('./lib/rollout_math');
const { DEFAULT_UA, sleep, envNumber } = require('./lib/utils');
const { safeJson, fetchWithRetry } = require('./lib/http');

const DATA = path.join(__dirname, '..', 'data');
const OUTPUT = path.join(DATA, 'experiment_rollouts.json');
const EXPERIMENTS_FILE = path.join(DATA, 'experiments.json');
const CURRENT_FILE = path.join(DATA, 'current_experiments.json');

const DISCORD_API = 'https://discord.com/api/v9';
const SCALE = DEFAULT_SCALE; // 10000
const FP_SAMPLES = envNumber('EXP_FP_SAMPLES', 50, { min: 0, max: 500, int: true });
const FP_CONCURRENCY = 1; // Must be 1 — Discord rate-limits fingerprint generation
const FP_DELAY_MS = envNumber('EXP_FP_DELAY_MS', 5000, { min: 0, max: 10000, int: true });

// ── HTTP helpers ──────────────────────────────────────

async function fetchJson(url, opts = {}) {
  const res = await fetchWithRetry(url, {
    timeout: 20000,
    headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const data = await safeJson(res);
  if (data === null) throw new Error(`${url} → JSON invalide`);
  return data;
}

// ── Parse guild experiment rollouts from Discord API ──

/**
 * Parse the compact array format returned by Discord API /experiments.
 * Format: [hash, name, revision, populations, overrides, ...]
 * Populations: [[[positions], [filters]], ...]
 * Positions: [[bucket, [{s, e}, ...]], ...]
 */
function parseGuildExperiment(ge) {
  if (!Array.isArray(ge) || ge.length < 4) return null;
  // Discord renvoie un hash numérique ; une sérialisation texte ne doit pas
  // casser la correspondance avec murmur3(id) (Map à clés numériques).
  const hash = Number.isFinite(Number(ge[0])) ? Number(ge[0]) : ge[0];
  const name = ge[1];
  const revision = ge[2];
  const populationsValid = Array.isArray(ge[3]);
  const populations = populationsValid ? ge[3] : [];
  let dataValid = populationsValid;

  // Collect all bucket ranges for treatment buckets (bucket > 0)
  const treatmentRanges = [];
  const allRanges = [];
  const filtersByPop = [];

  for (const pop of populations) {
    if (!Array.isArray(pop) || !Array.isArray(pop[0]) || (pop[1] != null && !Array.isArray(pop[1]))) {
      dataValid = false;
      continue;
    }
    const positions = pop[0];
    const filters = Array.isArray(pop[1]) ? pop[1] : [];
    const filterDesc = describeFilters(filters);
    filtersByPop.push(filterDesc);

    for (const pos of positions) {
      if (!Array.isArray(pos) || pos.length < 2 || !Array.isArray(pos[1])) {
        dataValid = false;
        continue;
      }
      const bucket = Number(pos[0]);
      if (!Number.isInteger(bucket)) {
        dataValid = false;
        continue;
      }
      const rollouts = pos[1];
      for (const r of rollouts) {
        let start, end;
        if (Array.isArray(r) && r.length >= 2) {
          start = Number(r[0]);
          end = Number(r[1]);
        } else if (r && typeof r === 'object') {
          start = Number(r.s ?? r.start);
          end = Number(r.e ?? r.end);
        } else {
          continue;
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          dataValid = false;
          continue;
        }
        if (start < 0 || end > SCALE) dataValid = false;
        const a = Math.max(0, Math.min(SCALE, start));
        const b = Math.max(0, Math.min(SCALE, end));
        if (b <= a) continue;
        allRanges.push([a, b, bucket]);
        if (bucket > 0) {
          treatmentRanges.push([a, b]);
        }
      }
    }
  }

  // Exact half-open [0, SCALE) coverage without off-by-one or gap-filling
  const merged = mergeIntervalsHalfOpen(treatmentRanges);
  const coverage = merged.reduce((sum, [a, b]) => sum + (b - a), 0);
  const pct = dataValid ? rangesPercentExclusive(merged, SCALE) : null;

  // Determine rollout status
  let status = 'unknown';
  if (pct != null && Number.isFinite(pct)) {
    if (pct <= 0) status = 'not_started';
    else if (pct >= 100) status = 'full_rollout';
    else status = 'partial';
  }

  return {
    hash,
    name,
    revision,
    percentage: pct,
    status,
    coverage,
    populations: populations.length,
    dataStatus: dataValid ? 'complete' : 'malformed',
    filters: filtersByPop,
    treatmentRanges: merged,
    allRanges,
  };
}

function describeFilters(filters) {
  if (!Array.isArray(filters) || !filters.length) return 'all';
  const parts = [];
  for (const f of filters) {
    if (!Array.isArray(f) || f.length < 1 || f[0] == null) continue;
    const type = f[0];
    if (type === 1604612045) {
      // Feature filter
      const rawFeatures = Array.isArray(f[1]) ? f[1] : [];
      const features = rawFeatures.map((ff) => {
        if (Array.isArray(ff) && ff.length >= 2) {
          return typeof ff[1] === 'string' ? ff[1] : `feature_${ff[0]}`;
        }
        return String(ff);
      });
      parts.push('feature:' + features.join(','));
    } else if (type === 2404720969) {
      parts.push('member_count:' + JSON.stringify(f[1]));
    } else if (type === 2918402255) {
      parts.push('id_range:' + JSON.stringify(f[1]));
    } else {
      parts.push(`filter_${type}`);
    }
  }
  return parts.join('; ') || 'all';
}

/**
 * Repli sûr quand la récupération guild échoue ou renvoie un format inconnu :
 * on conserve les rollouts du fichier précédent au lieu d'écrire une liste
 * vide (qui faisait disparaître TOUTES les expériences guild de la sortie).
 * @param {object|null} previous - contenu précédent de experiment_rollouts.json
 * @param {Array} fresh - rollouts fraîchement parsés (peut être vide)
 * @returns {{ list: Array, stale: boolean }}
 */
function fallbackGuildRollouts(previous, fresh) {
  const identityKeys = (e) => {
    if (!e || typeof e !== 'object') return [];
    const keys = [];
    if (e.id) keys.push('id:' + String(e.id));
    if (e.hash != null && String(e.hash).trim()) keys.push('hash:' + String(e.hash));
    return keys;
  };
  const prev = previous && Array.isArray(previous.guildExperiments)
    ? previous.guildExperiments.filter((e) => identityKeys(e).length)
    : [];
  const cur = Array.isArray(fresh) ? fresh.filter((e) => identityKeys(e).length) : [];
  if (cur.length) {
    const previousByKey = new Map();
    for (const e of prev) {
      for (const key of identityKeys(e)) previousByKey.set(key, e);
    }
    const list = cur.map((e) => {
      if (e.dataStatus !== 'malformed') return e;
      const old = identityKeys(e).map((key) => previousByKey.get(key)).find(Boolean);
      if (!old || old.percentage == null) return e;
      const preserved = { ...old };
      for (const key of ['id', 'hash', 'name', 'revision', 'title', 'type']) {
        if (e[key] != null) preserved[key] = e[key];
      }
      preserved.dataStatus = 'stale_preserved';
      preserved.currentDataStatus = 'malformed';
      preserved.stale = true;
      return preserved;
    });
    return { list, stale: false };
  }
  if (prev.length) return { list: prev, stale: true };
  return { list: [], stale: false };
}

// ── Fingerprint-based user experiment sampling ──────

/**
 * Generate a Discord fingerprint without authentication.
 * Retries on 429 with exponential backoff.
 */
async function getFingerprint(retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await fetch(`${DISCORD_API}/auth/fingerprint`, {
      method: 'POST',
      headers: { 'User-Agent': DEFAULT_UA, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    if (r.status === 429) {
      const retryAfter = Number(r.headers.get('Retry-After') || 5);
      const delay = Math.min(30, retryAfter + attempt * 2) * 1000;
      if (attempt < retries) {
        await sleep(delay);
        continue;
      }
    }
    if (!r.ok) throw new Error(`fingerprint → ${r.status}`);
    const data = await safeJson(r);
    if (!data || !data.fingerprint) throw new Error('fingerprint → réponse invalide');
    return data.fingerprint;
  }
}

/**
 * Query /experiments with a given fingerprint.
 * Returns { assignments, guild_experiments }.
 */
async function getExperimentsWithFp(fp) {
  const r = await fetch(`${DISCORD_API}/experiments?with_guild_experiments=true`, {
    headers: { 'User-Agent': DEFAULT_UA, 'X-Fingerprint': fp },
    timeout: 15000,
  });
  if (!r.ok) throw new Error(`experiments(fp) → ${r.status}`);
  const data = await safeJson(r);
  return data;
}

/**
 * Sample user experiment rollouts using anonymous fingerprints.
 *
 * The Discord API /experiments endpoint returns 3-4 user assignments per
 * fingerprint. Each assignment is an array:
 *   [hash, bucket, revision, ?, treatment, hash_result, ...]
 * Where treatment > 0 means the user is enrolled in a treatment variant.
 *
 * By generating many fingerprints and collecting the treatment values,
 * we can estimate the rollout percentage for each user experiment.
 *
 * @param {Map<number, {id, type, title}>} hashToId - hash → experiment info
 * @returns {Map<number, {hash, samples, enrolled, percentage, hashResults}>}
 */
async function sampleFingerprintRollouts(hashToId) {
  console.log(`\n=== Fingerprint sampling (${FP_SAMPLES} samples, concurrency ${FP_CONCURRENCY}) ===`);

  const stats = new Map(); // hash → { samples, enrolled, hashResults, treatments }
  let success = 0;
  let fail = 0;
  let lastProgress = 0;

  async function sampleOne() {
    try {
      const fp = await getFingerprint();
      if (FP_DELAY_MS > 0) await sleep(FP_DELAY_MS / 2);
      const data = await getExperimentsWithFp(fp);
      const assignments = (data && data.assignments) || {};

      for (const [, val] of Object.entries(assignments)) {
        if (!Array.isArray(val) || val.length < 6) continue;
        const hash = val[0];
        const treatment = val[4];
        const hashResult = val[5];

        if (!stats.has(hash)) {
          stats.set(hash, { samples: 0, enrolled: 0, hashResults: [], treatments: new Map() });
        }
        const s = stats.get(hash);
        s.samples++;
        if (treatment > 0) s.enrolled++;
        s.treatments.set(treatment, (s.treatments.get(treatment) || 0) + 1);
        if (hashResult != null && hashResult >= 0) s.hashResults.push(hashResult);
      }
      success++;
    } catch (e) {
      fail++;
    }

    const progress = Math.floor(((success + fail) / FP_SAMPLES) * 100);
    if (progress >= lastProgress + 10) {
      lastProgress = progress;
      const hits = [...stats.values()].reduce((a, s) => a + s.samples, 0);
      console.log(`  ${progress}% — ${success} ok, ${fail} fail, ${stats.size} unique hashes, ${hits} assignment hits`);
    }
  }

  // Run sequentially (Discord rate-limits fingerprint generation)
  for (let i = 0; i < FP_SAMPLES; i++) {
    await sampleOne();
    if (FP_DELAY_MS > 0 && i < FP_SAMPLES - 1) {
      await sleep(FP_DELAY_MS);
    }
  }

  console.log(`  Done: ${success} ok, ${fail} fail, ${stats.size} unique experiment hashes sampled`);

  // Calculate estimated percentages
  const results = [];
  for (const [hash, s] of stats) {
    const pct = s.samples > 0 ? Math.round((s.enrolled / s.samples) * 10000) / 100 : null;
    const idInfo = hashToId.get(hash);
    const treatmentDist = {};
    for (const [t, c] of s.treatments) {
      treatmentDist[t] = c;
    }

    let status = 'unknown';
    if (pct != null) {
      if (pct <= 0) status = 'not_started';
      else if (pct >= 100) status = 'full_rollout';
      else status = 'partial';
    }

    results.push({
      hash,
      id: idInfo ? idInfo.id : null,
      type: idInfo ? idInfo.type : 'user',
      title: idInfo ? idInfo.title : `hash_${hash}`,
      percentage: pct,
      status,
      samples: s.samples,
      enrolled: s.enrolled,
      treatmentDistribution: treatmentDist,
      source: 'fingerprint_sampling',
      note: !idInfo ? 'No local experiment ID match for this hash' : null,
    });
  }

  return results;
}

// ── Main ─────────────────────────────────────────────

async function main() {
  console.log('=== Experiment Rollouts ===');
  const fetchedAt = new Date().toISOString();
  const results = {
    fetchedAt,
    sources: {},
    guildExperiments: [],
    userExperiments: [],
    matchedExperiments: [],
    summary: { guild: 0, user: 0, withPercentage: 0, withoutPercentage: 0 },
  };

  // 1. Load local experiments (from client JS bundle)
  let localExperiments = [];
  try {
    if (await fs.pathExists(CURRENT_FILE)) {
      const d = await fs.readJson(CURRENT_FILE);
      localExperiments = d.experiments || d;
      if (!Array.isArray(localExperiments)) localExperiments = [];
      console.log('Local experiments:', localExperiments.length);
    }
  } catch (e) {
    console.warn('Local experiments load failed:', e.message);
  }

  // Also try experiments.json
  try {
    if (await fs.pathExists(EXPERIMENTS_FILE)) {
      const d = await fs.readJson(EXPERIMENTS_FILE);
      const exps = d.experiments || d;
      if (Array.isArray(exps)) {
        for (const e of exps) {
          if (!localExperiments.find((le) => le.id === e.id)) {
            localExperiments.push(e);
          }
        }
      }
    }
  } catch (e) {
    console.warn('experiments.json load failed:', e.message);
  }

  // Build hash → ID map from local experiments
  const localHashMap = new Map();
  for (const exp of localExperiments) {
    const id = String(exp.id || '');
    if (!id) continue;
    const hash = murmur3(id);
    localHashMap.set(hash, { id, type: exp.kind || exp.type || 'unknown', title: exp.label || exp.title || id });
  }
  console.log('Local hash map:', localHashMap.size, 'entries');

  // 2. Fetch guild experiment rollouts from Discord API (no auth)
  let guildRollouts = [];
  let previousOutput = null;
  try {
    if (await fs.pathExists(OUTPUT)) previousOutput = await fs.readJson(OUTPUT);
  } catch {}
  try {
    const data = await fetchJson(`${DISCORD_API}/experiments?with_guild_experiments=true`);
    if (!data || !Array.isArray(data.guild_experiments)) {
      throw new Error('réponse sans guild_experiments (format inattendu)');
    }
    const guildExps = data.guild_experiments;
    console.log('Discord API guild experiments:', guildExps.length);
    results.sources.discordApi = { url: `${DISCORD_API}/experiments`, count: guildExps.length };

    for (const ge of guildExps) {
      const parsed = parseGuildExperiment(ge);
      if (!parsed) continue;

      // Match hash to experiment ID
      const localMatch = localHashMap.get(parsed.hash);
      if (localMatch) {
        parsed.id = localMatch.id;
        parsed.type = 'guild';
        parsed.title = localMatch.title;
        parsed.source = 'discord_api + local_match';
      } else {
        parsed.id = null;
        parsed.type = 'guild';
        parsed.title = `hash_${parsed.hash}`;
        parsed.source = 'discord_api';
        parsed.note = 'No local experiment ID match for this hash';
      }
      guildRollouts.push(parsed);
    }
    results.guildExperiments = guildRollouts;
    results.summary.guild = guildRollouts.length;
  } catch (e) {
    console.warn('Discord API fetch failed:', e.message);
    results.sources.discordApi = { error: e.message };
  }
  {
    const fb = fallbackGuildRollouts(previousOutput, guildRollouts);
    if (fb.stale) {
      console.warn(
        'Discord API indisponible — conservation de',
        fb.list.length,
        'rollouts guild du run précédent',
      );
      results.sources.discordApi = {
        ...(results.sources.discordApi || {}),
        stale: true,
        fallbackCount: fb.list.length,
      };
    }
    guildRollouts = fb.list;
    results.guildExperiments = guildRollouts;
    results.summary.guild = guildRollouts.length;
  }

  // 4. Sample user experiment rollouts via anonymous fingerprints
  //    This generates N fingerprints, queries /experiments for each, and
  //    estimates rollout percentages based on treatment assignment rates.
  const fpResults = [];
  try {
    const fpRollouts = await sampleFingerprintRollouts(localHashMap);
    results.sources.fingerprintSampling = {
      samples: FP_SAMPLES,
      uniqueHashes: fpRollouts.length,
      matched: fpRollouts.filter((r) => r.id).length,
    };
    for (const r of fpRollouts) {
      fpResults.push(r);
    }
  } catch (e) {
    console.warn('Fingerprint sampling failed:', e.message);
    results.sources.fingerprintSampling = { error: e.message };
  }

  // 5. Merge guild rollouts from Discord API with fingerprint samples
  const mergedExperiments = new Map();

  // Add Discord API guild experiments
  for (const ge of guildRollouts) {
    const key = ge.id || `hash_${ge.hash}`;
    mergedExperiments.set(key, { ...ge, source: 'discord_api' });
  }

  // Add fingerprint-sampled user experiments
  for (const fp of fpResults) {
    const key = fp.id || `hash_${fp.hash}`;
    if (mergedExperiments.has(key)) {
      // Merge fingerprint data into existing entry
      const existing = mergedExperiments.get(key);
      existing.fpPercentage = fp.percentage;
      existing.fpSamples = fp.samples;
      existing.fpEnrolled = fp.enrolled;
      existing.fpTreatmentDist = fp.treatmentDistribution;
      // Use fingerprint percentage if no other percentage is available
      if (existing.percentage == null && fp.percentage != null) {
        existing.percentage = fp.percentage;
        existing.status = fp.status;
        existing.source = 'fingerprint_sampling';
      }
    } else {
      mergedExperiments.set(key, {
        ...fp,
        fpSamples: fp.samples,
        fpEnrolled: fp.enrolled,
        fpTreatmentDist: fp.treatmentDistribution,
        source: 'fingerprint_sampling',
      });
    }
  }

  // 6. Add local experiments that have no rollout data
  for (const exp of localExperiments) {
    const id = String(exp.id || '');
    if (!id) continue;
    if (!mergedExperiments.has(id)) {
      const hash = murmur3(id);
      const kind = exp.kind || exp.type || 'unknown';
      mergedExperiments.set(id, {
        id,
        hash,
        type: kind,
        title: exp.label || exp.title || id,
        percentage: null,
        status: 'no_rollout_data',
        source: 'client_bundle',
        note: kind === 'user'
          ? 'User experiment — rollout percentage not publicly available. Use user_rollouts.js with tokens for estimation.'
          : 'No rollout data found in the Discord API.',
      });
    }
  }

  // 7. Build final results
  const allExperiments = [...mergedExperiments.values()];
  results.matchedExperiments = allExperiments;

  results.summary = {
    total: allExperiments.length,
    guild: allExperiments.filter((e) => e.type === 'guild').length,
    user: allExperiments.filter((e) => e.type === 'user').length,
    withPercentage: allExperiments.filter((e) => e.percentage != null).length,
    withoutPercentage: allExperiments.filter((e) => e.percentage == null).length,
    fullRollout: allExperiments.filter((e) => e.status === 'full_rollout').length,
    partial: allExperiments.filter((e) => e.status === 'partial').length,
    notStarted: allExperiments.filter((e) => e.status === 'not_started').length,
    fpSampled: allExperiments.filter((e) => e.fpSamples != null || e.source === 'fingerprint_sampling').length,
  };

  // Print summary
  console.log('\n=== Summary ===');
  console.log(`Total: ${results.summary.total}`);
  console.log(`Guild: ${results.summary.guild} | User: ${results.summary.user}`);
  console.log(`With percentage: ${results.summary.withPercentage} | Without: ${results.summary.withoutPercentage}`);
  console.log(`Full rollout: ${results.summary.fullRollout} | Partial: ${results.summary.partial} | Not started: ${results.summary.notStarted}`);

  // Print specific experiments the user asked about
  const interesting = ['silp-direct-to-discoverable', 'soundboard-quick-action'];
  for (const term of interesting) {
    const matches = allExperiments.filter((e) => e.id && e.id.includes(term));
    for (const m of matches) {
      console.log(`\n  ${m.id}: ${m.percentage != null ? m.percentage + '%' : 'no percentage'} (${m.type}, ${m.status}, ${m.source})`);
      if (m.fpSamples != null) {
        console.log(`    FP samples: ${m.fpSamples}, enrolled: ${m.fpEnrolled}, treatment: ${JSON.stringify(m.fpTreatmentDist)}`);
      }
    }
  }

  // Save
  await writeJsonAtomic(OUTPUT, results, 2);
  console.log('\nSaved to', OUTPUT);
  return results;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  main,
  parseGuildExperiment,
  describeFilters,
  getFingerprint,
  getExperimentsWithFp,
  sampleFingerprintRollouts,
  fallbackGuildRollouts,
};
