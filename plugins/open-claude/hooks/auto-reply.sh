#!/bin/bash
# auto-reply.sh — Stop hook: send Claude's response to Discord
#
# Routing: session_id → memory/threads/{chat_id}.json
# Config from environment variables (set via .mcp.json env field)

INPUT=$(cat)

# Re-entry guard
if [ "$CLAUDE_HOOK_NOREENTRY" = "1" ]; then
  exit 0
fi

# Kill typing loop
TYPING_PID_FILE="/tmp/open-claude-typing.pid"
if [ -f "$TYPING_PID_FILE" ]; then
  TYPING_PID=$(cat "$TYPING_PID_FILE" 2>/dev/null)
  if [ -n "$TYPING_PID" ] && kill -0 "$TYPING_PID" 2>/dev/null; then
    kill "$TYPING_PID" 2>/dev/null
  fi
  rm -f "$TYPING_PID_FILE"
fi

# Extract basic info
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

# Config from environment
WORKSPACE="$(pwd)"
MAIN_CHANNEL="${DISCORD_MAIN_CHANNEL:-}"
LOG_THREAD="${DISCORD_LOG_THREAD:-}"
BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
EVENT_LOG="${DISCORD_EVENT_LOG:-}"

if [ -z "$BOT_TOKEN" ]; then
  exit 0
fi

# ── Routing: determine chat_id ──

CHAT_ID=""
ROUTE_SOURCE=""

if [ -n "$SESSION_ID" ] && [ -n "$WORKSPACE" ]; then
  THREADS_DIR="$WORKSPACE/memory/threads"
  if [ -d "$THREADS_DIR" ]; then
    for f in "$THREADS_DIR"/*.json; do
      [ -f "$f" ] || continue
      FILE_SID=$(jq -r '.session_id // empty' "$f" 2>/dev/null)
      if [ "$FILE_SID" = "$SESSION_ID" ]; then
        CHAT_ID=$(basename "$f" .json)
        if [ "$CHAT_ID" = "$MAIN_CHANNEL" ]; then
          ROUTE_SOURCE="main"
        else
          ROUTE_SOURCE="thread"
        fi
        break
      fi
    done
  fi
fi

# Fallback: log thread
if [ -z "$CHAT_ID" ]; then
  if [ -n "$LOG_THREAD" ]; then
    CHAT_ID="$LOG_THREAD"
    ROUTE_SOURCE="log"
  else
    exit 0
  fi
fi

# ── Extract response ──

RESPONSE=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  if [ "$ROUTE_SOURCE" = "main" ]; then
    LAST_USER_LINE=$(grep -n '"origin":{"kind":"channel"' "$TRANSCRIPT" | tail -1 | cut -d: -f1)
  elif [ "$ROUTE_SOURCE" = "thread" ]; then
    LAST_USER_LINE=$(grep -n '"type":"user"' "$TRANSCRIPT" | tail -1 | cut -d: -f1)
  else
    LAST_USER_LINE=1
  fi

  if [ -n "$LAST_USER_LINE" ]; then
    # Extract text responses
    TRANSCRIPT_TEXT=$(tail -n +"$LAST_USER_LINE" "$TRANSCRIPT" | jq -s '[.[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text] | join("\n\n")' -r 2>/dev/null)

    # Extract Edit tool diffs as ANSI-colored blocks
    EDIT_DIFFS=$(tail -n +"$LAST_USER_LINE" "$TRANSCRIPT" | jq -s '
      [.[] | select(.type == "assistant") | .message.content[]? |
       select(.type == "tool_use" and .name == "Edit") |
       "\n\u001b[1;34m📝 " + (.input.file_path | split("/") | last) + "\u001b[0m\n```ansi\n" +
       (.input.old_string | split("\n") | map("\u001b[0;31m- " + . + "\u001b[0m") | join("\n")) +
       "\n" +
       (.input.new_string | split("\n") | map("\u001b[0;32m+ " + . + "\u001b[0m") | join("\n")) +
       "\n```"
      ] | join("\n")' -r 2>/dev/null)

    if [ -n "$EDIT_DIFFS" ]; then
      TRANSCRIPT_TEXT="${TRANSCRIPT_TEXT}${EDIT_DIFFS}"
    fi
  fi
fi

LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null)

if [ -n "$TRANSCRIPT_TEXT" ] && [ -n "$LAST_MSG" ]; then
  if [ "${TRANSCRIPT_TEXT: -${#LAST_MSG}}" = "$LAST_MSG" ]; then
    RESPONSE="$TRANSCRIPT_TEXT"
  else
    RESPONSE="${TRANSCRIPT_TEXT}

${LAST_MSG}"
  fi
elif [ -n "$TRANSCRIPT_TEXT" ]; then
  RESPONSE="$TRANSCRIPT_TEXT"
else
  RESPONSE="$LAST_MSG"
fi

if [ -z "$RESPONSE" ]; then
  exit 0
fi

# ── Event logging (optional) ──

if [ "$EVENT_LOG" = "true" ]; then
  record_event() {
    EVENTS_DIR="$WORKSPACE/memory/events"
    mkdir -p "$EVENTS_DIR"
    TODAY=$(date +%Y-%m-%d)
    EVENTS_FILE="$EVENTS_DIR/${TODAY}.md"
    NOW=$(date +%H:%M)

    SUMMARY_TMP=$(mktemp)
    echo "${RESPONSE:0:500}" > "$SUMMARY_TMP"
    SUMMARY=$(CLAUDE_HOOK_NOREENTRY=1 claude -p --model haiku \
      --append-system-prompt "You are a summarizer. Summarize the text in one line (max 100 chars). Format: [topic] key content. No questions. No conversation. Only summary." \
      "Summarize this text." \
      < "$SUMMARY_TMP" 2>/dev/null | head -1 | head -c 150)
    rm -f "$SUMMARY_TMP"

    if [ -n "$SUMMARY" ]; then
      echo "${NOW} [${CHAT_ID}] ${SUMMARY}" >> "$EVENTS_FILE"
    fi
  }
  record_event &
fi

# ── Send to Discord ──

send_message() {
  local text="$1"
  curl -s -X POST \
    "https://discord.com/api/v10/channels/${CHAT_ID}/messages" \
    -H "Authorization: Bot ${BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -n --arg content "$text" '{content: $content}')" > /dev/null 2>&1
}

MSG_LEN=${#RESPONSE}
if [ "$MSG_LEN" -le 2000 ]; then
  send_message "$RESPONSE"
else
  OFFSET=0
  while [ "$OFFSET" -lt "$MSG_LEN" ]; do
    CHUNK="${RESPONSE:$OFFSET:2000}"
    send_message "$CHUNK"
    OFFSET=$((OFFSET + 2000))
    sleep 0.3
  done
fi

# Cron: copy to log thread
CRON_MARKER="/tmp/cron-marker-${SESSION_ID}"
if [ -f "$CRON_MARKER" ] && [ -n "$LOG_THREAD" ] && [ "$CHAT_ID" != "$LOG_THREAD" ]; then
  SAVE_CHAT_ID="$CHAT_ID"
  CHAT_ID="$LOG_THREAD"
  send_message "[cron → ${SAVE_CHAT_ID}] ${RESPONSE:0:1900}"
  CHAT_ID="$SAVE_CHAT_ID"
  rm -f "$CRON_MARKER"
fi

exit 0
