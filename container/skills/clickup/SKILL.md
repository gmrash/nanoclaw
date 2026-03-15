---
name: clickup
description: Access ClickUp workspace — manage tasks, lists, spaces, and projects. Use whenever the user mentions ClickUp, задачи в кликапе, таски, спринты, or project management.
allowed-tools: Bash(curl:*)
---

# ClickUp Integration

## Credentials
Token stored at: `/workspace/shared-credentials/clickup/credentials.json`

```bash
TOKEN=$(cat /workspace/shared-credentials/clickup/credentials.json | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).access_token)")
```

## API Usage

Base URL: `https://api.clickup.com/api/v2`

### Get teams (workspaces)
```bash
curl -s "https://api.clickup.com/api/v2/team" -H "Authorization: Bearer $TOKEN"
```

### Get spaces in a team
```bash
curl -s "https://api.clickup.com/api/v2/team/TEAM_ID/space" -H "Authorization: Bearer $TOKEN"
```

### Get folders in a space
```bash
curl -s "https://api.clickup.com/api/v2/space/SPACE_ID/folder" -H "Authorization: Bearer $TOKEN"
```

### Get lists in a folder
```bash
curl -s "https://api.clickup.com/api/v2/folder/FOLDER_ID/list" -H "Authorization: Bearer $TOKEN"
```

### Get tasks in a list
```bash
curl -s "https://api.clickup.com/api/v2/list/LIST_ID/task" -H "Authorization: Bearer $TOKEN"
```

### Get a single task
```bash
curl -s "https://api.clickup.com/api/v2/task/TASK_ID" -H "Authorization: Bearer $TOKEN"
```

### Create a task
```bash
curl -s -X POST "https://api.clickup.com/api/v2/list/LIST_ID/task" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Task name", "description": "Details", "priority": 3, "status": "to do"}'
```

### Update a task
```bash
curl -s -X PUT "https://api.clickup.com/api/v2/task/TASK_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Updated name", "status": "in progress"}'
```

### Add comment to a task
```bash
curl -s -X POST "https://api.clickup.com/api/v2/task/TASK_ID/comment" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"comment_text": "Comment here"}'
```

### Search tasks
```bash
curl -s "https://api.clickup.com/api/v2/team/TEAM_ID/task?statuses[]=to%20do&statuses[]=in%20progress" \
  -H "Authorization: Bearer $TOKEN"
```

## Priority values
- 1 = Urgent
- 2 = High
- 3 = Normal
- 4 = Low

## Tips
- Start with `GET /team` to discover workspace/team IDs
- Then drill down: team → spaces → folders → lists → tasks
- Task IDs are alphanumeric strings (e.g., "abc123")
- User: Эмиль Гайнанов (gainanov@medods.ru)
- OAuth token does not expire
