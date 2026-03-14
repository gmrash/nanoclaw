#!/usr/bin/env bash
# Auto-commit and push uncommitted changes nightly
# Runs via systemd timer. Only commits if there are actual changes.

set -euo pipefail

PROJECT_DIR="/root/nanoclaw"
LOG_FILE="$PROJECT_DIR/logs/auto-commit.log"

cd "$PROJECT_DIR"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" >> "$LOG_FILE"
}

log "Checking for uncommitted changes..."

# Check if there are any changes
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  log "No changes to commit"
  exit 0
fi

# Stage all changes
git add -A

# Commit
CHANGED=$(git diff --cached --stat | tail -1)
git commit -m "chore: auto-commit $(date +%Y-%m-%d)

$CHANGED" >> "$LOG_FILE" 2>&1

# Push
git push origin main >> "$LOG_FILE" 2>&1 || {
  log "ERROR: push failed"
  exit 1
}

log "Auto-committed and pushed: $CHANGED"
