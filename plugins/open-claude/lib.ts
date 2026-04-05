/**
 * Pure functions extracted from server.ts for testability.
 * No side effects — no Discord client, no file I/O, no MCP.
 */

// ── Types ──

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export type GateInput = {
  senderId: string
  isDM: boolean
  channelId: string
  isThread: boolean
  parentId?: string
  isMentioned: boolean
}

// ── Functions ──

export const MAX_CHUNK_LIMIT = 2000

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {},
    ackReaction: '👀',
    chunkMode: 'newline',
  }
}

export function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) { delete a.pending[code]; changed = true }
  }
  return changed
}

export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * Pure gate logic — determines whether to deliver, drop, or pair a message.
 * Does NOT handle pairing code generation (that requires randomBytes).
 * Returns 'need_pair' when a new pairing is needed (caller generates the code).
 */
export function gatePure(
  input: GateInput,
  access: Access,
): GateResult | { action: 'need_pair' } {
  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  if (input.isDM) {
    if (access.allowFrom.includes(input.senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    // Pairing — check for existing code
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === input.senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    return { action: 'need_pair' }
  }

  // Guild channel — key on channel ID (threads inherit parent)
  const channelId = input.isThread
    ? input.parentId ?? input.channelId
    : input.channelId
  const policy = access.groups[channelId]
  if (!policy) return { action: 'drop' }
  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(input.senderId)) return { action: 'drop' }
  if (policy.requireMention && !input.isMentioned) return { action: 'drop' }
  return { action: 'deliver', access }
}
