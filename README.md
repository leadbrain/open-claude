# open-claude

Discord channel plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Talk to Claude from Discord — messages, threads, file attachments, and scheduled tasks.

## What it does

- **Main channel**: Messages forwarded to your running Claude Code session
- **Threads**: Each thread gets an independent Claude session (auto-spawned)
- **Typing indicator**: Shows "typing..." while Claude processes
- **Access control**: Pairing codes for DMs, per-channel allowlists for servers
- **Slash commands**: `/clear`, `/compact`, `/restart`, `/enter`, `/esc`
- **Scheduled tasks**: Built-in cron scheduler for conversation analysis, indexing, etc.
- **CLAUDE.md template**: Persistent user context with auto-updating sections

## Architecture

```
Discord
  │
  ▼
server-http.ts (persistent HTTP server)
  ├─ Single Discord gateway connection
  ├─ Access control (gate)
  ├─ Built-in scheduler (jobs.json)
  ├─ Thread spawning (tmux)
  └─ Message queue per session
       │
       ▼ (HTTP polling)
proxy.ts (stdio, per session)
  ├─ Registers with server, polls /api/messages
  ├─ Delivers messages as claude/channel notifications
  └─ Proxies tool calls to server
       │
       ▼ (stdio)
Claude Code session
  ├─ Processes messages
  └─ Stop hook (auto-reply.sh) sends response to Discord
```

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (CLI)
- [Bun](https://bun.sh) (runtime)
- [tmux](https://github.com/tmux/tmux) (session management)
- [jq](https://jqlang.github.io/jq/) (JSON processing in hooks)
- A Discord bot token (or Lark app credentials)

## Setup

### 1. Create a Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. New Application → Bot → Reset Token → copy it
3. Enable **Privileged Gateway Intents**:
   - Message Content Intent (required)
   - Server Members Intent (optional)
4. Invite the bot: OAuth2 → URL Generator → scopes: `bot` + `applications.commands` → permissions: Send Messages, Read Message History, Add Reactions, Manage Messages, Use Slash Commands

### 2. Install and configure

```bash
# Install plugin
claude plugins marketplace add leadbrain/open-claude
claude plugins install open-claude@open-claude --scope project

# Run setup wizard
/open-claude:setup
```

The setup wizard creates:
- `.mcp.json` — proxy configuration
- `.claude/discord.env` — bot token and settings
- `.claude/discord/access.json` — access control with main channel
- `start-http.sh` — launch script

### 3. Start

```bash
./start-http.sh
```

This creates a tmux session with:
- **server** window: HTTP server + Discord connection
- **main** window: Claude Code session (auto-connects via proxy)

### 4. Pair your Discord account

1. DM the bot on Discord → get a pairing code
2. In Claude Code: `/open-claude:access pair <code>`

Or add directly: `/open-claude:access allow <your-discord-user-id>`

## Configuration

Bot token and channel settings are in `.claude/discord.env`:

```bash
DISCORD_BOT_TOKEN=MTIz...          # Bot token
DISCORD_MAIN_CHANNEL=123456789     # Main channel ID
OPEN_CLAUDE_WORKSPACE=/path/to/ws  # Workspace path
```

Optional settings (add to `.claude/discord.env`):
```bash
DISCORD_TMUX_SESSION=open-claude   # tmux session name (default: open-claude)
DISCORD_THREAD_MODEL=sonnet        # Model for thread sessions (default: sonnet)
DISCORD_EVENT_LOG=true             # Cross-session event logging (default: true)
DISCORD_LOG_THREAD=123456789       # Thread for cron job log copies
OPEN_CLAUDE_PORT=3100              # HTTP server port (default: 3100)
```

Manage settings: `/open-claude:configure`

## Access control

Quick reference:
- **Pair a user**: `/open-claude:access pair <code>`
- **Add to allowlist**: `/open-claude:access allow <user-id>`
- **Add a channel**: `/open-claude:access group add <channel-id>`
- **Check status**: `/open-claude:access status`

See [ACCESS.md](plugins/open-claude/ACCESS.md) for details.

## Scheduled jobs

Jobs are managed via `memory/jobs.json` and the built-in scheduler:

```bash
/open-claude:configure jobs list                                          # Show status
/open-claude:configure jobs enable conversation-analysis --channel <id>   # Enable daily analysis
/open-claude:configure jobs disable conversation-analysis                 # Disable
```

Available jobs:

| Feature | Description | Schedule |
|---------|-------------|----------|
| `conversation-analysis` | Daily conversation summary, updates user context | `30 21 * * *` |
| `qmd` | Transcript indexing + semantic search | on-demand |

The scheduler checks `memory/jobs.json` every 60 seconds and sends `[scheduled] /<name>` to the target channel when the cron expression matches.

## CLAUDE.md template

Setup generates a `CLAUDE.md` with persistent user context:

```bash
# Generated during /open-claude:setup
```

The `<!-- AUTO:recent-context -->` section is auto-updated by the conversation-analysis feature.

## Plugin structure

```
open-claude/
├── proxy.ts               # Stdio MCP proxy (per session)
├── server-http.ts         # Persistent HTTP server
├── server.ts              # Legacy stdio server (fallback)
├── core.ts                # Shared logic (tools, gate, dedup)
├── lib.ts                 # Pure functions (chunk, gate, cron)
├── platform.ts            # Platform adapter interface
├── adapters/
│   ├── discord.ts         # Discord adapter
│   └── lark.ts            # Lark adapter (experimental)
├── hooks/
│   ├── hooks.json         # Hook registrations
│   ├── auto-reply.sh      # Stop hook — send response to Discord
│   ├── track-channel.sh   # Submit hook — session tracking + typing
│   ├── typing-loop.sh     # Background typing indicator
│   └── platform-send.sh   # Platform-aware send functions
├── scripts/
│   ├── start-http.sh      # HTTP mode launcher
│   ├── start.sh           # Legacy stdio launcher
│   └── cron-runner.sh     # Legacy cron executor
├── skills/
│   ├── setup/SKILL.md
│   ├── configure/SKILL.md
│   ├── access/SKILL.md
│   ├── conversation-analysis/SKILL.md
│   └── qmd-index/SKILL.md
├── templates/
│   └── CLAUDE.md          # User context template
├── __tests__/             # 93 tests (bun test)
├── package.json
├── ACCESS.md
└── LICENSE
```

Runtime state (in your workspace):
```
.claude/discord/
├── access.json            # Access control
├── discord.env            # Bot config
└── dedup/                 # Message dedup locks
memory/
├── threads/{chat_id}.json # Session ↔ channel mapping
├── events/{date}.md       # Cross-session event log
├── jobs.json          # Scheduled jobs config
└── user-context.json      # User profile & preferences
```

## Troubleshooting

| Issue | Check |
|-------|-------|
| No response in Discord | `curl http://localhost:3100/health` — sessions > 0? |
| Messages dropped | Check `access.json` — is the channel in `groups`? Is `requireMention` false? |
| Typing never stops | `/tmp/open-claude-typing.pid` — PID still alive? |
| Thread not responding | Server log — `tmux capture-pane -t open-claude:server` |
| Proxy not connecting | `/tmp/open-claude-proxy.log` |

Debug logs:
- Server: `tmux capture-pane -t open-claude:server`
- Proxy: `/tmp/open-claude-proxy.log`
- Stop hook: `/tmp/open-claude-debug.log`
- Health: `curl http://localhost:3100/health`

## License

Apache-2.0
