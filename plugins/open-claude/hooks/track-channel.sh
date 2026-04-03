#!/bin/bash
# track-channel.sh — UserPromptSubmit hook
#
# 1. Records session_id → chat_id mapping in memory/threads/{chat_id}.json
# 2. Injects cross-session events as additionalContext (if event logging is on)
# 3. Starts typing indicator loop

INPUT=$(cat)
LOG="/tmp/open-claude-track.log"

echo "[$(date)] track-channel.sh fired" >> "$LOG"

# Load config — project-local: .claude/discord.env in workspace (cwd)
WORKSPACE="$(pwd)"
ENV_FILE="$WORKSPACE/.claude/discord.env"
MAIN_CHANNEL="${DISCORD_MAIN_CHANNEL:-}"
EVENT_LOG="${DISCORD_EVENT_LOG:-}"

echo "[$(date)] ENV_FILE=$ENV_FILE exists=$([ -f "$ENV_FILE" ] && echo yes || echo no)" >> "$LOG"

if [ -f "$ENV_FILE" ]; then
  [ -z "$MAIN_CHANNEL" ] && MAIN_CHANNEL=$(grep DISCORD_MAIN_CHANNEL "$ENV_FILE" | cut -d= -f2)
  [ -z "$EVENT_LOG" ] && EVENT_LOG=$(grep DISCORD_EVENT_LOG "$ENV_FILE" | cut -d= -f2)
fi

echo "[$(date)] WORKSPACE=$WORKSPACE MAIN_CHANNEL=$MAIN_CHANNEL" >> "$LOG"

# Extract chat_id from prompt
PROMPT_TEXT=$(echo "$INPUT" | jq -r '(.user_prompt // .prompt // "")' 2>/dev/null)
CHAT_ID=$(echo "$PROMPT_TEXT" | sed -n 's/.*chat_id="\([^"]*\)".*/\1/p' | head -1)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)

echo "[$(date)] CHAT_ID=$CHAT_ID SESSION_ID=$SESSION_ID" >> "$LOG"
echo "[$(date)] PROMPT_TEXT (first 200): ${PROMPT_TEXT:0:200}" >> "$LOG"

# Not a Discord message? Skip.
if [ -z "$CHAT_ID" ]; then
  echo "[$(date)] No chat_id found, exiting" >> "$LOG"
  exit 0
fi

# Record session_id → chat_id mapping
if [ -n "$SESSION_ID" ] && [ -n "$WORKSPACE" ]; then
  THREADS_DIR="$WORKSPACE/memory/threads"
  mkdir -p "$THREADS_DIR"
  THREAD_FILE="$THREADS_DIR/${CHAT_ID}.json"
  jq -n --arg sid "$SESSION_ID" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{session_id: $sid, last_active: $ts}' > "$THREAD_FILE"
  echo "[$(date)] Wrote $THREAD_FILE (sid=$SESSION_ID)" >> "$LOG"
else
  echo "[$(date)] SKIP write: SESSION_ID=$SESSION_ID WORKSPACE=$WORKSPACE" >> "$LOG"
fi

# ── Cross-session event injection (optional) ──

inject_events() {
  [ "$EVENT_LOG" != "true" ] && return
  [ -z "$WORKSPACE" ] && return
  EVENTS_DIR="$WORKSPACE/memory/events"
  TODAY=$(date +%Y-%m-%d)
  EVENTS_FILE="$EVENTS_DIR/${TODAY}.md"
  [ -f "$EVENTS_FILE" ] || return

  THREADS_DIR="$WORKSPACE/memory/threads"
  THREAD_FILE="$THREADS_DIR/${CHAT_ID}.json"

  # Last event check time
  LAST_EVENT_TIME=""
  if [ -f "$THREAD_FILE" ]; then
    LAST_EVENT_TIME=$(jq -r '.last_event_time // empty' "$THREAD_FILE" 2>/dev/null)
  fi

  # Get events since last check, excluding own session
  if [ -n "$LAST_EVENT_TIME" ]; then
    NEW_EVENTS=$(awk -v cutoff="$LAST_EVENT_TIME" '$1 > cutoff' "$EVENTS_FILE" | grep -v "\\[$CHAT_ID\\]" | tail -10)
  else
    NEW_EVENTS=$(grep -v "\\[$CHAT_ID\\]" "$EVENTS_FILE" | tail -10)
  fi

  [ -z "$NEW_EVENTS" ] && return

  # Update last_event_time
  LATEST_TIME=$(tail -1 "$EVENTS_FILE" | cut -d' ' -f1)
  if [ -n "$LATEST_TIME" ] && [ -f "$THREAD_FILE" ]; then
    jq --arg t "$LATEST_TIME" '.last_event_time = $t' "$THREAD_FILE" > "${THREAD_FILE}.tmp" && \
      mv "${THREAD_FILE}.tmp" "$THREAD_FILE"
  fi

  # Output as additionalContext
  CONTEXT="Events from other sessions:\n${NEW_EVENTS}"
  jq -n --arg ctx "$CONTEXT" '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: $ctx
    }
  }'
}

inject_events

# Start typing loop
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TYPING_SCRIPT="$PLUGIN_DIR/hooks/typing-loop.sh"
if [ -f "$TYPING_SCRIPT" ]; then
  nohup bash "$TYPING_SCRIPT" "$CHAT_ID" > /dev/null 2>&1 &
  disown
fi

exit 0
