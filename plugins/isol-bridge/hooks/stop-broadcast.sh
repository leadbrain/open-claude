#!/bin/bash
# isol-bridge Stop hook
# window 세션의 turn (user_msg + last_assistant_message)을 mirror·meta inbox에 broadcast
# 다른 세션에서는 즉시 exit (역할 가드)

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

BRIDGE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}/session-bridge"
SESSIONS_FILE="$BRIDGE_DIR/sessions.json"
[ ! -f "$SESSIONS_FILE" ] && exit 0

ROLE=$(jq -r --arg id "$SESSION_ID" '.[$id] // empty' "$SESSIONS_FILE" 2>/dev/null)
[ "$ROLE" = "window" ] || exit 0

ASSISTANT_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null)
[ -z "$ASSISTANT_MSG" ] && exit 0

TMPFILE="/tmp/isol-bridge-last-user-${SESSION_ID}.txt"
USER_MSG=""
[ -f "$TMPFILE" ] && USER_MSG=$(cat "$TMPFILE")

LOG="/tmp/isol-bridge-stop-broadcast.log"
TIMESTAMP=$(date +%Y%m%dT%H%M%S)

# 백그라운드 — 창의 turn 종료 블로킹 회피
(
  for target in mirror meta; do
    INBOX="$BRIDGE_DIR/inbox/$target"
    mkdir -p "$INBOX"
    FILE="$INBOX/${TIMESTAMP}-from-window.md"
    {
      echo '[share]'
      echo '## user'
      printf '%s\n\n' "$USER_MSG"
      echo '## response'
      printf '%s\n' "$ASSISTANT_MSG"
    } > "$FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] broadcast → $FILE" >> "$LOG"
  done
) &

exit 0
