---
name: conversation-analysis
description: Analyze today's conversations and update user context. Runs as a scheduled job or on-demand.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(date *)
---

# /conversation-analysis — Daily Conversation Analysis

Analyze today's conversation events and update user context. Designed to run automatically via the built-in scheduler, or manually.

Arguments passed: `$ARGUMENTS`

---

## Step 1: Check feature status

Read `memory/jobs.json`. If `conversation-analysis` is not enabled or the file doesn't exist:

> Conversation analysis is not enabled. Enable with:
> `/open-claude:configure jobs enable conversation-analysis --channel <thread-id>`

Stop here.

## Step 2: Gather today's data

Get today's date and read event logs:

```bash
date +%Y-%m-%d
```

Read these files (skip if they don't exist):
- `memory/events/{today}.md` — today's event summaries
- `memory/events/{yesterday}.md` — yesterday's events
- `memory/events/{day-before}.md` — two days ago

Each event log line has the format: `HH:MM [channel-id] summary text`

## Step 3: Read existing user context

Read `memory/user-context.json`. If it doesn't exist, create the initial structure:

```json
{
  "profile": { "name": "", "timezone": "", "language": "en" },
  "interests": [],
  "communication_preferences": {
    "tone": "",
    "detail_level": "",
    "autonomy_level": ""
  },
  "recent_context": {
    "period": "",
    "today": [],
    "yesterday": [],
    "ongoing": []
  },
  "updated_at": ""
}
```

Also read `CLAUDE.md` in the workspace root if it exists — look for the User Profile section to fill in any missing profile fields.

## Step 4: Analyze and update

Based on the event logs, update `memory/user-context.json`:

### recent_context
- Move previous `today` entries to `yesterday`
- Clear old `yesterday` (it becomes 2+ days old)
- Extract key topics/activities from today's events → new `today` array
- Identify themes that appear across multiple days → `ongoing` array
- Set `period` to the date range covered (e.g., "2026-04-03 ~ 2026-04-05")

### interests
- Look for recurring topics, tools, or domains in the events
- Add new interests not already in the list
- Keep the list under 20 items (remove least recent if needed)

### communication_preferences
- Only update if you observe clear patterns (e.g., user consistently uses terse messages → tone: "concise")
- Don't guess — only update based on evidence

### updated_at
- Set to current ISO timestamp

Write the updated `memory/user-context.json`.

## Step 5: Update CLAUDE.md (if markers exist)

Read the workspace `CLAUDE.md`. Look for these markers:

```
<!-- AUTO:recent-context -->
...content...
<!-- /AUTO:recent-context -->
```

If found, replace everything between the markers with a formatted summary:

```markdown
<!-- AUTO:recent-context -->
**Period**: {period}

**Today** ({date}):
- {topic1}
- {topic2}

**Yesterday** ({date}):
- {topic3}

**Ongoing**:
- {theme1}
<!-- /AUTO:recent-context -->
```

If the markers are not found, do NOT modify CLAUDE.md. Mention this in the output.

## Step 6: Output summary

Print a concise summary of what was updated:

```
Conversation analysis complete ({date}).
- Events analyzed: {count} from today, {count} from yesterday
- Topics: {top 3 topics}
- Interests updated: {added/unchanged}
- CLAUDE.md: {updated / markers not found / no CLAUDE.md}
```

This output goes to Discord via the Stop hook.

## Important

- Never delete existing interests — only add or reorder
- Don't fabricate topics — only extract from actual event data
- If no events exist for today, say so and skip the analysis
- Keep the CLAUDE.md section concise (under 20 lines)
- Respect the marker boundaries — never edit outside `<!-- AUTO:recent-context -->`
