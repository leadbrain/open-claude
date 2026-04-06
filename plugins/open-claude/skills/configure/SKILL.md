---
name: configure
description: View or update Discord channel configuration. Use when the user wants to check status, change settings, or update the bot token.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /open-claude:configure — View & Update Configuration

Quick configuration management. For first-time setup, suggest `/open-claude:setup` instead.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — show status

Read `.claude/discord.env` and `.claude/discord/access.json` (project-local).

Show a concise status:
- **Token**: set/not set (mask: first 6 chars + `...`)
- **Main channel**: ID or "not set"
- **Workspace**: path or "not set"
- **Optional settings**: only show if set (tmux session, event log, thread model, log thread)
- **Access**: DM policy, allowlist count, group count

If no .env exists, say:
> No configuration found. Run `/open-claude:setup` for guided first-time setup.

### `token <value>` — update bot token

1. Read existing .env (or create new)
2. Replace DISCORD_BOT_TOKEN line
3. Write with mode 600
4. Confirm (masked)

### `main_channel <id>` — update main channel

1. Read existing .env
2. Replace DISCORD_MAIN_CHANNEL line
3. Write
4. Confirm

### `workspace <path>` — update workspace path

1. Read existing .env
2. Replace DISCORD_WORKSPACE line
3. Write
4. Confirm

### `<key> <value>` — set any optional setting

Supported keys: `tmux_session`, `thread_model`, `event_log`, `log_thread`, `permission_channel`

Maps to env vars:
- `tmux_session` → `DISCORD_TMUX_SESSION`
- `thread_model` → `DISCORD_THREAD_MODEL`
- `event_log` → `DISCORD_EVENT_LOG`
- `log_thread` → `DISCORD_LOG_THREAD`
- `permission_channel` → `DISCORD_PERMISSION_CHANNEL`

1. Read existing .env
2. Add or update the line
3. Write
4. Confirm

### `reset` — remove configuration

1. Confirm with the user
2. Delete `.claude/discord.env`
3. Confirm

### `jobs` — manage scheduled jobs

The built-in scheduler runs any skill on a cron schedule. Jobs are stored in `memory/jobs.json`. Each job has a name (matching a skill), schedule (cron expression), and target channel.

**Any skill can be a job** — not just the built-in ones. If you create a custom skill `/my-report`, you can schedule it as a job.

Dispatch based on subcommand:

### `jobs list` — show all jobs

Read `memory/jobs.json` (create with `{}` if missing). Show all entries:

| Job | Status | Schedule | Channel |
|-----|--------|----------|---------|
| conversation-analysis | enabled/disabled | cron expression or — | channel ID or — |
| qmd | enabled/disabled | — | — |
| *(any custom jobs)* | | | |

### `jobs enable <name> [--channel <id>] [--schedule <cron>]`

1. Read `memory/jobs.json` (create if missing)
2. Set `{ "enabled": true, "schedule": "<cron>", "targetChannel": "<id>" }`
3. Write updated `memory/jobs.json`

The scheduler sends `[scheduled] /<name>` to the target channel at the scheduled time. The session runs the matching skill.

**Built-in defaults:**
- `conversation-analysis` — default schedule `30 21 * * *`, requires `--channel`
- `qmd` — no schedule (on-demand only), just `{ "enabled": true }`

**Custom job example:**
```
/open-claude:configure jobs enable my-report --channel 123456 --schedule "0 9 * * 1"
```
This runs `/my-report` every Monday at 9:00 in channel 123456.

### `jobs disable <name>`

1. Read `memory/jobs.json`
2. Set `enabled: false` for the job
3. Write
4. Confirm: "<name> disabled."

## Important

- Never show the full bot token
- Always preserve file permissions (600 for .env, 700 for directory)
- After any change, remind: "Restart Claude Code to apply changes."
- For features, always validate the job name against the known list
