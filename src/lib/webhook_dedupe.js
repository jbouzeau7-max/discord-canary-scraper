/**
 * Webhook dedupe — claim BEFORE HTTP so concurrent GHA runs cannot double-post.
 * States: pending | sent | failed
 * - pending: in-flight (stale after CLAIM_STALE_MS → re-claimable)
 * - sent: delivered OK (blocked for WINDOW_MS)
 * - failed: HTTP failed → immediately re-claimable
 * Legacy status "done" is treated as "sent".
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { sleep, envNumber } = require('./utils');

const WINDOW_MS = envNumber('NOTIFY_DEDUPE_WINDOW_MS', 7 * 24 * 3600 * 1000, { min: 60000 });
const CLAIM_STALE_MS = envNumber('NOTIFY_CLAIM_STALE_MS', 15 * 60 * 1000, { min: 30000 });
const DEFAULT_FILE = path.join(process.cwd(), 'data', 'notify_dedupe.json');

function fingerprint(payload) {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
}

async function loadDedupe(file = DEFAULT_FILE) {
  try {
    if (await fs.pathExists(file)) return await fs.readJson(file);
  } catch {}
  return { fps: {} };
}

async function saveDedupe(data, file = DEFAULT_FILE) {
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, data, { spaces: 0 });
}

async function claim(fp, file = DEFAULT_FILE) {
  const data = await loadDedupe(file);
  const now = Date.now();
  const entry = data.fps[fp];

  if (entry) {
    const st = entry.status || 'sent';
    const age = now - (entry.ts || 0);
    if (st === 'sent' || st === 'done') {
      if (age < WINDOW_MS) return { claimed: false, reason: 'already-sent' };
    }
    if (st === 'pending' && age < CLAIM_STALE_MS) {
      return { claimed: false, reason: 'in-flight' };
    }
  }

  data.fps[fp] = { status: 'pending', ts: now };
  await saveDedupe(data, file);
  return { claimed: true };
}

async function markSent(fp, file = DEFAULT_FILE) {
  const data = await loadDedupe(file);
  data.fps[fp] = { status: 'sent', ts: Date.now() };
  await saveDedupe(data, file);
}

async function markFailed(fp, file = DEFAULT_FILE) {
  const data = await loadDedupe(file);
  data.fps[fp] = { status: 'failed', ts: Date.now() };
  await saveDedupe(data, file);
}

module.exports = { fingerprint, claim, markSent, markFailed, loadDedupe, saveDedupe };
