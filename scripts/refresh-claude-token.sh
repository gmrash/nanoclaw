#!/bin/bash
# Refresh Claude OAuth token
# Cron: 0 */6 * * *
# Updates /root/.claude/.credentials.json — container-runner reads fresh accessToken from it

CREDS_FILE="/root/.claude/.credentials.json"
LOG_FILE="/root/nanoclaw/logs/token-refresh.log"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$LOG_FILE"; }

# Read current refresh token
REFRESH_TOKEN=$(python3 -c "
import json
creds = json.load(open('$CREDS_FILE'))
print(creds['claudeAiOauth']['refreshToken'])
" 2>/dev/null)

if [ -z "$REFRESH_TOKEN" ]; then
    log "ERROR: Could not read refresh token from $CREDS_FILE"
    exit 1
fi

# Exchange refresh token for new access token
RESPONSE=$(curl -s -X POST https://platform.claude.com/v1/oauth/token \
    -H "Content-Type: application/json" \
    -d "{
        \"grant_type\": \"refresh_token\",
        \"refresh_token\": \"$REFRESH_TOKEN\",
        \"client_id\": \"9d1c250a-e61b-44d9-88ed-5944d1962f5e\"
    }" 2>/dev/null)

# Parse response — extract access_token or error
PARSE_RESULT=$(echo "$RESPONSE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'error' in d:
    msg = d['error'].get('message', str(d['error'])) if isinstance(d['error'], dict) else str(d['error'])
    print('ERR:' + msg)
else:
    at = d['access_token']
    rt = d.get('refresh_token', '')
    ex = d.get('expires_in', 28800)
    print('OK:' + at + ':' + rt + ':' + str(ex))
" 2>/dev/null)

if [ -z "$PARSE_RESULT" ]; then
    log "ERROR: Failed to parse response: $RESPONSE"
    exit 1
fi

case "$PARSE_RESULT" in
    ERR:*)
        log "ERROR: Token refresh failed: ${PARSE_RESULT#ERR:}"
        exit 1
        ;;
    OK:*)
        IFS=':' read -r _ NEW_ACCESS NEW_REFRESH EXPIRES_IN <<< "$PARSE_RESULT"
        ;;
    *)
        log "ERROR: Unexpected parse result: $PARSE_RESULT"
        exit 1
        ;;
esac

if [ -z "$NEW_ACCESS" ]; then
    log "ERROR: Empty access token"
    exit 1
fi

# Keep old refresh token if new one not provided
if [ -z "$NEW_REFRESH" ]; then
    NEW_REFRESH="$REFRESH_TOKEN"
fi

# Update credentials.json
python3 << PYEOF
import json, time

with open('$CREDS_FILE') as f:
    creds = json.load(f)

creds['claudeAiOauth']['accessToken'] = '${NEW_ACCESS}'
creds['claudeAiOauth']['refreshToken'] = '${NEW_REFRESH}'
creds['claudeAiOauth']['expiresAt'] = int((time.time() + ${EXPIRES_IN:-28800}) * 1000)

with open('$CREDS_FILE', 'w') as f:
    json.dump(creds, f, indent=2)
PYEOF

if [ $? -ne 0 ]; then
    log "ERROR: Failed to write credentials to $CREDS_FILE"
    exit 1
fi

log "OK: Token refreshed (expires_in=${EXPIRES_IN}s)"
