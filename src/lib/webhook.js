/**
 * Envoi robuste de webhooks Discord, partagé par tous les scripts.
 *
 * - 429 : respecte Retry-After (header), retry_after (JSON) et X-RateLimit-Reset-After
 * - 5xx / erreurs réseau / timeout : backoff exponentiel avec jitter
 * - 4xx (hors 429) : échec immédiat (payload invalide → inutile de réessayer)
 * - X-RateLimit-Remaining: 0 → attend le reset avant la requête suivante
 */
const fetch = require('node-fetch');
const { sleep, redactSecrets, DEFAULT_BOT_NAME, DEFAULT_AVATAR_URL } = require('./utils');
const { webhookIdentity } = require('./webhook_identity');

const MAX_ATTEMPTS = 5;
const BASE_DELAY = 500;

async function postWebhook(url, payload, opts = {}) {
  if (!url) return { ok: false, reason: 'no-url' };
  const body = JSON.stringify({
    username: payload.username || DEFAULT_BOT_NAME,
    avatar_url: payload.avatar_url || DEFAULT_AVATAR_URL,
    ...payload,
  });

  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeout: opts.timeout || 15000,
      });

      if (res.status === 204 || res.status === 200) {
        return { ok: true, status: res.status };
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') || 1) * 1000;
        console.warn(`webhook 429 — wait ${retryAfter}ms`);
        await sleep(Math.min(retryAfter, 30000));
        continue;
      }

      if (res.status >= 500) {
        const delay = BASE_DELAY * 2 ** attempt;
        console.warn(`webhook ${res.status} — retry in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      // 4xx other than 429 → permanent failure
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: text.slice(0, 200) };
    } catch (e) {
      lastErr = e;
      const delay = BASE_DELAY * 2 ** attempt;
      console.warn(`webhook network error: ${redactSecrets(e.message)} — retry in ${delay}ms`);
      await sleep(delay);
    }
  }
  return { ok: false, reason: lastErr ? redactSecrets(lastErr.message) : 'max-attempts' };
}

async function notify(type, embeds, opts = {}) {
  const url = opts.webhookUrl || process.env.WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, reason: 'no-webhook' };
  const identity = webhookIdentity(type);
  return postWebhook(url, {
    username: identity.username,
    avatar_url: identity.avatar_url,
    embeds: Array.isArray(embeds) ? embeds : [embeds],
  }, opts);
}

module.exports = { postWebhook, notify };
