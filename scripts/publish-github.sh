#!/usr/bin/env bash
# Crea il repository GitHub (privato di default) e pubblica tutti i commit.
# Requisiti: GitHub CLI autenticata (gh auth login).
# Uso: ./scripts/publish-github.sh [nome-repo] [--public]
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=${1:-spesa-smart}
VISIBILITY=--private
[[ "${2:-}" == "--public" ]] && VISIBILITY=--public

command -v gh >/dev/null || { echo "Installa GitHub CLI: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || gh auth login

if git remote get-url origin >/dev/null 2>&1; then
  echo "Remote origin già presente: $(git remote get-url origin)"
  git push -u origin main
else
  gh repo create "$NAME" "$VISIBILITY" --source=. --remote=origin \
    --description "App Spesa Smart: confronto prezzi della lista della spesa (microservizi + Flutter)" --push
fi
echo "Fatto: $(gh repo view --json url -q .url)"
