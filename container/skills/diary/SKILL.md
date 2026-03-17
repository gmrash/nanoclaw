---
name: diary
description: Access user's personal diary stored in GitHub repo gmrash/diary. Use when user mentions дневник, diary, записи, journal, or wants to read/search past entries.
allowed-tools: Bash(curl:*)
---

# Personal Diary (GitHub)

Read-only access to user's personal diary at `gmrash/diary`.

## Credentials
Token stored at: `/workspace/shared-credentials/github/credentials.json`

```bash
TOKEN=$(cat /workspace/shared-credentials/github/credentials.json | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).token)")
```

## API Usage

### List files in repo root
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/gmrash/diary/contents/"
```

### List files in a directory
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/gmrash/diary/contents/PATH"
```

### Read a file (decoded content)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github.raw+json" \
  "https://api.github.com/repos/gmrash/diary/contents/PATH/TO/FILE"
```

### Search file contents
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/search/code?q=QUERY+repo:gmrash/diary"
```

### Get recent commits (to find latest entries)
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/gmrash/diary/commits?per_page=10"
```

## Tips
- This is READ-ONLY access — do not attempt to write/push
- First explore the repo structure (list root) to understand how entries are organized
- Use search to find entries by keyword
- Use commits to find the most recent entries
- Content may be in Russian
- This is private/personal data — treat with care, don't share outside the conversation
