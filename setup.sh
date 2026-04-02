#!/bin/bash
# setup.sh — open-claude: Discord channel plugin for Claude Code
#
# Usage:
#   cd your-workspace
#   git clone https://github.com/user/open-claude .claude/plugins/open-claude
#   .claude/plugins/open-claude/setup.sh
#
# Prerequisites:
#   - Claude Code (claude --version)
#   - Bun (bun --version)
#   - jq (jq --version)
#   - A Discord bot token (create at https://discord.com/developers)

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$PLUGIN_DIR/../../.." && pwd)"
HOOKS_DIR="$WORKSPACE/.claude/hooks"
SETTINGS_FILE="$WORKSPACE/.claude/settings.json"
MCP_FILE="$WORKSPACE/.mcp.json"
ENV_DIR="$HOME/.claude/channels/discord"
ENV_FILE="$ENV_DIR/.env"

echo "=== open-claude Setup ==="
echo "Workspace: $WORKSPACE"
echo "Plugin:    $PLUGIN_DIR"
echo ""

# ── 1. Prerequisites ──
echo "[1/6] Checking prerequisites..."
command -v claude >/dev/null 2>&1 || { echo "ERROR: claude not found. Install Claude Code first."; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not found. Install Bun first (https://bun.sh)."; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not found. Install: brew install jq"; exit 1; }
echo "  OK: claude $(claude --version 2>&1 | head -1)"
echo "  OK: bun $(bun --version 2>&1)"
echo "  OK: jq $(jq --version 2>&1)"

# ── 2. Discord .env ──
echo ""
echo "[2/6] Discord configuration..."
mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"

setup_env=false
if [ -f "$ENV_FILE" ]; then
  echo "  .env already exists:"
  grep -v TOKEN "$ENV_FILE" | sed 's/^/    /'
  echo "  (token hidden)"
  read -p "  Overwrite? (y/N): " OVERWRITE
  [ "$OVERWRITE" = "y" ] && setup_env=true || echo "  Keeping existing config"
else
  setup_env=true
fi

if [ "$setup_env" = "true" ]; then
  read -p "  Discord Bot Token: " BOT_TOKEN
  read -p "  Main channel ID: " MAIN_CHANNEL
  read -p "  tmux session name (optional, for /clear /restart commands): " TMUX_SESSION
  read -p "  Enable event logging? Cross-session context sharing (y/N): " ENABLE_EVENTS

  cat > "$ENV_FILE" << EOF
DISCORD_BOT_TOKEN=$BOT_TOKEN
DISCORD_MAIN_CHANNEL=$MAIN_CHANNEL
DISCORD_WORKSPACE=$WORKSPACE
EOF

  [ -n "$TMUX_SESSION" ] && echo "DISCORD_TMUX_SESSION=$TMUX_SESSION" >> "$ENV_FILE"
  [ "$ENABLE_EVENTS" = "y" ] && echo "DISCORD_EVENT_LOG=true" >> "$ENV_FILE"

  chmod 600 "$ENV_FILE"
  echo "  OK: .env created"
fi

# ── 3. Install dependencies ──
echo ""
echo "[3/6] Installing dependencies..."
cd "$PLUGIN_DIR"
bun install --no-summary 2>/dev/null
echo "  OK: node_modules installed"

# ── 4. Register MCP server ──
echo ""
echo "[4/6] Registering MCP server..."

if [ -f "$MCP_FILE" ] && grep -q "open-claude" "$MCP_FILE"; then
  echo "  Already registered"
else
  if [ -f "$MCP_FILE" ]; then
    # Merge into existing .mcp.json
    TMP=$(mktemp)
    jq --arg dir "$PLUGIN_DIR" '.mcpServers["open-claude"] = {
      "command": "bun",
      "args": ["run", "--cwd", $dir, "--shell=bun", "--silent", "start"]
    }' "$MCP_FILE" > "$TMP" && mv "$TMP" "$MCP_FILE"
  else
    cat > "$MCP_FILE" << EOF
{
  "mcpServers": {
    "open-claude": {
      "command": "bun",
      "args": ["run", "--cwd", "$PLUGIN_DIR", "--shell=bun", "--silent", "start"]
    }
  }
}
EOF
  fi
  echo "  OK: .mcp.json updated"
fi

# ── 5. Configure hooks ──
echo ""
echo "[5/6] Setting up hooks..."
mkdir -p "$HOOKS_DIR"

# Symlink hooks from plugin to workspace hooks dir
for hook in auto-reply.sh track-channel.sh typing-loop.sh; do
  SRC="$PLUGIN_DIR/hooks/$hook"
  DST="$HOOKS_DIR/$hook"
  if [ -L "$DST" ] && [ "$(readlink "$DST")" = "$SRC" ]; then
    echo "  $hook: already linked"
  elif [ -f "$DST" ]; then
    echo "  $hook: exists (not a symlink) — skipping. Review manually."
  else
    ln -s "$SRC" "$DST"
    chmod +x "$SRC"
    echo "  $hook: linked"
  fi
done

# Register hooks in settings.json
if [ ! -f "$SETTINGS_FILE" ]; then
  cat > "$SETTINGS_FILE" << 'SETTINGS'
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/track-channel.sh" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/auto-reply.sh" }
        ]
      }
    ]
  }
}
SETTINGS
  echo "  OK: settings.json created with hooks"
else
  echo "  settings.json exists — verify hooks are registered:"
  echo "    UserPromptSubmit → .claude/hooks/track-channel.sh"
  echo "    Stop             → .claude/hooks/auto-reply.sh"
fi

# ── 6. Create workspace directories ──
echo ""
echo "[6/6] Creating workspace directories..."
mkdir -p "$WORKSPACE/memory/threads" "$WORKSPACE/memory/events"
echo "  OK: memory/threads/ and memory/events/ created"

# ── Done ──
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Start Claude Code in your workspace:"
echo "  cd \"$WORKSPACE\""
echo "  claude"
echo ""
echo "Discord pairing:"
echo "  1. DM the bot on Discord"
echo "  2. You'll get a pairing code"
echo "  3. Add user to access.json allowlist"
echo ""
echo "Optional — cron jobs:"
echo "  $PLUGIN_DIR/scripts/cron-runner.sh <skill> <thread-id> [model] [timeout]"
echo ""
echo "Documentation: $PLUGIN_DIR/README.md"
