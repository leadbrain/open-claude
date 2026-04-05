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
---

# /open-claude:setup — Interactive Setup Wizard

Walk the user through setting up open-claude step by step. Be friendly, clear, and check each step before moving to the next.

Arguments passed: `$ARGUMENTS`

---

## Step 1: Check prerequisites

Check if `bun` and `jq` are available in PATH:
```bash
which bun
which jq
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

If both are installed, say so and move on.

## Step 2: Check existing configuration

Read `.claude/discord.env` (in the current workspace). If it exists and has a token:
- Show status (mask the token: first 6 chars + `...`)
- Ask: "Already configured! Want to reconfigure, or skip to pairing?"
- If skip → jump to Step 5

If no `.env` exists, continue to Step 3.

## Step 3: Discord bot creation guide

Tell the user:

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

## Step 4: Save configuration

When the user provides a token:

1. Ask for the **main channel ID**:
   > To get a channel ID: right-click the channel in Discord → **Copy Channel ID**
   > (Enable Developer Mode in Discord Settings → App Settings → Advanced if you don't see this option)

2. Once both are provided, add the config to the **workspace `.mcp.json`** as environment variables.

Read the existing `.mcp.json` in the workspace root. If it doesn't exist, create it. Add the `env` field to the open-claude MCP server entry:

```json
{
  "mcpServers": {
    "open-claude": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--silent", "start"],
      "env": {
        "DISCORD_BOT_TOKEN": "<token>",
        "DISCORD_MAIN_CHANNEL": "<channel_id>",
        "OPEN_CLAUDE_WORKSPACE": "<workspace path (pwd)>"
      }
    }
  }
}
```

**Important**: If `.mcp.json` already exists with other MCP servers, MERGE — don't overwrite. Only add/update the `open-claude` entry.

Also create runtime directories:
```bash
mkdir -p .claude/discord memory/threads memory/events
```

3. Add `.mcp.json` to `.gitignore` (contains token):
```bash
echo '.mcp.json' >> .gitignore
```

4. Copy `start.sh` to the workspace:
```bash
cp ${CLAUDE_PLUGIN_ROOT}/scripts/start.sh ./start.sh
chmod +x ./start.sh
```

5. Confirm:
   > Configuration saved!

## Step 5: Launch guide

Tell the user:

> **To start the Discord connection, exit Claude Code and run:**
> ```
> ./start.sh
> ```
> This creates a tmux session with the correct flags for Discord channel support.
>
> Alternatively, run directly:
> ```
> claude --dangerously-load-development-channels plugin:open-claude@open-claude
> ```
>
> **Tip:** Add an alias to your shell profile:
> ```
> alias open-claude='claude --dangerously-load-development-channels plugin:open-claude@open-claude'
> ```

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

Ask if the user wants to configure any optional features:

> **Optional features** (add to discord.env):
> - `DISCORD_TMUX_SESSION=<name>` — control Claude from Discord (`/clear`, `/restart`)
> - `DISCORD_EVENT_LOG=true` — cross-session context sharing
> - `DISCORD_THREAD_MODEL=<model>` — model for thread sessions (default: sonnet)
>
> Want to set up any of these? Or you're all set!

## Step 8: CLAUDE.md & optional features

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

4. Create `memory/features.json` with all features disabled:
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
   > **Optional features you can enable later:**
   > - `conversation-analysis` — daily conversation summary + auto-update CLAUDE.md context
   > - `qmd` — index and search your conversation history
   >
   > Enable with: `/open-claude:configure features enable <name>`

If no, skip to the end.

## Important

- Always mask tokens (show only first 6 chars)
- Set file permissions: directory 700, .env file 600
- Use the current working directory as DISCORD_WORKSPACE
- Be encouraging — this is their first experience with the plugin
- Don't overwrite existing CLAUDE.md without asking
