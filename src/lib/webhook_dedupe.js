/**
 * Webhook dedupe — claim BEFORE HTTP so concurrent GHA runs cannot double-post.
 * States: pending | sent | failed (unavailable is a transient claim result)
 * - pending: in-flight (stale after CLAIM_STALE_MS → re-claimable)
 * - sent: delivered OK (blocked for WINDOW_MS)
 * - failed: HTTP failed → immediately re-claimable
 * Legacy status "done" is treated as "sent".
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { sleep, envNumber } = require('./utils');
// NOTIFY_DEDUPE_FILE permet aux tests d'utiliser un fichier temporaire
// (sinon ils écrasaient le vrai data/notify_dedupe.json → doubles notifications).
const DEDUPE_FILE =
  process.env.NOTIFY_DEDUPE_FILE ||
  path.join(__dirname, '..', '..', 'data', 'notify_dedupe.json');
const WINDOW_MS = 24 * 3600 * 1000;
const CLAIM_STALE_MS = 5 * 60 * 1000;
// 800 était trop bas (1 clé par expérience + 1 par message) : les clés
// récentes étaient purgées → doublons après un échec partiel.
const MAX_KEYS = envNumber('NOTIFY_DEDUPE_MAX_KEYS', 6000, { min: 100, int: true });
const LOCK_FILE = DEDUPE_FILE + '.lock';
const LOCK_WAIT_MS = envNumber('NOTIFY_DEDUPE_LOCK_WAIT_MS', 8000, { min: 1, int: true });

class DedupeLockError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DedupeLockError';
    this.code = 'DEDUPE_LOCK_UNAVAILABLE';
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

async function removeStaleLock() {
  let before;
  let owner;
  try {
    before = await fs.stat(LOCK_FILE);
    if (Date.now() - before.mtimeMs <= LOCK_WAIT_MS * 2) return false;
  } catch {
    return false;
  }
  try { owner = await fs.readJson(LOCK_FILE); } catch { owner = null; }

  // A live process owns a valid lock even if its critical section is long.
  // Legacy/malformed locks remain recoverable after the conservative age test.
  if (owner && processIsAlive(Number(owner.pid))) return false;
  try {
    const current = await fs.stat(LOCK_FILE);
    if (current.dev !== before.dev || current.ino !== before.ino) return false;
    let currentOwner;
    try { currentOwner = await fs.readJson(LOCK_FILE); } catch { currentOwner = null; }
    if (JSON.stringify(currentOwner) !== JSON.stringify(owner)) return false;
    await fs.unlink(LOCK_FILE);
    return true;
  } catch {
    return false;
  }
}

async function removeOwnedLock(token) {
  try {
    const owner = await fs.readJson(LOCK_FILE);
    if (owner && owner.token === token) await fs.unlink(LOCK_FILE);
  } catch {}
}

async function withDedupeLock(fn) {
  const start = Date.now();
  while (true) {
    let handle;
    const token = crypto.randomBytes(16).toString('hex');
    try {
      await fs.ensureDir(path.dirname(LOCK_FILE));
      handle = await fs.promises.open(LOCK_FILE, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
    } catch (e) {
      if (handle) {
        try { await handle.close(); } catch {}
        await removeOwnedLock(token);
      }
      if (!e || e.code !== 'EEXIST') {
        throw new DedupeLockError('could not acquire dedupe lock', e);
      }
      await removeStaleLock();
      if (Date.now() - start >= LOCK_WAIT_MS) {
        throw new DedupeLockError('dedupe lock acquisition timed out');
      }
      await sleep(15 + Math.floor(Math.random() * 20));
      continue;
    }

    try {
      return await fn();
    } finally {
      try { await handle.close(); } catch {}
      await removeOwnedLock(token);
    }
  }
}

async function load() {
  try {
    const d = await fs.readJson(DEDUPE_FILE);
    if (!d || typeof d !== 'object' || Array.isArray(d) ||
        !d.fps || typeof d.fps !== 'object' || Array.isArray(d.fps)) {
      throw new Error('invalid dedupe state schema');
    }
    return d;
  } catch (error) {
    if (error && error.code === 'ENOENT') return { fps: {} };
    throw error;
  }
}

async function save(d) {
  try {
    const cut = Date.now() - WINDOW_MS;
    for (const [k, v] of Object.entries(d.fps || {})) {
      const ts = typeof v === 'object' ? Number(v.ts || 0) : Number(v);
      if (ts < cut) delete d.fps[k];
    }
    const keys = Object.keys(d.fps || {});
    if (keys.length > MAX_KEYS) {
      keys
        .sort((a, b) => {
          const ta = typeof d.fps[a] === 'object' ? d.fps[a].ts : d.fps[a];
          const tb = typeof d.fps[b] === 'object' ? d.fps[b].ts : d.fps[b];
          return Number(ta) - Number(tb);
        })
        .slice(0, keys.length - MAX_KEYS)
        .forEach((k) => delete d.fps[k]);
    }
    await fs.ensureDir(path.dirname(DEDUPE_FILE));
    const tmp =
      DEDUPE_FILE +
      '.tmp.' +
      process.pid +
      '.' +
      Date.now() +
      '.' +
      Math.random().toString(36).slice(2, 8);
    await fs.writeJson(tmp, d);
    try {
      await fs.move(tmp, DEDUPE_FILE, { overwrite: true });
    } catch (moveErr) {
      try {
        await fs.remove(tmp).catch(() => {});
        const tmp2 =
          DEDUPE_FILE +
          '.tmp.' +
          process.pid +
          '.' +
          Date.now() +
          '.' +
          Math.random().toString(36).slice(2, 8);
        await fs.writeJson(tmp2, d);
        await fs.move(tmp2, DEDUPE_FILE, { overwrite: true });
      } catch {
        throw moveErr;
      }
    }
  } catch (e) {
    console.warn('dedupe save fail', e.message);
    throw e;
  }
}

function entryTs(v) {
  if (v == null) return 0;
  if (typeof v === 'object') return Number(v.ts || 0);
  return Number(v);
}

function entryStatus(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    const s = v.status || 'sent';
    if (s === 'done') return 'sent';
    return s;
  }
  return 'sent';
}

async function wasPosted(fp) {
  try {
    const d = await load();
    const v = d.fps[fp];
    if (!v) return false;
    if (entryStatus(v) !== 'sent') return false;
    const age = Date.now() - entryTs(v);
    return age < WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Réserve une clé. Retourne 'claimed' (à envoyer), 'sent' (déjà livré),
 * 'pending' (envoi en cours / run interrompu récent) ou 'unavailable'
 * (verrou indisponible → réessayer sans envoyer).
 * Distinguer 'sent' de 'pending' évite de considérer comme envoyé un message
 * qui ne l'a jamais été (l'état avançait → message perdu).
 */
async function claimState(fp) {
  try {
    return await withDedupeLock(async () => {
      const d = await load();
      const v = d.fps[fp];
      if (v) {
        const age = Date.now() - entryTs(v);
        const st = entryStatus(v);
        if (st === 'sent' && age < WINDOW_MS) return 'sent';
        if (st === 'pending' && age < CLAIM_STALE_MS) return 'pending';
      }
      d.fps[fp] = { ts: Date.now(), status: 'pending' };
      await save(d);
      return 'claimed';
    });
  } catch (e) {
    console.warn('claimPosted fail (retry required)', e.message);
    return 'unavailable';
  }
}

async function claimPosted(fp) {
  return (await claimState(fp)) === 'claimed';
}

/**
 * Réserve N clés en UNE seule passe verrou+lecture+écriture.
 * Mêmes garanties que claimState (pending écrit AVANT l'envoi), mais un lot
 * de 300 messages passait par 300 réécritures du fichier de dedupe ; ici :
 * une seule. Retourne Map<clé, 'claimed'|'sent'|'pending'|'unavailable'>.
 * Si le verrou n'est pas obtenu, les clés sont « unavailable » et doivent
 * être retentées sans envoyer.
 */
async function claimMany(fps) {
  const keys = [
    ...new Set(
      (fps || [])
        .filter((k) => k != null && String(k).trim() !== '')
        .map((k) => String(k)),
    ),
  ];
  const out = new Map();
  if (!keys.length) return out;
  try {
    await withDedupeLock(async () => {
      const d = await load();
      const now = Date.now();
      let dirty = false;
      for (const fp of keys) {
        const v = d.fps[fp];
        if (v) {
          const age = now - entryTs(v);
          const st = entryStatus(v);
          if (st === 'sent' && age < WINDOW_MS) {
            out.set(fp, 'sent');
            continue;
          }
          if (st === 'pending' && age < CLAIM_STALE_MS) {
            out.set(fp, 'pending');
            continue;
          }
        }
        d.fps[fp] = { ts: now, status: 'pending' };
        out.set(fp, 'claimed');
        dirty = true;
      }
      if (dirty) await save(d);
    });
    for (const fp of keys) if (!out.has(fp)) out.set(fp, 'claimed');
    return out;
  } catch (e) {
    console.warn('claimMany fail (retry required)', e.message);
    for (const fp of keys) out.set(fp, 'unavailable');
    return out;
  }
}

/** Ensemble des clés déjà livrées (une seule lecture disque pour N clés). */
async function sentSet(fps) {
  const out = new Set();
  try {
    const d = await load();
    const now = Date.now();
    for (const fp of fps || []) {
      const v = d.fps[fp];
      if (v && entryStatus(v) === 'sent' && now - entryTs(v) < WINDOW_MS) out.add(fp);
    }
  } catch {}
  return out;
}

/** Marque plusieurs clés comme livrées en une seule écriture. */
async function markPostedMany(fps) {
  if (!fps || !fps.length) return;
  try {
    await withDedupeLock(async () => {
      const d = await load();
      const ts = Date.now();
      for (const fp of fps) d.fps[fp] = { ts, status: 'sent' };
      await save(d);
    });
  } catch (e) {
    console.warn('markPostedMany fail', e.message);
  }
}

async function markPosted(fp) {
  try {
    await withDedupeLock(async () => {
      const d = await load();
      d.fps[fp] = { ts: Date.now(), status: 'sent' };
      await save(d);
    });
  } catch (e) {
    console.warn('markPosted fail', e.message);
  }
}

async function markFailed(fp, error) {
  return markFailedMany([{ key: fp, error }]);
}

/** Marque N clés en échec en une seule écriture. entries = [{key,error}]. */
async function markFailedMany(entries) {
  const list = (entries || []).filter((e) => e && e.key);
  if (!list.length) return;
  try {
    await withDedupeLock(async () => {
      const d = await load();
      const ts = Date.now();
      let dirty = false;
      for (const { key, error } of list) {
        const current = d.fps[key];
        // Un échec tardif d'une autre tentative ne peut annuler une livraison confirmée.
        if (entryStatus(current) === 'sent' && ts - entryTs(current) < WINDOW_MS) continue;
        d.fps[String(key)] = {
          ts,
          status: 'failed',
          error: String(error || '').slice(0, 500),
        };
        dirty = true;
      }
      if (dirty) await save(d);
    });
  } catch (e) {
    console.warn('markFailedMany fail', e.message);
  }
}

/** Per-event fingerprint: type + build + experiment id (partial batch safe). */
function stableExpEventKey(bn, changeType, exp) {
  const id = String(
    typeof exp === 'string' ? exp : (exp && (exp.id || exp.name)) || '',
  ).trim();
  const raw = ['expev', String(bn), String(changeType || ''), id].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function stableExpKey(bn, exp) {
  const pack = (arr) =>
    (arr || [])
      .map((e) => String(typeof e === 'string' ? e : e.id || ''))
      .filter(Boolean)
      .sort()
      .join(',');
  const raw = [
    'exp',
    String(bn),
    'a:' + pack(exp.added),
    'm:' + pack(exp.modified),
    'r:' + pack(exp.removed),
    'c:' + pack(exp.categoryChanged),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function stableMapKey(bn, kind, diff) {
  const ids = (o) => Object.keys(o || {}).sort().join(',');
  const raw = [
    kind,
    String(bn),
    'a:' + ids(diff.added),
    'm:' + ids(diff.modified),
    'r:' + ids(diff.removed),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function payloadFingerprint(body) {
  const embeds = body.embeds || [];
  const core = embeds.map((e) => ({
    t: e.title || '',
    d: String(e.description || '').slice(0, 240),
    f: (e.fields || [])
      .map((x) => String(x.name || '') + ':' + String(x.value || '').slice(0, 80))
      .join('|')
      .slice(0, 400),
  }));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ u: body.username, core }))
    .digest('hex')
    .slice(0, 20);
}

module.exports = {
  wasPosted,
  markPosted,
  markFailed,
  claimPosted,
  claimState,
  claimMany,
  sentSet,
  markPostedMany,
  markFailedMany,
  payloadFingerprint,
  stableExpKey,
  stableExpEventKey,
  stableMapKey,
  WINDOW_MS,
  CLAIM_STALE_MS,
};
