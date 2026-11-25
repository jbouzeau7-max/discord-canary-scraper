/** Atomic JSON / file writes */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs').promises;

// Nom temporaire unique : pid + timestamp seuls collisionnent quand deux écritures
// du même fichier partent dans la même milliseconde.
const tmpName = (file) => `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

/**
 * Flush le fichier sur disque avant le rename.
 *
 * Sans fsync, `rename` peut être visible AVANT que les données soient écrites :
 * après une coupure (runner GHA interrompu, machine qui redémarre), le fichier
 * renommé existe mais est vide/tronqué → l'état suivant (build.json,
 * notify_dedupe.json…) repart d'une base corrompue et rejoue des notifications.
 * On synchronise donc le contenu, puis le répertoire (entrée de rename).
 */
async function fsyncFile(tmp) {
  const handle = await fsp.open(tmp, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** fsync du répertoire : rend le rename durable. Best-effort (non supporté partout). */
async function fsyncDir(dir) {
  let handle;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch {
    // Windows / FS sans support du fsync de répertoire : le rename reste atomique,
    // seule la durabilité de l'entrée n'est pas garantie.
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {}
    }
  }
}

async function writeJsonAtomic(file, value, spaces = 2) {
  const dir = path.dirname(file);
  await fs.ensureDir(dir);
  const tmp = tmpName(file);
  try {
    // Même sérialisation que fs.writeJson (jsonfile) : JSON + fin de ligne.
    // spaces == null → compact (comportement historique de fs-extra sans option).
    const json = JSON.stringify(value, null, spaces == null ? undefined : spaces);
    await fsp.writeFile(tmp, String(json) + '\n', 'utf8');
    await fsyncFile(tmp);
    await fsp.rename(tmp, file);
    await fsyncDir(dir);
  } catch (e) {
    try {
      await fs.remove(tmp);
    } catch {}
    throw e;
  }
}

async function writeFileAtomic(file, buf) {
  const dir = path.dirname(file);
  await fs.ensureDir(dir);
  const tmp = tmpName(file);
  try {
    await fsp.writeFile(tmp, buf);
    await fsyncFile(tmp);
    await fsp.rename(tmp, file);
    await fsyncDir(dir);
  } catch (e) {
    try {
      await fs.remove(tmp);
    } catch {}
    throw e;
  }
}

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

module.exports = { writeJsonAtomic, writeFileAtomic, envInt, fsyncFile, fsyncDir };
