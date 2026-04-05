#!/bin/bash
# platform-send.sh — Platform-agnostic message sending for hooks.
# Source this file to get send_message() and send_typing() functions.
#
# Expects: OPEN_CLAUDE_PLATFORM, BOT_TOKEN (Discord) or LARK_TENANT_TOKEN (Lark)
# Usage:
#   source "$(dirname "$0")/platform-send.sh"
#   send_message "$CHAT_ID" "Hello!"
#   send_typing "$CHAT_ID"

PLATFORM="${OPEN_CLAUDE_PLATFORM:-discord}"

send_message() {
  local chat_id="$1"
  local text="$2"

  if [ "$PLATFORM" = "lark" ]; then
    _send_lark "$chat_id" "$text"
  else
    _send_discord "$chat_id" "$text"
  fi
}

send_typing() {
  local chat_id="$1"

  if [ "$PLATFORM" = "lark" ]; then
    # Lark has no typing indicator — no-op
    :
  else
    _typing_discord "$chat_id"
  fi
}

# ── Discord ──

_send_discord() {
  local chat_id="$1"
  local text="$2"
  curl -s -X POST \
    "https://discord.com/api/v10/channels/${chat_id}/messages" \
    -H "Authorization: Bot ${BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-raw "$(jq -n --arg content "$text" '{content: $content}')" > /dev/null 2>&1
}

_typing_discord() {
  local chat_id="$1"
  curl -s -X POST \
    "https://discord.com/api/v10/channels/${chat_id}/typing" \
    -H "Authorization: Bot ${BOT_TOKEN}" > /dev/null 2>&1
}

# ── Lark ──

_send_lark() {
  local chat_id="$1"
  local text="$2"
  local token="${LARK_TENANT_TOKEN:-}"
  [ -z "$token" ] && return

  local content
  content=$(jq -n --arg text "$text" '{text: $text}')

  curl -s -X POST \
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json; charset=utf-8" \
    --data-raw "$(jq -n \
      --arg rid "$chat_id" \
      --arg content "$content" \
      '{receive_id: $rid, msg_type: "text", content: $content}')" > /dev/null 2>&1
}
