'use strict';

/**
 * Scan des chunks : pré-filtre de routes (condition nécessaire) et choix du
 * nombre de workers. Le pré-filtre doit être STRICTEMENT lossless : s'il rejette
 * un chunk, c'est qu'aucune des six formes de route ne peut y apparaître.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRoutes, chunkScanWorkerCount } = require('../src/lib/extract');

test('extractRoutes trouve une route simple', () => {
  const out = {};
  extractRoutes('var a={CHANNEL:()=>"/channels/:id"};', out);
  assert.equal(out.CHANNEL, '/channels/:id');
});

test('extractRoutes trouve une route en forme minifiée (template)', () => {
  const out = {};
  extractRoutes('const e={USER:e=>`/users/${e}`,BADGE:(e,t)=>`/users/${e}/badges/${t}`};', out);
  assert.equal(out.USER, '/users/:param');
  assert.ok(Object.keys(out).length >= 1);
});

test('pré-filtre : un contenu sans quote+slash ne produit aucune route', () => {
  const out = {};
  extractRoutes('const x={FOO:"bar",BAZ:42};function f(){return 1}', out);
  assert.deepEqual(out, {});
});

test('pré-filtre : un chunk rejeté n’aurait rien trouvé (lossless)', () => {
  const rejected = 'const s="/a";const t={FOO:s};';
  const out = {};
  extractRoutes(rejected, out);
  assert.deepEqual(out, {});
});

test('pré-filtre : ignore les URL http (pas un chemin de route)', () => {
  const out = {};
  extractRoutes('const u={URL:"https://discord.com/api/v9"};', out);
  assert.deepEqual(out, {});
});

test('chunkScanWorkerCount : séquentiel sous le seuil de fichiers', () => {
  assert.equal(chunkScanWorkerCount(1), 1);
  assert.equal(chunkScanWorkerCount(10), 1);
});

test('chunkScanWorkerCount : borné par le nombre de fichiers', () => {
  const n = chunkScanWorkerCount(1000);
  assert.ok(n >= 1 && n <= 4, 'entre 1 et 4 workers');
});
