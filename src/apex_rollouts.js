/**
 * Apex rollouts v7 — EXACT guild % (Discord wire uniquement, aucune source externe)
 * User global % is handled by user_rollouts.js (own sampling).
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { sendEmbeds } = require('./lib/webhook');
const { murmur3 } = require('./lib/murmur3');
const { writeJsonAtomic } = require('./lib/atomic');
const { loadTokens, sleep, DEFAULT_UA, DEFAULT_BOT_NAME: BOT, DEFAULT_AVATAR_URL: AVATAR } = require('./lib/utils');
const { safeJson } = require('./lib/http');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_STATE_FILE = path.join(DATA_DIR, 'apex_rollouts.json');
const LOCAL_EXP = path.join(DATA_DIR, 'experiments.json');
const KNOWN_EXP = path.join(DATA_DIR, 'known_experiment_ids.json');

// Webhooks candidats : une webhook supprimée (404 Unknown Webhook) bascule sur la suivante.
const WEBHOOKS = [
  ...new Set(
    [process.env.APEX_WEBHOOK_URL, process.env.ROLLOUT_WEBHOOK_URL, process.env.DISCORD_WEBHOOK_URL]
      .map((u) => String(u || '').trim())
      .filter(Boolean),
  ),
];
let WEBHOOK = WEBHOOKS[0] || null;
// Une valeur d'env illisible (« abc », vide, négative) donnait NaN : toute
// comparaison `>= NaN` est fausse → PLUS AUCUNE notification. Repli sur le défaut.
function envPositive(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const MIN_DELTA = envPositive(process.env.APEX_MIN_PCT_DELTA, 0.01);
const YEAR_MIN = envPositive(process.env.APEX_RECENT_YEAR, 2024);
const FETCH_ROUNDS = Math.min(5, Math.max(1, Math.floor(envPositive(process.env.APEX_FETCH_ROUNDS, 2))));
const FETCH_RETRY_MS = envPositive(process.env.APEX_FETCH_RETRY_MS, 1500);
const EMPTY_CONFIRM = Math.max(1, Math.floor(envPositive(process.env.APEX_EMPTY_CONFIRM, 3)));
const SCALE = 10000;
// Précision des % stockés/notifiés (décimales). 2 = 0,01 pt (1 position /10000).
const PCT_PRECISION = 2;
const USER_TOKENS = loadTokens();

function tLabel(bucket) {
  const b = Number(bucket);
  if (b === -1) return 'None';
  if (b === 0) return 'Control';
  return 'Variant ' + b;
}

function isRecent(id) {
  const m = String(id).match(/^(\d{4})-/);
  return m ? Number(m[1]) >= YEAR_MIN : false;
}

function rangesToPct(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return 0;
  const iv = [];
  for (const r of ranges) {
    let a, b;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      a = Number(r.s ?? r.start);
      b = Number(r.e ?? r.end);
    } else if (Array.isArray(r) && r.length >= 2) {
      a = Number(r[0]);
      b = Number(r[1]);
    } else continue;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    // Bornes ramenées à l'espace [0, SCALE] : une plage qui déborde
    // (ex. 9000-20000) comptait 110 % → plafonnée à 100 % au lieu de 10 %.
    a = Math.max(0, a);
    b = Math.min(SCALE, b);
    if (b <= a) continue;
    iv.push([a, b]);
  }
  if (!iv.length) return 0;
  iv.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  let cs = iv[0][0],
    ce = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    const [a, b] = iv[i];
    if (a <= ce) ce = Math.max(ce, b);
    else {
      merged.push([cs, ce]);
      cs = a;
      ce = b;
    }
  }
  merged.push([cs, ce]);
  let c = 0;
  for (const [a, b] of merged) c += b - a;
  return Math.min(100, Math.round((c / SCALE) * 10000) / 100);
}

function decodeGuildWire(tuple, hashMap) {
  if (!Array.isArray(tuple) || tuple.length < 4) return null;
  const hash = tuple[0];
  const key = tuple[1];
  const revision = tuple[2];
  // Un format inattendu (objet au lieu de tableau) ne doit pas faire perdre
  // TOUTES les expériences guild : on ignore simplement la partie illisible.
  const pops = Array.isArray(tuple[3]) ? tuple[3] : [];
  const ovs = Array.isArray(tuple[4]) ? tuple[4] : [];
  const getMapped = (h) => {
    if (!hashMap) return null;
    if (typeof hashMap.get === 'function') {
      return hashMap.get(Number(h)) || hashMap.get(String(h)) || null;
    }
    if (typeof hashMap === 'object') {
      return hashMap[Number(h)] || hashMap[String(h)] || null;
    }
    return null;
  };
  let id =
    (typeof key === 'string' && key.trim() && key) ||
    getMapped(hash) ||
    'hash:' + hash;

  const byBucket = new Map();
  for (const pop of pops) {
    if (!Array.isArray(pop)) continue;
    const positions = Array.isArray(pop[0]) ? pop[0] : [];
    for (const pos of positions) {
      if (!Array.isArray(pos)) continue;
      const bucket = Number(pos[0]);
      if (!Number.isFinite(bucket)) continue;
      const ranges = Array.isArray(pos[1]) ? pos[1] : [];
      if (!byBucket.has(bucket)) byBucket.set(bucket, { bucket, label: tLabel(bucket), intervals: [] });
      for (const r of ranges) {
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          byBucket.get(bucket).intervals.push([Number(r.s ?? r.start), Number(r.e ?? r.end)]);
        } else if (Array.isArray(r) && r.length >= 2) {
          byBucket.get(bucket).intervals.push([Number(r[0]), Number(r[1])]);
        }
      }
    }
  }
  const treatments = [...byBucket.values()]
    .map((t) => ({
      bucket: t.bucket,
      label: t.label,
      pct: rangesToPct(t.intervals.map(([a, b]) => ({ s: a, e: b }))),
    }))
    .sort((a, b) => (a.bucket ?? 9999) - (b.bucket ?? 9999));

  let ovCount = 0;
  for (const o of ovs) {
    // Tester Array.isArray AVANT typeof object : un tableau est un objet,
    // l'ancien ordre comptait donc toujours 0 pour le format [bucket, ids].
    if (Array.isArray(o)) ovCount += Array.isArray(o[1]) ? o[1].length : 0;
    else if (o && typeof o === 'object') {
      const ids = Array.isArray(o.k) ? o.k : Array.isArray(o.ids) ? o.ids : [];
      ovCount += ids.length;
    }
  }
  const fingerprint = treatments.map((t) => t.bucket + ':' + Number(t.pct).toFixed(2)).join('|');
  return {
    id: String(id),
    type: 'guild',
    quality: 'exact',
    title: String(id),
    treatments,
    overrideIdCount: ovCount,
    populationCount: pops.length,
    fingerprint,
    revision,
    hash: Number(hash),
    recent: isRecent(id),
    source: 'discord',
    hasGlobalPct: treatments.some((t) => t.pct != null && Number.isFinite(t.pct)),
  };
}

async function buildHashMap() {
  const map = new Map();
  const addId = (id) => {
    if (!id || typeof id !== 'string') return;
    const clean = id.trim();
    if (!clean || clean.startsWith('hash:')) return;
    const h = murmur3(clean);
    map.set(h, clean);
    map.set(String(h), clean);
  };
  for (const file of [
    LOCAL_EXP,
    KNOWN_EXP,
    path.join(DATA_DIR, 'apex_experiments.json'),
    path.join(DATA_DIR, 'baseline_experiments.json'),
  ]) {
    try {
      if (!(await fs.pathExists(file))) continue;
      const data = await fs.readJson(file);
      const list = Array.isArray(data)
        ? data
        : data.experiments || data.ids || (typeof data === 'object' ? Object.keys(data) : []);
      for (const x of list) {
        if (typeof x === 'string') addId(x);
        else if (x && (x.id || x.name)) addId(String(x.id || x.name));
      }
    } catch (_) {}
  }
  console.log('Hash map (fichiers locaux):', Math.floor(map.size / 2), 'ids');
  return map;
}

function clientHeaders(token) {
  const superProps = Buffer.from(
    JSON.stringify({
      os: 'Windows',
      browser: 'Chrome',
      device: '',
      system_locale: 'en-US',
      browser_user_agent: DEFAULT_UA,
      browser_version: '131.0.0.0',
      os_version: '10',
      release_channel: 'stable',
      client_build_number: 360000,
    }),
  ).toString('base64');
  const h = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    'X-Super-Properties': superProps,
    'X-Discord-Locale': 'en-US',
  };
  if (token) h.Authorization = token;
  return h;
}

/**
 * Lit les guild_experiments du wire Discord.
 * Retourne { experiments, okResponses, failedResponses } : l'appelant DOIT
 * distinguer « Discord a répondu une collection vide » de « aucune réponse »
 * (panne réseau, 401, 429, HTML Cloudflare). Avant, les deux donnaient [] →
 * toutes les expériences suivies étaient notifiées « retirées », puis
 * « nouvelles » au run suivant.
 */
async function fetchDiscordGuild(hashMap, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const wait = deps.sleep || sleep;
  const rounds = deps.fetchRounds || FETCH_ROUNDS;
  const tokenList = Array.isArray(deps.tokens) ? deps.tokens : USER_TOKENS;
  const urls = [
    'https://canary.discord.com/api/v9/experiments?with_guild_experiments=true',
    'https://discord.com/api/v9/experiments?with_guild_experiments=true',
  ];
  const tokens = tokenList.length ? tokenList : [null];
  console.log('User tokens:', tokenList.length);
  const byId = new Map();
  // v8 : jetons interrogés en PARALLÈLE (avant : en série, jusqu'à 5×2
  // requêtes de 25 s) ; canary d'abord (le plus frais), stable en repli.
  // v9 : une 2e passe après une courte pause si les deux URL échouent
  // (coupure réseau brève, 5xx, 429) ; 401/403 = jeton mort, pas de 2e passe.
  const one = async (token) => {
    for (let round = 0; round < rounds; round++) {
      let authDead = 0;
      for (const url of urls) {
        try {
          const res = await fetchImpl(url, { headers: clientHeaders(token), timeout: 12000 });
          if (!res.ok) {
            console.warn('Discord', res.status, url.includes('canary') ? 'canary' : 'stable');
            if (res.status === 401 || res.status === 403) authDead++;
            continue;
          }
          const data = await safeJson(res);
          if (!data || !Array.isArray(data.guild_experiments)) {
            console.warn('Discord: réponse sans guild_experiments', url.includes('canary') ? 'canary' : 'stable');
            continue;
          }
          return data.guild_experiments;
        } catch (e) {
          console.warn('Discord fail', e && e.message);
        }
      }
      if (authDead === urls.length) break;
      if (round < rounds - 1) await wait(FETCH_RETRY_MS * (round + 1));
    }
    return null;
  };
  const results = await Promise.all(tokens.slice(0, 5).map(one));
  let okResponses = 0;
  for (const ge of results) {
    if (!ge) continue;
    okResponses++;
    console.log('Discord guild_experiments:', ge.length);
    for (const t of ge) {
      let e = null;
      try {
        e = decodeGuildWire(t, hashMap);
      } catch (err) {
        console.warn('decodeGuildWire: tuple illisible ignoré', String((err && err.message) || err).slice(0, 80));
      }
      if (e && e.hasGlobalPct && !String(e.id).startsWith('hash:')) byId.set(e.id, e);
    }
  }
  return { experiments: [...byId.values()], okResponses, failedResponses: results.length - okResponses };
}

function pctKey(e) {
  return (Array.isArray(e && e.treatments) ? e.treatments : [])
    .filter((t) => t && t.pct != null && Number.isFinite(Number(t.pct)))
    .map((t) => t.bucket + ':' + Number(t.pct).toFixed(2))
    .sort()
    .join('|');
}

function diffExperiments(prev, next) {
  const pMap = new Map(
    (Array.isArray(prev) ? prev : [])
      .filter((e) => e && e.id)
      .map((e) => [e.id, e]),
  );
  const nMap = new Map(
    (Array.isArray(next) ? next : [])
      .filter((e) => e && e.id)
      .map((e) => [e.id, e]),
  );
  const added = [],
    removed = [],
    changed = [];
  for (const [id, n] of nMap) {
    if (!n.hasGlobalPct || String(id).startsWith('hash:')) continue;
    const treatments = (Array.isArray(n.treatments) ? n.treatments : []).filter(
      (t) => t && t.pct != null,
    );
    if (!treatments.length) continue;
    const p = pMap.get(id);
    if (!p) {
      added.push(n);
      continue;
    }
    const deltas = [];
    const pt = new Map(
      (Array.isArray(p.treatments) ? p.treatments : []).map((t) => [
        String(t.bucket ?? t.label),
        t,
      ]),
    );
    let maxAbs = 0;
    const seen = new Set();
    const finite = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);
    for (const t of treatments) {
      const k = String(t.bucket ?? t.label);
      seen.add(k);
      const old = pt.get(k);
      const from = old ? finite(old.pct) : 0;
      const to = finite(t.pct);
      const d = Math.round((to - from) * 100) / 100;
      if (Math.abs(d) >= MIN_DELTA) {
        deltas.push({ label: t.label, bucket: t.bucket, from, to, delta: d });
        maxAbs = Math.max(maxAbs, Math.abs(d));
      }
    }
    // Bucket présent avant et ABSENT maintenant = retombé à 0 %. Avant, seuls
    // les buckets encore présents étaient comparés : le retrait d'une variante
    // (ex. Variant 2 : 10 % → plus rien) n'était jamais notifié.
    for (const [k, old] of pt) {
      if (seen.has(k) || !old) continue;
      const from = finite(old.pct);
      const d = Math.round((0 - from) * 100) / 100;
      if (Math.abs(d) >= MIN_DELTA) {
        deltas.push({ label: old.label || tLabel(old.bucket), bucket: old.bucket, from, to: 0, delta: d, dropped: true });
        maxAbs = Math.max(maxAbs, Math.abs(d));
      }
    }
    if (deltas.length) changed.push({ after: n, deltas, maxAbs });
  }
  for (const [id, p] of pMap) {
    if (!nMap.has(id) && p.hasGlobalPct && !String(id).startsWith('hash:')) removed.push(p);
  }
  changed.sort((a, b) => b.maxAbs - a.maxAbs);
  return { added, changed, removed };
}

function pctBar(pct, width = 10) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const full = Math.round((p / 100) * width);
  return '▰'.repeat(full) + '▱'.repeat(width - full);
}

function fmtP(p) {
  return Number(p).toFixed(2).replace('.', ',') + ' %';
}

function fmtTreat(ts, max = 12) {
  const lines = (ts || [])
    .slice(0, max)
    .map((t) => '`' + pctBar(t.pct) + '` **' + fmtP(t.pct) + '** · ' + (t.label || 'Bucket ' + t.bucket));
  if ((ts || []).length > max) lines.push('_+' + (ts.length - max) + ' autre(s)_');
  return lines.join('\n') || '_—_';
}

function nowStamp() {
  return '<t:' + Math.floor(Date.now() / 1000) + ':R>';
}

function buildEmbeds(diff) {
  const embeds = [];
  for (const e of diff.added.slice(0, 10)) {
    embeds.push({
      title: '🆕 Nouveau rollout serveur — ' + e.id,
      description: [fmtTreat(e.treatments), '', '🏠 Serveurs · ✅ % exact (wire Discord) · détecté ' + nowStamp()]
        .join('\n')
        .slice(0, 4000),
      color: 0x57f287,
      footer: { text: 'Rollouts serveurs · révision ' + (e.revision ?? '?') + ' · ' + (e.source || 'discord') },
    });
  }
  for (const c of diff.changed.slice(0, 10)) {
    const e = c.after;
    const up = c.deltas.some((d) => d.delta > 0);
    const down = c.deltas.some((d) => d.delta < 0);
    const lines = c.deltas.slice(0, 12).map(
      (d) =>
        (d.delta > 0 ? '📈' : '📉') + ' **' + (d.label || 'bucket') + '** · ' + fmtP(d.from) + ' → **' + fmtP(d.to) + '** (`' +
        (d.delta > 0 ? '+' : '') + Number(d.delta).toFixed(2).replace('.', ',') + ' pt`)\n`' + pctBar(d.to) + '`',
    );
    embeds.push({
      title: (up && !down ? '📈 Montée' : down && !up ? '📉 Baisse' : '🔀 Changement') + ' de rollout serveur — ' + e.id,
      description: [lines.join('\n'), '', '🏠 Serveurs · ✅ % exact (wire Discord) · détecté ' + nowStamp()]
        .join('\n')
        .slice(0, 4000),
      color: up && !down ? 0x57f287 : down && !up ? 0xe67e22 : 0x5865f2,
      footer: { text: 'Rollouts serveurs · Δ max ' + Number(c.maxAbs).toFixed(2).replace('.', ',') + ' pt · révision ' + (e.revision ?? '?') },
    });
  }
  for (const e of diff.removed.slice(0, 10)) {
    embeds.push({
      title: '🗑️ Rollout serveur retiré — ' + e.id,
      description: 'Dernier état connu :\n' + fmtTreat(e.treatments) + '\n\n🏠 Serveurs · détecté ' + nowStamp(),
      color: 0xed4245,
      footer: { text: 'Rollouts serveurs · retiré du wire Discord' },
    });
  }
  return embeds.slice(0, 10);
}

async function postWebhook(embeds) {
  if (!WEBHOOK || !embeds.length) return { ok: false, status: 0, text: 'skip' };
  for (;;) {
    const r = await sendEmbeds(
      WEBHOOK,
      { username: BOT.slice(0, 80), avatar_url: AVATAR },
      embeds,
      { identity: 'apex', label: 'apex', withDismiss: true },
    );
    const idx = WEBHOOKS.indexOf(WEBHOOK);
    // 404 au 1er message seulement (rien de posté) → on rejoue tout sur la webhook suivante
    if (!r.ok && r.status === 404 && !r.sent && idx >= 0 && idx + 1 < WEBHOOKS.length) {
      console.warn('apex webhook 404 (supprimée) → bascule sur la webhook de secours');
      WEBHOOK = WEBHOOKS[idx + 1];
      continue;
    }
    return r;
  }
}

/**
 * deps (tests) : stateFile, hashMap, fetchGuild, fetch, tokens, sleep,
 * postWebhook, exit. En production aucun deps → comportement inchangé.
 */
async function main(deps = {}) {
  const STATE_FILE = deps.stateFile || DEFAULT_STATE_FILE;
  const post = deps.postWebhook || postWebhook;
  const hasWebhook = deps.postWebhook ? true : !!WEBHOOK;
  // exit injectable : en prod process.exit ; en test on récupère le code.
  const fail = (code, reason) => {
    (deps.exit || ((c) => process.exit(c)))(code);
    return { ok: false, code, reason };
  };
  await fs.ensureDir(path.dirname(STATE_FILE));
  console.log('📊 Apex rollouts v9 (EXACT guild % · jetons en parallèle · garde panne réseau)');
  console.log('Webhook:', hasWebhook ? 'set' : 'MISSING');
  console.log('Tokens:', (deps.tokens || USER_TOKENS).length);

  const hashMap = deps.hashMap || (await buildHashMap());
  const fetched = await (deps.fetchGuild || fetchDiscordGuild)(hashMap, deps);
  const fromDiscord = (fetched && fetched.experiments) || [];
  const okResponses = fetched ? Number(fetched.okResponses) || 0 : 0;
  // AUCUNE réponse exploitable (réseau, 401, 429, HTML) : ce n'est PAS une
  // collection vide. On ne touche ni à l'état ni aux notifications.
  if (!okResponses) {
    console.error('APEX_FETCH_FAILED: aucune réponse Discord exploitable — état conservé, aucune notification');
    return fail(1, 'fetch_failed');
  }
  const byId = new Map();
  for (const e of fromDiscord) {
    if (!e || !e.id || !e.hasGlobalPct) continue;
    if (String(e.id).startsWith('hash:')) continue;
    byId.set(e.id, e);
  }
  const experiments = [...byId.values()];
  console.log('Live exact (wire Discord):', experiments.length, '· réponses OK:', okResponses);

  let previous = { experiments: [], announced: {} };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (_) {}
  }
  // État illisible (null, tableau, chaîne) : on repart d'un état vide au lieu
  // de planter sur previous.announced.
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
    previous = { experiments: [], announced: {} };
  }
  const announced =
    previous.announced &&
    typeof previous.announced === 'object' &&
    !Array.isArray(previous.announced)
      ? { ...previous.announced }
      : {};
  const prev = Array.isArray(previous.experiments) ? previous.experiments : [];
  const isFirst = !prev.length;

  if (!isFirst && prev.length >= 20 && experiments.length < Math.max(5, prev.length * 0.4)) {
    console.error('APEX_DEGRADED: collection too small vs previous', {
      prev: prev.length,
      now: experiments.length,
    });
    return fail(1, 'degraded');
  }
  // Collection VIDE alors qu'on en suivait : presque toujours une réponse
  // dégradée (jeton rétrogradé, wire tronqué), pas « tout a été retiré ».
  // La garde ci-dessus ne couvrait que prev >= 20 (l'état réel en a souvent < 20).
  // Un vide CONFIRMÉ sur EMPTY_CONFIRM runs consécutifs est accepté (vrai retrait
  // global) : sinon le tracker resterait bloqué en échec pour toujours.
  if (!isFirst && !experiments.length) {
    const streak = (Number(previous.emptyStreak) || 0) + 1;
    if (streak < EMPTY_CONFIRM) {
      try {
        await writeJsonAtomic(STATE_FILE, { ...previous, emptyStreak: streak }, 2);
      } catch (_) {}
      console.error('APEX_DEGRADED: collection vide alors que', prev.length, 'expérience(s) étaient suivies — état conservé (' + streak + '/' + EMPTY_CONFIRM + ')');
      return fail(1, 'empty_collection');
    }
    console.warn('Collection vide confirmée ' + streak + ' fois de suite — acceptée');
  }

  const compact = experiments.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    fingerprint: pctKey(e),
    treatments: (e.treatments || [])
      .filter((t) => t && t.pct != null)
      .map((t) => ({ bucket: t.bucket, label: t.label, pct: Math.round(Number(t.pct) * 100) / 100 })),
    revision: e.revision,
    recent: !!e.recent,
    hash: e.hash,
    source: e.source,
    hasGlobalPct: true,
    quality: 'exact',
  }));
  const compactById = new Map(compact.map((e) => [e.id, e]));

  // V14 : ackExperiments = dernière collection NOTIFIÉE avec succès. Un
  // échec de webhook ne perd plus les changements (l'ancien code sauvait la
  // nouvelle collection avant l'envoi → au run suivant, plus de diff).
  let ackList = Array.isArray(previous.ackExperiments)
    ? previous.ackExperiments.slice()
    : null;
  const ackMapFrom = (list) =>
    new Map(
      (Array.isArray(list) ? list : [])
        .filter((e) => e && e.id)
        .map((e) => [e.id, e]),
    );

  async function writeState(announcedMap, ackExperiments) {
    await writeJsonAtomic(
      STATE_FILE,
      {
        scrapedAt: new Date().toISOString(),
        count: compact.length,
        experiments: compact,
        announced: announcedMap,
        ackExperiments: ackExperiments != null ? ackExperiments : undefined,
        pctPrecision: PCT_PRECISION,
      },
      2,
    );
  }

  // Migration 0,1 → 0,01 pt : une expérience dont l'ancien % (arrondi au
  // dixième) correspond au nouveau % arrondi au dixième n'a PAS bougé → on
  // remplace silencieusement son ack par la valeur précise (aucune fausse
  // notif). Les vrais changements gardent l'ancien ack et sont notifiés.
  if (ackList && previous.pctPrecision !== PCT_PRECISION) {
    const r1 = (e) => pctKey({ treatments: (e.treatments || []).map((t) => ({ ...t, pct: t.pct == null ? null : Math.round(Number(t.pct) * 10) / 10 })) });
    const ann = announced;
    ackList = ackList.map((old) => {
      const cur = compactById.get(old.id);
      if (cur && r1(cur) === r1(old)) {
        if (ann[old.id] && ann[old.id] !== 'REMOVED') ann[old.id] = cur.fingerprint;
        return cur;
      }
      return old;
    });
    console.log('Migration précision % → 0,01 pt (silencieuse)');
  }

  // Premier run OU migration (< ackExperiments) : seed silencieux.
  if (isFirst || ackList == null) {
    const seedAnn = { ...announced };
    for (const e of compact) {
      if (e.id && e.fingerprint) seedAnn[e.id] = e.fingerprint;
    }
    await writeState(seedAnn, compact);
    console.log('Seed', compact.length, '- no notify');
    return { ok: true, seeded: compact.length };
  }

  // Diff contre la dernière collection NOTIFIÉE (pas contre la dernière
  // mesure) — un échec de webhook laisse le diff intact pour le run suivant.
  const ackMap = ackMapFrom(ackList);
  let diff = diffExperiments(ackList, experiments);
  const filter = (arr, getId, getKey) =>
    arr.filter((x) => {
      const id = getId(x);
      const key = getKey(x);
      if (!id || !key) return false;
      if (announced[id] === key) return false;
      return true;
    });
  diff = {
    added: filter(diff.added, (e) => e.id, (e) => pctKey(e)),
    changed: filter(diff.changed, (c) => c.after && c.after.id, (c) => pctKey(c.after)),
    removed: diff.removed.filter((e) => e && e.id && announced[e.id] !== 'REMOVED'),
  };

  console.log('Diff', {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
  });

  const changes = [
    ...diff.added.map((e) => ({ kind: 'added', e })),
    ...diff.changed.map((c) => ({ kind: 'changed', e: c.after, deltas: c.deltas, maxAbs: c.maxAbs })),
    ...diff.removed.map((e) => ({ kind: 'removed', e })),
  ];

  if (!changes.length) {
    await writeState(announced, ackList);
    console.log('No significant % change');
    return { ok: true, changes: 0, delivered: 0 };
  }

  if (!hasWebhook) {
    await writeState(announced, ackList);
    console.warn('No webhook - state saved without advancing acknowledged');
    return fail(2, 'webhook_missing');
  }

  // V14 : envoi par lots de 10 embeds ; ackExperiments n'avance que pour les
  // lots réellement livrés (fin sur échec → exit 2, retry au run suivant).
  const EMBED_BATCH = 10;
  let sendFailed = false;
  let delivered = 0;
  for (let i = 0; i < changes.length; i += EMBED_BATCH) {
    const chunk = changes.slice(i, i + EMBED_BATCH);
    const part = {
      added: chunk.filter((c) => c.kind === 'added').map((c) => c.e),
      changed: chunk.filter((c) => c.kind === 'changed').map((c) => ({ after: c.e, deltas: c.deltas, maxAbs: c.maxAbs })),
      removed: chunk.filter((c) => c.kind === 'removed').map((c) => c.e),
    };
    const embeds = buildEmbeds(part);
    if (!embeds.length) {
      delivered += chunk.length;
      continue;
    }
    let sent;
    try {
      sent = await post(embeds);
    } catch (e) {
      // Une exception d'envoi vaut échec : acknowledged n'avance pas (retry).
      sent = { ok: false, status: 0, text: String((e && e.message) || e).slice(0, 120) };
    }
    if (!sent || typeof sent !== 'object') sent = { ok: false, status: 0, text: 'réponse webhook vide' };
    console.log('Webhook lot', Math.floor(i / EMBED_BATCH) + 1, sent.status, sent.ok ? 'OK' : sent.text);
    if (!sent.ok) {
      sendFailed = true;
      break;
    }
    delivered += chunk.length;
    for (const c of chunk) {
      const e = c.e;
      if (!e || !e.id) continue;
      if (c.kind === 'removed') {
        ackMap.delete(e.id);
        announced[e.id] = 'REMOVED';
      } else {
        const ce = compactById.get(e.id);
        if (ce) {
          ackMap.set(e.id, ce);
          announced[e.id] = ce.fingerprint;
        }
      }
    }
    ackList = [...ackMap.values()];
    await writeState(announced, ackList);
  }

  if (sendFailed) {
    console.warn('Webhook failed - acknowledged avancé pour les ' + delivered + ' changements livrés seulement (retry au prochain run)');
    return fail(2, 'webhook_failed');
  }
  console.log('Done - ' + delivered + ' changements notifiés');
  return { ok: true, changes: changes.length, delivered };
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
module.exports = { main, decodeGuildWire, rangesToPct, murmur3, buildEmbeds, pctBar, fetchDiscordGuild, diffExperiments, pctKey, envPositive };
