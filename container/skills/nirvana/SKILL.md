---
name: nirvana
description: Manage NirvanaHQ tasks — list, create, complete, move, search, and edit tasks and projects. Use whenever the user mentions tasks, to-dos, or NirvanaHQ.
allowed-tools: Bash(nirvana:*)
---

# NirvanaHQ Task Manager

## Quick start

```bash
nirvana list next          # Show Next tasks
nirvana list inbox         # Show Inbox
nirvana list focus         # Show starred/focused tasks
nirvana tagged "high priority"  # Tasks with high priority tag
nirvana tags               # List all tags/contexts
nirvana add "Buy groceries" --due 2025-03-20
nirvana complete abc12345  # Complete by ID prefix
nirvana search meeting     # Search by name
```

## Commands

| Command | Description |
|---------|-------------|
| `nirvana list [state]` | List tasks. States: inbox, next, waiting, scheduled, someday, done, focus, all |
| `nirvana projects` | List active projects |
| `nirvana search <query>` | Search tasks by name |
| `nirvana tags` | List all tags and contexts |
| `nirvana tagged <tag>` | List tasks with a specific tag/context |
| `nirvana add <name> [opts]` | Add task. Options: `--note`, `--state`, `--due YYYY-MM-DD`, `--start YYYY-MM-DD`, `--project ID` |
| `nirvana complete <id>` | Mark task as done |
| `nirvana move <id> <state>` | Move task to another state |
| `nirvana edit <id> [opts]` | Edit task. Options: `--name`, `--note`, `--due`, `--start` |
| `nirvana delete <id>` | Trash a task |
| `nirvana show <id>` | Show full task details |

## Task IDs

Use the first 8 characters of the UUID shown in list/search output.

## States

inbox, next, waiting, scheduled, someday, later, done, focus

- `focus` shows starred/focused tasks (sorted by priority)

## Tags / Contexts

Tasks can have tags (called "Contexts" in NirvanaHQ UI). Tags are shown in [brackets] in list output.

- When user asks for "high priority" or "приоритетные" tasks → use `nirvana tagged "high priority"`
- Tags are case-insensitive in filtering

## Tips

- New tasks go to Inbox by default. Use `--state next` to add directly to Next.
- When listing, `all` shows all active tasks (inbox through later).
- Completing a task sets state to "done" with current timestamp.
- All task output now includes tags in [brackets] when present.
