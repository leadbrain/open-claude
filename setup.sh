#!/bin/bash
# setup.sh — open-claude: Discord channel plugin for Claude Code
#
# Quick start:
#   claude plugins marketplace add leadbrain/open-claude
#   claude plugins install open-claude@open-claude
#
# Or manual:
#   git clone https://github.com/leadbrain/open-claude
#   claude --plugin-dir ./open-claude
#
# This script configures the Discord bot token and workspace.
# MCP server and hooks are registered automatically by the plugin system.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_DIR="$HOME/.claude/channels/discord"
ENV_FILE="$ENV_DIR/.env"

echo "=== open-claude Setup ==="
echo ""

# ── 1. Prerequisites ──
echo "[1/3] Checking prerequisites..."
command -v bun >/dev/null 2>&1 || { echo "ERROR: bun not found. Install: https://bun.sh"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq not found. Install: brew install jq"; exit 1; }
echo "  OK"

# ── 2. Install dependencies ──
echo ""
echo "[2/3] Installing dependencies..."
cd "$PLUGIN_DIR"
bun install --no-summary 2>/dev/null
echo "  OK"

# ── 3. Discord configuration ──
echo ""
echo "[3/3] Discord configuration..."
mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"

if [ -f "$ENV_FILE" ]; then
  echo "  .env already exists:"
  grep -v TOKEN "$ENV_FILE" | sed 's/^/    /'
  echo "  (token hidden)"
  read -p "  Overwrite? (y/N): " OVERWRITE
  if [ "$OVERWRITE" != "y" ]; then
    echo "  Keeping existing config"
    echo ""
    echo "=== Done ==="
    echo "Restart Claude Code to activate the plugin."
    exit 0
  fi
fi

read -p "  Discord Bot Token: " BOT_TOKEN
read -p "  Main channel ID: " MAIN_CHANNEL

# Detect workspace — if installed via plugin system, use CWD
WORKSPACE="${DISCORD_WORKSPACE:-$(pwd)}"
if [ -d "$PLUGIN_DIR/../../.." ] && [ -d "$PLUGIN_DIR/../../../.claude" ]; then
  WORKSPACE="$(cd "$PLUGIN_DIR/../../.." && pwd)"
fi
read -p "  Workspace path [$WORKSPACE]: " CUSTOM_WORKSPACE
[ -n "$CUSTOM_WORKSPACE" ] && WORKSPACE="$CUSTOM_WORKSPACE"

cat > "$ENV_FILE" << EOF
DISCORD_BOT_TOKEN=$BOT_TOKEN
DISCORD_MAIN_CHANNEL=$MAIN_CHANNEL
DISCORD_WORKSPACE=$WORKSPACE
EOF
chmod 600 "$ENV_FILE"
echo "  OK: .env created"

# Create runtime directories
mkdir -p "$WORKSPACE/memory/threads" "$WORKSPACE/memory/events" 2>/dev/null || true

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code (or start with: claude)"
echo "  2. DM the bot on Discord to pair"
echo "  3. Approve: /open-claude:access pair <code>"
echo ""
echo "Configure more: /open-claude:configure"
echo "Manage access:  /open-claude:access"
