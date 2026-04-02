# open-claude

Discord channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Talk to Claude from Discord — messages, threads, file attachments, and cron jobs.

## What it does

- **Main channel**: Messages forwarded to your running Claude Code session via MCP
- **Threads**: Each thread gets an independent `claude -p` session (auto-resumed)
- **Typing indicator**: Shows "typing..." while Claude processes
- **Access control**: Pairing codes for DMs, per-channel allowlists for servers
- **Slash commands**: `/clear`, `/compact`, `/restart`, `/enter`, `/esc` (requires tmux)
- **Skills**: `/open-claude:configure` and `/open-claude:access` for setup and access management
- **Cron jobs**: Run skills on a schedule, results sent to Discord threads

## Architecture

```
Discord Message
  │
  ▼
server.ts (MCP Server)
  ├─ Main channel → MCP notification → Claude Code session
  ├─ Thread → spawn claude -p (sonnet) → Stop hook sends response
  └─ Access gate (pairing / allowlist / mention check)
       │
       ▼
UserPromptSubmit Hook (track-channel.sh)
  ├─ Records session_id → chat_id mapping
  ├─ Starts typing loop
  └─ Injects cross-session events (optional)
       │
       ▼
Stop Hook (auto-reply.sh)
  ├─ Kills typing loop
  ├─ Routes response via session_id lookup
  ├─ Splits messages >2000 chars
  └─ Records event summary (optional)
```

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI)
- [Bun](https://bun.sh) (runtime for the MCP server)
- [jq](https://jqlang.github.io/jq/) (JSON processing in hooks)
- A Discord bot token

## Setup

### 1. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. New Application → Bot → Reset Token → copy it
3. Enable these **Privileged Gateway Intents**:
   - Message Content Intent
   - Server Members Intent (optional, for mentions)
4. Invite the bot to your server with these permissions:
   - Send Messages, Read Message History, Add Reactions, Manage Messages, Use Slash Commands

   OAuth2 URL scope: `bot` + `applications.commands`

### 2. Install and configure

```bash
# Install
claude plugins marketplace add leadbrain/open-claude
claude plugins install open-claude@open-claude

# Configure (in Claude Code)
/open-claude:configure <your-bot-token>
```

After install, **restart Claude Code** (exit and reopen) to load the plugin.

Alternative — load from local directory:
```bash
git clone https://github.com/leadbrain/open-claude
claude --plugin-dir ./open-claude
```

### 3. Pair your Discord account

1. DM the bot on Discord — you'll get a pairing code
2. In Claude Code: `/open-claude:access pair <code>`
3. Done! Send messages in your main channel or threads

## Configuration

Run `/open-claude:configure` in Claude Code, or edit `~/.claude/channels/discord/.env` directly:

```bash
# Required
DISCORD_BOT_TOKEN=MTIz...          # Bot token
DISCORD_MAIN_CHANNEL=123456789     # Main channel ID
DISCORD_WORKSPACE=/path/to/workspace

# Optional
DISCORD_TMUX_SESSION=claude        # tmux session for /clear, /restart, etc.
DISCORD_LOG_THREAD=123456789       # Thread for cron job log copies
DISCORD_THREAD_MODEL=sonnet        # Model for thread sessions (default: sonnet)
DISCORD_EVENT_LOG=true             # Enable cross-session event logging
DISCORD_PERMISSION_CHANNEL=123     # Channel for permission notifications
DISCORD_ACCESS_MODE=static         # Lock access config at boot
```

## Access control

Run `/open-claude:access` for interactive management, or see [ACCESS.md](ACCESS.md) for details.

Quick reference:
- **Pair a user**: `/open-claude:access pair <code>`
- **Add to allowlist**: `/open-claude:access allow <user-id>`
- **Add a channel**: `/open-claude:access group add <channel-id>`
- **Check status**: `/open-claude:access status`

## Cron jobs

Run skills on a schedule and send results to a Discord thread:

```bash
.claude/plugins/open-claude/scripts/cron-runner.sh <skill> <thread-id> [model] [timeout]
```

Example crontab:
```
30 7 * * * /path/to/workspace/.claude/plugins/open-claude/scripts/cron-runner.sh weather-briefing 1485223225737613362 haiku 120
```

## Plugin structure

```
open-claude/
├── .claude-plugin/
│   └── plugin.json         # Plugin metadata
├── .mcp.json               # MCP server config (auto-loaded)
├── hooks/
│   ├── hooks.json          # Hook registrations (auto-loaded)
│   ├── auto-reply.sh       # Stop hook — send response to Discord
│   ├── track-channel.sh    # Submit hook — session tracking + typing
│   └── typing-loop.sh      # Background typing indicator
├── skills/
│   ├── configure/SKILL.md  # /open-claude:configure
│   └── access/SKILL.md     # /open-claude:access
├── scripts/
│   └── cron-runner.sh      # Cron job executor
├── server.ts               # MCP server
├── package.json
├── README.md
├── ACCESS.md
└── LICENSE
```

Runtime state (in your workspace):
```
memory/
├── threads/{chat_id}.json  # Session ↔ channel mapping
└── events/{date}.md        # Cross-session event log (optional)
```

## Troubleshooting

| Issue | Check |
|-------|-------|
| No response in Discord | Plugin enabled? `claude plugins list` |
| Typing never stops | `/tmp/open-claude-typing.pid` — PID still alive? |
| Thread not responding | `DISCORD_WORKSPACE` correct in `.env`? |
| Permission errors | `~/.claude/channels/discord/` mode 700? |

Debug logs:
- Stop hook: `/tmp/open-claude-debug.log`
- Cron: `/tmp/open-claude-cron/<skill>-<timestamp>.log`
- MCP: Claude Code's MCP stderr

## License

Apache-2.0
