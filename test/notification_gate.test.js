'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasMapDiff,
  hasExperimentDiff,
  canAdvanceNotificationState,
} = require('../src/lib/notification_gate');

test('diff normal : distingue les maps vides, les ajouts et les changements', () => {
  assert.equal(hasMapDiff({ added: {}, modified: {}, removed: {} }), false);
  assert.equal(hasMapDiff({ added: { KEY: 'texte' } }), true);
  assert.equal(hasMapDiff({ modified: { KEY: { from: 'A', to: 'B' } } }), true);
  assert.equal(hasMapDiff({ removed: { KEY: 'texte' } }), true);
  assert.equal(hasMapDiff(null), false);
});

test('diff expériences : détecte chaque catégorie et ignore les listes vides', () => {
  assert.equal(hasExperimentDiff({ added: [], modified: [], removed: [], categoryChanged: [] }), false);
  for (const key of ['added', 'modified', 'removed', 'categoryChanged']) {
    assert.equal(hasExperimentDiff({ [key]: [{ id: 'exp-1' }] }), true, key);
  }
  assert.equal(hasExperimentDiff(null), false);
});

test('autorise un run sans webhook s’il n’y a rien à notifier', () => {
  assert.equal(
    canAdvanceNotificationState({
      webhookConfigured: false,
      hasNormalDiff: false,
      hasExpDiff: false,
      normalNotifyOk: true,
      experimentNotifyOk: true,
    }),
    true,
  );
});

test('bloque l’avancement si un diff strings/routes existe sans webhook', () => {
  assert.equal(
    canAdvanceNotificationState({
      webhookConfigured: false,
      hasNormalDiff: true,
      hasExpDiff: false,
      normalNotifyOk: true,
      experimentNotifyOk: true,
    }),
    false,
  );
});

test('bloque l’avancement si un diff d’expérience existe sans webhook', () => {
  assert.equal(
    canAdvanceNotificationState({
      webhookConfigured: false,
      hasNormalDiff: false,
      hasExpDiff: true,
      normalNotifyOk: true,
      experimentNotifyOk: true,
    }),
    false,
  );
});

test('un échec d’envoi normal bloque seulement quand un diff normal attend livraison', () => {
  assert.equal(
    canAdvanceNotificationState({
      webhookConfigured: true,
      hasNormalDiff: true,
      hasExpDiff: false,
      normalNotifyOk: false,
      experimentNotifyOk: true,
    }),
    false,
  );
  assert.equal(
    canAdvanceNotificationState({
      webhookConfigured: true,
      hasNormalDiff: false,
      hasExpDiff: false,
      normalNotifyOk: false,
      experimentNotifyOk: false,
    }),
    true,
  );
});

test('un échec d’envoi des expériences bloque quand un diff d’expérience attend livraison', () => {
  assert.equal(
    canAdvanceNotificationState({
      webhookConfigured: true,
      hasNormalDiff: true,
      hasExpDiff: true,
      normalNotifyOk: true,
      experimentNotifyOk: false,
    }),
    false,
  );
});
