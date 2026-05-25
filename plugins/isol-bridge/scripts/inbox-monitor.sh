#!/bin/bash
# isol-bridge — 자기 inbox 감시 (영속 명령으로 Monitor가 실행)
# 사용: inbox-monitor.sh <role>
# fswatch 있으면 이벤트 기반, 없으면 1초 폴링 fallback

if [ $# -lt 1 ]; then
  echo "Usage: $(basename "$0") <role>" >&2
  exit 1
fi

ROLE="$1"
BRIDGE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}/session-bridge"
INBOX="$BRIDGE_DIR/inbox/$ROLE"
mkdir -p "$INBOX"

emit() {
  local file="$1"
  [ -f "$file" ] || return
  local intent=""
  intent=$(head -n1 "$file" 2>/dev/null | sed -n 's/^\[\([^]]*\)\].*$/\1/p')
  local basename=""
  basename=$(basename "$file")
  echo "[isol-bridge] inbox=${ROLE} intent=${intent:-unknown} file=${basename}"
}

if command -v fswatch >/dev/null 2>&1; then
  fswatch -0 --event Created --event MovedTo "$INBOX" | while IFS= read -r -d '' file; do
    emit "$file"
  done
else
  declare -A SEEN
  # 시작 시 기존 파일은 seen으로 마킹 (재시작 시 폭발 방지)
  for f in "$INBOX"/*; do
    [ -e "$f" ] && SEEN["$(basename "$f")"]=1
  done
  while true; do
    for f in "$INBOX"/*; do
      [ -e "$f" ] || continue
      bn=$(basename "$f")
      if [ -z "${SEEN[$bn]:-}" ]; then
        SEEN["$bn"]=1
        emit "$f"
      fi
    done
    sleep 1
  done
fi
