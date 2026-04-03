#!/bin/bash
# auto-reply.sh — Stop hook: send Claude's response to Discord
#
# Routing: session_id → memory/threads/{chat_id}.json (no transcript parsing)
#   1. Reverse-lookup session_id in memory/threads/*.json
#   2. Fallback to DISCORD_LOG_THREAD (for cron jobs)
#
# Optional: event logging (set DISCORD_EVENT_LOG=true in .env)
#   Records haiku summaries to memory/events/YYYY-MM-DD.md
#   Enables cross-session context sharing

INPUT=$(cat)
LOG="/tmp/open-claude-debug.log"

# Re-entry guard: if this hook fires from the event recorder's claude -p, exit
if [ "$CLAUDE_HOOK_NOREENTRY" = "1" ]; then
  exit 0
fi

echo "[$(date)] Stop hook fired" >> "$LOG"

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
echo "[$(date)] session_id=$SESSION_ID" >> "$LOG"

# Load .env
ENV_FILE="$HOME/.claude/channels/discord/.env"
MAIN_CHANNEL=""
LOG_THREAD=""
BOT_TOKEN=""
WORKSPACE=""
EVENT_LOG=""
if [ -f "$ENV_FILE" ]; then
  MAIN_CHANNEL=$(grep DISCORD_MAIN_CHANNEL "$ENV_FILE" | cut -d= -f2)
  LOG_THREAD=$(grep DISCORD_LOG_THREAD "$ENV_FILE" | cut -d= -f2)
  BOT_TOKEN=$(grep DISCORD_BOT_TOKEN "$ENV_FILE" | cut -d= -f2)
  WORKSPACE=$(grep DISCORD_WORKSPACE "$ENV_FILE" | cut -d= -f2)
  EVENT_LOG=$(grep DISCORD_EVENT_LOG "$ENV_FILE" | cut -d= -f2)
fi
if [ -z "$BOT_TOKEN" ]; then
  echo "[$(date)] No BOT_TOKEN, exiting" >> "$LOG"
  exit 0
fi

# ── Routing: determine chat_id ──

CHAT_ID=""
ROUTE_SOURCE=""

# 1. Reverse-lookup session_id in memory/threads/*.json
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

# 2. Fallback: log thread (cron jobs)
if [ -z "$CHAT_ID" ]; then
  if [ -n "$LOG_THREAD" ]; then
    CHAT_ID="$LOG_THREAD"
    ROUTE_SOURCE="log"
  else
    echo "[$(date)] No route found, skipping" >> "$LOG"
    exit 0
  fi
fi

echo "[$(date)] Route: $ROUTE_SOURCE → $CHAT_ID" >> "$LOG"

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
    TRANSCRIPT_TEXT=$(tail -n +"$LAST_USER_LINE" "$TRANSCRIPT" | jq -s '[.[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text] | join("\n\n")' -r 2>/dev/null)
    echo "[$(date)] Transcript text len: ${#TRANSCRIPT_TEXT}" >> "$LOG"
  fi
fi

LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null)

# Merge: transcript + last_assistant_message (deduplicated)
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
  echo "[$(date)] No response, exiting" >> "$LOG"
  exit 0
fi

echo "[$(date)] Sending (len=${#RESPONSE}) to $CHAT_ID" >> "$LOG"

# ── Event logging (optional) ──

if [ "$EVENT_LOG" = "true" ]; then
  record_event() {
    [ -z "$WORKSPACE" ] && return
    EVENTS_DIR="$WORKSPACE/memory/events"
    mkdir -p "$EVENTS_DIR"
    TODAY=$(date +%Y-%m-%d)
    EVENTS_FILE="$EVENTS_DIR/${TODAY}.md"
    NOW=$(date +%H:%M)

    SOURCE_LABEL="$CHAT_ID"

    SUMMARY_TMP=$(mktemp)
    echo "${RESPONSE:0:500}" > "$SUMMARY_TMP"
    SUMMARY=$(CLAUDE_HOOK_NOREENTRY=1 claude -p --model haiku \
      --append-system-prompt "You are a summarizer. Summarize the text in one line (max 100 chars). Format: [topic] key content. No questions. No conversation. Only summary." \
      "Summarize this text." \
      < "$SUMMARY_TMP" 2>/dev/null | head -1 | head -c 150)
    rm -f "$SUMMARY_TMP"

    if [ -n "$SUMMARY" ]; then
      echo "${NOW} [${SOURCE_LABEL}] ${SUMMARY}" >> "$EVENTS_FILE"
      echo "[$(date)] Event recorded: $SUMMARY" >> "$LOG"
    fi
  }
  record_event &
fi

# ── Send to Discord ──

send_message() {
  local text="$1"
  CURL_RESULT=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST \
    "https://discord.com/api/v10/channels/${CHAT_ID}/messages" \
    -H "Authorization: Bot ${BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -n --arg content "$text" '{content: $content}')" 2>&1)
  echo "[$(date)] curl: $CURL_RESULT" >> "$LOG"
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

# ── Cron job: copy to log thread ──
CRON_MARKER="/tmp/cron-marker-${SESSION_ID}"
if [ -f "$CRON_MARKER" ] && [ -n "$LOG_THREAD" ] && [ "$CHAT_ID" != "$LOG_THREAD" ]; then
  echo "[$(date)] Cron detected, copying to log thread $LOG_THREAD" >> "$LOG"
  SAVE_CHAT_ID="$CHAT_ID"
  CHAT_ID="$LOG_THREAD"
  LOG_MSG="[cron → ${SAVE_CHAT_ID}] ${RESPONSE:0:1900}"
  send_message "$LOG_MSG"
  CHAT_ID="$SAVE_CHAT_ID"
  rm -f "$CRON_MARKER"
fi

exit 0
