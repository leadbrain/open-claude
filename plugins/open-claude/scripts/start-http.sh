#!/bin/bash
# start-http.sh — Start open-claude in HTTP mode
#
# Creates a tmux session with:
#   1. HTTP MCP server (persistent, single Discord connection)
#   2. Claude Code main session (connects via URL)

set -euo pipefail

WORKSPACE="${OPEN_CLAUDE_WORKSPACE:-$(pwd)}"
TMUX_SESSION="${DISCORD_TMUX_SESSION:-open-claude}"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Check if session already exists
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "tmux session '$TMUX_SESSION' already exists."
  echo "  Attach: tmux attach -t $TMUX_SESSION"
  echo "  Kill:   tmux kill-session -t $TMUX_SESSION"
  exit 1
fi

# Load env from .mcp.json if available
if [ -f "$WORKSPACE/.mcp.json" ]; then
  eval "$(jq -r '
    .mcpServers["open-claude"].env // {} |
    to_entries[] |
    "export \(.key)=\(.value | @sh)"
  ' "$WORKSPACE/.mcp.json" 2>/dev/null)" 2>/dev/null || true
fi

export OPEN_CLAUDE_WORKSPACE="$WORKSPACE"

echo "Starting open-claude HTTP mode..."
echo "  Workspace: $WORKSPACE"
echo "  tmux session: $TMUX_SESSION"

# Window 1: HTTP MCP server
tmux new-session -d -s "$TMUX_SESSION" -n server \
  "cd '$WORKSPACE' && bun run --cwd '$PLUGIN_DIR' start:http; echo 'Server exited. Press Enter.'; read"

# Wait for server to start
sleep 2

# Window 2: Claude Code main session
tmux new-window -t "$TMUX_SESSION" -n main \
  "cd '$WORKSPACE' && claude --dangerously-load-development-channels plugin:open-claude@open-claude; echo 'Claude exited. Press Enter.'; read"

echo "Started! Attaching to tmux session..."
echo "  Detach: Ctrl-b d"
echo "  Switch windows: Ctrl-b n/p"

tmux attach -t "$TMUX_SESSION"
