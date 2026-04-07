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

# Kill all typing loops (per-channel PID files)
for TYPING_PID_FILE in /tmp/open-claude-typing-*.pid; do
  [ -f "$TYPING_PID_FILE" ] || continue
  TYPING_PID=$(cat "$TYPING_PID_FILE" 2>/dev/null)
  if [ -n "$TYPING_PID" ] && kill -0 "$TYPING_PID" 2>/dev/null; then
    kill "$TYPING_PID" 2>/dev/null
  fi
  rm -f "$TYPING_PID_FILE"
done
# Legacy single PID file cleanup
if [ -f "/tmp/open-claude-typing.pid" ]; then
  TYPING_PID=$(cat "/tmp/open-claude-typing.pid" 2>/dev/null)
  [ -n "$TYPING_PID" ] && kill "$TYPING_PID" 2>/dev/null
  rm -f "/tmp/open-claude-typing.pid"
fi

# Extract basic info
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

# Config from environment
WORKSPACE="${OPEN_CLAUDE_WORKSPACE:-$(pwd)}"
MAIN_CHANNEL="${DISCORD_MAIN_CHANNEL:-}"
LOG_THREAD="${DISCORD_LOG_THREAD:-}"
BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
EVENT_LOG="${DISCORD_EVENT_LOG:-true}"

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
    LAST_USER_LINE=$(grep -n '"type":"user"' "$TRANSCRIPT" | grep '"permissionMode"' | tail -1 | cut -d: -f1)
  else
    LAST_USER_LINE=1
  fi

  if [ -n "$LAST_USER_LINE" ]; then
    # Extract text + tool_use summaries + Edit diffs in order
    TRANSCRIPT_TEXT=$(tail -n +"$LAST_USER_LINE" "$TRANSCRIPT" | jq -s '
      # Index structuredPatch results by tool_use_id
      ([.[] | select(.type == "user" and (.toolUseResult | type) == "object" and .toolUseResult.structuredPatch) |
        {key: (.toolUseResult.tool_use_id // ""), value: .toolUseResult}] | from_entries) as $patches |

      # Process assistant messages in order
      [.[] | select(.type == "assistant") | .message.content[]? |
        if .type == "text" then .text
        elif .type == "tool_use" then
          (if .name == "Bash" then
            "> `Bash` `" + ((.input.command // "") | split("\n")[0] | .[0:80]) + "`"
          elif .name == "Read" then
            "> `Read` " + ((.input.file_path // "") | split("/") | .[-2:] | join("/"))
          elif .name == "Write" then
            "> `Write` " + ((.input.file_path // "") | split("/") | last)
          elif .name == "Glob" then
            "> `Glob` `" + (.input.pattern // "") + "`"
          elif .name == "Grep" then
            "> `Grep` `" + (.input.pattern // "") + "`" + (if .input.path then " in " + (.input.path | split("/") | last) else "" end)
          elif .name == "Edit" then
            "> `Edit` " + ((.input.file_path // "") | split("/") | last) +
            ($patches[.id] // null | if . then
              "\n```ansi\n" + ([.structuredPatch[].lines[] |
                if startswith("-") then "\u001b[0;31m" + . + "\u001b[0m"
                elif startswith("+") then "\u001b[0;32m" + . + "\u001b[0m"
                else . end] | join("\n")) + "\n```"
            else "" end)
          elif .name == "Agent" then
            "> `Agent` " + (.input.description // .name)
          else
            "> `" + .name + "`"
          end)
        else empty end
      ] | join("\n\n")' -r 2>/dev/null)
  fi
fi

LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null)

# Guard: if transcript extraction is too large (>4000 chars), it likely
# picked up old conversation history. Fall back to last_assistant_message.
if [ -n "$TRANSCRIPT_TEXT" ] && [ ${#TRANSCRIPT_TEXT} -gt 4000 ] && [ -n "$LAST_MSG" ]; then
  TRANSCRIPT_TEXT=""
fi

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

# ── Send message in background (don't block Stop hook) ──
# Claude Code waits for Stop hook to finish before accepting new messages.
# Running send in background minimizes the gap.

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPEN_CLAUDE_SERVER="${OPEN_CLAUDE_SERVER:-http://localhost:3100}"

(
  # Send via server's /api/tools (platform-agnostic — works for Discord + Lark)
  _send() {
    curl -s -X POST "${OPEN_CLAUDE_SERVER}/api/tools" \
      -H "Content-Type: application/json" \
      --data-raw "$(jq -n --arg tool "reply" --arg chat_id "$CHAT_ID" --arg text "$1" \
        '{tool: $tool, args: {chat_id: $chat_id, text: $text}}')" > /dev/null 2>&1
  }

  MSG_LEN=${#RESPONSE}
  if [ "$MSG_LEN" -le 2000 ]; then
    _send "$RESPONSE"
  else
    REMAINING="$RESPONSE"
    while [ -n "$REMAINING" ]; do
      if [ ${#REMAINING} -le 2000 ]; then
        _send "$REMAINING"
        break
      fi
      CHUNK="${REMAINING:0:2000}"
      LAST_NL=$(printf '%s' "$CHUNK" | grep -bo $'\n' | tail -1 | cut -d: -f1)
      if [ -n "$LAST_NL" ] && [ "$LAST_NL" -gt 100 ]; then
        CHUNK="${REMAINING:0:$LAST_NL}"
        REMAINING="${REMAINING:$((LAST_NL+1))}"
      else
        REMAINING="${REMAINING:2000}"
      fi
      BACKTICK_COUNT=$(printf '%s' "$CHUNK" | grep -o '```' | wc -l | tr -d ' ')
      if [ $((BACKTICK_COUNT % 2)) -eq 1 ]; then
        CHUNK="${CHUNK}"$'\n'"\`\`\`"
        REMAINING="\`\`\`"$'\n'"${REMAINING}"
      fi
      _send "$CHUNK"
      sleep 0.3
    done
  fi

  # Remove ack reaction
  curl -s -X POST "${OPEN_CLAUDE_SERVER}/api/ack-clear" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -n --arg ch "$CHAT_ID" '{chat_id: $ch}')" > /dev/null 2>&1

  # Cron: copy to log thread
  CRON_MARKER="/tmp/cron-marker-${SESSION_ID}"
  if [ -f "$CRON_MARKER" ] && [ -n "$LOG_THREAD" ] && [ "$CHAT_ID" != "$LOG_THREAD" ]; then
    SAVE_CHAT_ID="$CHAT_ID"
    CHAT_ID="$LOG_THREAD"
    _send "[cron → ${SAVE_CHAT_ID}] ${RESPONSE:0:1900}"
    rm -f "$CRON_MARKER"
  fi
) &

exit 0
