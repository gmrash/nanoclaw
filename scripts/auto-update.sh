#!/usr/bin/env bash
# Auto-update NanoClaw from upstream
# Runs via systemd timer. Sends Telegram notification on update or failure.

set -euo pipefail

PROJECT_DIR="/root/nanoclaw"
LOG_FILE="$PROJECT_DIR/logs/auto-update.log"
ENV_FILE="$PROJECT_DIR/.env"

cd "$PROJECT_DIR"

# Load Telegram token from .env
TELEGRAM_BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT_ID="5060595922"

notify() {
  local msg="$1"
  if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="$CHAT_ID" \
      -d text="$msg" \
      -d parse_mode="Markdown" >/dev/null 2>&1 || true
  fi
}

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $1" >> "$LOG_FILE"
}

log "Checking for updates..."

# Fetch upstream
git fetch upstream main 2>>"$LOG_FILE" || {
  log "ERROR: git fetch failed"
  notify "⚠️ *NanoClaw auto-update*: git fetch upstream failed"
  exit 1
}

# Check if there are new commits from upstream
COMMIT_COUNT=$(git rev-list --count HEAD..upstream/main 2>/dev/null)

if [[ "$COMMIT_COUNT" -eq 0 ]]; then
  log "Already up to date"
  exit 0
fi

LOCAL=$(git rev-parse --short HEAD)
REMOTE=$(git rev-parse --short upstream/main)
NEW_COMMITS=$(git log --oneline HEAD..upstream/main 2>/dev/null | head -10)
log "Found $COMMIT_COUNT new commit(s)"

# Try to merge
if git merge upstream/main --no-edit 2>>"$LOG_FILE"; then
  log "Clean merge succeeded"
else
  log "Merge conflicts detected, trying --theirs strategy"
  git merge --abort 2>/dev/null || true

  if git merge -X theirs upstream/main --no-edit 2>>"$LOG_FILE"; then
    log "Merge with --theirs succeeded"
  else
    log "ERROR: Merge failed even with --theirs"
    git merge --abort 2>/dev/null || true
    notify "⚠️ *NanoClaw auto-update*: merge failed, manual intervention needed.

New commits:
\`\`\`
$NEW_COMMITS
\`\`\`"
    exit 1
  fi
fi

# Install deps and build
log "Installing dependencies..."
npm install --no-audit --no-fund 2>>"$LOG_FILE" || {
  log "ERROR: npm install failed"
  notify "⚠️ *NanoClaw auto-update*: npm install failed after merge"
  exit 1
}

log "Building..."
npm run build 2>>"$LOG_FILE" || {
  log "ERROR: build failed"
  notify "⚠️ *NanoClaw auto-update*: build failed after merge"
  exit 1
}

# Sync env to container
cp "$ENV_FILE" "$PROJECT_DIR/data/env/env" 2>/dev/null || true

# Restart service
log "Restarting service..."
systemctl restart nanoclaw 2>>"$LOG_FILE" || {
  log "ERROR: service restart failed"
  notify "⚠️ *NanoClaw auto-update*: service restart failed"
  exit 1
}

log "Update complete: $LOCAL -> $(git rev-parse --short HEAD)"

notify "✅ *NanoClaw обновлён* ($COMMIT_COUNT коммит(ов))

$NEW_COMMITS"
