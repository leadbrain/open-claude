---
name: setup
description: Interactive first-time setup wizard for open-claude. Guides the user step-by-step through Discord bot creation, token configuration, and pairing. Use when the user runs /open-claude:setup or says "set up Discord" or "connect Discord".
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
  - Bash(bun *)
  - Bash(which *)
  - Bash(source *)
  - Bash(echo *)
  - Bash(grep *)
  - Bash(cat *)
  - Bash(jq *)
---

# /open-claude:setup — Interactive Setup Wizard

Walk the user through setting up open-claude step by step. Be friendly, clear, and check each step before moving to the next.

Arguments passed: `$ARGUMENTS`

---

## Step 1: Check prerequisites

Check if `bun`, `jq`, and `tmux` are available in PATH:
```bash
which bun
which jq
which tmux
```

If `bun` is not found:
1. Check if it's installed but not in PATH:
   ```bash
   ls ~/.bun/bin/bun 2>/dev/null || ls /usr/local/bin/bun 2>/dev/null
   ```
2. If found but not in PATH, add it:
   ```bash
   echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.zshrc
   echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.zshrc
   source ~/.zshrc
   ```
   Then verify: `bun --version`
3. If not installed at all, tell the user:
   > Run this in your terminal: `curl -fsSL https://bun.sh/install | bash`
   > Then restart Claude Code (the shell needs to pick up the new PATH).

If `jq` is not found:
- **macOS**: `brew install jq`
- **Linux**: `apt install jq` or `yum install jq`

If `tmux` is not found:
- **macOS**: `brew install tmux`
- **Linux**: `apt install tmux` or `yum install tmux`

tmux is required — the HTTP server and Claude Code sessions run in separate tmux windows.

If all three are installed, say so and move on.

## Step 2: Check existing configuration

Read `.mcp.json` in the workspace root. If it has an `open-claude` entry:
- Show status (mask the token: first 6 chars + `...`, show mode: stdio/http)
- Ask: "Already configured! Want to reconfigure, or skip to pairing?"
- If skip → jump to Step 6

If no config exists, continue to Step 3.

## Step 3: Platform selection

Ask:
> **Which messaging platform?**
> 1. **Discord** (default)
> 2. **Lark (Feishu)**

### Discord

> **Create a Discord bot (if you haven't already):**
>
> 1. Go to https://discord.com/developers/applications
> 2. Click **New Application** → give it a name → **Create**
> 3. Go to **Bot** tab → click **Reset Token** → **Copy** the token
> 4. Under **Privileged Gateway Intents**, enable:
>    - **Message Content Intent** (required)
>    - **Server Members Intent** (optional, helps with mentions)
> 5. Go to **OAuth2** → **URL Generator**:
>    - Scopes: `bot`, `applications.commands`
>    - Bot Permissions: Send Messages, Read Message History, Add Reactions, Manage Messages, Use Slash Commands
>    - Copy the generated URL and open it to invite the bot to your server
>
> **Paste your bot token here when ready.**

Then wait for the user's response. The token typically starts with letters and contains two dots.

### Lark (Feishu)

> **Create a Lark app:**
>
> 1. Go to [Lark Developer Console](https://open.larksuite.com/app)
> 2. Create New App → get **App ID** and **App Secret**
> 3. Under **Bot**, enable the bot capability
> 4. Under **Permissions**, add: `im:message`, `im:message:send_as_bot`, `im:resource`, `im:chat`
> 5. Under **Event Subscriptions**, select **Use long connection** (WebSocket mode)
> 6. Add event: `im.message.receive_v1`
> 7. Publish the app
>
> **Paste your App ID and App Secret when ready.**

Then wait for both values.

## Step 4: Save configuration

Ask for the **main channel/chat ID**:

For Discord:
> Right-click the channel in Discord → **Copy Channel ID**

For Lark:
> Open the chat, click the chat name → **Copy Chat ID** from the URL or settings

Once credentials and channel ID are provided:

1. Write the workspace `.mcp.json`:

```json
{
  "mcpServers": {
    "open-claude": {
      "command": "bun",
      "args": ["${CLAUDE_PLUGIN_ROOT}/proxy.ts"],
      "env": {
        "OPEN_CLAUDE_SERVER": "http://localhost:3100",
        "DISCORD_MAIN_CHANNEL": "<main channel/chat ID>",
        "DISCORD_BOT_TOKEN": "<Discord bot token, if using Discord>",
        "OPEN_CLAUDE_WORKSPACE": "<workspace path (pwd)>"
      }
    }
  }
}
```

**Important**: Do NOT put `OPEN_CLAUDE_CHAT_ID` in `.mcp.json` — it is set via shell env per session so threads get their own channel binding.

**Important**: If `.mcp.json` already exists with other MCP servers, MERGE — don't overwrite. Only add/update the `open-claude` entry.

2. Create `.claude/discord.env` (needed by the HTTP server process and hooks):

Include credentials for the platforms you're using. Both can be active simultaneously:

```
# Discord (include if using Discord)
DISCORD_BOT_TOKEN=<token>

# Lark (include if using Lark)
LARK_APP_ID=<app_id>
LARK_APP_SECRET=<app_secret>
OPEN_CLAUDE_PLATFORM=lark

# Common
DISCORD_MAIN_CHANNEL=<main channel/chat ID>
OPEN_CLAUDE_WORKSPACE=<workspace path (pwd)>
```

Note: `OPEN_CLAUDE_PLATFORM=lark` is only needed for hooks (auto-reply.sh, typing-loop.sh) to use Lark API instead of Discord. The server auto-detects platforms from credentials.

```bash
chmod 600 .claude/discord.env
```

3. Create runtime directories:
```bash
mkdir -p .claude/discord memory/threads memory/events
```

4. Create initial `access.json` with the main channel registered:
```bash
cat > .claude/discord/access.json << EOFACCESS
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {
    "<main_channel_id>": {
      "requireMention": false,
      "allowFrom": []
    }
  },
  "pending": {},
  "ackReaction": "👀",
  "chunkMode": "newline"
}
EOFACCESS
chmod 600 .claude/discord/access.json
```

5. Copy start script:
```bash
cp ${CLAUDE_PLUGIN_ROOT}/scripts/start-http.sh ./start-http.sh
chmod +x ./start-http.sh
```

6. Add `.mcp.json` to `.gitignore` (contains token):
```bash
grep -q '.mcp.json' .gitignore 2>/dev/null || echo '.mcp.json' >> .gitignore
```

Confirm:
> Configuration saved!

## Step 5: Launch guide

> **To start:**
> ```
> ./start-http.sh
> ```
> This creates a tmux session with:
> - Window 1: HTTP server (persistent, single Discord connection)
> - Window 2: Claude Code main session (auto-connects via proxy)
>
> Thread sessions are spawned automatically when messages arrive in Discord threads.

## Step 6: Pairing guide

Tell the user:

> **After starting, pair your Discord account:**
>
> 1. Send a DM to the bot on Discord → you'll get a pairing code
> 2. Run `/open-claude:access pair <code>` in Claude Code
>
> Or add yourself directly: `/open-claude:access allow <your-discord-user-id>`
>
> To find your Discord user ID: enable Developer Mode → right-click your name → Copy User ID

## Step 7: Optional settings

Ask if the user wants to configure any optional settings:

> **Optional settings:**
> - `DISCORD_TMUX_SESSION=<name>` — control Claude from Discord (`/clear`, `/restart`)
> - `DISCORD_EVENT_LOG=true` — cross-session context sharing (default: enabled)
> - `DISCORD_THREAD_MODEL=<model>` — model for thread sessions (default: sonnet)
>
> Want to set up any of these? Or you're all set!

## Step 8: CLAUDE.md & optional jobs

Ask the user:

> **Would you like to set up a CLAUDE.md template?**
> This gives Claude persistent context about your preferences across sessions.
> It can also be auto-updated by the conversation-analysis feature.

If yes:

1. Copy the template from the plugin:
   ```bash
   cat ${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md
   ```
   Write it to the workspace root as `CLAUDE.md` (don't overwrite if one exists — ask first).

2. Ask for basic profile info:
   - Name (or leave blank)
   - Timezone (e.g., America/New_York, Asia/Seoul)
   - Preferred communication style (concise/detailed/casual/formal)

3. Fill in the placeholders in the template with the provided values.

4. Create `memory/jobs.json` with all jobs disabled:
   ```json
   {
     "conversation-analysis": { "enabled": false },
     "qmd": { "enabled": false }
   }
   ```

5. Create initial `memory/user-context.json`:
   ```json
   {
     "profile": { "name": "<provided>", "timezone": "<provided>", "language": "en" },
     "interests": [],
     "communication_preferences": { "tone": "<provided>", "detail_level": "", "autonomy_level": "" },
     "recent_context": { "period": "", "today": [], "yesterday": [], "ongoing": [] },
     "updated_at": "<now>"
   }
   ```

6. Mention available features:
   > **Optional jobs you can enable later:**
   > - `conversation-analysis` — daily conversation summary + auto-update CLAUDE.md context
   > - `qmd` — index and search your conversation history
   >
   > Enable with: `/open-claude:configure jobs enable <name>`

If no, skip to the end.

## Important

- Always mask tokens (show only first 6 chars)
- Set file permissions: directory 700, .env file 600, access.json 600
- Use the current working directory as OPEN_CLAUDE_WORKSPACE
- **Always create access.json with the main channel in groups** — without this, channel messages are dropped by the gate
- Be encouraging — this is their first experience with the plugin
- Don't overwrite existing CLAUDE.md without asking
