---
name: qmd-index
description: Index conversation transcripts and user context into QMD for semantic search.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(/opt/homebrew/bin/qmd *)
  - Bash(find *)
  - Bash(date *)
  - Bash(wc *)
---

# /qmd-index — Index Conversations for Search

Index conversation transcripts and user context into QMD collections for BM25 and semantic search. Runs as a scheduled job or on-demand.

Arguments passed: `$ARGUMENTS`

---

## Step 1: Check prerequisites

Check if QMD is installed:

```bash
ls /opt/homebrew/bin/qmd 2>/dev/null || echo "NOT_FOUND"
```

If not found:
> QMD is not installed. Install it to use search features.
> See: https://github.com/user/qmd (or appropriate install instructions)

Stop here.

Check `memory/features.json` — if `qmd` is not enabled:
> QMD indexing is disabled. Enable with:
> `/open-claude:configure features enable qmd`

Stop here.

## Step 2: Check indexing state

Read `memory/qmd-state.json`. If it doesn't exist, create:

```json
{
  "last_indexed": "1970-01-01T00:00:00Z",
  "collections": {
    "sessions": { "doc_count": 0 },
    "user": { "doc_count": 0 }
  }
}
```

## Step 3: Index event logs (sessions collection)

Find event log files modified since `last_indexed`:

```bash
find memory/events -name "*.md" -newer memory/qmd-state.json 2>/dev/null
```

For each new/modified file, index into the `sessions` collection:

```bash
/opt/homebrew/bin/qmd index -c sessions -f <file_path>
```

If no QMD `index` subcommand exists, check `qmd --help` and adapt. Common patterns:
- `qmd add -c sessions <file>`
- `qmd ingest -c sessions <file>`

## Step 4: Index user context (user collection)

If `memory/user-context.json` exists and has been modified since last index:

```bash
/opt/homebrew/bin/qmd index -c user -f memory/user-context.json
```

## Step 5: Update state

Update `memory/qmd-state.json` with current timestamp and doc counts:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
```

Write updated state file.

## Step 6: Output summary

```
QMD indexing complete.
- Sessions: indexed {n} new event logs ({total} total docs)
- User context: {indexed / up to date}
- Last indexed: {timestamp}
```

## Important

- Only index files that changed since last run (incremental)
- If QMD binary interface differs from expected, adapt based on `qmd --help` output
- Don't index binary files or non-text content
- Keep `qmd-state.json` accurate — it's the single source of truth for what's been indexed
