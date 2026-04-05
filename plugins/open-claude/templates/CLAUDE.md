# Assistant Configuration

This file provides persistent context for Claude across sessions. Edit freely — only the `AUTO:recent-context` section is updated automatically.

---

## User Profile

- **Name**: 
- **Timezone**: 
- **Language**: en

## Principles

- **Communication style**: (concise / detailed / casual / formal)
- **Autonomy level**: (ask before acting / act then report / full autonomy for internal work)
- **When uncertain**: (ask / best guess and flag / proceed and report)
- **Response language**: (match user / always English / always [other])

## Workflows

### Active Features
<!-- managed by /open-claude:configure features -->
- [ ] conversation-analysis — daily conversation summary + user context update
- [ ] qmd — transcript indexing + semantic search

### Cron Schedule
<!-- updated by /open-claude:configure features enable -->
(no scheduled features yet)

## Recent Context
<!-- AUTO:recent-context -->
*This section is auto-updated by the conversation-analysis feature.*
*Enable with: `/open-claude:configure features enable conversation-analysis --channel <id>`*

No context available yet.
<!-- /AUTO:recent-context -->
