/**
 * Shared utility functions used across all scraper scripts.
 *
 * Centralises: sleep, redactSecrets, loadTokens, common constants.
 * Prevents drift between scripts that previously each defined their own copy.
 */

/** Default User-Agent for all HTTP requests to Discord. */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Default bot name shown on Discord webhook messages. */
const DEFAULT_BOT_NAME = process.env.ORBIT_BOT_NAME || 'Datamining';

/** Default avatar URL for webhook messages. */
const DEFAULT_AVATAR_URL =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/media/datamining-avatar.png';

/** Default avatar for mobile/blog/quest scripts. */
const DEFAULT_MOBILE_AVATAR =
  process.env.ORBIT_BOT_AVATAR ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

function sleep(ms) {
  const n = Number(ms);
  return new Promise((r) => setTimeout(r, Number.isFinite(n) && n > 0 ? n : 0));
}

function envNumber(name, fallback, opts = {}) {
  const raw = process.env[name];
  let v = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(v)) v = fallback;
  if (opts.int && Number.isFinite(v)) v = Math.trunc(v);
  if (opts.min != null) v = Math.max(opts.min, v);
  if (opts.max != null) v = Math.min(opts.max, v);
  return v;
}

function redactSecrets(msg) {
  return String(msg || '')
    .replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{10,}/g, '[REDACTED_JWT]')
    .replace(/mfa\.[\w-]{20,}/gi, '[REDACTED_TOKEN]')
    .replace(/Bot\s+[\w.-]{20,}/gi, 'Bot [REDACTED]');
}

function loadTokens(maxIndex = 10) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const s = String(t || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const part of String(process.env.DISCORD_USER_TOKENS || '').split(/[,;\n]+/)) push(part);
  for (let i = 1; i <= maxIndex; i++) {
    push(process.env['DISCORD_USER_TOKEN_' + i]);
    push(process.env['DISCORD_USER_TOKENS' + i]);
  }
  push(process.env.DISCORD_USER_TOKEN);
  push(process.env.DISCORD_TOKEN);
  return out;
}

function firstToken() {
  const tokens = loadTokens();
  return tokens.length > 0 ? tokens[0] : null;
}

function trimRecent(ids, max) {
  const arr = [...new Set(Array.from(ids || [], String))];
  return max > 0 && arr.length > max ? arr.slice(arr.length - max) : arr;
}

function safeIso(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : fallback;
}

function capKnownIds(ids, max, current) {
  if (ids.length <= max) return ids;
  const cur = current || {};
  const live = ids.filter((k) => Object.prototype.hasOwnProperty.call(cur, k));
  const liveSet = new Set(live);
  const rest = ids.filter((k) => !liveSet.has(k));
  const keep = new Set([...live, ...rest.slice(rest.length - Math.max(0, max - live.length))]);
  const out = ids.filter((k) => keep.has(k));
  ids.length = 0;
  ids.push(...out);
  return ids;
}

module.exports = {
  capKnownIds,
  safeIso,
  trimRecent,
  sleep,
  envNumber,
  redactSecrets,
  loadTokens,
  firstToken,
  DEFAULT_UA,
  DEFAULT_BOT_NAME,
  DEFAULT_AVATAR_URL,
  DEFAULT_MOBILE_AVATAR,
};
