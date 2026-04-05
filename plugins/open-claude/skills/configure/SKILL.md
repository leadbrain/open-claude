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

### `features` — manage optional features

Dispatch based on subcommand:

### `features list` — show available features

Read `memory/features.json` (create with `{}` if missing). Show:

| Feature | Status | Schedule | Channel |
|---------|--------|----------|---------|
| conversation-analysis | enabled/disabled | cron expression or — | channel ID or — |
| qmd | enabled/disabled | — | — |

For `qmd`, also check if `/opt/homebrew/bin/qmd` exists and note if missing.

### `features enable <name> [--channel <id>] [--schedule <cron>]`

1. Read `memory/features.json` (create if missing)
2. Based on feature name:

**conversation-analysis**:
- Requires `--channel <id>` (Discord thread/channel for results)
- Default schedule: `30 21 * * *` (21:30 daily)
- Set `{ "enabled": true, "schedule": "<cron>", "targetChannel": "<id>" }`
- Create `memory/user-context.json` if it doesn't exist (initial empty structure)
- Output: "Conversation analysis enabled. Results will be posted to <channel> at <schedule>."
- Remind: "Restart Claude Code for the scheduler to pick up changes."

**qmd**:
- Check `/opt/homebrew/bin/qmd` exists — if not, warn and stop
- Set `{ "enabled": true }`
- Output: "QMD search enabled. The `search` tool is now available. Run `/qmd-index` to index existing conversations."
- Remind: "Restart Claude Code for the search tool to appear."

3. Write updated `memory/features.json`

### `features disable <name>`

1. Read `memory/features.json`
2. Set `enabled: false` for the feature
3. Write
4. Confirm: "<name> disabled. Restart Claude Code to apply."

## Important

- Never show the full bot token
- Always preserve file permissions (600 for .env, 700 for directory)
- After any change, remind: "Restart Claude Code to apply changes."
- For features, always validate the feature name against the known list
