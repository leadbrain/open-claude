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

## Messaging Platforms

open-claude supports Discord and Lark simultaneously. The server auto-detects platforms from credentials in `.claude/discord.env`. To add a platform, add its credentials and restart the server.

- **Discord**: `DISCORD_BOT_TOKEN` in `.claude/discord.env`
- **Lark**: `LARK_APP_ID` + `LARK_APP_SECRET` in `.claude/discord.env` (uses WebSocket, no public URL needed)

## Scheduled Jobs

Jobs are stored in `memory/jobs.json`. Any skill can be scheduled. Manage with:
- `/open-claude:configure jobs list` — show status
- `/open-claude:configure jobs enable <name> --channel <id> --schedule "cron"` — activate
- `/open-claude:configure jobs disable <name>` — deactivate

Built-in jobs:
- **conversation-analysis** — daily conversation summary, updates `memory/user-context.json` and the Recent Context section below
- **qmd** — index conversation transcripts for search (requires `/opt/homebrew/bin/qmd`)

Skills for jobs must be in `.claude/skills/` (project scope), not `~/.claude/skills/`.

## Recent Context
<!-- AUTO:recent-context -->
*This section is auto-updated by the conversation-analysis job.*
*Enable with: `/open-claude:configure jobs enable conversation-analysis --channel <id>`*

No context available yet.
<!-- /AUTO:recent-context -->
