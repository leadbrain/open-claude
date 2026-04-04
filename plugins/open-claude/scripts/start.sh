#!/bin/bash
# start.sh — Launch open-claude Discord channel
#
# Starts Claude Code with the required flag for Discord channel support.
# Run from your workspace directory.

set -euo pipefail

SESSION_NAME="${1:-open-claude}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "Session '$SESSION_NAME' already running."
  echo "  Attach: tmux attach -t $SESSION_NAME"
  echo "  Kill:   tmux kill-session -t $SESSION_NAME"
  exit 0
fi

echo "Starting open-claude..."

# Export DISCORD_ env vars from .mcp.json so hooks can access them
WORKSPACE="$(pwd)"
ENV_EXPORTS=$(python3 -c "
import json, os
try:
    d = json.load(open('$WORKSPACE/.mcp.json'))
    env = d.get('mcpServers', {}).get('open-claude', {}).get('env', {})
    for k, v in env.items():
        print(f\"export {k}='{v}'\")
except: pass
" 2>/dev/null)

tmux new-session -d -s "$SESSION_NAME" \
  "cd '$WORKSPACE' && $ENV_EXPORTS && claude --dangerously-load-development-channels server:open-claude"

echo "open-claude started in tmux session '$SESSION_NAME'."
echo ""
echo "  Attach:  tmux attach -t $SESSION_NAME"
echo "  Detach:  Ctrl+B, D"
echo "  Stop:    tmux kill-session -t $SESSION_NAME"
