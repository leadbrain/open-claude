#!/bin/bash
# cron-runner.sh — Run a Claude Code skill and send results to a Discord thread
#
# Usage: ./scripts/cron-runner.sh <skill-name> <discord-thread-id> [model] [timeout]
# Example: ./scripts/cron-runner.sh weather-briefing 1485223225737613362 haiku 120

set -uo pipefail

SKILL_NAME="${1:?Usage: cron-runner.sh <skill-name> <discord-thread-id> [model] [timeout]}"
DISCORD_THREAD="${2:?Usage: cron-runner.sh <skill-name> <discord-thread-id> [model] [timeout]}"
MODEL="${3:-haiku}"
TIMEOUT="${4:-}"

# Load config
DISCORD_ENV_FILE="$HOME/.claude/channels/discord/.env"
if [ -f "$DISCORD_ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    export "$key=$value"
  done < "$DISCORD_ENV_FILE"
fi

WORKSPACE="${DISCORD_WORKSPACE:?Set DISCORD_WORKSPACE in $DISCORD_ENV_FILE}"
DISCORD_TOKEN="${DISCORD_BOT_TOKEN:?Set DISCORD_BOT_TOKEN in $DISCORD_ENV_FILE}"
LOG_DIR="/tmp/open-claude-cron"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${SKILL_NAME}-$(date '+%Y%m%d-%H%M%S').log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "Starting: $SKILL_NAME → thread $DISCORD_THREAD (model: $MODEL${TIMEOUT:+, timeout: ${TIMEOUT}s})"

# Look up existing session for --resume
cd "$WORKSPACE"
THREAD_FILE="$WORKSPACE/memory/threads/${DISCORD_THREAD}.json"
RESUME_ARG=""
if [ -f "$THREAD_FILE" ]; then
  THREAD_SID=$(jq -r '.session_id // empty' "$THREAD_FILE" 2>/dev/null)
  if [ -n "$THREAD_SID" ]; then
    RESUME_ARG="--resume $THREAD_SID"
    log "Resuming session: $THREAD_SID"
  fi
fi

# Cron marker for log-thread copy (Stop hook uses this)
if [ -n "$RESUME_ARG" ]; then
  MARKER_SID="$THREAD_SID"
else
  MARKER_SID="pending-$$"
fi
echo "$DISCORD_THREAD" > "/tmp/cron-marker-${MARKER_SID}"

# Run skill
STDERR_FILE=$(mktemp)

if [ -n "$TIMEOUT" ]; then
  RESULT=$(timeout "$TIMEOUT" claude -p "/$SKILL_NAME" \
    --dangerously-skip-permissions \
    --model "$MODEL" --output-format json \
    $RESUME_ARG 2>"$STDERR_FILE" < /dev/null) || EXIT_CODE=$?
else
  RESULT=$(claude -p "/$SKILL_NAME" \
    --dangerously-skip-permissions \
    --model "$MODEL" --output-format json \
    $RESUME_ARG 2>"$STDERR_FILE" < /dev/null) || EXIT_CODE=$?
fi

EXIT_CODE=${EXIT_CODE:-0}

if [ -s "$STDERR_FILE" ]; then
  log "STDERR: $(head -20 "$STDERR_FILE")"
fi
rm -f "$STDERR_FILE"

if [ -n "$TIMEOUT" ] && [ "$EXIT_CODE" -eq 124 ]; then
  log "ERROR: Timeout after ${TIMEOUT}s"
  exit 1
fi

if [ -z "$RESULT" ]; then
  log "ERROR: Empty result (exit: $EXIT_CODE)"
  exit 1
fi

# Parse result
NEW_SID=$(echo "$RESULT" | jq -r '.session_id // empty' 2>/dev/null)
RESULT_TEXT=$(echo "$RESULT" | jq -r '.result // empty' 2>/dev/null)
[ -z "$RESULT_TEXT" ] && RESULT_TEXT="$RESULT"

log "Result: ${#RESULT_TEXT} chars (exit: $EXIT_CODE)"
echo "$RESULT_TEXT" >> "$LOG_FILE"

# Update session
if [ -n "$NEW_SID" ]; then
  mkdir -p "$(dirname "$THREAD_FILE")"
  EXISTING=$(cat "$THREAD_FILE" 2>/dev/null || echo '{}')
  echo "$EXISTING" | jq --arg sid "$NEW_SID" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '.session_id = $sid | .last_active = $ts' > "$THREAD_FILE"
  log "Session updated: $NEW_SID"
  if [ -f "/tmp/cron-marker-pending-$$" ]; then
    mv "/tmp/cron-marker-pending-$$" "/tmp/cron-marker-${NEW_SID}"
  fi
fi

if [ "$EXIT_CODE" -ne 0 ]; then
  log "SKIP: exit code $EXIT_CODE"
  exit 1
fi

# Send to Discord if Stop hook won't handle it (no --resume = new session)
if [ -z "$RESUME_ARG" ]; then
  log "No resume — sending via curl"
  SEND_TEXT="${RESULT_TEXT:0:2000}"
  RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "https://discord.com/api/v10/channels/$DISCORD_THREAD/messages" \
    -H "Authorization: Bot $DISCORD_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg content "$SEND_TEXT" '{content: $content}')")
  HTTP_CODE=$(echo "$RESPONSE" | tail -1)
  if [ "$HTTP_CODE" -ne 200 ]; then
    BODY=$(echo "$RESPONSE" | sed '$d')
    log "ERROR: Discord HTTP $HTTP_CODE: $BODY"
    exit 1
  fi
  log "OK: sent via curl to $DISCORD_THREAD"
else
  log "OK: Stop hook will route to $DISCORD_THREAD"
fi
