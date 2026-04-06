#!/bin/bash
# Refresh Claude OAuth token via official CLI
# Cron: 0 */6 * * *
# `claude auth status` auto-refreshes expired tokens and writes to ~/.claude/.credentials.json
# container-runner reads fresh accessToken from that file at each container start

LOG_FILE="/root/nanoclaw/logs/token-refresh.log"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG_FILE"; }

OUTPUT=$(claude auth status 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    log "ERROR: claude auth status failed (exit $EXIT_CODE): $OUTPUT"
    exit 1
fi

# Verify token is valid
if echo "$OUTPUT" | grep -q '"loggedIn": true'; then
    EXPIRES=$(python3 -c "
import json, time
creds = json.load(open('/root/.claude/.credentials.json'))
remaining = (creds['claudeAiOauth']['expiresAt'] / 1000 - time.time()) / 3600
print(f'{remaining:.1f}h')
" 2>/dev/null)
    log "OK: Token valid (expires in $EXPIRES)"
else
    log "ERROR: Not logged in: $OUTPUT"
    exit 1
fi
