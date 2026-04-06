# Assistant Configuration

This file provides persistent context for Claude across sessions. Edit freely — only the `AUTO:recent-context` section is updated automatically.

---

## User Profile

- **Name**: 
- **Timezone**: 
- **Language**: en

## Principles

- **Communication style**: (concise / detailed / casual / formal)
- **Autonomy level**: (ask before acting / act then report / full autonomy for internal work)
- **When uncertain**: (ask / best guess and flag / proceed and report)
- **Response language**: (match user / always English / always [other])

## Workflows

### Jobs Jobs Features & Scheduling Scheduling Scheduling
Feature state is stored in `memory/jobs.json`. Manage with:
- `/open-claude:configure jobs list` — show status
- `/open-claude:configure jobs enable <name> --channel <id>` — activate
- `/open-claude:configure jobs disable <name>` — deactivate

Available jobs:
- **conversation-analysis** — daily conversation summary, updates `memory/user-context.json` and the Recent Context section below
- **qmd** — index conversation transcripts for search (requires `/opt/homebrew/bin/qmd`)

The built-in scheduler (in server-http.ts) checks `memory/jobs.json` every 60 seconds and sends `[scheduled] /<name>` to the target channel when the cron expression matches.

## Recent Context
<!-- AUTO:recent-context -->
*This section is auto-updated by the conversation-analysis feature.*
*Enable with: `/open-claude:configure jobs enable conversation-analysis --channel <id>`*

No context available yet.
<!-- /AUTO:recent-context -->
