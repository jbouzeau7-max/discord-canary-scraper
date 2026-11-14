#!/usr/bin/env node
/**
 * Ne garde de notify_dedupe.json que les entrées confirmées livrées (« sent »).
 * Utilisé après un run en échec : les envois réussis ne sont pas renvoyés au
 * run suivant, les envois ratés / interrompus sont retentés immédiatement.
 *
 * Usage : node scripts/dedupe-sent-only.js <entrée> <sortie>
 */
const fs = require('fs');

function sentOnly(d) {
  const out = {};
  for (const [k, v] of Object.entries((d && d.fps) || {})) {
    const st = v && typeof v === 'object' ? v.status || 'sent' : 'sent';
    if (st === 'sent' || st === 'done') out[k] = v;
  }
  return { ...(d || {}), fps: out };
}

if (require.main === module) {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) {
    console.error('usage: dedupe-sent-only.js <in> <out>');
    process.exit(2);
  }
  const d = sentOnly(JSON.parse(fs.readFileSync(src, 'utf8')));
  fs.writeFileSync(dst, JSON.stringify(d));
  console.log('dedupe sent-only:', Object.keys(d.fps).length, 'clé(s)');
}

module.exports = { sentOnly };
