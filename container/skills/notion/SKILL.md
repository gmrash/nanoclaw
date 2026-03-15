---
name: notion
description: Access Notion workspace — search, read, create, and update pages and databases. Use whenever the user mentions Notion, notes, wiki, or knowledge base.
allowed-tools: Bash(node:*),Bash(curl:*)
---

# Notion Integration

## Credentials
Token stored at: `/workspace/shared-credentials/notion/credentials.json`

```js
const creds = require('/workspace/shared-credentials/notion/credentials.json');
const NOTION_TOKEN = creds.token;
```

## API Usage

Base URL: `https://api.notion.com/v1`

Headers for all requests:
```bash
-H "Authorization: Bearer ${NOTION_TOKEN}" \
-H "Notion-Version: 2022-06-28" \
-H "Content-Type: application/json"
```

### Search pages and databases
```bash
curl -s -X POST "https://api.notion.com/v1/search" \
  -H "Authorization: Bearer NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"query": "search term", "page_size": 10}'
```

### Get a page
```bash
curl -s "https://api.notion.com/v1/pages/PAGE_ID" \
  -H "Authorization: Bearer NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28"
```

### Get page content (blocks)
```bash
curl -s "https://api.notion.com/v1/blocks/PAGE_ID/children?page_size=100" \
  -H "Authorization: Bearer NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28"
```

### Query a database
```bash
curl -s -X POST "https://api.notion.com/v1/databases/DB_ID/query" \
  -H "Authorization: Bearer NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"page_size": 50}'
```

### Create a page
```bash
curl -s -X POST "https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"database_id": "DB_ID"},
    "properties": {
      "Name": {"title": [{"text": {"content": "New page title"}}]}
    }
  }'
```

### Update a page
```bash
curl -s -X PATCH "https://api.notion.com/v1/pages/PAGE_ID" \
  -H "Authorization: Bearer NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"Status": {"select": {"name": "Done"}}}}'
```

### Append blocks to a page
```bash
curl -s -X PATCH "https://api.notion.com/v1/blocks/PAGE_ID/children" \
  -H "Authorization: Bearer NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "children": [
      {"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "Text here"}}]}}
    ]
  }'
```

## Tips
- The integration only sees pages/databases that have been explicitly shared with it (via "Connect to" in Notion)
- Use `search` first to discover available pages and databases
- Page IDs can be extracted from Notion URLs: `notion.so/Page-Title-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` — the last 32 hex chars are the ID (add dashes to make UUID format)
- For large databases, use pagination with `start_cursor` from the response
- Prefer curl for API calls — no extra dependencies needed
