#!/usr/bin/env bash
# Commit + push d'un etat (data/*.json, builds/...) avec retries et resolution de conflit.
#
# Usage : scripts/commit-state.sh "message de commit" chemin1 [chemin2 ...]
#
# - fichiers : ajoutes avec -f (meme s'ils sont ignores)
# - dossiers : ajoutes avec -A (suppressions incluses, .gitignore respecte)
# - conflit au rebase : echec ferme, sans reset ni reapplication d'un dossier
#   potentiellement perime qui ecraserait des fichiers ajoutes a distance
# - JSON : ignore les changements purement metadonnees (scrapedAt, updatedAt...)
#
# Env : COMMIT_MAX_ATTEMPTS (8).
set -euo pipefail

MSG="${1:?message de commit requis}"
shift
[ "$#" -gt 0 ] || { echo "commit-state: aucun chemin"; exit 0; }

MAX="${COMMIT_MAX_ATTEMPTS:-8}"
BRANCH="${COMMIT_BRANCH:-main}"
RECOVERY_PATCH="${COMMIT_RECOVERY_PATCH:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/commit-state-recovery.patch}"

git config user.name >/dev/null 2>&1 || git config user.name "github-actions[bot]"
git config user.email >/dev/null 2>&1 || git config user.email "github-actions[bot]@users.noreply.github.com"

stage() {
  for p in "$@"; do
    if [ -d "$p" ]; then
      git add -A -- "$p"
    elif [ -e "$p" ]; then
      git add -f -- "$p"
    elif git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
      git add -A -- "$p"
    fi
  done
}

# Drop staged JSON files whose only changes are ephemeral timestamps.
# Exit 0 if anything meaningful remains staged, 1 if nothing useful left.
prune_timestamp_only() {
  python3 - <<'PY'
import json, subprocess, sys
from pathlib import Path

EPHEMERAL = {
    "scrapedAt",
    "updatedAt",
    "fetchedAt",
    "lastRunAt",
    "last_run_at",
    "timestamp",
    "ts",
    "runId",
    "run_id",
    "generatedAt",
    "checkedAt",
}

def strip(obj):
    if isinstance(obj, dict):
        return {k: strip(v) for k, v in obj.items() if k not in EPHEMERAL}
    if isinstance(obj, list):
        return [strip(x) for x in obj]
    return obj

def load(text):
    try:
        return strip(json.loads(text))
    except Exception:
        return None

def head_blob(path):
    try:
        return subprocess.check_output(
            ["git", "show", f"HEAD:{path}"], stderr=subprocess.DEVNULL
        ).decode("utf-8", "replace")
    except Exception:
        return None

def meaningful(path: str) -> bool:
    p = Path(path)
    if not p.is_file() or p.suffix.lower() != ".json":
        return True
    new_text = p.read_text(encoding="utf-8", errors="replace")
    old_text = head_blob(path)
    if old_text is None:
        return True
    a, b = load(old_text), load(new_text)
    if a is None or b is None:
        return True
    return a != b

staged = subprocess.check_output(
    ["git", "diff", "--cached", "--name-only", "-z"],
    stderr=subprocess.DEVNULL,
).decode("utf-8", "replace").split("\0")
staged = [s for s in staged if s]

kept = 0
for path in staged:
    if meaningful(path):
        kept += 1
        continue
    subprocess.run(
        ["git", "checkout", "HEAD", "--", path],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(f"commit-state: ignore timestamp-only {path}")

sys.exit(0 if kept else 1)
PY
}

stage "$@"
if git diff --cached --quiet; then
  echo "commit-state: aucun changement"
  exit 0
fi

if ! prune_timestamp_only; then
  echo "commit-state: uniquement des timestamps — pas de commit"
  exit 0
fi

if git diff --cached --quiet; then
  echo "commit-state: aucun changement utile"
  exit 0
fi

git commit -q -m "$MSG"
LOCAL_COMMIT="$(git rev-parse HEAD)"

save_recovery_patch() {
  local commit="${1:-$LOCAL_COMMIT}"
  local tmp="${RECOVERY_PATCH}.tmp.$$"
  mkdir -p "$(dirname "$RECOVERY_PATCH")"
  if git format-patch -1 --stdout "$commit" > "$tmp"; then
    mv -f -- "$tmp" "$RECOVERY_PATCH"
    echo "commit-state: patch local sauvegardé pour récupération: $RECOVERY_PATCH"
  else
    rm -f -- "$tmp"
    echo "::warning::commit-state: impossible de créer le patch de récupération"
    return 1
  fi
}

for i in $(seq 1 "$MAX"); do
  git fetch -q origin "$BRANCH"
  REMOTE_HEAD="$(git rev-parse --verify FETCH_HEAD)"
  if rebase_output="$(git rebase "$REMOTE_HEAD" 2>&1)"; then
    LOCAL_COMMIT="$(git rev-parse HEAD)"
    if git push -q origin "HEAD:$BRANCH"; then
      echo "commit-state: push OK (tentative $i) — $MSG"
      exit 0
    fi
  else
    conflict_paths="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
    save_recovery_patch "$LOCAL_COMMIT" || true
    git rebase --abort 2>/dev/null || true
    echo "::error::commit-state: rebase impossible sur origin/$BRANCH ($REMOTE_HEAD); aucun reset ni ecrasement distant effectue"
    if [ -n "$conflict_paths" ]; then
      echo "commit-state: chemins en conflit:"
      printf '%s\n' "$conflict_paths"
    else
      echo "commit-state: détail git rebase: ${rebase_output:-aucun détail fourni}"
    fi
    echo "commit-state: le runner est éphémère; récupérer le patch avant de relancer le producteur"
    exit 1
  fi
  sleep $(( i * 2 ))
done

save_recovery_patch "$LOCAL_COMMIT" || true
echo "::error::commit-state: push impossible apres $MAX tentatives — $MSG"
exit 1
