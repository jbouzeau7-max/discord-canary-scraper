'use strict';

function hasMapDiff(diff) {
  if (!diff || typeof diff !== 'object') return false;
  return ['added', 'modified', 'removed'].some((key) => {
    const value = diff[key];
    return value && typeof value === 'object' && Object.keys(value).length > 0;
  });
}

function hasExperimentDiff(diff) {
  if (!diff || typeof diff !== 'object') return false;
  return ['added', 'modified', 'removed', 'categoryChanged'].some(
    (key) => Array.isArray(diff[key]) && diff[key].length > 0,
  );
}

function canAdvanceNotificationState({
  webhookConfigured,
  hasNormalDiff,
  hasExpDiff,
  normalNotifyOk,
  experimentNotifyOk,
}) {
  const normalPending = Boolean(hasNormalDiff);
  const experimentsPending = Boolean(hasExpDiff);

  // A missing webhook must never turn a detected change into an acknowledged one.
  if (!webhookConfigured && (normalPending || experimentsPending)) return false;

  return (
    (!normalPending || normalNotifyOk === true) &&
    (!experimentsPending || experimentNotifyOk === true)
  );
}

module.exports = { hasMapDiff, hasExperimentDiff, canAdvanceNotificationState };
