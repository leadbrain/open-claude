#!/bin/bash
# isol-bridge — 최초 1회 vault에 session-bridge/ 구조 생성
# 사용: cd {vault} && bash <plugin>/scripts/init-session-bridge.sh

set -euo pipefail

BRIDGE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}/session-bridge"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Initializing isol-bridge at: $BRIDGE_DIR"

mkdir -p \
  "$BRIDGE_DIR/inbox/window" \
  "$BRIDGE_DIR/inbox/mirror" \
  "$BRIDGE_DIR/inbox/meta" \
  "$BRIDGE_DIR/archive"

if [ ! -f "$BRIDGE_DIR/sessions.json" ]; then
  cp "$PLUGIN_DIR/templates/sessions.json.example" "$BRIDGE_DIR/sessions.json"
  echo "  ✓ Created sessions.json (default UUIDs)"
else
  echo "  ✓ sessions.json exists (kept)"
fi

echo ""
echo "Next steps:"
echo "  1. Review $BRIDGE_DIR/sessions.json (use default UUIDs or generate your own)"
echo "  2. Add §0 section to your CLAUDE.md:"
echo "     $PLUGIN_DIR/templates/claude-md-section-0.md"
echo "  3. Start sessions with:"
echo "     bash $PLUGIN_DIR/scripts/start-window.sh"
echo "     bash $PLUGIN_DIR/scripts/start-mirror.sh"
echo "     bash $PLUGIN_DIR/scripts/start-meta.sh"
echo ""
echo "Done."
