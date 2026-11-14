#!/usr/bin/env bash
# Commit + push d'un etat (data/*.json, builds/...) avec retries et resolution de conflit.
#
# Usage : scripts/commit-state.sh "message de commit" chemin1 [chemin2 ...]
#
# - fichiers : ajoutes avec -f (meme s'ils sont ignores)
# - dossiers : ajoutes avec -A (suppressions incluses)
set -euo pipefail

MSG="${1:-state update}"
shift || true

if [ "$#" -eq 0 ]; then
  echo "usage: commit-state.sh <message> <path> [path...]"
  exit 2
fi

BRANCH="${GITHUB_REF_NAME:-main}"
MAX="${COMMIT_STATE_RETRIES:-5}"

stage() {
  for p in "$@"; do
    if [ -d "$p" ]; then
      git add -A "$p" || true
    elif [ -e "$p" ]; then
      git add -f "$p" || true
    fi
  done
}

stage "$@"

if git diff --cached --quiet; then
  echo "commit-state: aucun changement"
  exit 0
fi

git commit -q -m "$MSG" || true

for i in $(seq 1 "$MAX"); do
  git fetch -q origin "$BRANCH" || true
  if git rebase -q "origin/$BRANCH" >/dev/null 2>&1; then
    if git push -q origin "HEAD:$BRANCH"; then
      echo "commit-state: push OK (tentative $i) — $MSG"
      exit 0
    fi
  else
    echo "commit-state: conflit — reapplication"
    git rebase --abort 2>/dev/null || true
    git reset -q --hard "origin/$BRANCH" || true
    stage "$@"
    if git diff --cached --quiet; then
      echo "commit-state: etat deja identique"
      exit 0
    fi
    git commit -q -m "$MSG" || true
    if git push -q origin "HEAD:$BRANCH"; then
      echo "commit-state: push OK apres conflit (tentative $i)"
      exit 0
    fi
  fi
  sleep $(( i * 2 ))
done

echo "::error::commit-state: push impossible apres $MAX tentatives — $MSG"
if [ "${COMMIT_SOFT_FAIL:-0}" = "1" ]; then exit 0; fi
exit 1
