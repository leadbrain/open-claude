#!/bin/bash
# isol-bridge — 다른 세션 inbox에 메시지 작성
# 사용: push-message.sh <target_role> <intent> <body>
# 예: push-message.sh window alert "BTC drawdown -10%"

set -euo pipefail

if [ $# -lt 3 ]; then
  echo "Usage: $(basename "$0") <target_role> <intent> <body>" >&2
  echo "Example: $(basename "$0") window alert 'BTC drawdown -10%'" >&2
  exit 1
fi

TARGET="$1"
INTENT="$2"
BODY="$3"
FROM="${ISOL_ROLE:-unknown}"

BRIDGE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}/session-bridge"
INBOX="$BRIDGE_DIR/inbox/$TARGET"
mkdir -p "$INBOX"

TIMESTAMP=$(date +%Y%m%dT%H%M%S)
FILE="$INBOX/${TIMESTAMP}-from-${FROM}.md"

{
  echo "[${INTENT}]"
  printf '%s\n' "$BODY"
} > "$FILE"

echo "$FILE"
