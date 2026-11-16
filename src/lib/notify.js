/**
 * Datamining — notify (classic embeds only — reliable on all webhooks)
 * - No backticks around keys
 * - Strings: phrase only (no hash key) · Routes: key + path
 * - Mise en avant : le contenu le plus important de chaque section en
 *   bloc de code, la liste complète derrière
 * - Batch dedupe marked ONLY after successful webhook post
 * - Présentation : titre « Routes · Build N », listes en blocs ```diff
 *   (+ vert / - rouge), libellés en français, pied de page horodaté
 */
const { sendEmbeds } = require('./webhook');
const { DEFAULT_BOT_NAME, DEFAULT_AVATAR_URL } = require('./utils');

const BOT = process.env.WEBHOOK_BOT_NAME || DEFAULT_BOT_NAME;
const AVATAR = process.env.WEBHOOK_AVATAR_URL || DEFAULT_AVATAR_URL;

const {
  markPosted,
  markFailed,
  claimState,
  sentSet,
  markPostedMany,
  markFailedMany,
  claimMany,
  payloadFingerprint,
  stableExpKey,
  stableExpEventKey,
  stableMapKey,
} = require('./webhook_dedupe');

const COLOR = {
  build: 0x5865f2,
  added: 0x57f287,
  modified: 0xe67e22,
  removed: 0xed4245,
};

// Aucun emoji dans les messages (titres et libellés en texte brut).
function label(_emoji, text) {
  return text;
}
const E = {};

const FIELD_MAX = 1020;
// Components V2 : un TextDisplay accepte 4000 caractères et la somme des
// TextDisplay d'un message est plafonnée à ~4000. Un champ de 3750 (fences,
// titre et pied de page compris) tient donc dans UN message, alors qu'un
// bloc de 5 champs de 1020 (5100) était découpé en DEUX messages : ~30 % de
// requêtes en moins pour les gros diffs (et autant de temps gagné, Discord
// limitant le débit des webhooks).
const COMPONENT_FIELD_MAX = (() => {
  const n = Number(process.env.NOTIFY_FIELD_MAX_CHARS);
  return Number.isFinite(n) && n >= 1020 && n <= 3800 ? Math.floor(n) : 3750;
})();
const LINE_VAL_MAX = 240;
const LINE_VAL_ROUTES = 100;
// Plus de troncature silencieuse : tout est envoyé (découpé en plusieurs messages)
// Aucun plafond par défaut : chaque élément du diff est envoyé (sinon le
// surplus était enregistré comme « vu » et jamais notifié).
const capEnv = (name) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
};
const MAX_STR_LINES = capEnv('NOTIFY_MAX_STR_LINES');
const MAX_RT_LINES = capEnv('NOTIFY_MAX_RT_LINES');
const MAX_EXP_LINES = capEnv('NOTIFY_MAX_EXP_LINES');

/**
 * Réserve une clé de lot. 'sent' → déjà livré (succès), 'pending' → un autre
 * envoi est en cours ou a été interrompu : on retourne ÉCHEC pour que l'état
 * n'avance pas (avant : succès → le lot n'était jamais envoyé).
 */
async function claimBatch(key, what) {
  const st = await claimState(key);
  if (st === 'claimed') return null;
  console.log(what, 'batch CLAIM skip', st, key);
  return st === 'sent';
}

// Seuil en dessous duquel une section part entièrement en un seul bloc.
const HIGHLIGHT_COUNT = 5;

async function notifyAll(opts) {
  const [a, b] = await Promise.all([notifyUrgent(opts), notifyNormal(opts)]);
  return a && b;
}

async function notifyUrgent({ build, expDiff, webhookUrl, scope }) {
  if (!webhookUrl) return true;
  const bn = String(build.buildNumber || '?');
  const ts = new Date().toISOString();
  const exp = normalizeExpDiff(expDiff);
  const nExp =
    exp.added.length +
    exp.modified.length +
    exp.removed.length +
    (exp.categoryChanged || []).length;
  if (!nExp) {
    console.log('Urgent: no experiment diff');
    return true;
  }
  return sendExperiments(webhookUrl, bn, exp, ts, scope);
}

async function notifyNormal({ build, strDiff, rtDiff, webhookUrl, scope }) {
  if (!webhookUrl) return true;
  const bn = String(build.buildNumber || '?');
  const ts = new Date().toISOString();
  const str = normalizeMapDiff(strDiff);
  const rt = normalizeMapDiff(rtDiff);
  const nStr =
    Object.keys(str.added).length +
    Object.keys(str.modified).length +
    Object.keys(str.removed).length;
  const nRt =
    Object.keys(rt.added).length +
    Object.keys(rt.modified).length +
    Object.keys(rt.removed).length;
  let ok = true;
  const promises = [];
  if (nStr)
    promises.push(
      sendMapDiff(webhookUrl, bn, str, ts, 'Strings', scope).then((r) => {
        if (!r) ok = false;
      }),
    );
  if (nRt)
    promises.push(
      sendMapDiff(webhookUrl, bn, rt, ts, 'Routes', scope).then((r) => {
        if (!r) ok = false;
      }),
    );
  if (promises.length) await Promise.all(promises);
  return ok;
}

function normalizeExpDiff(diff) {
  if (diff && (diff.added || diff.modified || diff.removed || diff.categoryChanged)) {
    return {
      added: Array.isArray(diff.added) ? diff.added : [],
      modified: Array.isArray(diff.modified) ? diff.modified : [],
      removed: Array.isArray(diff.removed) ? diff.removed : [],
      categoryChanged: Array.isArray(diff.categoryChanged) ? diff.categoryChanged : [],
    };
  }
  return { added: [], modified: [], removed: [], categoryChanged: [] };
}

function normalizeMapDiff(diff) {
  if (diff && (diff.added || diff.modified || diff.removed)) {
    return {
      added: diff.added && typeof diff.added === 'object' && !Array.isArray(diff.added) ? diff.added : {},
      modified: diff.modified && typeof diff.modified === 'object' && !Array.isArray(diff.modified) ? diff.modified : {},
      removed: diff.removed && typeof diff.removed === 'object' && !Array.isArray(diff.removed) ? diff.removed : {},
    };
  }
  return { added: {}, modified: {}, removed: {} };
}

function cleanText(s, max = LINE_VAL_MAX) {
  const t = String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  // troncature visible (avant : coupée net, sans indication)
  return t.length > max ? t.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : t;
}

// Strings : la phrase seule (pas de clé hash), préfixée +/~/- pour la
// coloration « diff » du bloc de code.
function stringLine(prefix, key, value, maxVal) {
  const v = cleanText(value, maxVal) || String(key || '').replace(/`/g, "'");
  return `${prefix} ${v}`;
}

function routeLine(prefix, key, value) {
  const k = String(key || '').replace(/`/g, "'");
  const v = cleanText(value, LINE_VAL_ROUTES);
  if (!v) return `${prefix} ${k}`;
  return `${prefix} ${k} → ${v}`;
}

/** Auto tags from experiment id (max 5). */
const EXP_TAG_RULES = [
  [/shop|store|collectible|sku/i, 'shop'],
  [/nitro|premium|subscription|billing|purchase/i, 'nitro'],
  [/marketing|upsell|fatigue|promo|incentive/i, 'marketing'],
  [/voice|rtc|audio|call|stage|go.?live|stream/i, 'voice'],
  [/video|camera|clips/i, 'video'],
  [/member.?list|guild.?list|tooltip/i, 'member-list'],
  [/profile|display.?name|avatar|banner|nameplate|decor/i, 'profile'],
  [/server.?tag|clan.?tag|guild.?tag/i, 'server-tag'],
  [/invite|referral|referr/i, 'invite'],
  [/quest|orb|reward/i, 'quests'],
  [/sticker|emoji|expression/i, 'emoji'],
  [/mobile|ios|android/i, 'mobile'],
  [/web\\b|browser/i, 'web'],
  [/dm\\b|gdm|group.?dm|message/i, 'chat'],
  [/moderat|automod|safety|report/i, 'safety'],
  [/onboard|welcome|tutorial/i, 'onboarding'],
  [/search|discovery|directory/i, 'discovery'],
  [/activity|activities|game|play/i, 'activities'],
  [/notif|toast|badge/i, 'notifications'],
  [/macaron|best.?buy/i, 'promo-partner'],
];

function experimentTags(id) {
  const s = String(id || '');
  const tags = [];
  const seen = new Set();
  for (const [re, tag] of EXP_TAG_RULES) {
    if (re.test(s) && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length >= 5) break;
  }
  return tags;
}

function formatConfigValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return cleanText(v, 48);
  if (typeof v === 'object') return cleanText(JSON.stringify(v), 48);
  return String(v);
}

function formatVariantLine(key, obj) {
  if (!obj || typeof obj !== 'object') return `V${key}`;
  const parts = [];
  for (const k of Object.keys(obj).sort()) {
    if (k === 'id') continue;
    parts.push(`${k}=${formatConfigValue(obj[k])}`);
    if (parts.length >= 5) break;
  }
  if (!parts.length && obj.label) return `V${key} ${cleanText(obj.label, 60)}`;
  if (!parts.length) return `V${key}`;
  return `V${key} ${parts.join(' · ')}`;
}

function getVariationsMap(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.variations && typeof e.variations === 'object' && !Array.isArray(e.variations))
    return e.variations;
  if (Array.isArray(e.treatments)) {
    const out = {};
    e.treatments.forEach((t, i) => {
      out[String(i)] = t && typeof t === 'object' ? t : { value: t };
    });
    return out;
  }
  return null;
}

function formatVariantsBlock(e, maxVariants = 6) {
  const vars = getVariationsMap(e);
  if (!vars) return [];
  const keys = Object.keys(vars).sort(
    (a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)),
  );
  if (!keys.length) return [];
  const lines = [];
  for (const k of keys.slice(0, maxVariants)) lines.push(formatVariantLine(k, vars[k]));
  if (keys.length > maxVariants) lines.push(`… +${keys.length - maxVariants} variants`);
  return lines;
}

function flatConfig(prefix, obj, out, maxKeys = 12) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj).sort()) {
    if (out.length >= maxKeys) {
      out.push('…');
      return;
    }
    out.push(`${prefix}${k}: ${formatConfigValue(obj[k])}`);
  }
}

function computeExpConfigDiff(before, after) {
  const lines = [];
  if (!before || !after) return lines;
  const bl = (before.label || before.title || '').trim();
  const al = (after.label || after.title || '').trim();
  if (bl !== al) lines.push(`label: ${bl || '—'} → ${al || '—'}`);
  const bdc = before.defaultConfig && typeof before.defaultConfig === 'object' ? before.defaultConfig : {};
  const adc = after.defaultConfig && typeof after.defaultConfig === 'object' ? after.defaultConfig : {};
  for (const k of [...new Set([...Object.keys(bdc), ...Object.keys(adc)])].sort()) {
    const bv = bdc[k];
    const av = adc[k];
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    if (bv === undefined) lines.push(`+ defaultConfig.${k}: ${formatConfigValue(av)}`);
    else if (av === undefined) lines.push(`- defaultConfig.${k}: ${formatConfigValue(bv)}`);
    else lines.push(`defaultConfig.${k}: ${formatConfigValue(bv)} → ${formatConfigValue(av)}`);
    if (lines.length >= 14) break;
  }
  const bv = getVariationsMap(before) || {};
  const av = getVariationsMap(after) || {};
  for (const k of [...new Set([...Object.keys(bv), ...Object.keys(av)])].sort(
    (a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)),
  )) {
    if (lines.length >= 18) {
      lines.push('…');
      break;
    }
    const bvo = bv[k];
    const avo = av[k];
    if (bvo == null && avo != null) {
      lines.push(`+ ${formatVariantLine(k, avo)}`);
      continue;
    }
    if (avo == null && bvo != null) {
      lines.push(`- V${k}`);
      continue;
    }
    if (!bvo || !avo) continue;
    for (const ck of [...new Set([...Object.keys(bvo), ...Object.keys(avo)])].sort()) {
      if (ck === 'id') continue;
      if (JSON.stringify(bvo[ck]) === JSON.stringify(avo[ck])) continue;
      if (bvo[ck] === undefined) lines.push(`+ V${k}.${ck}: ${formatConfigValue(avo[ck])}`);
      else if (avo[ck] === undefined) lines.push(`- V${k}.${ck}: ${formatConfigValue(bvo[ck])}`);
      else lines.push(`V${k}.${ck}: ${formatConfigValue(bvo[ck])} → ${formatConfigValue(avo[ck])}`);
      if (lines.length >= 18) break;
    }
  }
  return lines.slice(0, 18);
}

function expLine(e, prefix) {
  const id = typeof e === 'string' ? e : e.id;
  const kind = (e && (e.type || e.kind)) || 'user';
  const system = (e && e.system) || (e && e.treatments ? 'legacy' : 'apex');
  const labelTxt = e && (e.label || e.title) ? cleanText(e.label || e.title, 80) : null;
  let nVar = null;
  if (e && Array.isArray(e.treatments) && e.treatments.length) nVar = e.treatments.length;
  else if (e && e.variations && typeof e.variations === 'object') nVar = Object.keys(e.variations).length;
  else if (e && e.variationCount) nVar = e.variationCount;
  let line = `${prefix} ${id}`;
  const meta = [];
  if (kind) meta.push(kind);
  if (system) meta.push(system);
  if (nVar != null) meta.push(`${nVar} variation${nVar === 1 ? '' : 's'}`);
  let pct = null;
  const k = String(kind || '').toLowerCase();
  if ((k === 'guild' || k === 'server') && e && e.guildPercentage && e.guildPercentage.status !== 'unknown')
    pct = e.guildPercentage;
  else if (k === 'user' && e && e.userPercentage && e.userPercentage.status !== 'unknown') pct = e.userPercentage;
  else if (e && e.guildPercentage && e.guildPercentage.status !== 'unknown') pct = e.guildPercentage;
  else if (e && e.userPercentage && e.userPercentage.status !== 'unknown') pct = e.userPercentage;
  if (pct && pct.value != null) meta.push(`${pct.value}% (${pct.status})`);
  const tags = experimentTags(id);
  if (tags.length) meta.push(tags.map((t) => `#${t}`).join(' '));
  if (labelTxt) line += `\n  « ${labelTxt} »`;
  if (meta.length) line += `\n  ${meta.join(' · ')}`;
  if (prefix === '~' && e && e._before) {
    const diffs = computeExpConfigDiff(e._before, e);
    if (diffs.length) {
      line += '\n' + diffs.map((d) => `  ${d}`).join('\n');
      return line;
    }
  }
  if (e && typeof e === 'object') {
    if (e.defaultConfig && typeof e.defaultConfig === 'object') {
      const dcLines = [];
      flatConfig('', e.defaultConfig, dcLines, 8);
      if (dcLines.length) {
        line += '\n  defaultConfig';
        for (const l of dcLines) line += `\n    ${l}`;
      }
    }
    const vLines = formatVariantsBlock(e, 6);
    if (vLines.length) line += '\n' + vLines.map((v) => `  ${v}`).join('\n');
  }
  return line;
}

function chunkLines(lines, maxLen = FIELD_MAX) {
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + (buf.length ? 1 : 0);
    if (len + add > maxLen && buf.length) {
      chunks.push(buf.join('\n'));
      buf = [line];
      len = line.length;
    } else {
      buf.push(line);
      len += add;
    }
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

// Une ligne peut contenir des backticks triples (textes du client) :
// neutralisés pour ne pas casser la clôture du bloc de code.
function sanitizeCodeLine(s) {
  return String(s || '').replace(/```/g, "'''");
}

// Bloc « diff » : Discord colore les lignes + (vert) et - (rouge).
const FENCE_OPEN = '```diff\n';
const FENCE_CLOSE = '\n```';
const FENCE_LEN = FENCE_OPEN.length + FENCE_CLOSE.length;

function codeBlock(lines) {
  return FENCE_OPEN + lines.join('\n') + FENCE_CLOSE;
}

function discordTime(ts) {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? `<t:${Math.floor(t / 1000)}:f>` : '';
}

function footerText(bn, ts, footerLabel = 'Canary') {
  const when = discordTime(ts);
  const lbl = footerLabel || 'Canary';
  return when ? `${lbl} ${bn} · ${when}` : `${lbl} ${bn}`;
}

/** Construit les embeds d'une section (pur : ni envoi, ni dedupe). */
function sectionEmbeds(sec, { title, bn, ts, maxFieldChars, footerLabel }) {
  const fieldMax = Number.isFinite(maxFieldChars) && maxFieldChars >= 200 ? maxFieldChars : FIELD_MAX;
  // Un embed = un message quand les champs sont grands (>= 1900) : la clé de
  // dedupe reste alors au niveau du message, sans risque de doublon partiel.
  const perEmbed = fieldMax >= 1900 ? 1 : 5;
  if (!sec || !sec.lines || !sec.lines.length) return [];
  const embeds = [];
  // Titre unique « ## Routes · Build 123 » : plus d'auteur, de description
  // ni de pied de page qui répétaient le build (espace perdu).
  const head = `${title} · Build ${bn}`;
  const footer = { text: footerText(bn, ts, footerLabel) };
  const safe = sec.lines.map(sanitizeCodeLine);

  // Petite section (≤ HIGHLIGHT_COUNT entrées qui tiennent en un bloc) :
  // TOUT le contenu part en bloc de code sous le libellé de section.
  if (safe.length <= HIGHLIGHT_COUNT) {
    const joined = safe.join('\n');
    if (joined.length && joined.length + FENCE_LEN <= fieldMax) {
      embeds.push({
        title: head,
        fields: [{ name: sec.label, value: codeBlock([joined]), inline: false }],
        color: sec.color,
        footer,
        timestamp: ts,
      });
      return embeds;
    }
  }

  // Grande section : la liste complète en blocs « diff » colorés.
  const chunks = chunkLines(safe, fieldMax - FENCE_LEN).map((c) => codeBlock([c]));
  const firstCount = perEmbed;
  // Champs de suite sans nom : pas de ligne « … (2) » inutile entre les blocs
  const firstFields = chunks.slice(0, firstCount).map((c, i) => ({
    name: i === 0 ? sec.label : '',
    value: c,
    inline: false,
  }));
  const lastIdx = Math.ceil((chunks.length - firstCount) / perEmbed);
  embeds.push({
    title: head,
    fields: firstFields,
    color: sec.color,
    ...(lastIdx > 0 ? {} : { footer }),
    timestamp: ts,
  });
  let offset = firstCount;
  let part = 2;
  while (offset < chunks.length) {
    const slice = chunks.slice(offset, offset + perEmbed);
    const isLast = offset + perEmbed >= chunks.length;
    embeds.push({
      title: `${title} · Build ${bn} · suite ${part}`,
      fields: slice.map((c) => ({ name: '', value: c, inline: false })),
      color: sec.color,
      ...(isLast ? { footer } : {}),
      timestamp: ts,
    });
    offset += perEmbed;
    part += 1;
  }
  return embeds;
}

async function sendSectionEmbeds({ webhookUrl, title, bn, ts, sections, batchKey, identity, footerLabel }) {
  const items = [];
  for (let si = 0; si < sections.length; si++) {
    // 1 embed par post : chaque message reste sous la limite Discord
    // (4000 caractères de texte par message Components V2)
    // Clé de dedupe unique par (lot, section, partie). Avant : empreinte du
    // contenu tronqué → deux messages « … suite » qui commençaient pareil
    // (ou identiques à un message d'un build précédent < 24 h) étaient
    // considérés comme déjà envoyés et JAMAIS postés.
    const embeds = sectionEmbeds(sections[si], {
      title,
      bn,
      ts,
      maxFieldChars: COMPONENT_FIELD_MAX,
      footerLabel,
    });
    for (let i = 0; i < embeds.length; i++) {
      items.push({
        embed: embeds[i],
        key: batchKey ? `${batchKey}:s${si}:p${i}:${embeds.length}` : null,
      });
    }
  }
  if (!items.length) return true;

  // UNE réservation pour tout le lot : avant, chaque message payait un verrou
  // + une lecture + une réécriture complète du fichier de dedupe AVANT l'envoi
  // (300 messages = 300 écritures de ~100 Ko sur le chemin critique).
  const keys = items.map((it) => it.key).filter(Boolean);
  const claims = keys.length ? await claimMany(keys) : new Map();
  const toSend = [];
  let ok = true;
  for (const it of items) {
    const st = it.key ? claims.get(it.key) : 'claimed';
    if (st === 'sent') {
      console.log('webhook CLAIM skip', 'sent', it.embed.title || '');
      continue;
    }
    if (st === 'pending') {
      // Envoi concurrent ou run interrompu : ne PAS envoyer, ne PAS marquer
      // comme livré (l'état ne doit pas avancer sur un message non parti).
      console.log('webhook CLAIM skip', 'pending', it.embed.title || '');
      ok = false;
      continue;
    }
    toSend.push(it);
  }

  // Envoi séquentiel : l'ordre est garanti et webhook.js absorbe les 429
  // (attente exacte demandée par Discord) sans perdre le message.
  for (const it of toSend) {
    const r = await sendEmbeds(
      webhookUrl,
      { username: BOT, avatar_url: AVATAR },
      [it.embed],
      { identity, label: it.embed.title || '', withDismiss: true },
    );
    console.log('webhook', r.status, it.embed.title || '');
    if (r.ok) {
      if (it.key) await markPostedMany([it.key]);
    } else {
      ok = false;
      if (it.key) {
        await markFailedMany([
          { key: it.key, error: `HTTP ${r.status}: ${String(r.text || '').slice(0, 200)}` },
        ]);
      }
    }
  }
  return ok;
}

// scope (optionnel) : { titlePrefix, footerLabel, keyPrefix } — réutilisé par
// le datamining mobile (mêmes messages que Canary, titre « Mobile … »).
function scoped(scope, title) {
  return scope && scope.titlePrefix ? `${scope.titlePrefix} ${title}` : title;
}

async function sendExperiments(webhookUrl, bn, exp, ts, scope) {
  const kp = (scope && scope.keyPrefix) || '';
  const batchKey = 'expbatch:' + kp + stableExpKey(bn, exp);
  const claimed = await claimBatch(batchKey, 'Experiments');
  if (claimed !== null) return claimed;

  // Per-event filter: drop items already sent (partial batch recovery).
  // Une seule lecture du fichier de dedupe pour tous les événements.
  const evKey = (changeType, e) => 'expev:' + kp + stableExpEventKey(bn, changeType, e);
  const types = [['added', 'added'], ['modified', 'modified'], ['removed', 'removed'], ['categoryChanged', 'category']];
  const allEvKeys = [];
  for (const [f, t] of types) for (const e of exp[f] || []) if (e && (typeof e === 'string' || e.id)) allEvKeys.push(evKey(t, e));
  const already = await sentSet(allEvKeys);
  const filterEv = (list, changeType) =>
    (list || []).filter((e) => {
      const id = typeof e === 'string' ? e : e && e.id;
      return !id || !already.has(evKey(changeType, e));
    });
  exp = {
    ...exp,
    added: filterEv(exp.added, 'added'),
    modified: filterEv(exp.modified, 'modified'),
    removed: filterEv(exp.removed, 'removed'),
    categoryChanged: filterEv(exp.categoryChanged, 'category'),
  };
  const total =
    exp.added.length +
    exp.modified.length +
    exp.removed.length +
    (exp.categoryChanged || []).length;
  if (!total) {
    await markPosted(batchKey);
    console.log('Experiments all events already sent — skip');
    return true;
  }

  const sections = [];
  if (exp.added.length) {
    const lines = exp.added.slice(0, MAX_EXP_LINES).map((e) => expLine(e, '+'));
    if (exp.added.length > MAX_EXP_LINES) lines.push(`… +${exp.added.length - MAX_EXP_LINES} de plus`);
    sections.push({
      label: label(E.added, `Ajoutées · ${exp.added.length}`),
      color: COLOR.added,
      count: exp.added.length,
      lines,
    });
  }
  if (exp.modified.length) {
    const lines = exp.modified.slice(0, MAX_EXP_LINES).map((e) => expLine(e, '~'));
    if (exp.modified.length > MAX_EXP_LINES) lines.push(`… +${exp.modified.length - MAX_EXP_LINES} de plus`);
    sections.push({
      label: label(E.modified, `Modifiées · ${exp.modified.length}`),
      color: COLOR.modified,
      count: exp.modified.length,
      lines,
    });
  }
  if ((exp.categoryChanged || []).length) {
    const lines = exp.categoryChanged.slice(0, MAX_EXP_LINES).map((e) => {
      const id = e.id || '?';
      const from = e.from || '?';
      const to = e.to || e.kind || '?';
      return `~ ${id}  ${from} → ${to}`;
    });
    if (exp.categoryChanged.length > MAX_EXP_LINES) lines.push(`… +${exp.categoryChanged.length - MAX_EXP_LINES} de plus`);
    sections.push({
      label: label(E.modified, `Catégorie changée · ${exp.categoryChanged.length}`),
      color: COLOR.modified,
      count: exp.categoryChanged.length,
      lines,
    });
  }
  if (exp.removed.length) {
    const lines = exp.removed.slice(0, MAX_EXP_LINES).map((e) => {
      const id = typeof e === 'string' ? e : e.id;
      return `- ${id}`;
    });
    if (exp.removed.length > MAX_EXP_LINES) lines.push(`… +${exp.removed.length - MAX_EXP_LINES} de plus`);
    sections.push({
      label: label(E.removed, `Supprimées · ${exp.removed.length}`),
      color: COLOR.removed,
      count: exp.removed.length,
      lines,
    });
  }
  const ok = await sendSectionEmbeds({
    webhookUrl,
    title: label(E.exp, scoped(scope, 'Experiments')),
    identity: 'experiments',
    bn,
    ts,
    sections,
    batchKey,
    footerLabel: scope && scope.footerLabel,
  });
  if (ok) {
    const keys = [batchKey];
    for (const [f, t] of types)
      for (const e of exp[f] || []) if (e && (typeof e === 'string' || e.id)) keys.push(evKey(t, e));
    await markPostedMany(keys);
  } else {
    console.warn('Experiments webhook failed — batch NOT locked');
    await markFailed(batchKey, 'experiments batch send failed');
  }
  console.log('Sent experiments', {
    ok,
    added: exp.added.length,
    modified: exp.modified.length,
    removed: exp.removed.length,
    categoryChanged: (exp.categoryChanged || []).length,
  });
  return ok;
}

async function sendMapDiff(webhookUrl, bn, diff, ts, kind, scope) {
  const batchKey = 'mapbatch:' + ((scope && scope.keyPrefix) || '') + stableMapKey(bn, kind, diff);
  const claimed = await claimBatch(batchKey, kind);
  if (claimed !== null) return claimed;
  const isRoutes = kind === 'Routes';
  const a = Object.keys(diff.added);
  const m = Object.keys(diff.modified);
  const r = Object.keys(diff.removed);
  const sections = [];
  const kindEmoji = isRoutes ? E.route : E.str;
  const maxLines = isRoutes ? MAX_RT_LINES : MAX_STR_LINES;
  const maxVal = isRoutes ? LINE_VAL_ROUTES : LINE_VAL_MAX;
  if (a.length) {
    const lines = a.slice(0, maxLines).map((k) =>
      isRoutes ? routeLine('+', k, diff.added[k]) : stringLine('+', k, diff.added[k], maxVal),
    );
    if (a.length > maxLines) lines.push(`… +${a.length - maxLines} de plus`);
    sections.push({
      label: label(E.added, isRoutes ? `Ajoutées · ${a.length}` : `Ajoutés · ${a.length}`),
      color: COLOR.added,
      count: a.length,
      lines,
    });
  }
  if (m.length) {
    const lines = m.slice(0, maxLines).map((k) =>
      isRoutes ? routeLine('~', k, diff.modified[k]) : stringLine('~', k, diff.modified[k], maxVal),
    );
    if (m.length > maxLines) lines.push(`… +${m.length - maxLines} de plus`);
    sections.push({
      label: label(E.modified, isRoutes ? `Modifiées · ${m.length}` : `Modifiés · ${m.length}`),
      color: COLOR.modified,
      count: m.length,
      lines,
    });
  }
  if (r.length) {
    const lines = r.slice(0, maxLines).map((k) =>
      isRoutes ? routeLine('-', k, diff.removed[k]) : stringLine('-', k, diff.removed[k], maxVal),
    );
    if (r.length > maxLines) lines.push(`… +${r.length - maxLines} de plus`);
    sections.push({
      label: label(E.removed, isRoutes ? `Supprimées · ${r.length}` : `Supprimés · ${r.length}`),
      color: COLOR.removed,
      count: r.length,
      lines,
    });
  }
  const ok = await sendSectionEmbeds({
    webhookUrl,
    title: label(kindEmoji, scoped(scope, kind)),
    identity: isRoutes ? 'routes' : 'strings',
    bn,
    ts,
    sections,
    batchKey,
    footerLabel: scope && scope.footerLabel,
  });
  if (ok) await markPosted(batchKey);
  else {
    console.warn(kind, 'webhook failed — batch NOT locked');
    await markFailed(batchKey, kind + ' batch send failed');
  }
  console.log('Sent', kind, { ok, added: a.length, modified: m.length, removed: r.length });
  return ok;
}

/**
 * Dismissible Content : même rendu que Experiments / Routes (blocs « diff »),
 * même webhook / même salon. diff = { added:{K:n}, modified:{K:{from,to}}, removed:{K:n} }.
 */
async function sendDismissible(webhookUrl, bn, diff, ts = new Date().toISOString()) {
  if (!webhookUrl) return true;
  const d = normalizeMapDiff(diff);
  const a = Object.keys(d.added).sort((x, y) => Number(d.added[x]) - Number(d.added[y]));
  const m = Object.keys(d.modified).sort();
  const r = Object.keys(d.removed).sort((x, y) => Number(d.removed[x]) - Number(d.removed[y]));
  if (!a.length && !m.length && !r.length) return true;
  bn = String(bn || '?');
  const batchKey = 'dcbatch:' + stableMapKey(bn, 'Dismissible', d);
  const claimed = await claimBatch(batchKey, 'Dismissible');
  if (claimed !== null) return claimed;
  const sections = [];
  if (a.length)
    sections.push({
      label: `Ajoutés · ${a.length}`,
      color: COLOR.added,
      count: a.length,
      lines: a.map((k) => `+ ${k} = ${d.added[k]}`),
    });
  if (m.length)
    sections.push({
      label: `Modifiés · ${m.length}`,
      color: COLOR.modified,
      count: m.length,
      lines: m.map((k) => `~ ${k} = ${d.modified[k].from} → ${d.modified[k].to}`),
    });
  if (r.length)
    sections.push({
      label: `Supprimés · ${r.length}`,
      color: COLOR.removed,
      count: r.length,
      lines: r.map((k) => `- ${k} = ${d.removed[k]}`),
    });
  const ok = await sendSectionEmbeds({
    webhookUrl,
    title: 'Dismissible Content',
    identity: 'dismissible',
    bn,
    ts,
    sections,
    batchKey,
  });
  if (ok) await markPosted(batchKey);
  else {
    console.warn('Dismissible webhook failed — batch NOT locked');
    await markFailed(batchKey, 'dismissible batch send failed');
  }
  console.log('Sent Dismissible', { ok, added: a.length, modified: m.length, removed: r.length });
  return ok;
}

async function post(url, body, dedupeKey, identity) {
  body.username = BOT;
  body.avatar_url = AVATAR;
  const fp = dedupeKey ? 'msg:' + dedupeKey : payloadFingerprint(body);
  const st = await claimState(fp);
  if (st !== 'claimed') {
    console.log('webhook CLAIM skip', st, body.embeds?.[0]?.title || fp);
    // 'pending' = jamais confirmé livré → échec (retry au run suivant)
    return st === 'sent';
  }
  const title = body.embeds?.[0]?.title || '';
  const embeds = body.embeds || [];
  const base = { username: body.username, avatar_url: body.avatar_url };
  const r = await sendEmbeds(url, base, embeds, { identity, label: title, withDismiss: true });
  console.log('webhook', r.status, title);
  if (r.ok) {
    await markPosted(fp);
    return true;
  }
  await markFailed(fp, `HTTP ${r.status}: ${String(r.text || '').slice(0, 200)}`);
  return false;
}

module.exports = {
  notifyAll,
  notifyUrgent,
  notifyNormal,
  post,
  sectionEmbeds,
  sendSectionEmbeds,
  sendDismissible,
  COMPONENT_FIELD_MAX,
};
