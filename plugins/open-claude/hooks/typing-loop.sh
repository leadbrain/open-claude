#!/bin/bash
# typing-loop.sh — Send typing indicator every 8 seconds
#
# Started by: track-channel.sh (UserPromptSubmit)
# Killed by:  auto-reply.sh (Stop hook)
# Supports: Discord (typing API), Lark (no-op)

CHANNEL_ID="$1"
PID_FILE="/tmp/open-claude-typing.pid"

if [ -z "$CHANNEL_ID" ]; then
  exit 1
fi

# Token from environment
BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
if [ -z "$BOT_TOKEN" ] && [ "${OPEN_CLAUDE_PLATFORM:-discord}" = "discord" ]; then
  exit 0
fi

# Source platform-aware send functions
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$PLUGIN_DIR/hooks/platform-send.sh"

# Kill existing loop
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null
  fi
fi

echo $$ > "$PID_FILE"

while true; do
  send_typing "$CHANNEL_ID"
  sleep 8
done
