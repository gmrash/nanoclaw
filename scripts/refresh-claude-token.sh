#!/bin/bash
set -euo pipefail

# Refresh Claude OAuth token via a real Claude CLI request.
# Cron: 0 */6 * * *
# container-runner reads fresh accessToken from ~/.claude/.credentials.json

LOG_FILE="/root/nanoclaw/logs/token-refresh.log"
CREDENTIALS_FILE="/root/.claude/.credentials.json"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG_FILE"; }

get_expires_ms() {
  python3 - "$CREDENTIALS_FILE" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    creds = json.load(f)
print(int(creds["claudeAiOauth"]["expiresAt"]))
PY
}

format_remaining_hours() {
  python3 - "$1" <<'PY'
import sys, time
expires_ms = int(sys.argv[1])
print(f"{(expires_ms / 1000 - time.time()) / 3600:.1f}h")
PY
}

if [ ! -f "$CREDENTIALS_FILE" ]; then
  log "ERROR: Missing credentials file at $CREDENTIALS_FILE"
  exit 1
fi

BEFORE_EXPIRES_MS=$(get_expires_ms)
if OUTPUT=$(timeout 90 claude -p "Reply with exactly OK." --output-format text --no-session-persistence --allowedTools "" 2>&1); then
  :
else
  EXIT_CODE=$?
  OUTPUT_ONE_LINE=$(printf '%s' "$OUTPUT" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
  log "ERROR: claude refresh probe failed (exit $EXIT_CODE): $OUTPUT_ONE_LINE"
  exit 1
fi

AFTER_EXPIRES_MS=$(get_expires_ms)
NOW_MS=$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)

if [ "$AFTER_EXPIRES_MS" -le "$NOW_MS" ]; then
  log "ERROR: Claude probe succeeded but credentials are still expired"
  exit 1
fi

REMAINING=$(format_remaining_hours "$AFTER_EXPIRES_MS")

if [ "$AFTER_EXPIRES_MS" -gt "$BEFORE_EXPIRES_MS" ]; then
  log "REFRESHED: Token extended (expires in $REMAINING)"
else
  log "OK: Token still valid (expires in $REMAINING)"
fi
