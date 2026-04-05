#!/bin/bash
# start-http.sh — Start open-claude in HTTP mode
#
# Creates a tmux session with:
#   1. HTTP MCP server (persistent, single Discord connection)
#   2. Claude Code main session (connects via URL)

set -euo pipefail

WORKSPACE="${OPEN_CLAUDE_WORKSPACE:-$(pwd)}"
TMUX_SESSION="${DISCORD_TMUX_SESSION:-open-claude}"

# Find plugin directory — check marketplace install, then local
if [ -d "$HOME/.claude/plugins/marketplaces/open-claude/plugins/open-claude" ]; then
  PLUGIN_DIR="$HOME/.claude/plugins/marketplaces/open-claude/plugins/open-claude"
elif [ -d "$WORKSPACE/.claude/plugins/open-claude" ]; then
  PLUGIN_DIR="$WORKSPACE/.claude/plugins/open-claude"
else
  echo "Error: open-claude plugin not found"
  exit 1
fi

# Check if session already exists
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "tmux session '$TMUX_SESSION' already exists."
  echo "  Attach: tmux attach -t $TMUX_SESSION"
  echo "  Kill:   tmux kill-session -t $TMUX_SESSION"
  exit 1
fi

# Load env from discord.env (HTTP mode stores config here, not in .mcp.json)
ENV_FILE="$WORKSPACE/.claude/discord.env"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    export "$key=$value"
  done < "$ENV_FILE"
fi

export OPEN_CLAUDE_WORKSPACE="$WORKSPACE"

echo "Starting open-claude HTTP mode..."
echo "  Workspace: $WORKSPACE"
echo "  tmux session: $TMUX_SESSION"

# Build env export string for tmux commands
ENV_EXPORTS=""
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    ENV_EXPORTS="${ENV_EXPORTS}export ${key}='${value}' && "
  done < "$ENV_FILE"
fi
ENV_EXPORTS="${ENV_EXPORTS}export OPEN_CLAUDE_WORKSPACE='$WORKSPACE' && "

# Window 1: HTTP MCP server
tmux new-session -d -s "$TMUX_SESSION" -n server \
  "${ENV_EXPORTS}cd '$WORKSPACE' && bun run --cwd '$PLUGIN_DIR' start:http; echo 'Server exited. Press Enter.'; read"

# Wait for server to start
sleep 2

# Window 2: Claude Code main session (proxy connects to HTTP server via stdio)
tmux new-window -t "$TMUX_SESSION" -n main \
  "${ENV_EXPORTS}export OPEN_CLAUDE_SERVER='http://localhost:${OPEN_CLAUDE_PORT:-3100}' && export OPEN_CLAUDE_CHAT_ID='${DISCORD_MAIN_CHANNEL}' && cd '$WORKSPACE' && claude --dangerously-skip-permissions --dangerously-load-development-channels server:open-claude; echo 'Claude exited. Press Enter.'; read"

# Auto-approve the development channels prompt
sleep 3
tmux send-keys -t "$TMUX_SESSION":main Enter 2>/dev/null

echo "Started! Attaching to tmux session..."
echo "  Detach: Ctrl-b d"
echo "  Switch windows: Ctrl-b n/p"

tmux attach -t "$TMUX_SESSION"
