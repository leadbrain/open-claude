# open-claude

Discord channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Talk to Claude from Discord — messages, threads, file attachments, and cron jobs.

## What it does

- **Main channel**: Messages forwarded to your running Claude Code session via MCP
- **Threads**: Each thread gets an independent `claude -p` session (auto-resumed)
- **Typing indicator**: Shows "typing..." while Claude processes
- **Access control**: Pairing codes for DMs, per-channel allowlists for servers
- **Slash commands**: `/clear`, `/compact`, `/restart`, `/enter`, `/esc` (requires tmux)
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
   - Send Messages
   - Read Message History
   - Add Reactions
   - Manage Messages (for editing)
   - Use Slash Commands

   OAuth2 URL scope: `bot` + `applications.commands`

### 2. Install the plugin

```bash
cd /path/to/your/workspace
git clone https://github.com/leadbrain/open-claude .claude/plugins/open-claude
.claude/plugins/open-claude/setup.sh
```

The setup script will:
- Ask for your bot token and main channel ID
- Install dependencies (bun)
- Register the MCP server in `.mcp.json`
- Symlink hooks to `.claude/hooks/`
- Configure `settings.json` with hook registrations
- Create `memory/threads/` and `memory/events/` directories

### 3. Start Claude Code

```bash
cd /path/to/your/workspace
claude
```

The MCP server starts automatically when Claude Code loads.

## Configuration

All config lives in `~/.claude/channels/discord/.env`:

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
DISCORD_ACCESS_MODE=static         # Lock access config at boot (no runtime changes)
```

## Access control

Access is managed via `~/.claude/channels/discord/access.json`:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["discord-user-id"],
  "groups": {
    "channel-id": {
      "requireMention": true,
      "allowFrom": []
    }
  }
}
```

**DM Policies:**
- `pairing` (default): Unknown users get a pairing code to approve
- `allowlist`: Only users in `allowFrom` can DM
- `disabled`: DMs blocked entirely

**Guild channels:**
- Add channel ID to `groups` to opt in
- `requireMention: true` — bot only responds when @mentioned or replied to
- `allowFrom: []` — empty means anyone in the channel; add user IDs to restrict

**Delivery settings** (optional in access.json):
- `ackReaction`: Emoji to react with on receipt (e.g., `"👀"`)
- `replyToMode`: `"first"` (default), `"all"`, or `"off"`
- `textChunkLimit`: Max chars per message (default/max: 2000)
- `chunkMode`: `"length"` (hard cut) or `"newline"` (prefer paragraph boundaries)

## Cron jobs

Run skills on a schedule and send results to a Discord thread:

```bash
# Usage
.claude/plugins/open-claude/scripts/cron-runner.sh <skill> <thread-id> [model] [timeout]

# Example crontab entry
30 7 * * * /path/to/workspace/.claude/plugins/open-claude/scripts/cron-runner.sh weather-briefing 1485223225737613362 haiku 120
```

The cron runner:
1. Looks up existing session for the thread (resumes if found)
2. Runs the skill via `claude -p`
3. Stop hook routes the response to the Discord thread
4. Falls back to direct curl if no session to resume

## File structure

```
.claude/plugins/open-claude/    # Plugin code (this repo)
├── server.ts                   # MCP server
├── hooks/                      # Hook scripts
│   ├── auto-reply.sh           # Stop hook — send response to Discord
│   ├── track-channel.sh        # Submit hook — session tracking + typing
│   └── typing-loop.sh          # Background typing indicator
├── scripts/
│   └── cron-runner.sh          # Cron job executor
├── setup.sh                    # Installer
├── package.json
└── README.md

memory/                         # Runtime state (in workspace root)
├── threads/{chat_id}.json      # Session ↔ channel mapping
└── events/{date}.md            # Cross-session event log (optional)

~/.claude/channels/discord/     # User-local config
├── .env                        # Bot token, workspace path, options
├── access.json                 # Access control rules
├── inbox/                      # Downloaded attachments
└── dedup/                      # Message dedup locks
```

## Troubleshooting

- **Debug log**: `/tmp/open-claude-debug.log` (Stop hook)
- **Typing PID**: `/tmp/open-claude-typing.pid`
- **Cron logs**: `/tmp/open-claude-cron/<skill>-<timestamp>.log`
- **MCP server**: stderr goes to Claude Code's MCP log

Common issues:
- **No response in Discord**: Check that Stop hook is registered in `settings.json`
- **Typing never stops**: Check if `auto-reply.sh` is killing the typing PID
- **Thread not responding**: Verify `DISCORD_WORKSPACE` points to the right directory
- **Permission errors**: Ensure `~/.claude/channels/discord/` has mode 700

## License

Apache-2.0
