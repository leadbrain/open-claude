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

Read `~/.claude/channels/discord/.env`. If it exists and has a token:
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

2. Once both are provided, create the config:

```bash
mkdir -p ~/.claude/channels/discord
chmod 700 ~/.claude/channels/discord
```

Write `~/.claude/channels/discord/.env`:
```
DISCORD_BOT_TOKEN=<token>
DISCORD_MAIN_CHANNEL=<channel_id>
DISCORD_WORKSPACE=<current working directory>
```

```bash
chmod 600 ~/.claude/channels/discord/.env
```

Also create runtime directories:
```bash
mkdir -p memory/threads memory/events
```

3. Confirm:
   > Configuration saved. Hooks are auto-registered by the plugin system — no manual setup needed.

## Step 5: Pairing guide

Tell the user:

> **Pair your Discord account:**
>
> 1. Restart Claude Code (exit and reopen)
> 2. Send a DM to your bot on Discord
> 3. The bot will reply with a 6-character pairing code
> 4. Run: `/open-claude:access pair <code>`
>
> Or add yourself directly: `/open-claude:access allow <your-discord-user-id>`
>
> To find your Discord user ID: enable Developer Mode → right-click your name → Copy User ID

## Step 6: Optional settings

Ask if the user wants to configure any optional features:

> **Optional features:**
> - **tmux integration** — control Claude Code from Discord (`/clear`, `/restart`). Set `DISCORD_TMUX_SESSION=<session-name>` in .env
> - **Event logging** — cross-session context sharing. Set `DISCORD_EVENT_LOG=true` in .env
> - **Thread model** — change the model for thread sessions (default: sonnet). Set `DISCORD_THREAD_MODEL=<model>` in .env
>
> Want to set up any of these? Or you're all set!

If the user wants any, update the `.env` file accordingly.

## Step 7: Restart prompt

After all configuration is done, give a clear final message:

> **All set! Restart Claude Code to activate the Discord connection.**
>
> Exit this session (`Ctrl+C` or type `exit`), then run `claude` again.
>
> After restart:
> 1. The bot will appear online in Discord
> 2. DM the bot to get a pairing code
> 3. Run `/open-claude:access pair <code>` to connect your account

This is the LAST step. Do not continue the conversation after this — the user needs to restart for the plugin to load the MCP server and hooks.

## Important

- Always mask tokens (show only first 6 chars)
- Set file permissions: directory 700, .env file 600
- Use the current working directory as DISCORD_WORKSPACE
- Be encouraging — this is their first experience with the plugin
