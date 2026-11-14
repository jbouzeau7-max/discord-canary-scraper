/**
 * Datamining — notify (classic embeds)
 * Functional version using webhook.js + webhook_identity + webhook_dedupe.
 */
const { postWebhook } = require('./webhook');
const { webhookIdentity } = require('./webhook_identity');
const { fingerprint, claim, markSent, markFailed } = require('./webhook_dedupe');

function cleanText(s, max = 200) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function expLine(e, prefix = '+') {
  const id = e && e.id ? e.id : '?';
  const type = e && e.type ? e.type : '';
  return `${prefix} ${id}${type ? ` (${type})` : ''}`;
}

function mapLines(diff, prefixAdded = '+', prefixRemoved = '-') {
  const lines = [];
  if (diff && diff.added) {
    for (const [k, v] of Object.entries(diff.added)) {
      lines.push(`${prefixAdded} ${k}${v ? `: ${cleanText(v, 80)}` : ''}`);
    }
  }
  if (diff && diff.removed) {
    for (const [k, v] of Object.entries(diff.removed)) {
      lines.push(`${prefixRemoved} ${k}${v ? `: ${cleanText(v, 80)}` : ''}`);
    }
  }
  if (diff && diff.modified) {
    for (const [k, v] of Object.entries(diff.modified)) {
      lines.push(`~ ${k}${v ? `: ${cleanText(v, 80)}` : ''}`);
    }
  }
  return lines;
}

function codeBlock(lines) {
  if (!lines || !lines.length) return '```\n(aucun)\n```';
  return '```diff\n' + lines.slice(0, 40).join('\n') + '\n```';
}

async function notifyUrgent({ build, expDiff, webhookUrl }) {
  const url = webhookUrl || process.env.WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, reason: 'no-webhook' };

  const added = (expDiff && expDiff.added) || [];
  const modified = (expDiff && expDiff.modified) || [];
  const removed = (expDiff && expDiff.removed) || [];
  if (!added.length && !modified.length && !removed.length) return { ok: true, skipped: true };

  const lines = [
    ...added.map((e) => expLine(e, '+')),
    ...modified.map((e) => expLine(e, '~')),
    ...removed.map((e) => expLine(e, '-')),
  ];

  const identity = webhookIdentity('experiments');
  const bn = build && build.buildNumber ? build.buildNumber : '?';
  const payload = {
    username: identity.username,
    avatar_url: identity.avatar_url,
    embeds: [{
      title: `Expériences · Build ${bn}`,
      description: codeBlock(lines),
      color: 0xe4c36b,
      footer: { text: `Canary · ${new Date().toISOString()}` },
    }],
  };

  const fp = fingerprint({ type: 'urgent', bn, lines });
  const c = await claim(fp);
  if (!c.claimed) return { ok: true, deduped: true, reason: c.reason };

  const res = await postWebhook(url, payload);
  if (res.ok) await markSent(fp);
  else await markFailed(fp);
  return res;
}

async function notifyNormal({ build, strDiff, rtDiff, webhookUrl }) {
  const url = webhookUrl || process.env.WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { ok: false, reason: 'no-webhook' };

  const embeds = [];
  const bn = build && build.buildNumber ? build.buildNumber : '?';

  const strLines = mapLines(strDiff);
  if (strLines.length) {
    const id = webhookIdentity('strings');
    embeds.push({
      title: `Textes · Build ${bn}`,
      description: codeBlock(strLines),
      color: 0x5ee9a0,
    });
  }

  const rtLines = mapLines(rtDiff);
  if (rtLines.length) {
    const id = webhookIdentity('routes');
    embeds.push({
      title: `Routes · Build ${bn}`,
      description: codeBlock(rtLines),
      color: 0xd4d8de,
    });
  }

  if (!embeds.length) return { ok: true, skipped: true };

  const identity = webhookIdentity('strings');
  const payload = {
    username: identity.username,
    avatar_url: identity.avatar_url,
    embeds,
  };

  const fp = fingerprint({ type: 'normal', bn, str: strLines, rt: rtLines });
  const c = await claim(fp);
  if (!c.claimed) return { ok: true, deduped: true, reason: c.reason };

  const res = await postWebhook(url, payload);
  if (res.ok) await markSent(fp);
  else await markFailed(fp);
  return res;
}

async function notifyAll(opts) {
  const urgent = await notifyUrgent(opts);
  const normal = await notifyNormal(opts);
  return { urgent, normal };
}

module.exports = {
  notifyUrgent,
  notifyNormal,
  notifyAll,
};
