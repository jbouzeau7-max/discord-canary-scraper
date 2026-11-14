'use strict';

/**
 * Pings de rôles intelligents.
 *
 * - Experiments (ajoutés / modifiés / supprimés) : ping à chaque notification
 *   (1re partie de chaque section uniquement, pas les « suite »).
 * - Quêtes : ping à chaque nouvelle quête.
 * - Déploiements (pourcentages) : ping modéré — uniquement les changements
 *   significatifs (nouveau rollout, 100 %, 0 %, |Δ| ≥ seuil) + délai minimal.
 * - Strings / Routes : ping rare — seuil minimal d'éléments + délai long
 *   entre deux pings d'un même rôle (état persisté dans data/cache/ping_state.json).
 *
 * Toute notification part avec allowed_mentions explicite : seuls les rôles
 * listés peuvent pinger (jamais @everyone / @here / utilisateurs).
 *
 * Env :
 *   PING_DISABLE=1              désactive tous les pings
 *   PING_ROLE_<CLE>=<id>        remplace l'ID d'un rôle (ex. PING_ROLE_QUESTS)
 *   PING_STRINGS_COOLDOWN_H     délai entre 2 pings Strings (défaut 6)
 *   PING_ROUTES_COOLDOWN_H      délai entre 2 pings Routes (défaut 6)
 *   PING_ROLLOUTS_COOLDOWN_MIN  délai entre 2 pings déploiements (défaut 60)
 *   PING_ROLLOUTS_MIN_DELTA     Δ minimal en points pour pinger (défaut 5)
 *   PING_STATE_DIR              dossier de l'état des délais
 */
const fs = require('fs');
const path = require('path');

const H = 3600 * 1000;

function num(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

const DEFAULT_ROLES = Object.freeze({
  EXP_ADDED: '1569711030718693396',
  EXP_MODIFIED: '1569711177561284618',
  EXP_REMOVED: '1569711113304543345',
  STR_ADDED: '1569711339197304982',
  STR_MODIFIED: '1569711452187529246',
  STR_REMOVED: '1569711391978430646',
  ROUTE_ADDED: '1569711585784635492',
  ROUTE_REMOVED: '1569711925494026280',
  QUESTS: '1569711825627516938',
  ROLLOUTS: '1440702716677722202',
});

function roleId(key) {
  const v = process.env['PING_ROLE_' + key];
  if (v != null && v !== '') return /^\d{15,25}$/.test(v) ? v : null;
  return DEFAULT_ROLES[key] || null;
}

/** Politique par rôle : group = fichier d'état, minCount = seuil, cooldown. */
function policy(key) {
  const strCd = num('PING_STRINGS_COOLDOWN_H', 6) * H;
  const rtCd = num('PING_ROUTES_COOLDOWN_H', 6) * H;
  const roCd = num('PING_ROLLOUTS_COOLDOWN_MIN', 60) * 60 * 1000;
  switch (key) {
    case 'EXP_ADDED':
    case 'EXP_MODIFIED':
    case 'EXP_REMOVED':
    case 'QUESTS':
      return { cooldownMs: 0, minCount: 1 };
    case 'STR_ADDED':
      return { group: 'build', cooldownMs: strCd, minCount: num('PING_STRINGS_MIN_ADDED', 3) };
    case 'STR_MODIFIED':
      return { group: 'build', cooldownMs: strCd, minCount: num('PING_STRINGS_MIN_MODIFIED', 5) };
    case 'STR_REMOVED':
      return { group: 'build', cooldownMs: strCd, minCount: num('PING_STRINGS_MIN_REMOVED', 3) };
    case 'ROUTE_ADDED':
    case 'ROUTE_REMOVED':
      return { group: 'build', cooldownMs: rtCd, minCount: 1 };
    case 'ROLLOUTS':
      return { group: 'rollouts', cooldownMs: roCd, minCount: 1 };
    default:
      return null;
  }
}

function stateFile(group) {
  // Rollouts : état temporaire du job (rollouts_fast lance plusieurs scripts
  // dans le même runner ; pas besoin de commit).
  if (group === 'rollouts' && !process.env.PING_STATE_DIR) return path.join(require('os').tmpdir(), 'dcs_ping_state_rollouts.json');
  const dir =
    process.env.PING_STATE_DIR ||
    (process.env.NOTIFY_DEDUPE_FILE ? path.dirname(process.env.NOTIFY_DEDUPE_FILE) : null) ||
    // Sous node --test : jamais l'état réel du dépôt
    (process.env.NODE_TEST_CONTEXT ? path.join(require('os').tmpdir(), 'dcs-ping-test-' + process.pid) : null) ||
    // data/cache est déjà commité par le workflow scrape → délais conservés
    path.join(__dirname, '..', '..', 'data', 'cache');
  return path.join(dir, group === 'build' ? 'ping_state.json' : `ping_state_${group}.json`);
}

function readState(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' && d.last && typeof d.last === 'object' ? d : { last: {} };
  } catch {
    return { last: {} };
  }
}

function writeState(file, d) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('ping state save fail', e.message);
  }
}

/**
 * Décide si un rôle doit être pingé maintenant (et réserve le délai).
 * @returns {string|null} ID du rôle à pinger, ou null.
 */
function claimPing(key, { count = 1, significant = true, now = Date.now() } = {}) {
  if (process.env.PING_DISABLE === '1') return null;
  const id = roleId(key);
  const p = policy(key);
  if (!id || !p || !significant) return null;
  if (!(Number(count) >= p.minCount)) return null;
  if (!p.cooldownMs || !p.group) return id;
  const file = stateFile(p.group);
  const st = readState(file);
  const last = Number(st.last[key] || 0);
  if (last && now - last < p.cooldownMs) {
    console.log('ping skip (cooldown)', key);
    return null;
  }
  st.last[key] = now;
  writeState(file, st);
  return id;
}

/** allowed_mentions strict : seuls les rôles fournis peuvent pinger. */
function allowedMentions(roleIds = []) {
  const roles = [...new Set((roleIds || []).filter(Boolean).map(String))].slice(0, 100);
  return roles.length ? { parse: [], roles } : { parse: [] };
}

function mentionText(roleIds = []) {
  return [...new Set((roleIds || []).filter(Boolean))].map((id) => `<@&${id}>`).join(' ');
}

/** Rollout « significatif » : nouveau, retiré, 100 %, 0 % ou |Δ| ≥ seuil. */
function isSignificantRollout({ kind, deltas = [], deltaPct = null } = {}) {
  if (kind === 'new' || kind === 'added' || kind === 'removed') return true;
  const min = num('PING_ROLLOUTS_MIN_DELTA', 5);
  const list = [...(deltas || [])];
  if (deltaPct != null) list.push({ delta: deltaPct });
  return list.some((d) => {
    const delta = d.delta != null ? Number(d.delta) : Number(d.to) - Number(d.from);
    if (d.to != null && (Number(d.to) >= 100 || Number(d.to) <= 0) && Number(d.to) !== Number(d.from)) return true;
    return Number.isFinite(delta) && Math.abs(delta) >= min;
  });
}

/** Texte brut d'une liste d'embeds / composants (pour l'analyse). */
function flatText(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => flatText(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'url' && k !== 'avatar_url') flatText(x, out);
  return out;
}

/** Δ en points détectés dans un texte (« +12,00 pt », « -3,5 pts »). */
function textDeltas(text) {
  const out = [];
  for (const m of String(text).matchAll(/([+-−]\s?\d+(?:[.,]\d+)?)\s?pts?\b/g)) {
    const v = Number(m[1].replace('−', '-').replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(v)) out.push({ delta: v });
  }
  return out;
}

/**
 * Rôles à pinger automatiquement selon l'identité du message
 * (experiments, strings, routes, quêtes, déploiements).
 */
const SECTION_KEYS = {
  experiments: { add: 'EXP_ADDED', mod: 'EXP_MODIFIED', rem: 'EXP_REMOVED', cat: 'EXP_MODIFIED' },
  strings: { add: 'STR_ADDED', mod: 'STR_MODIFIED', rem: 'STR_REMOVED' },
  routes: { add: 'ROUTE_ADDED', rem: 'ROUTE_REMOVED' },
};

/**
 * Experiments / Strings / Routes : 1 section par message (notify.js). Le
 * libellé du 1er champ (« Ajoutées · 12 ») donne le type et le nombre ; les
 * messages « suite » n'ont pas de libellé → jamais de ping.
 */
function sectionPing(identity, embeds) {
  const map = SECTION_KEYS[identity];
  const e = (embeds || [])[0];
  if (!map || !e || / · suite \d+/.test(String(e.title || ''))) return [];
  const lbl = String((e.fields && e.fields[0] && e.fields[0].name) || '');
  const m = lbl.match(/^(Ajouté|Modifié|Supprimé|Catégorie changée)\S*\s*·\s*(\d+)/);
  if (!m) return [];
  const kind = m[1].startsWith('Ajout') ? 'add' : m[1].startsWith('Modif') ? 'mod' : m[1].startsWith('Suppr') ? 'rem' : 'cat';
  const key = map[kind];
  if (!key) return [];
  const r = claimPing(key, { count: Number(m[2]) });
  return r ? [r] : [];
}

function autoPingRoles(identity, embeds, components) {
  try {
    if (SECTION_KEYS[identity]) return sectionPing(identity, embeds);
    if (identity === 'quests') {
      const text = flatText([embeds, components]).join('\n');
      if (/Expirée|Aperçu \(preview\)/.test(text)) return [];
      const r = claimPing('QUESTS');
      return r ? [r] : [];
    }
    if (identity === 'apex' || identity === 'gistRollouts' || identity === 'userRollouts') {
      const text = flatText([embeds, components]).join('\n');
      const kind = /Nouveau rollout|Nouvelle expérience|Rollout serveur retiré|retirée du gist/i.test(text) ? 'new' : 'changed';
      const deltas = textDeltas(text);
      // 100 % / 0 % atteints (« → **100,00 %** »)
      const full = /→\s*\**\s*(?:100(?:[.,]0+)?|0(?:[.,]0+)?)\s?%/.test(text);
      if (!full && !isSignificantRollout({ kind, deltas })) return [];
      const r = claimPing('ROLLOUTS');
      return r ? [r] : [];
    }
  } catch (e) {
    console.warn('autoPing fail', e.message);
  }
  return [];
}

module.exports = {
  autoPingRoles,
  textDeltas,
  DEFAULT_ROLES,
  roleId,
  policy,
  claimPing,
  allowedMentions,
  mentionText,
  isSignificantRollout,
  stateFile,
};
