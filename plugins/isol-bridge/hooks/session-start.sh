#!/bin/bash
# isol-bridge SessionStart hook
# session_id로 sessions.json 조회 → ISOL_ROLE을 $CLAUDE_ENV_FILE에 export

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0

BRIDGE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}/session-bridge"
SESSIONS_FILE="$BRIDGE_DIR/sessions.json"
[ ! -f "$SESSIONS_FILE" ] && exit 0

ROLE=$(jq -r --arg id "$SESSION_ID" '.[$id] // empty' "$SESSIONS_FILE" 2>/dev/null)
[ -z "$ROLE" ] && exit 0

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export ISOL_ROLE=${ROLE}" >> "$CLAUDE_ENV_FILE"
fi

# 로그
LOG="/tmp/isol-bridge-session-start.log"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] SessionStart role=$ROLE session_id=$SESSION_ID" >> "$LOG"
exit 0
