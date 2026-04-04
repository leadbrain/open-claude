#!/bin/bash
# typing-loop.sh — Send Discord typing indicator every 8 seconds
#
# Started by: track-channel.sh (UserPromptSubmit)
# Killed by:  auto-reply.sh (Stop hook)

CHANNEL_ID="$1"
PID_FILE="/tmp/open-claude-typing.pid"

if [ -z "$CHANNEL_ID" ]; then
  exit 1
fi

# Load bot token from CLAUDE_PLUGIN_DATA
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$(pwd)/.claude/discord}"
TOKEN_FILE="$DATA_DIR/discord.env"
if [ ! -f "$TOKEN_FILE" ]; then
  exit 0
fi
TOKEN=$(grep DISCORD_BOT_TOKEN "$TOKEN_FILE" | cut -d= -f2)
if [ -z "$TOKEN" ]; then
  exit 0
fi

# Kill existing loop
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null
  fi
fi

# Record PID
echo $$ > "$PID_FILE"

# Send typing every 8 seconds
while true; do
  curl -s -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/typing" \
    -H "Authorization: Bot $TOKEN" \
    > /dev/null 2>&1
  sleep 8
done
