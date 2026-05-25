#!/bin/bash
# isol-bridge UserPromptSubmit hook
# user msg를 /tmp 임시 파일에 저장 (Stop hook이 읽음)

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
USER_MSG=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)

[ -z "$SESSION_ID" ] && exit 0
[ -z "$USER_MSG" ] && exit 0

TMPFILE="/tmp/isol-bridge-last-user-${SESSION_ID}.txt"
printf '%s' "$USER_MSG" > "$TMPFILE"
exit 0
