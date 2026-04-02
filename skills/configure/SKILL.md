---
name: configure
description: Set up the Discord channel — save the bot token and configure options. Use when the user pastes a Discord bot token, asks to configure Discord, or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /open-claude:configure — Discord Channel Setup

Writes the bot token and config to `~/.claude/channels/discord/.env` and orients the user on access policy.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Token** — check `~/.claude/channels/discord/.env` for `DISCORD_BOT_TOKEN`. Show set/not-set; if set, show first 6 chars masked.

2. **Config** — show current settings:
   - `DISCORD_MAIN_CHANNEL` — main channel ID
   - `DISCORD_WORKSPACE` — workspace path
   - `DISCORD_TMUX_SESSION` — tmux session name (optional)
   - `DISCORD_THREAD_MODEL` — model for thread sessions (default: sonnet)
   - `DISCORD_EVENT_LOG` — cross-session event logging (true/false)
   - `DISCORD_LOG_THREAD` — log thread for cron jobs (optional)

3. **Access** — read `~/.claude/channels/discord/access.json` (missing file = defaults). Show DM policy, allowlist count, group count.

4. **Next steps** — tell the user what to do next.

### Token provided — save it

If `$ARGUMENTS` looks like a Discord bot token (starts with letters, has dots):

1. Create `~/.claude/channels/discord/` with mode 700 if missing
2. Write or update `.env`:
   ```
   DISCORD_BOT_TOKEN=<token>
   DISCORD_MAIN_CHANNEL=<ask if not set>
   DISCORD_WORKSPACE=<current workspace>
   ```
3. Set file mode 600
4. Tell the user to restart Claude Code to connect

### Setting a specific option

If `$ARGUMENTS` is like `main_channel 123456` or `tmux_session claude`:

1. Read existing `.env`
2. Update the relevant variable
3. Write back
4. Confirm

## Environment file format

```bash
# Required
DISCORD_BOT_TOKEN=MTIz...
DISCORD_MAIN_CHANNEL=123456789
DISCORD_WORKSPACE=/path/to/workspace

# Optional
DISCORD_TMUX_SESSION=claude
DISCORD_LOG_THREAD=123456789
DISCORD_THREAD_MODEL=sonnet
DISCORD_EVENT_LOG=true
DISCORD_PERMISSION_CHANNEL=123456789
```

## Important

- Never show the full bot token — mask all but first 6 chars
- The `.env` file must have mode 600 (owner read/write only)
- The directory must have mode 700
- After any token change, tell the user to restart Claude Code
