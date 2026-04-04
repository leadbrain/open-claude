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

# Token from environment
TOKEN="${DISCORD_BOT_TOKEN:-}"
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

echo $$ > "$PID_FILE"

while true; do
  curl -s -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/typing" \
    -H "Authorization: Bot $TOKEN" \
    > /dev/null 2>&1
  sleep 8
done
