# isol-bridge

Multi-session bridge for Claude Code — `window` / `mirror` / `meta` sessions communicate via file-based inbox messages. The `window` session's every turn (user message + final assistant response) automatically broadcasts to the others through a Stop hook. The others actively push messages back via a helper script.

Designed for setups where you want one identity but separate roles: a session for real-time dialogue, a session for autonomous work and inner processing, and (optionally) a session for system-policy review.

## Architecture

```
Alan ──▶ window session ──Stop hook──▶ inbox/{mirror,meta}/
                ▲                              │
                │ push-message.sh ◀────────────┘
                │ (alert / prefetch / insight)
                │
        mirror session ──── scheduler.sh (Monitor) ──── autonomous triggers
                │
                └── push-message.sh ──▶ inbox/meta/

        meta session ──── analyzes broadcasts ──── push policy proposals
```

- **Identification**: each session uses a fixed UUID via `claude --session-id <uuid>`. A `sessions.json` file maps UUID → role.
- **Role awareness**: SessionStart hook reads the mapping and exports `ISOL_ROLE=<role>` via `$CLAUDE_ENV_FILE`. The shared `CLAUDE.md §0` describes how each role behaves.
- **Communication**: each role has an inbox directory; messages are timestamped markdown files with a `[intent]` header.

## Install

1. Install this plugin via the open-claude marketplace (or load it locally with `claude --plugin-dir`).
2. From your project (vault) directory, run:
   ```
   bash <plugin>/scripts/init-session-bridge.sh
   ```
   This creates `session-bridge/` and a default `sessions.json`.
3. Append `templates/claude-md-section-0.md` to your project's `CLAUDE.md` (the init script shows the path).
4. Start three sessions:
   ```
   bash <plugin>/scripts/start-window.sh
   bash <plugin>/scripts/start-mirror.sh
   bash <plugin>/scripts/start-meta.sh
   ```
   Each launcher uses `--session-id` to set a deterministic UUID — no shell env var setup needed.

## How it works

### Hooks (all live under `hooks/`)

| Event | Script | What it does |
|-------|--------|--------------|
| `SessionStart` | `session-start.sh` | Look up role from `sessions.json` → write `export ISOL_ROLE=<role>` to `$CLAUDE_ENV_FILE`. Compaction also re-fires this. |
| `UserPromptSubmit` | `capture-user-msg.sh` | Save the user prompt to `/tmp/isol-bridge-last-user-<session_id>.txt`. |
| `Stop` | `stop-broadcast.sh` | If `ISOL_ROLE=window`, write `(user_msg, last_assistant_message)` to `inbox/mirror/` and `inbox/meta/`. Background job — does not block. |

### Scripts (under `scripts/`)

- `start-{window,mirror,meta}.sh` — one-line launchers that pin the session UUID
- `push-message.sh <target> <intent> <body>` — write a message into another session's inbox
- `inbox-monitor.sh <role>` — watch your own inbox and emit a stdout line per new message; intended to be wrapped by the Monitor tool inside a persistent Claude Code session
- `init-session-bridge.sh` — one-shot setup of `session-bridge/` for a project

### Runtime layout (under your project)

```
${CLAUDE_PROJECT_DIR}/session-bridge/
├── sessions.json                # uuid → role
├── inbox/{window,mirror,meta}/  # per-role inboxes
└── archive/YYYY-MM/             # archive of processed messages
```

### Message format

```
[intent]
<free-form body>
```

`intent` is a one-word hint: `alert`, `prefetch`, `share`, `query`, `result`, `insight`, `policy`. From/to/timestamp live in the filename: `<timestamp>-from-<role>.md`.

## Notes

- This plugin assumes the running Claude Code version supports the `--session-id <uuid>` CLI flag (verified on 2.1.x).
- macOS fswatch is preferred for inbox monitoring but the script falls back to 1-second polling.
- The plugin does not modify `CLAUDE.md` automatically — append §0 manually so you can audit it.
- Sessions outside this mapping (e.g., a regular `claude` invocation) get no `ISOL_ROLE`, no Stop broadcast, and behave like a normal single-session setup.

## License

MIT — see the open-claude repo root.
